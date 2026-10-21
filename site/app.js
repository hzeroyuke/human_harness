const $ = (selector) => document.querySelector(selector);
const DATA_URL = new URL("./data/benchmark.json", import.meta.url);
const PHASE_NAMES = { generation: "生成原始回复", review: "独立盲审", lookup: "查证背景", rewrite: "改写回复" };
const STATUS_NAMES = { changed: "改写后通过", unchanged: "原样通过", failed: "未通过", unavailable: "调用不可用", pending: "执行中" };
const SHORT_STATUS_NAMES = { changed: "已改写", unchanged: "原样", failed: "未通过", unavailable: "不可用", pending: "执行中" };
const STATUS_SYMBOLS = { changed: "↻", unchanged: "✓", failed: "×", unavailable: "—", pending: "…" };
const state = { dataset: null, mode: "fixed", model: "all", task: "all", status: "all", runId: null };
let shareResetTimer;

function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = String(text);
  return result;
}

function statusKey(run) {
  if (run.state === "running") return "pending";
  if (run.status === "approved") return run.after === run.before ? "unchanged" : "changed";
  return run.status === "unavailable" ? "unavailable" : "failed";
}

function formatDuration(duration) {
  if (!Number.isFinite(duration)) return "—";
  return duration < 1000 ? `${Math.round(duration)} ms` : `${(duration / 1000).toFixed(1)} s`;
}

function formatJSON(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "未记录";
}

function parseResponse(phase) {
  if (phase.parsed && typeof phase.parsed === "object") return phase.parsed;
  if (typeof phase.response !== "string") return null;
  try {
    const raw = phase.response.trim();
    const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(raw);
    return JSON.parse(fence ? fence[1] : raw);
  } catch {
    return null;
  }
}

function stringList(value, maxItems, maxChars) {
  return Array.isArray(value) && value.length <= maxItems &&
    value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= maxChars);
}

function validReviewDecision(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 3 && typeof value.clear === "boolean" &&
    typeof value.needsContext === "boolean" && stringList(value.issues, 16, 2000) &&
    (value.clear ? !value.needsContext && value.issues.length === 0 : value.issues.length > 0);
}

function validRewrite(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 && typeof value.text === "string" && value.text.trim().length > 0;
}

function taskList() {
  const tasks = state.dataset.tasks;
  if (state.mode === "fixed") return tasks;
  const ids = state.dataset.methodology?.generatedTaskIds;
  return tasks.filter((task) => Array.isArray(ids) ? ids.includes(task.id) : task.generated);
}

function modelList() {
  return state.dataset.models.filter((model) => model.type !== "embeddings" && !model.excludedReason);
}

function matchesFilters(run) {
  return run.mode === state.mode &&
    (state.model === "all" || run.modelId === state.model) &&
    (state.task === "all" || run.taskId === state.task) &&
    (state.status === "all" || statusKey(run) === state.status);
}

function updateQuery(hash = location.hash) {
  const query = new URLSearchParams();
  if (state.runId) query.set("run", state.runId);
  if (state.mode !== "fixed") query.set("mode", state.mode);
  if (state.model !== "all") query.set("model", state.model);
  if (state.task !== "all") query.set("task", state.task);
  if (state.status !== "all") query.set("status", state.status);
  const url = new URL(location.href);
  url.search = query.toString();
  url.hash = hash;
  history.replaceState(null, "", url);
}

function populateSelect(select, entries, current) {
  const first = select.options[0].cloneNode(true);
  select.replaceChildren(first);
  for (const entry of entries) {
    const option = element("option", "", entry.label);
    option.value = entry.id;
    select.append(option);
  }
  select.value = entries.some((entry) => entry.id === current) ? current : "all";
}

function restoreQuery() {
  const query = new URLSearchParams(location.search);
  const requested = state.dataset.runs.find((run) => run.id === query.get("run"));
  state.mode = requested?.mode ?? (query.get("mode") === "generated" ? "generated" : "fixed");
  state.model = modelList().some((model) => model.id === query.get("model")) ? query.get("model") : "all";
  state.task = taskList().some((task) => task.id === query.get("task")) ? query.get("task") : "all";
  state.status = Object.hasOwn(STATUS_NAMES, query.get("status") ?? "") ? query.get("status") : "all";
  state.runId = requested?.id ?? null;
}

function renderFilters() {
  for (const radio of document.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === state.mode;
  populateSelect($("#model-filter"), modelList().map((model) => ({ id: model.id, label: model.name ?? model.id })), state.model);
  populateSelect($("#task-filter"), taskList().map((task) => ({ id: task.id, label: task.title ?? task.id })), state.task);
  $("#status-filter").value = state.status;
  $("#mode-description").textContent = state.mode === "fixed"
    ? "每个读者模型收到相同的固定草稿。适合观察：遇到同一种表达问题，它会不会查证、怎样改写。"
    : "主模型先根据测试场景生成草稿，再由同一型号的独立读者审阅。只覆盖下表列出的生成任务。";
}

function renderMatrix() {
  const models = modelList().filter((model) => state.model === "all" || model.id === state.model);
  const tasks = taskList().filter((task) => state.task === "all" || task.id === state.task);
  const matching = state.dataset.runs.filter(matchesFilters);
  const available = new Map(state.dataset.runs.filter((run) => run.mode === state.mode).map((run) => [`${run.modelId}/${run.taskId}`, run]));
  const header = element("tr");
  const corner = element("th", "", "读者模型 / 任务");
  corner.scope = "col";
  header.append(corner);
  for (const task of tasks) {
    const th = element("th", "", task.title ?? task.id);
    th.scope = "col";
    th.title = task.description ?? task.title ?? task.id;
    header.append(th);
  }
  $("#matrix thead").replaceChildren(header);
  const body = document.createDocumentFragment();
  for (const model of models) {
    const row = element("tr");
    const label = element("th", "", model.id);
    label.scope = "row";
    label.title = `${model.name ?? model.id}${model.vendor ? ` · ${model.vendor}` : ""}`;
    row.append(label);
    for (const task of tasks) {
      const td = element("td");
      const run = available.get(`${model.id}/${task.id}`);
      if (!run) {
        td.append(element("span", "pending-cell", state.dataset.methodology?.complete ? "未记录" : "待记录"));
      } else if (!matchesFilters(run)) {
        const filtered = element("span", "filtered-cell", "已筛除");
        filtered.title = STATUS_NAMES[statusKey(run)];
        td.append(filtered);
      } else {
        const kind = statusKey(run);
        const button = element("button", `matrix-cell ${kind}`);
        button.type = "button";
        button.dataset.runId = run.id;
        button.setAttribute("aria-pressed", String(run.id === state.runId));
        button.setAttribute("aria-label", `${model.name ?? model.id}，${task.title ?? task.id}，${STATUS_NAMES[kind]}，${formatDuration(run.durationMs)}`);
        button.title = `${STATUS_NAMES[kind]} · ${formatDuration(run.durationMs)}${run.report ? ` · ${run.report.revisions} 次改写` : ""}`;
        const symbol = element("span", "cell-symbol", STATUS_SYMBOLS[kind]);
        symbol.setAttribute("aria-hidden", "true");
        button.append(symbol, element("span", "", SHORT_STATUS_NAMES[kind]));
        button.addEventListener("click", () => selectRun(run.id, true));
        td.append(button);
      }
      row.append(td);
    }
    body.append(row);
  }
  $("#matrix tbody").replaceChildren(body);
  $("#matrix-empty").hidden = matching.length > 0 || state.dataset.runs.length === 0;
  $("#visible-count").textContent = `${matching.length} 条匹配记录`;
  return matching;
}

function renderCoverage() {
  const dataset = state.dataset;
  const coverage = $("#coverage");
  coverage.replaceChildren(
    element("strong", "", modelList().length), document.createTextNode(" 个文本模型 · "),
    element("strong", "", dataset.tasks.length), document.createTextNode(" 类任务 · "),
    element("strong", "", dataset.runs.length), document.createTextNode(` / ${dataset.methodology?.expectedRuns ?? dataset.runs.length} 条记录`),
  );
  if (!dataset.methodology?.complete) coverage.append(document.createElement("br"), document.createTextNode("这批记录尚未全部完成"));
  const stamp = new Date(dataset.generatedAt);
  $("#data-date").textContent = Number.isNaN(stamp.valueOf()) ? "轨迹数据按实验批次更新" : `数据更新于 ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(stamp)} · 北京时间`;
}

function renderInput(run, task) {
  const target = $("#visible-input");
  target.replaceChildren();
  const input = Array.isArray(run.input) ? run.input : task?.input ?? [];
  if (!input.length) target.append(element("p", "", "未记录可见输入"));
  for (const message of input) {
    const wrapper = element("div");
    if (input.length > 1) wrapper.append(element("span", "input-role", message.role === "assistant" ? "此前助手回复" : "用户输入"));
    wrapper.append(element("p", "", message.text ?? message.content ?? ""));
    target.append(wrapper);
  }
}

function renderMetrics(run) {
  const metrics = $("#run-metrics");
  const duration = Number.isFinite(run.durationMs) ? (run.durationMs / 1000).toFixed(1) : "—";
  const calls = run.report?.calls ?? run.phases?.filter((phase) => phase.phase !== "generation").length ?? 0;
  const tokens = run.report?.usage?.totalTokens ?? run.phases?.filter((phase) => phase.phase !== "generation").reduce((total, phase) => total + (phase.usage?.totalTokens ?? 0), 0);
  const entries = [
    ["整条记录耗时", duration, "秒"],
    ["审阅辅助调用", calls, "次"],
    ["回复改写", run.report?.revisions ?? 0, "次"],
    ["审阅用量", Number.isFinite(tokens) ? tokens.toLocaleString("zh-CN") : "—", "tokens"],
  ];
  metrics.replaceChildren();
  for (const [label, value, unit] of entries) {
    const item = element("div");
    const dd = element("dd", "", value);
    dd.append(element("span", "", unit));
    item.append(element("dt", "", label), dd);
    metrics.append(item);
  }
}

function phaseDescription(phase, parsed) {
  if (phase.stopReason === "pending") return "请求已发出，正在等待返回";
  if (phase.error) return "调用未正常完成，保留错误记录";
  if (phase.stopReason !== "stop") return "返回未完整结束，不能据此批准回复";
  if (phase.phase === "generation") return phase.response?.trim() ? "主模型根据用户输入与执行记录生成原始回复" : "没有生成可展示的原始回复";
  if (phase.phase === "review" && !validReviewDecision(parsed)) return "审阅决定无效，未获批准";
  if (phase.phase === "review" && parsed?.clear === true) return "读者认为可以理解，允许展示";
  if (phase.phase === "review" && parsed?.needsContext) return "读者提出问题，需要查证背景";
  if (phase.phase === "review" && parsed?.clear === false) return "读者提出表达问题，需要改写";
  if (phase.phase === "lookup" && stringList(parsed?.facts, 32, 4000) && Object.keys(parsed).length === 1) return `返回了 ${parsed.facts.length} 条查证说明`;
  if (phase.phase === "lookup") return "查证返回格式无效";
  if (phase.phase === "rewrite") return validRewrite(parsed) ? "返回了一个候选改写版本" : "改写返回格式无效";
  return "查看模型的原始返回";
}

function renderPhases(run) {
  const phases = Array.isArray(run.phases) ? run.phases : [];
  const navigation = $("#phase-navigation");
  const list = $("#phase-list");
  navigation.replaceChildren();
  list.replaceChildren();
  $("#no-phases").hidden = phases.length > 0;
  $("#trajectory-caption").textContent = `${phases.length} 次已记录调用${run.mode === "generated" ? " · 含主模型生成" : ""}`;
  const firstReview = Math.max(phases.findIndex((phase) => phase.phase === "review"), 0);
  const allDetails = [];
  phases.forEach((phase, index) => {
    const parsed = parseResponse(phase);
    const name = PHASE_NAMES[phase.phase] ?? phase.phase;
    const item = element("li");
    const detail = element("details", "phase-detail");
    detail.id = `phase-${index + 1}`;
    detail.open = index === firstReview;
    const summary = element("summary");
    const heading = element("span");
    heading.append(element("span", "phase-heading", name), element("span", "phase-decision", phaseDescription(phase, parsed)));
    summary.append(element("span", "phase-number", index + 1), heading, element("span", "phase-duration", formatDuration(phase.durationMs)));
    const body = element("div", "phase-content");
    const scopes = {
      generation: "可见范围：用户输入与合成执行记录。此步骤属于主模型，不是盲审。",
      review: "可见范围：用户可见的对话与本轮草稿。不携带工具执行记录或上一轮查证结果。",
      lookup: "可见范围：读者提出的问题与执行记录。只查证已有事实，没有工具执行权限。",
      rewrite: "可见范围：用户可见对话、草稿、读者问题，以及本轮按需查到的说明。",
    };
    body.append(element("p", "scope-note", scopes[phase.phase] ?? "本次模型调用的输入与输出记录如下。"));
    const content = element("div", "phase-result");
    if (phase.stopReason === "pending") content.textContent = "这次调用尚未结束。重新加载页面可以读取最新返回。";
    else if (phase.error) content.textContent = formatJSON(phase.error);
    else if (phase.stopReason !== "stop" || (phase.phase === "review" && !validReviewDecision(parsed))) {
      content.textContent = `这次返回未完整结束或不符合审阅格式，不能据此批准回复。\n\n${phase.response || "模型没有返回文字。"}`;
    }
    else if (phase.phase === "review" && Array.isArray(parsed?.issues) && parsed.issues.length) {
      const issues = element("ul");
      for (const issue of parsed.issues) issues.append(element("li", "", issue));
      content.append(issues);
    } else if (phase.phase === "review" && parsed?.clear === true) content.textContent = "这次盲审没有提出理解问题。";
    else if (phase.phase === "lookup" && stringList(parsed?.facts, 32, 4000) && Object.keys(parsed).length === 1) {
      const facts = element("ul");
      for (const fact of parsed.facts) facts.append(element("li", "", fact));
      content.append(facts);
    } else if (phase.phase === "rewrite" && validRewrite(parsed)) content.textContent = parsed.text;
    else content.textContent = phase.response || "模型未返回可显示的文字。";
    body.append(content);
    const raw = element("details", "raw-detail");
    raw.append(element("summary", "", "查看完整请求、原始返回与提示词"));
    for (const [label, value] of [["实际请求", phase.request], ["模型原始返回", phase.response], ["本次调用提示词", phase.systemPrompt], ["接口返回用量", phase.usage]]) {
      if (value === undefined) continue;
      raw.append(element("p", "raw-label", label), element("pre", "", formatJSON(value)));
    }
    body.append(raw);
    detail.append(summary, body);
    item.append(detail);
    list.append(item);
    allDetails.push(detail);
    const jump = element("button", "phase-jump");
    jump.type = "button";
    jump.append(element("span", "phase-number", index + 1), element("span", "", name));
    jump.setAttribute("aria-controls", detail.id);
    if (index === firstReview) jump.setAttribute("aria-current", "step");
    jump.addEventListener("click", () => {
      allDetails.forEach((entry, position) => { entry.open = position === index; });
      navigation.querySelectorAll("button").forEach((button, position) => {
        if (position === index) button.setAttribute("aria-current", "step");
        else button.removeAttribute("aria-current");
      });
      detail.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "nearest" });
    });
    detail.addEventListener("toggle", () => {
      if (detail.open) {
        navigation.querySelectorAll("button").forEach((button) => button.removeAttribute("aria-current"));
        jump.setAttribute("aria-current", "step");
      }
      else jump.removeAttribute("aria-current");
    });
    navigation.append(jump);
  });
}

function renderEvidence(run, task) {
  const evidence = $("#execution-evidence");
  evidence.replaceChildren();
  const records = run.executionFixture ?? task?.executionFixture ?? [];
  if (!records.length) evidence.append(element("p", "small-note", "这条测试没有提供执行记录。"));
  records.forEach((record, index) => {
    const item = element("article", "evidence-item");
    item.append(element("p", "evidence-name", `${index + 1}. ${record.toolName ?? "执行记录"}${record.isError ? " · 执行报错" : ""}`));
    if (record.arguments !== undefined) item.append(element("pre", "", formatJSON(record.arguments)));
    item.append(element("p", "evidence-result", record.result ?? formatJSON(record)));
    evidence.append(item);
  });
  const checks = Array.isArray(run.qualityChecks) ? run.qualityChecks : [];
  const applicable = checks.filter((check) => check.status !== "not_applicable");
  $("#quality-caption").textContent = checks.length ? `${checks.filter((check) => check.status === "pass").length} / ${applicable.length} 项适用检查通过` : "本条没有机械检查结果";
  const quality = $("#quality-checks");
  quality.replaceChildren();
  if (!checks.length) quality.append(element("li", "small-note", "未记录检查结果。"));
  for (const check of checks) {
    const item = element("li", "quality-check");
    const words = { pass: "通过", fail: "未通过", not_applicable: "不适用" };
    const text = element("div");
    text.append(element("strong", "", check.label ?? check.id), element("p", "", check.detail ?? ""));
    item.append(element("span", `check-status ${check.status}`, words[check.status] ?? check.status), text);
    quality.append(item);
  }
}

function renderInspector(run) {
  const target = $("#comparison");
  if (!run) { target.hidden = true; return; }
  target.hidden = false;
  const task = state.dataset.tasks.find((item) => item.id === run.taskId);
  const model = state.dataset.models.find((item) => item.id === run.modelId);
  const kind = statusKey(run);
  const generationOnly = run.mode === "generated" && !run.phases.some((phase) => phase.phase === "review");
  $("#case-category").textContent = `${task?.category ?? "实验任务"}${task?.language ? ` · ${task.language}` : ""}`;
  $("#case-title").textContent = task?.title ?? run.taskId;
  $("#case-model").replaceChildren(element("span", "model-name", model?.name ?? run.modelId), element("span", "", model?.vendor ?? ""), element("span", "mode-tag", run.mode === "fixed" ? "固定草稿" : "模型生成草稿"));
  renderInput(run, task);
  $("#before-source").textContent = run.mode === "fixed" ? "预设草稿" : "模型生成";
  $("#before-text").textContent = run.before || (kind === "pending" && generationOnly ? "正在等待主模型生成原始回复。" : "主模型没有返回可显示的原始草稿。");
  $("#after-text").textContent = kind === "pending" ? "这条记录尚在执行，暂时没有最终回复。" : generationOnly ? "主模型没有完成原始回复，独立审阅尚未开始。" : run.status === "approved" ? run.after ?? "未记录最终回复" : "这条回复没有展示给用户。";
  $("#after-title").textContent = generationOnly ? (kind === "pending" ? "正在生成原始回复" : "未进入审阅") : kind === "pending" ? "正在审阅" : run.status === "approved" ? "给用户的回复" : "草稿被拦住了";
  $("#outcome-badge").className = `status-badge ${kind}`;
  $("#outcome-badge").textContent = STATUS_NAMES[kind];
  $(".response-after").classList.toggle("is-withheld", run.status !== "approved" && kind !== "pending");
  $("#after-note").textContent = kind === "pending" ? "重新加载页面可以读取最新记录。" : generationOnly ? "这是原始回复生成阶段的失败，不是读者对草稿的否决。" : kind === "unchanged" ? "读者没有提出理解问题，原文直接通过。" : kind === "changed" ? "改写后由新的盲审上下文再次检查。通过仅代表本轮读者认为可以理解。" : "审阅出错或无法通过时停止输出，不自动放行未审阅草稿。";
  $("#run-warning").hidden = !run.error;
  $("#run-warning").textContent = run.error ? `保留的错误信息：${formatJSON(run.error)}` : "";
  renderMetrics(run);
  renderPhases(run);
  renderEvidence(run, task);
}

function selectRun(id, announce = false) {
  const run = state.dataset.runs.find((entry) => entry.id === id);
  if (!run) return;
  state.runId = id;
  for (const button of document.querySelectorAll(".matrix-cell")) button.setAttribute("aria-pressed", String(button.dataset.runId === id));
  renderInspector(run);
  updateQuery(announce ? "#comparison" : location.hash);
  if (announce) {
    const task = state.dataset.tasks.find((entry) => entry.id === run.taskId);
    $("#announcement").textContent = `已打开 ${run.modelId} 的${task?.title ?? run.taskId}轨迹，${STATUS_NAMES[statusKey(run)]}。`;
    const comparison = $("#comparison");
    comparison.focus({ preventScroll: true });
    comparison.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  }
}

function refresh() {
  renderFilters();
  const matches = state.dataset.runs.filter(matchesFilters);
  const selected = matches.find((run) => run.id === state.runId) ?? matches.find((run) => statusKey(run) === "changed") ?? matches[0];
  state.runId = selected?.id ?? null;
  renderMatrix();
  renderInspector(selected);
  updateQuery();
}

function renderMethodology() {
  const method = state.dataset.methodology ?? {};
  const container = $("#method-parameters");
  const list = element("dl");
  const fixedTasks = state.dataset.tasks.length;
  const generatedTasks = method.generatedTaskIds?.length ?? state.dataset.tasks.filter((task) => task.generated).length;
  const entries = [
    ["固定草稿覆盖", `${modelList().length} 个模型 × ${fixedTasks} 个任务`],
    ["生成草稿覆盖", `${modelList().length} 个模型 × ${generatedTasks} 个任务`],
    ["最大并发", method.concurrency ?? "未记录"],
    ["单次请求时限", formatDuration(method.requestTimeoutMs)],
    ["每条审阅时限", formatDuration(method.reviewTimeoutMs)],
    ["数据完整性", method.complete ? "此批计划运行已全部记录" : "此批记录尚未全部完成"],
    ["计费说明", "数据中的零费用是配置占位值，不能据此推断实际计费。"],
  ];
  for (const [key, value] of entries) list.append(element("dt", "", key), element("dd", "", value));
  container.replaceChildren(list);
  if (Array.isArray(method.limits) && method.limits.length) {
    const limits = element("ul");
    for (const limit of method.limits) limits.append(element("li", "", limit));
    container.append(limits);
  }
  const excluded = state.dataset.excludedModels ?? state.dataset.models.filter((model) => model.excludedReason || model.type === "embeddings");
  if (excluded.length) container.append(element("p", "", `未用于文字生成的模型：${excluded.map((model) => `${model.id}（${model.excludedReason ?? "嵌入模型"}）`).join("；")}。`));
}

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", () => {
    if (!radio.checked || !state.dataset) return;
    state.mode = radio.value;
    if (!taskList().some((task) => task.id === state.task)) state.task = "all";
    refresh();
  });
}
for (const [selector, field] of [["#model-filter", "model"], ["#task-filter", "task"], ["#status-filter", "status"]]) {
  $(selector).addEventListener("change", (event) => {
    state[field] = event.target.value;
    refresh();
  });
}
$("#reset-filters").addEventListener("click", () => {
  state.model = "all";
  state.task = "all";
  state.status = "all";
  refresh();
  $("#announcement").textContent = "已重置模型、任务和结果筛选。";
});
$("#share-case").addEventListener("click", async () => {
  const button = $("#share-case");
  clearTimeout(shareResetTimer);
  updateQuery("#comparison");
  try {
    await navigator.clipboard.writeText(location.href);
    button.textContent = "链接已复制";
    $("#announcement").textContent = "这条轨迹的链接已复制。";
  } catch {
    button.textContent = "请复制地址栏链接";
    $("#announcement").textContent = "浏览器未允许复制。地址栏已经是这条轨迹的链接，可手动复制。";
  }
  shareResetTimer = setTimeout(() => { button.textContent = "复制这条链接 ↗"; }, 3000);
});
$("#download-case").addEventListener("click", () => {
  const run = state.dataset.runs.find((entry) => entry.id === state.runId);
  if (!run) return;
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(run, null, 2)}\n`], { type: "application/json" }));
  const link = element("a");
  link.href = url;
  link.download = `humanize-${run.id.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener("popstate", () => {
  if (!state.dataset) return;
  restoreQuery();
  refresh();
});

try {
  const response = await fetch(DATA_URL, { cache: "no-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const dataset = await response.json();
  if (dataset.schemaVersion !== 1 || !Array.isArray(dataset.models) || !Array.isArray(dataset.tasks) || !Array.isArray(dataset.runs)) throw new Error("数据结构不完整或版本不兼容");
  state.dataset = dataset;
  restoreQuery();
  renderCoverage();
  renderMethodology();
  refresh();
  $("#load-state").hidden = true;
  $("#app").hidden = false;
  if (location.hash === "#comparison" && state.runId) {
    const comparison = $("#comparison");
    comparison.focus({ preventScroll: true });
    comparison.scrollIntoView({ behavior: "instant", block: "start" });
  }
} catch (error) {
  const loadState = $("#load-state");
  loadState.className = "load-state error";
  loadState.replaceChildren(element("strong", "", "这次没有读到轨迹数据"), element("p", "", "请稍后刷新页面。若正在本地查看，请通过 HTTP 服务打开网页，直接双击 HTML 文件无法读取数据。"));
  loadState.append(element("p", "small-note", error instanceof Error ? error.message : String(error)));
  const retry = element("button", "secondary-button", "重新加载");
  retry.type = "button";
  retry.addEventListener("click", () => location.reload());
  loadState.append(retry);
}
