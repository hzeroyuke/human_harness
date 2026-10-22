const $ = (selector) => document.querySelector(selector);
const DATA_URL = new URL("./data/full-task.json", import.meta.url);
const PHASE_NAMES = { review: "独立读者审阅", lookup: "查阅执行记录", rewrite: "改写这条消息" };
const RULE_NAMES = { "北京时间边界": "按北京时间核对订单和通知日期", "幂等去重": "同一笔通知重复发送，只计算一次", "成功状态过滤": "只统计成功的支付和退款", "金额精度与非法金额隔离": "金额精确到分，异常金额单独核查", "退款不误记成欠款": "已退款与未收齐款分别列出", "孤儿通知": "找不到订单的通知单独核查", "部分付款和多付款": "列出需要催款和处理多付款的订单", "稳定排序和 CSV": "结果顺序固定，并导出 CSV 表格", "项目回归测试": "运行测试，确认旧功能仍然正常", "交付文件": "交付 JSON、CSV 和中文汇总文件", "迟到事件": "补来的通知按实际发生时间入账", "冲突 ID 的所有版本隔离": "同一通知编号内容冲突时，全部版本单独核查", "逐笔手续费及半分进位": "每笔支付分别计算手续费并四舍五入", "第一轮无手续费兼容": "不指定手续费时，仍保留第一轮的计算方式" };
const state = { dataset: null, modelId: null, runId: null, roundId: null, messageId: null, showExample: false };
let shareResetTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function formatJSON(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "未记录";
}

function duration(value) {
  if (!Number.isFinite(value)) return "未记录耗时";
  if (value < 1000) return `${Math.round(value)} 毫秒`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} 秒`;
  return `${Math.floor(value / 60_000)} 分 ${Math.round((value % 60_000) / 1000)} 秒`;
}

function badge(text, kind = "neutral") {
  return element("span", `badge ${kind}`, text);
}

function modelRuns(modelId = state.modelId) {
  return state.dataset.runs.filter((run) => run.modelId === modelId && run.enabled === true)
    .sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0));
}

function currentRun() {
  const runs = modelRuns();
  return runs.find((run) => run.id === state.runId) ?? runs.at(-1);
}

function attemptNumber(run) {
  return modelRuns(run.modelId).findIndex((entry) => entry.id === run.id) + 1;
}

function runDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "时间未记录" : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(date);
}

function runState(run) {
  return { completed: "计划执行结束", interrupted: "提前停止", error: "遇到错误", running: "正在执行" }[run?.status] ?? "尚未结束";
}

function attemptLabel(run) {
  const runs = modelRuns(run.modelId);
  const latest = runs.length > 1 && runs.at(-1)?.id === run.id;
  return `第 ${attemptNumber(run)} 次${latest ? " · 最新" : ""} · ${runDate(run.startedAt)} · ${runState(run)}`;
}

function mainResponseFailures(round) {
  return (round?.events ?? []).filter((event) => event.type === "assistant" && event.errorStage === "main-response" && event.isError === true && !event.review).map((event) => {
    const response = round.rawResponses?.find((entry) => entry.id === (event.sourceMessageId ?? event.id));
    const title = { length: "主模型生成被截断", aborted: "主模型调用被中止", error: "主模型调用返回错误" }[response?.stopReason] ?? "主模型调用未完成";
    return { event, response, title, detail: "主模型没有完成这条回复。此次返回没有发送给用户，也没有进入表达审核，不计作审核失败。" };
  });
}

function responseCounts(round) {
  const responses = round?.rawResponses ?? [];
  const withText = responses.filter((response) => typeof response.text === "string" && response.text.trim().length > 0).length;
  const toolsOnly = responses.filter((response) => !(typeof response.text === "string" && response.text.trim()) && response.toolCalls?.length > 0).length;
  return { recorded: Array.isArray(round?.rawResponses), total: responses.length, withText, toolsOnly, other: responses.length - withText - toolsOnly, incomplete: mainResponseFailures(round).length, tools: (round?.events ?? []).filter((event) => event.type === "tool").length };
}

function currentRound() {
  return currentRun()?.rounds.find((round) => round.id === state.roundId);
}

function messagesInRound(round = currentRound()) {
  return (round?.events ?? []).filter((event) => event.type === "assistant" && event.review);
}

function currentMessage() {
  return messagesInRound().find((event) => event.id === state.messageId);
}

function acceptanceStatus(round) {
  const result = round?.acceptance;
  if (!result || !result.total) return { text: "尚无验收结果", kind: "neutral" };
  if (result.checks?.some((check) => check.id === "verifier-error")) return { text: "验收未能完成", kind: "neutral" };
  if (result.passed) return { text: "业务验收通过", kind: "pass" };
  return { text: "仍有功能未完成", kind: "fail" };
}

function reviewStatus(round, enabled) {
  if (!enabled) return { text: "未开启表达检查", kind: "neutral", detail: "主模型的文字直接展示给用户。" };
  const reviews = (round?.events ?? []).filter((event) => event.type === "assistant" && event.review).map((event) => event.review);
  const failed = reviews.filter((review) => review.status === "failed").length;
  const changed = reviews.filter((review) => review.status === "approved" && review.original !== review.final).length;
  const approved = reviews.filter((review) => review.status === "approved").length;
  if (failed) return { text: `${failed} 条回复未获放行`, kind: "fail", detail: `${approved} 条已放行，其中 ${changed} 条经过改写。展开工作记录可查看拦截原因。` };
  if (approved) return { text: `${approved} 条回复获准展示`, kind: "review", detail: changed ? `${changed} 条经过改写，其余原样展示。` : "这些消息原样通过，没有改写。" };
  return { text: "尚无表达检查结果", kind: "neutral", detail: round?.status === "running" ? "模型正在处理任务，尚未完成文字审阅。" : round ? "这轮没有记录到完整的文字审阅。" : "这轮尚未执行，或前一轮已经停止。" };
}

function executionStatus(round) {
  if (!round) return "未执行";
  return { completed: "本轮执行结束", interrupted: "执行中断", error: "执行遇到错误", running: "正在执行" }[round.status] ?? "执行未结束";
}

function reviewInterruption(review) {
  if (review?.status !== "failed") return null;
  const phases = review.phases ?? [];
  const last = phases.at(-1);
  if (!last || (!last.error && !["aborted", "error"].includes(last.stopReason))) return null;
  const reviewedAfterRewrite = last.phase === "review" && phases.slice(0, -1).some((phase) => phase.phase === "rewrite");
  const name = reviewedAfterRewrite ? "复审" : { review: "审阅", lookup: "查证", rewrite: "改写" }[last.phase] ?? "模型";
  return {
    title: `${name}${last.stopReason === "aborted" ? "调用被中止" : "调用返回错误"}，未得到有效批准`,
    detail: "这次调用没有产生有效批准，不能据此判断候选稿是否容易理解。",
    error: last.error,
  };
}

function errorExplanation(error) {
  const raw = formatJSON(error ?? "");
  if (/revision limit/i.test(raw)) return "已经达到改写次数上限，独立读者仍然不能批准这条消息。";
  if (/invalid review decision|invalid review response|incomplete review response/i.test(raw)) return "审阅调用没有返回完整、有效的决定，系统没有放行草稿。";
  if (/timed out|timeout/i.test(raw)) return "调用超时，未能继续完成这轮工作。";
  if (/aborted|cancelled/i.test(raw)) return "调用被中止，未能继续完成这轮工作。";
  if (/protected technical content/i.test(raw)) return "改写变动了需要保留的技术内容，系统拦下了这个版本。";
  if (/fetch failed|WebSocket|HTTP 5|upstream|connect/i.test(raw)) return "模型接口或连接发生故障，不能据此判断模型是否能完成任务。";
  if (/Humanize/i.test(raw)) return "表达检查没有完成，未审阅的草稿被保留在内部。";
  return "这轮执行提前停止；下面保留了停止前的操作和具体错误。";
}

function rawDetail(label, value, open = false) {
  const detail = element("details", "raw-detail");
  detail.open = open;
  detail.append(element("summary", "", label), element("pre", "", formatJSON(value)));
  return detail;
}

function appendInline(target, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|<br\s*\/?>)/gi;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    target.append(document.createTextNode(text.slice(offset, match.index)));
    if (/^<br\s*\/?>$/i.test(match[0])) {
      target.append(element("br"));
      offset = match.index + match[0].length;
      continue;
    }
    const code = match[0].startsWith("`");
    const inline = element(code ? "code" : "strong");
    const content = match[0].slice(code ? 1 : 2, code ? -1 : -2);
    if (code) inline.textContent = content;
    else appendInline(inline, content);
    target.append(inline);
    offset = match.index + match[0].length;
  }
  target.append(document.createTextNode(text.slice(offset)));
}

/** Render common message formatting with text nodes only; model HTML never becomes executable markup. */
function renderMessage(text) {
  const container = element("div", "response-text formatted-message");
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const content = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) content.push(lines[index++]);
      const pre = element("pre", "message-code");
      pre.append(element("code", "", content.join("\n")));
      container.append(pre);
      continue;
    }
    if (line.trim().startsWith("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] ?? "")) {
      const rows = [line];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) rows.push(lines[index++]);
      index--;
      const shell = element("div", "message-table-scroll");
      shell.tabIndex = 0;
      shell.setAttribute("role", "region");
      shell.setAttribute("aria-label", "回复中的表格，可横向滚动");
      const table = element("table", "message-table");
      const head = element("thead");
      const body = element("tbody");
      rows.forEach((row, rowIndex) => {
        const tr = element("tr");
        for (const value of row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|")) {
          const cell = element(rowIndex === 0 ? "th" : "td");
          if (rowIndex === 0) cell.scope = "col";
          appendInline(cell, value.trim());
          tr.append(cell);
        }
        (rowIndex === 0 ? head : body).append(tr);
      });
      table.append(head, body);
      shell.append(table);
      container.append(shell);
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      const title = element("h4");
      appendInline(title, heading[1]);
      container.append(title);
      continue;
    }
    const bullet = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line);
    if (bullet) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const list = element(ordered ? "ol" : "ul");
      if (ordered) list.start = Number.parseInt(line.trim(), 10);
      let next = bullet;
      while (next) {
        const item = element("li");
        appendInline(item, next[1]);
        list.append(item);
        const nextLine = lines[index + 1] ?? "";
        next = (ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/).exec(nextLine);
        if (next) index++;
      }
      container.append(list);
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      container.append(element("hr"));
      continue;
    }
    const paragraph = element("p");
    appendInline(paragraph, line);
    container.append(paragraph);
  }
  return container;
}

function restoreQuery() {
  const query = new URLSearchParams(location.search);
  const models = state.dataset.models;
  const rounds = state.dataset.task.rounds;
  const requestedRun = state.dataset.runs.find((run) => run.enabled && run.id === query.get("runId"));
  const hasSelection = ["model", "runId", "round", "message"].some((key) => query.has(key));
  const example = hasSelection ? null : models.map((model) => modelRuns(model.id).at(-1)).filter(Boolean).flatMap((run) => run.rounds.flatMap((round) => round.events.filter((event) => event.review?.status === "approved" && event.review.original !== event.review.final).map((event) => ({ modelId: run.modelId, runId: run.id, roundId: round.id, messageId: event.id })))).at(0);
  state.modelId = requestedRun?.modelId ?? (models.some((model) => model.id === query.get("model")) ? query.get("model") : example?.modelId ?? models[0]?.id ?? null);
  state.roundId = rounds.some((round) => round.id === query.get("round")) ? query.get("round") : example?.roundId ?? rounds[0]?.id ?? null;
  const attempts = modelRuns();
  // Links created before runId existed belong to the earliest matching saved attempt.
  const legacyRun = !query.has("runId") && query.has("message") ? attempts.find((run) => run.rounds.some((round) => round.id === state.roundId && round.events.some((event) => event.id === query.get("message") && event.review))) : null;
  state.runId = requestedRun?.id ?? legacyRun?.id ?? example?.runId ?? attempts.at(-1)?.id ?? null;
  const messages = messagesInRound();
  state.messageId = messages.some((event) => event.id === query.get("message")) ? query.get("message") : example?.messageId ?? messages.at(-1)?.id ?? null;
  state.showExample = Boolean(example);
}

function updateQuery() {
  const url = new URL(location.href);
  url.search = "";
  if (state.modelId) url.searchParams.set("model", state.modelId);
  if (state.runId) url.searchParams.set("runId", state.runId);
  if (state.roundId) url.searchParams.set("round", state.roundId);
  if (state.messageId) url.searchParams.set("message", state.messageId);
  history.replaceState(null, "", url);
}

function renderBrief() {
  const { task, models, runs } = state.dataset;
  $("#task-title").textContent = task.title;
  $("#task-description").textContent = task.description;
  const rounds = $("#task-rounds");
  rounds.replaceChildren();
  task.rounds.forEach((round, index) => {
    const section = element("article", "round-brief");
    section.append(element("p", "round-number", `第 ${index + 1} 轮`), element("h3", "", round.title));
    const requirementDetails = element("details", "requirement-detail");
    requirementDetails.append(element("summary", "", `查看 ${round.acceptance?.length ?? 0} 类验收要求`));
    const requirements = element("ul", "requirement-list");
    for (const item of round.acceptance ?? []) requirements.append(element("li", "", RULE_NAMES[item] ?? item));
    requirementDetails.append(requirements);
    section.append(requirementDetails);
    const prompt = element("details", "prompt-detail");
    prompt.append(element("summary", "", "查看这轮完整用户需求"), element("p", "prompt-text", round.prompt));
    section.append(prompt);
    rounds.append(section);
  });
  const complete = state.dataset.complete === true;
  $("#batch-state").textContent = `${models.length} 个模型 · ${runs.filter((run) => run.enabled).length} 次真实尝试 · 每次最多 ${task.rounds.length} 轮需求。${complete ? "这批计划执行已结束，提前中断的情况也全部保留。" : "这批实验尚未全部结束，未完成的运行不会记作成功。"}`;
  $("#batch-state").classList.toggle("in-progress", !complete);
  $("#model-select").replaceChildren();
  for (const model of models) {
    const option = element("option", "", model.name ?? model.id);
    option.value = model.id;
    $("#model-select").append(option);
  }
  const stamp = new Date(state.dataset.generatedAt);
  if (!Number.isNaN(stamp.valueOf())) $("#data-date").textContent = `记录更新：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(stamp)} · 北京时间`;
}

function renderControls() {
  $("#selection-hint").hidden = !state.showExample;
  $("#model-select").value = state.modelId;
  const attempts = modelRuns();
  const run = currentRun();
  state.runId = run?.id ?? null;
  const attemptSelect = $("#attempt-select");
  attemptSelect.replaceChildren();
  for (const attempt of attempts.toReversed()) {
    const option = element("option", "", attemptLabel(attempt));
    option.value = attempt.id;
    attemptSelect.append(option);
  }
  if (!attempts.length) {
    const option = element("option", "", "尚无执行记录");
    option.value = "";
    attemptSelect.append(option);
  }
  attemptSelect.value = state.runId ?? "";
  attemptSelect.disabled = attempts.length < 2;
  const latest = attempts.at(-1)?.id === state.runId;
  $("#attempt-note").textContent = attempts.length > 1 ? `此模型保留 ${attempts.length} 次尝试，当前查看第 ${attemptNumber(run)} 次${latest ? "（最新）" : ""}。之前的失败和中断记录均保留，可切换查看。` : attempts.length ? "当前模型仅记录了一次尝试。" : "当前模型尚无执行记录。";
  const target = $("#round-select");
  target.replaceChildren();
  state.dataset.task.rounds.forEach((round, index) => {
    const button = element("button", "round-button", `第 ${index + 1} 轮 · ${round.title}`);
    button.type = "button";
    button.setAttribute("aria-pressed", String(state.roundId === round.id));
    button.addEventListener("click", () => {
      state.roundId = round.id;
      state.messageId = null;
      state.showExample = false;
      renderView();
      $("#announcement").textContent = `已切换到第 ${index + 1} 轮，${round.title}。`;
    });
    target.append(button);
  });
  const messages = messagesInRound();
  if (!messages.some((event) => event.id === state.messageId)) state.messageId = messages.at(-1)?.id ?? null;
  const select = $("#message-select");
  select.replaceChildren();
  if (!messages.length) {
    const option = element("option", "", "这轮没有产生可对照的草稿");
    option.value = "";
    select.append(option);
  }
  messages.forEach((event, index) => {
    const review = event.review;
    const outcome = review.status !== "approved" ? "未展示" : review.original === review.final ? "原样通过" : "改写后通过";
    const option = element("option", "", `第 ${index + 1} 条 · ${outcome}`);
    option.value = event.id;
    select.append(option);
  });
  select.value = state.messageId ?? "";
  select.disabled = messages.length === 0;
  $("#message-caption").textContent = messages.length ? `本轮 ${messages.length} 条消息都有各自的原稿与审阅记录。` : "尚无文字原稿，不会把调用失败当成改写结果。";
}

const LIMIT_NAMES = { maxRevisions: "最多改写次数", reviewTimeoutMs: "单条消息审阅时限", requestTimeoutMs: "单次请求超时参数", roundTimeoutMs: "每轮执行时限", maxAgentCallsPerRound: "每轮主模型调用上限" };

function limitValue(key, value) {
  if (value === undefined) return "未记录";
  return key.endsWith("Ms") && Number.isFinite(value) ? duration(value) : formatJSON(value);
}

function reasoningLabel(reasoning) {
  if (reasoning === undefined) return "未记录";
  if (reasoning?.mode === "upstream-unspecified" && reasoning.effort === null) return "未指定上游推理强度";
  const labels = { low: "low（较低）", medium: "medium（中等）", high: "high（较高）" };
  return reasoning?.mode === "explicit" && Object.hasOwn(labels, reasoning.effort) ? labels[reasoning.effort] : "无法识别该记录";
}

function runDifferences(previous, current) {
  if (!previous || !current) return [];
  const differences = [];
  const previousReasoning = reasoningLabel(previous.reasoning);
  const currentReasoning = reasoningLabel(current.reasoning);
  if (previousReasoning !== currentReasoning) differences.push(`上游推理强度：前次 ${previousReasoning} → 本次 ${currentReasoning}`);
  const keys = new Set([...Object.keys(previous.limits ?? {}), ...Object.keys(current.limits ?? {})]);
  for (const key of keys) {
    const before = previous.limits?.[key];
    const after = current.limits?.[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) differences.push(`${LIMIT_NAMES[key] ?? key}：前次 ${limitValue(key, before)} → 本次 ${limitValue(key, after)}`);
  }
  for (const [label, before, after] of [["模型接口", previous.api, current.api], ["审阅提示词版本", previous.reviewPromptVersion, current.reviewPromptVersion], ["初始项目版本", previous.seedHash, current.seedHash], ["Humanize 实现", previous.source?.humanizeSha256, current.source?.humanizeSha256], ["执行脚本版本", previous.source?.runnerSha256, current.source?.runnerSha256], ["模型请求配置版本", previous.source?.modelOptionsSha256, current.source?.modelOptionsSha256], ["任务版本", previous.source?.taskSha256, current.source?.taskSha256], ["主模型系统提示词", previous.systemPrompt, current.systemPrompt]]) {
    if (before !== after) differences.push(`${label}：${before === undefined || after === undefined ? "两次记录的信息不完整，不能确认相同" : "与前次不同"}`);
  }
  return differences;
}

function renderRunSettings() {
  const target = $("#run-settings");
  target.replaceChildren();
  const run = currentRun();
  if (!run) return;
  const attempts = modelRuns();
  const index = attempts.findIndex((entry) => entry.id === run.id);
  const differences = runDifferences(attempts[index - 1], run);
  const detail = element("details", "run-settings");
  detail.append(element("summary", "", `这次尝试的限制与条件${differences.length ? ` · 与前次有 ${differences.length} 项差异` : ""}`));
  const content = element("div", "run-settings-body");
  content.append(element("p", "", `开始时间：${runDate(run.startedAt)}（北京时间）。每次尝试单独保留参数、工具记录和回复。`));
  const values = element("dl", "limit-list");
  for (const [key, value] of Object.entries(run.limits ?? {})) values.append(element("dt", "", LIMIT_NAMES[key] ?? key), element("dd", "", limitValue(key, value)));
  values.append(element("dt", "", "上游推理强度"), element("dd", "", reasoningLabel(run.reasoning)));
  content.append(values);
  if (Object.keys(run.limits ?? {}).length) content.append(element("p", "", "请求超时由接口实现，实际耗时可能超过配置；单条审核限额覆盖全部审核阶段。"));
  else content.append(element("p", "empty-note", "此记录没有单独保存运行限制。"));
  if (index > 0) {
    content.append(element("p", "conditions-label", `与第 ${index} 次尝试相比`));
    if (differences.length) {
      const list = element("ul", "condition-differences");
      for (const difference of differences) list.append(element("li", "", difference));
      content.append(list);
    } else content.append(element("p", "", "已记录的限制和版本信息没有变化。"));
  }
  content.append(rawDetail("本次完整运行参数与版本", { runId: run.id, startedAt: run.startedAt, api: run.api, limits: run.limits, reasoning: run.reasoning, reviewPromptVersion: run.reviewPromptVersion, seedHash: run.seedHash, source: run.source, systemPrompt: run.systemPrompt }));
  detail.append(content);
  target.append(detail);
}

function moveToRecord(target) {
  if (!target) return;
  if (target.tagName === "DETAILS") target.open = true;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
}

function renderResponseSummary() {
  const round = currentRound();
  const target = $("#response-summary");
  target.replaceChildren();
  if (!round) {
    target.append(element("p", "", "这轮尚未执行，没有模型响应或工具记录。"));
    return;
  }
  const counts = responseCounts(round);
  const summary = counts.recorded ? `本轮共 ${counts.total} 次主模型${counts.other ? "调用记录" : "响应"}：${counts.withText} 条含文字，${counts.toolsOnly} 次仅工具调用。${counts.other ? `另有 ${counts.other} 次没有形成文字或工具返回。` : ""}` : `本轮已记录 ${messagesInRound(round).length} 条文字草稿；原始模型响应次数未记录。`;
  target.append(element("p", "response-counts", summary), element("p", "", `完整生成的文字消息才进入回复审核。本轮实际执行 ${counts.tools} 次工具操作；一次模型响应可以发出多个工具调用。`));
  if (counts.incomplete) target.append(element("p", "main-incomplete-count", `其中 ${counts.incomplete} 次主模型调用未完成，未进入审核，也未发送给用户。含文字的统计可能包含截断片段。`));
  const links = element("div", "record-links");
  if (counts.total) {
    const raw = element("a", "", `查看全部 ${counts.total} 次模型返回`);
    raw.href = "#main-responses";
    raw.addEventListener("click", (event) => { event.preventDefault(); moveToRecord($("#main-responses")); });
    links.append(raw);
  }
  if (round.events?.length) {
    const trace = element("a", "", `查看完整工具与消息轨迹`);
    trace.href = "#trace-content";
    trace.addEventListener("click", (event) => { event.preventDefault(); moveToRecord($("#trace-content")); });
    links.append(trace);
  }
  target.append(links);
}

function renderAcceptance(round) {
  const result = round.acceptance;
  const detail = element("details", "acceptance-detail");
  const initial = round.initialAcceptance;
  detail.append(element("summary", "", `逐项查看业务验收 · ${result.passedCount} / ${result.total} 项通过`));
  if (initial?.total) detail.append(element("p", "initial-result", `开始本轮前：${initial.passedCount} / ${initial.total} 项通过。下面是本轮结束后的实际结果。`));
  const list = element("ul", "check-list");
  for (const check of result.checks ?? []) {
    const verifierError = check.id === "verifier-error";
    const item = element("li", check.passed ? "check pass" : verifierError ? "check" : "check fail");
    const label = element("div", "check-heading");
    label.append(badge(check.passed ? "符合" : verifierError ? "未能验收" : "待修复", check.passed ? "pass" : verifierError ? "neutral" : "fail"), element("strong", "", check.label ?? check.id));
    item.append(label);
    if (check.detail) item.append(element("p", "check-description", check.detail));
    if (check.expected !== undefined || check.actual !== undefined) {
      const values = element("dl", "check-values");
      if (check.expected !== undefined) values.append(element("dt", "", "要求"), element("dd", "", formatJSON(check.expected)));
      if (check.actual !== undefined) values.append(element("dt", "", "实际"), element("dd", "", formatJSON(check.actual)));
      item.append(values);
    }
    list.append(item);
  }
  detail.append(list);
  if (result.summary !== undefined && result.summary !== null) detail.append(rawDetail("程序输出的业务汇总", result.summary));
  return detail;
}

function renderDelivery(after) {
  const event = currentMessage();
  const review = event?.review;
  const approved = review?.status === "approved";
  const changed = approved && review.original !== review.final;
  const panel = element("article", `delivery ${after ? "enabled" : "disabled"}`);
  const heading = element("header", "delivery-heading");
  const title = element("div");
  title.append(element("p", "delivery-kicker", after ? "这条原稿经过 Humanize 后" : "进入 Humanize 之前"), element("h3", "", after ? "实际发给用户的回复" : "模型原稿"));
  const status = after ? !review ? "尚无结果" : approved ? changed ? "改写后通过" : "原样通过" : "没有展示" : review ? "准备发送的草稿" : "尚未生成";
  heading.append(title, badge(status, after && review ? approved ? "review" : "fail" : "neutral"));
  panel.append(heading);
  const response = element("section", "visible-response");
  if (review) {
    if (after && !approved) {
      response.append(element("p", "response-empty", "这条草稿没有获准展示。这里没有最终回答，也不会把最后一个未通过的改写版本当作结果。"));
      if (review.diagnostic?.source === "offline-replay") response.append(element("p", "diagnostic-summary", `${review.diagnostic.title}。具体原因见下方本地复现诊断。`));
      else {
        const interruption = reviewInterruption(review);
        if (interruption) response.append(element("p", "diagnostic-summary", `${interruption.title}。${interruption.detail}`));
      }
    }
    else {
      const text = after ? review.final : review.original;
      const content = renderMessage(text);
      response.append(content);
      if (text.length > 900 || text.split("\n").length > 22) {
        content.id = after ? "final-message-content" : "original-message-content";
        content.classList.add("response-preview", "is-collapsed");
        for (const table of content.querySelectorAll(".message-table-scroll")) table.tabIndex = -1;
        const toggle = element("button", "expand-response", `展开完整${after ? "回复" : "原稿"}（${text.length.toLocaleString("zh-CN")} 字符）`);
        toggle.type = "button";
        toggle.setAttribute("aria-controls", content.id);
        toggle.setAttribute("aria-expanded", "false");
        toggle.addEventListener("click", () => {
          const expanded = toggle.getAttribute("aria-expanded") !== "true";
          toggle.setAttribute("aria-expanded", String(expanded));
          content.classList.toggle("is-collapsed", !expanded);
          for (const table of content.querySelectorAll(".message-table-scroll")) table.tabIndex = expanded ? 0 : -1;
          toggle.textContent = expanded ? "收起全文，只看开头" : `展开完整${after ? "回复" : "原稿"}（${text.length.toLocaleString("zh-CN")} 字符）`;
        });
        response.append(toggle);
      }
      response.append(rawDetail("查看逐字原文（含排版符号）", text));
    }
  } else {
    response.append(element("p", "response-empty", currentRound()?.status === "running" ? "模型仍在执行任务，尚未产生可对照的文字回复。下方可以查看已经完成的工具操作。" : "这轮没有记录到可对照的文字草稿。下方工作记录保留了已经执行的步骤和停止原因。"));
  }
  panel.append(response);
  const note = after ? !review ? "尚未形成消息对照" : approved ? changed ? "新的独立读者审阅了改写后的版本，随后才允许展示。" : "读者认为原稿已经清楚，没有为了改写而改写。" : "展开下方审阅记录，查看是哪一步没有放行。" : "保留主模型实际生成的文字，没有另跑一次生成作为参照。";
  panel.append(element("p", "delivery-footnote", note));
  return panel;
}

function renderWorkOutcome() {
  const round = currentRound();
  const run = currentRun();
  const target = $("#task-outcome");
  target.replaceChildren();
  const overview = element("div", "work-outcome");
  const heading = element("div", "work-outcome-heading");
  const status = acceptanceStatus(round);
  heading.append(element("h3", "", "这轮程序通过了哪些检查"), badge(status.text, status.kind));
  overview.append(heading, element("p", "outcome-context", "只覆盖预设的自动检查，不代表所有交付要求或回复质量都已合格。"));
  if (round?.acceptance?.total) overview.append(renderAcceptance(round));
  else overview.append(element("p", "outcome-context", round?.status === "running" ? "这轮仍在执行。结束后将展示最终业务验收结果。" : "这轮没有产生最终业务验收结果。"));
  const incomplete = mainResponseFailures(round);
  if (incomplete.length) overview.append(element("p", "outcome-context main-incomplete-count", `本轮主模型有 ${incomplete.length} 次未完成调用；这些返回没有进入表达审核，也没有发送给用户。`));
  const error = round?.error ?? (!round ? run?.error : null);
  if (error || incomplete.length || (round && ["interrupted", "error"].includes(round.status))) {
    const warning = element("div", "stop-note");
    const stoppedMessage = [...(round?.events ?? [])].reverse().find((event) => event.type === "assistant" && event.isError);
    const mainFailure = incomplete.find((entry) => entry.event.id === stoppedMessage?.id);
    const failedReview = stoppedMessage?.review?.status === "failed" ? stoppedMessage.review : null;
    const diagnostic = failedReview?.diagnostic?.source === "offline-replay" ? failedReview.diagnostic : null;
    const interruption = reviewInterruption(failedReview);
    warning.append(element("strong", "", mainFailure?.title ?? diagnostic?.title ?? interruption?.title ?? "这轮没有走到正常结束"), element("p", "", mainFailure?.detail ?? diagnostic?.detail ?? interruption?.detail ?? errorExplanation(error)));
    if (diagnostic) warning.append(element("p", "", "以上为已保存响应的本地重放诊断；原始运行错误仍保留在下方。"));
    if (interruption?.error) warning.append(rawDetail("调用返回的原始错误", interruption.error));
    if (error) warning.append(rawDetail("查看具体错误", error));
    overview.append(warning);
  }
  const expression = reviewStatus(round, true);
  overview.append(element("p", "outcome-context", `本轮表达检查：${expression.text}。${expression.detail}`));
  target.append(overview);
}

function renderReaderContext() {
  const review = currentMessage()?.review;
  const visible = review?.phases?.find((phase) => phase.phase === "review")?.request?.visibleMessages;
  const target = $("#reader-context");
  target.replaceChildren();
  if (!Array.isArray(visible)) return;
  const detail = element("details", "reader-context");
  detail.append(element("summary", "", `审阅时用户看得到的对话 · ${visible.length} 条`));
  const list = element("ol", "visible-conversation");
  for (const message of visible) {
    const item = element("li");
    item.append(element("span", "conversation-role", message.role === "user" ? "用户输入" : "此前已展示的回复"), element("p", "prompt-text", message.text));
    list.append(item);
  }
  detail.append(list);
  target.append(detail);
}

function parseResponse(phase) {
  if (typeof phase.response !== "string") return null;
  try {
    const raw = phase.response.trim();
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(raw);
    return JSON.parse(fenced ? fenced[1] : raw);
  } catch {
    return null;
  }
}

function validReviewDecision(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 3 && typeof value.clear === "boolean" &&
    typeof value.needsContext === "boolean" && Array.isArray(value.issues) && value.issues.length <= 16 &&
    value.issues.every((issue) => typeof issue === "string" && issue.trim().length > 0 && issue.length <= 2000) &&
    (value.clear ? !value.needsContext && value.issues.length === 0 : value.issues.length > 0);
}

function validLookup(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 && Array.isArray(value.facts) && value.facts.length <= 32 &&
    value.facts.every((fact) => typeof fact === "string" && fact.trim().length > 0 && fact.length <= 4000);
}

function validRewrite(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 && typeof value.text === "string" && value.text.trim().length > 0;
}

function phaseDescription(phase, parsed, blockedByProtection = false) {
  if (phase.error || phase.stopReason !== "stop") return "调用未完整结束，不能据此放行";
  if (phase.phase === "review") {
    if (!validReviewDecision(parsed)) return "返回的决定不符合格式要求";
    return parsed.clear ? "读者认为可以理解" : parsed.needsContext ? "读者需要查证背景" : "读者提出表达问题";
  }
  if (phase.phase === "lookup") return validLookup(parsed) ? "返回查证说明，供改写参考" : "查证返回格式无效";
  if (phase.phase === "rewrite") return validRewrite(parsed) ? blockedByProtection ? "候选稿被内容保护拦截，未进入复审" : "返回候选版本，仍需重新审阅" : "改写返回格式无效";
  return "实际模型调用";
}

function renderReview(review, includePair = true) {
  const detail = element("details", "message-review");
  detail.open = !includePair;
  const approved = review.status === "approved";
  const changed = approved && review.original !== review.final;
  detail.append(element("summary", "", approved ? changed ? "这条消息改了什么 · 查看原稿、改写与审阅" : "这条消息原样通过 · 查看读者如何审阅" : "这条草稿为何没展示 · 查看审阅与停止位置"));
  const body = element("div", "message-review-body");
  body.append(element("p", "scope-note", "这里比较的是同一条消息。独立读者初次审阅看不到执行记录；只有查证步骤能读取工具返回。"));
  const pair = element("div", "draft-pair");
  for (const [label, text] of [["主模型原始草稿", review.original], [approved ? "批准展示的版本" : "没有获准展示", approved ? review.final : "审阅没有给出有效批准，草稿被拦住。"]]) {
    const item = element("section");
    item.append(element("h4", "", label), element("div", "draft-text", text ?? "未记录"));
    pair.append(item);
  }
  if (includePair) body.append(pair);
  const phases = review.phases ?? [];
  const diagnostic = review.diagnostic?.source === "offline-replay" ? review.diagnostic : null;
  if (diagnostic) {
    const note = element("aside", "review-diagnostic");
    note.append(element("p", "diagnostic-source", "本地复现诊断 · 与原始运行记录分开标注"), element("strong", "", diagnostic.title), element("p", "", diagnostic.detail));
    note.append(rawDetail("查看复现依据", { diagnostic, protectionFailure: review.protectionFailure }));
    body.append(note);
  }
  const list = element("ol", "review-phases");
  phases.forEach((phase, index) => {
    const parsed = parseResponse(phase);
    const item = element("li");
    const phaseDetail = element("details", "review-phase");
    phaseDetail.open = !includePair && index === 0;
    const summary = element("summary");
    const blockedByProtection = diagnostic?.kind === "protected-content" && index === (diagnostic.phaseIndex ?? phases.findLastIndex((entry) => entry.phase === "rewrite"));
    summary.append(element("span", "phase-order", index + 1), element("strong", "", PHASE_NAMES[phase.phase] ?? phase.phase), element("span", "phase-outcome", phaseDescription(phase, parsed, blockedByProtection)), element("span", "phase-duration", duration(phase.durationMs)));
    phaseDetail.append(summary);
    const content = element("div", "review-phase-body");
    if (phase.error || phase.stopReason !== "stop") {
      content.append(element("p", "draft-text", phase.error ? formatJSON(phase.error) : `调用没有完整结束，不能据此放行。\n\n${phase.response || "没有返回可显示的文字。"}`));
    } else if (phase.phase === "review" && validReviewDecision(parsed)) {
      if (parsed.clear) content.append(element("p", "", "这次读者没有提出理解问题。"));
      else {
        const issues = element("ul", "reader-issues");
        for (const issue of parsed.issues) issues.append(element("li", "", issue));
        content.append(issues);
      }
    } else if (phase.phase === "lookup" && validLookup(parsed)) {
      const facts = element("ul", "reader-issues");
      for (const fact of parsed.facts) facts.append(element("li", "", fact));
      content.append(facts);
    } else if (phase.phase === "rewrite" && validRewrite(parsed)) content.append(element("p", "draft-text", parsed.text));
    else content.append(element("p", "draft-text", phase.error ? formatJSON(phase.error) : phase.response || "没有返回可显示的文字。"));
    const scopes = { review: "输入范围：已展示的对话与当前草稿。没有执行记录，也不携带上轮查证结果。", lookup: "输入范围：读者的问题与截至此时的执行记录。", rewrite: "输入范围：已展示的对话、草稿、读者问题与本轮查证说明。" };
    content.append(element("p", "scope-note", scopes[phase.phase] ?? "本次调用保留实际请求与返回。"));
    for (const [label, value] of [["实际请求", phase.request], ["原始返回", phase.response], ["系统提示词", phase.systemPrompt], ["接口用量", phase.usage]]) {
      if (value !== undefined) content.append(rawDetail(label, value));
    }
    phaseDetail.append(content);
    item.append(phaseDetail);
    list.append(item);
  });
  body.append(list);
  if (!phases.length) body.append(element("p", "empty-note", "没有记录到审阅调用。"));
  if (review.report !== undefined) body.append(rawDetail("本条审阅的运行统计", review.report));
  detail.append(body);
  return detail;
}

function eventTitle(event) {
  if (event.type === "user") return "用户提出需求";
  if (event.type === "assistant") return event.review?.status === "failed" ? "一条回复被拦下" : event.isError ? "主模型调用未完成" : "向用户展示回复";
  if (event.name === "run_project") return { tests: "运行回归测试", report: "生成本轮报表", acceptance: "独立业务验收" }[event.arguments?.action] ?? "运行项目检查";
  const names = { read: "读取文件", read_file: "读取文件", write: "修改文件", write_file: "修改文件", edit: "编辑文件", list: "查看项目文件", list_files: "查看项目文件", test: "运行测试", run: "执行项目命令", run_command: "执行项目命令", run_project: "运行项目检查" };
  return names[event.name] ?? event.name ?? (event.type === "test" ? "运行测试" : "工具操作");
}

function eventTarget(event) {
  const args = event.arguments;
  if (!args || typeof args !== "object") return "";
  if (event.name === "run_project") return "";
  const value = args.path ?? args.command ?? args.file ?? args.mode ?? "";
  return typeof value === "string" ? value : "";
}

function renderTrace() {
  const round = currentRound();
  const target = $("#trace-content");
  target.replaceChildren();
  $("#record-caption").textContent = round ? round.status === "running" ? "正在执行 · 记录尚未结束" : `${executionStatus(round)} · ${duration(round.durationMs)}` : "本轮没有工作记录";
  if (!round?.events?.length) {
    target.append(element("p", "empty-state", "这轮尚无工具或消息记录。若前一轮提前停止，可回到上一轮查看原因。"));
    return;
  }
  const list = element("ol", "event-list");
  const incomplete = mainResponseFailures(round);
  round.events.forEach((event, index) => {
    const item = element("li", `event ${event.type}`);
    const number = element("span", "event-number", String(index + 1).padStart(2, "0"));
    number.setAttribute("aria-hidden", "true");
    item.append(number);
    if (event.type === "assistant") {
      const failure = incomplete.find((entry) => entry.event.id === event.id);
      const message = element("article", `event-message${failure ? " event-incomplete" : ""}`);
      const heading = element("div", "event-message-heading");
      heading.append(element("h3", "", failure?.title ?? eventTitle(event)));
      if (failure) heading.append(badge("未发送 · 未进入审核"));
      if (event.review) heading.append(badge(event.review.status === "approved" ? event.review.original === event.review.final ? "原样展示" : "改写后展示" : "没有展示", event.review.status === "approved" ? "review" : "fail"));
      message.append(heading);
      if (event.review) {
        const jump = element("button", "jump-message", "在上方对照这条回复");
        jump.type = "button";
        jump.addEventListener("click", () => {
          state.messageId = event.id;
          state.showExample = false;
          renderView();
          $("#comparison").focus({ preventScroll: true });
          $("#comparison").scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
        });
        heading.append(jump);
      }
      if (failure) {
        message.append(element("p", "incomplete-response-note", failure.detail));
        const original = failure.response?.text;
        if (original?.trim()) message.append(rawDetail(`未发送的${failure.response.stopReason === "length" ? "截断原文" : "不完整返回"} · ${original.length.toLocaleString("zh-CN")} 字符`, original, original.length <= 700));
        else message.append(element("p", "empty-note", "没有保存可显示的主模型原文。"));
        if (failure.response) message.append(rawDetail("这次主模型调用的原始记录", failure.response));
        if (event.result !== undefined) message.append(rawDetail("执行器保存的原始错误", event.result));
      } else if (event.text?.trim() && event.text.length > 700) {
        const fullReply = element("details", "trace-reply");
        fullReply.append(element("summary", "", `查看实际发送的完整回复（${event.text.length.toLocaleString("zh-CN")} 字符）`), renderMessage(event.text));
        message.append(fullReply);
      } else message.append(element("p", "message-text", event.text?.trim() ? event.text : event.review ? "这条消息没有放行给用户；原稿和审阅过程保留在下面。" : "主模型没有完成这条回复，尚未形成可审阅的草稿。"));
      if (event.review) message.append(renderReview(event.review));
      item.append(message);
    } else {
      const detail = element("details", "event-detail");
      const summary = element("summary");
      const heading = element("span", "event-tool-label");
      heading.append(element("strong", "", eventTitle(event)));
      const targetText = eventTarget(event);
      if (targetText) heading.append(element("span", "event-target", targetText));
      summary.append(heading);
      if (event.isError) summary.append(badge("操作返回错误", "fail"));
      if (event.durationMs !== undefined) summary.append(element("span", "event-duration", duration(event.durationMs)));
      detail.append(summary);
      const content = element("div", "event-detail-body");
      if (event.type === "user") content.append(element("p", "prompt-text", event.text ?? "未记录输入"));
      else {
        if (event.arguments !== undefined) content.append(element("p", "raw-label", "实际传入参数"), element("pre", "", formatJSON(event.arguments)));
        if (event.result !== undefined) content.append(element("p", "raw-label", "实际工具返回"), element("pre", "", formatJSON(event.result)));
        if (event.text) content.append(element("p", "message-text", event.text));
      }
      detail.append(content);
      item.append(detail);
    }
    list.append(item);
  });
  target.append(list);
  if (round.rawResponses?.length) {
    const responses = rawDetail(`主模型全部原始返回 · ${round.rawResponses.length} 次（包含纯工具调用）`, round.rawResponses);
    responses.id = "main-responses";
    responses.tabIndex = -1;
    target.append(responses);
  }
}

function renderFiles() {
  const round = currentRound();
  const files = round?.files ?? [];
  const target = $("#file-changes");
  target.replaceChildren();
  const detail = element("details", "files-detail");
  detail.append(element("summary", "", round?.status === "running" ? "文件快照 · 本轮结束后可查看" : `实际文件变化 · ${files.length} 个文件`));
  const body = element("div", "files-body");
  if (!files.length) body.append(element("p", "empty-note", round?.status === "running" ? "模型正在修改的文件尚未生成本轮结束快照，实际写入操作可在上方工具记录中查看。" : "本轮没有记录到文件变化。"));
  for (const file of files) {
    const item = element("details", "file-detail");
    item.append(element("summary", "file-path", file.path));
    if (file.diff) item.append(element("pre", "file-diff", file.diff));
    const pair = element("div", "file-pair");
    for (const [label, content] of [["本轮开始前", file.before], ["本轮结束后", file.after]]) {
      const section = element("section");
      section.append(element("h4", "", label), element("pre", "", content ?? "该文件不存在"));
      pair.append(section);
    }
    item.append(pair);
    body.append(item);
  }
  detail.append(body);
  target.append(detail);
}

function renderAllRuns() {
  const { models, runs, task } = state.dataset;
  const enabledRuns = runs.filter((run) => run.enabled);
  $("#run-count").textContent = `${models.length} 个模型 · ${enabledRuns.length} 次尝试 · ${enabledRuns.reduce((total, run) => total + run.rounds.length, 0)} 轮实际记录`;
  const table = element("table", "runs-table");
  const caption = element("caption", "sr-only", "每个模型的每次尝试单独列出，旧失败记录不会被后续尝试替代");
  const head = element("thead");
  const row = element("tr");
  for (const title of ["执行模型", "执行尝试", ...task.rounds.map((_, index) => `第 ${index + 1} 轮业务验收`), "表达检查", "主模型未完成", "执行状态"]) {
    const th = element("th", "", title);
    th.scope = "col";
    row.append(th);
  }
  head.append(row);
  const body = element("tbody");
  for (const model of models) {
    const attempts = modelRuns(model.id);
    for (const run of attempts.length ? attempts.toReversed() : [null]) {
      const item = element("tr");
      const name = element("th", "model-cell", model.name ?? model.id);
      name.scope = "row";
      item.append(name);
      const attempt = element("td", "attempt-cell");
      if (run) attempt.append(element("strong", "", `第 ${attemptNumber(run)} 次${attempts.length > 1 && attempts.at(-1)?.id === run.id ? " · 最新" : ""}`), element("span", "", runDate(run.startedAt)));
      else attempt.textContent = "尚无执行记录";
      item.append(attempt);
      for (const taskRound of task.rounds) {
        const round = run?.rounds.find((entry) => entry.id === taskRound.id);
        const result = acceptanceStatus(round);
        const cell = element("td");
        const button = element("button", `table-result ${result.kind}`, round?.acceptance?.total ? `${round.acceptance.passedCount}/${round.acceptance.total} · ${result.text}` : "未执行验收");
        button.type = "button";
        button.disabled = !run;
        button.setAttribute("aria-label", `${model.name ?? model.id}，${run ? `第 ${attemptNumber(run)} 次尝试，` : ""}${taskRound.title}，${result.text}，打开记录`);
        button.addEventListener("click", () => {
          state.modelId = model.id;
          state.runId = run.id;
          state.roundId = taskRound.id;
          state.messageId = null;
          state.showExample = false;
          renderView();
          moveToRecord($("#comparison"));
        });
        cell.append(button);
        item.append(cell);
      }
      const reviews = (run?.rounds ?? []).flatMap((round) => round.events.filter((event) => event.review).map((event) => event.review));
      const blocked = reviews.filter((review) => review.status === "failed").length;
      const approved = reviews.filter((review) => review.status === "approved").length;
      const expression = reviews.length ? `${approved} 条放行${blocked ? ` / ${blocked} 条拦截` : ""}` : "尚无文字审阅";
      item.append(element("td", blocked ? "table-blocked" : "", expression));
      const incomplete = (run?.rounds ?? []).reduce((total, round) => total + responseCounts(round).incomplete, 0);
      item.append(element("td", incomplete ? "table-main-incomplete" : "table-state", run ? incomplete ? `${incomplete} 次 · 未进入审核` : "0 次" : "未记录"));
      item.append(element("td", "table-state", run ? runState(run) : "没有记录"));
      body.append(item);
    }
  }
  table.append(caption, head, body);
  $("#run-table").replaceChildren(table);
}

function renderMethodology() {
  const method = state.dataset.methodology ?? {};
  const limits = $("#method-limits");
  limits.replaceChildren();
  for (const text of method.limitations ?? []) limits.append(element("li", "", text));
  $("#method-raw").replaceChildren(element("pre", "", formatJSON(method)));
}

function renderView() {
  renderControls();
  renderRunSettings();
  renderResponseSummary();
  renderReaderContext();
  $("#delivery-grid").replaceChildren(renderDelivery(false), renderDelivery(true));
  $("#selected-review").replaceChildren();
  const review = currentMessage()?.review;
  if (review) $("#selected-review").append(renderReview(review, false));
  renderWorkOutcome();
  renderTrace();
  renderFiles();
  updateQuery();
}

$("#model-select").addEventListener("change", (event) => {
  state.modelId = event.target.value;
  state.runId = modelRuns().at(-1)?.id ?? null;
  state.messageId = null;
  state.showExample = false;
  renderView();
  $("#announcement").textContent = `已切换到 ${state.modelId} 的完整执行记录。`;
});
$("#attempt-select").addEventListener("change", (event) => {
  state.runId = event.target.value;
  state.messageId = null;
  state.showExample = false;
  renderView();
  $("#announcement").textContent = `已切换到 ${state.modelId} 的第 ${attemptNumber(currentRun())} 次尝试。`;
});
$("#message-select").addEventListener("change", (event) => {
  state.messageId = event.target.value;
  state.showExample = false;
  renderView();
  $("#announcement").textContent = "已打开这条消息一一对应的原稿和审阅结果。";
});
$("#share-view").addEventListener("click", async () => {
  clearTimeout(shareResetTimer);
  updateQuery();
  const url = new URL(location.href);
  url.hash = "comparison";
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url.href);
    $("#share-view").textContent = "链接已复制";
    $("#announcement").textContent = "当前模型、执行尝试、轮次和这条消息的链接已复制。";
  } catch {
    $("#share-view").textContent = "请复制地址栏链接";
    $("#announcement").textContent = "浏览器未允许复制。地址栏已经是当前视图的链接，可手动复制。";
  }
  shareResetTimer = setTimeout(() => { $("#share-view").textContent = "复制当前链接"; }, 3000);
});
window.addEventListener("popstate", () => {
  if (!state.dataset) return;
  restoreQuery();
  renderView();
});

try {
  const response = await fetch(DATA_URL, { cache: "no-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const dataset = await response.json();
  if (dataset.schemaVersion !== 1 || dataset.kind !== "full-task" || !Array.isArray(dataset.task?.rounds) || !Array.isArray(dataset.models) || !Array.isArray(dataset.runs)) throw new Error("数据结构不完整或版本不兼容");
  state.dataset = dataset;
  restoreQuery();
  renderBrief();
  renderView();
  renderAllRuns();
  renderMethodology();
  $("#load-state").hidden = true;
  $("#app").hidden = false;
  if (location.hash === "#comparison") $("#comparison").scrollIntoView({ behavior: "instant", block: "start" });
} catch (error) {
  const target = $("#load-state");
  target.className = "load-state error";
  target.replaceChildren(element("strong", "", "完整工作记录暂时未能加载"), element("p", "", "数据可能仍在生成，或请求没有完成。页面不会用演示内容代替真实结果。请稍后重新加载；历史实验仍可查看。"), element("p", "error-code", error instanceof Error ? error.message : String(error)));
  const actions = element("div", "error-actions");
  const retry = element("button", "secondary-button", "重新加载");
  retry.type = "button";
  retry.addEventListener("click", () => location.reload());
  const archive = element("a", "", "查看历史实验");
  archive.href = "./archive.html";
  actions.append(retry, archive);
  target.append(actions);
}
