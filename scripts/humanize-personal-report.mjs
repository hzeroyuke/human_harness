#!/usr/bin/env node
/** Local-only, self-contained report for exported personal Humanize samples. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Same canonical JSON convention as humanize-personal-data.ts. Keep the report
// dependency-free so opening/generating it never loads model providers.
export function traceFingerprint(value) {
	const canonical = (item) => {
		if (Array.isArray(item)) return "[" + item.map(canonical).join(",") + "]";
		if (item !== null && typeof item === "object") {
			return "{" + Object.keys(item).sort().map((key) => JSON.stringify(key) + ":" + canonical(item[key])).join(",") + "}";
		}
		const serialized = JSON.stringify(item);
		if (serialized === undefined) throw new Error("样本必须是完整 JSON，不能包含 undefined。");
		return serialized;
	};
	return createHash("sha256").update(canonical(value)).digest("hex");
}

function validateDataset(dataset, replay) {
	if (dataset?.schemaVersion !== 1 || dataset.kind !== "humanize-personal-samples" || !Array.isArray(dataset.samples)) {
		throw new Error("需要 schemaVersion 1 的 humanize-personal-samples 导出文件。");
	}
	const seen = new Set();
	for (const sample of dataset.samples) {
		const trace = sample?.trace;
		if (!trace || trace.schemaVersion !== 1 || typeof trace.traceId !== "string" || !trace.traceId ||
			typeof trace.sessionId !== "string" || typeof trace.messageEntryId !== "string" ||
			typeof trace.original !== "string" || !(trace.final === null || typeof trace.final === "string") ||
			!["approved", "failed"].includes(trace.status) || sample.id !== trace.traceId ||
			sample.source?.sessionId !== trace.sessionId || typeof sample.source?.traceSha256 !== "string" ||
			!Array.isArray(sample.feedback)) throw new Error("样本缺少有效身份、原稿、实际发出稿或来源校验值。");
		const key = JSON.stringify([trace.sessionId, trace.traceId]);
		if (seen.has(key)) throw new Error("导出包含重复的 sessionId / traceId，无法确定样本对应关系。");
		seen.add(key);
		if (sample.source.traceSha256 !== traceFingerprint(trace)) {
			throw new Error("样本 trace 的 SHA-256 与来源校验值不一致。");
		}
		for (const feedback of sample.feedback) {
			if (feedback?.schemaVersion !== 1 || feedback.traceId !== trace.traceId || feedback.sessionId !== trace.sessionId ||
				feedback.messageEntryId !== trace.messageEntryId || !["good", "bad", "failed"].includes(feedback.rating) ||
				!Array.isArray(feedback.tags) || feedback.tags.some((tag) => !["lost-facts", "unclear", "too-long"].includes(tag)) ||
				typeof feedback.note !== "string" || typeof feedback.expected !== "string" || typeof feedback.createdAt !== "string") {
				throw new Error("反馈身份或内容无效，不能把其他回复的反馈显示在当前样本。");
			}
		}
	}
	if (replay && (replay.schemaVersion !== 1 || replay.kind !== "humanize-personal-replay" || !Array.isArray(replay.results))) {
		throw new Error("需要 schemaVersion 1 的 humanize-personal-replay 重放文件。");
	}
}

/** Never pair different sessions, source revisions, or originally delivered text. */
export function findReplayResult(sample, replay) {
	const matches = (replay?.results ?? []).filter((result) =>
		result.sourceTraceId === sample.trace.traceId && result.sourceSessionId === sample.trace.sessionId &&
		result.sourceTraceSha256 === sample.source.traceSha256 && result.oldFinal === sample.trace.final);
	return matches.length === 1 ? matches[0] : null;
}

const css = [
	':root{--ink:#17263b;--muted:#516177;--page:#f2f5fa;--paper:#fff;--line:#d5dde8;--original:#46617f;--sent:#1c6d59;--replay:#6850a1;--error:#a43f3f;--focus:#235fc2;color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--page);font-size:16px;line-height:1.6}',
	"*{box-sizing:border-box}body{margin:0}main{max-width:1600px;margin:auto;padding:40px 32px 64px}h1,h2,h3,p{margin:0}h1{font-size:clamp(28px,3vw,42px);line-height:1.25;letter-spacing:-.035em;font-weight:650}h2{font-size:21px;line-height:1.4}h3{font-size:16px}button,input,select{font:inherit}button,select,input{border:1px solid #a7b5c7;border-radius:6px;background:var(--paper);color:var(--ink);padding:9px 12px;min-height:44px}button{cursor:pointer}button:hover:not(:disabled){background:#e8eef7}button:disabled{opacity:.45;cursor:default}:focus-visible{outline:3px solid var(--focus);outline-offset:3px}label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:650}select,input{width:100%;min-width:0;font-weight:400}",
	"header{display:flex;justify-content:space-between;gap:24px;align-items:start;margin-bottom:30px}.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}.intro{max-width:770px;color:var(--muted);margin-top:12px}.local{padding:5px 11px;background:#e4ece8;color:var(--sent);border-radius:5px;white-space:nowrap;font-size:13px}.filters{display:grid;grid-template-columns:1fr 1fr 1fr 2fr;gap:16px;padding:20px;background:var(--paper);border:1px solid var(--line);border-radius:10px}.browse{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:end;margin:18px 0 24px}.count{font-size:13px;color:var(--muted);margin-top:8px}.empty{padding:48px 24px;border:1px dashed #a7b5c7;border-radius:10px;text-align:center}.empty p{margin-top:10px;color:var(--muted)}",
	".sample-head{display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:18px}.metadata{font-size:12px;color:var(--muted);overflow-wrap:anywhere;margin-top:7px}.badge{display:inline-block;border-radius:4px;padding:4px 9px;font-size:12px;font-weight:650;background:#e8eef7;color:var(--original);white-space:nowrap}.badge.approved{background:#e4f0eb;color:var(--sent)}.badge.failed{background:#f9e9e9;color:var(--error)}.request{padding:18px 20px;border-left:4px solid var(--original);background:#e8eef6;border-radius:0 6px 6px 0;margin-bottom:24px}.request .text{margin-top:8px}",
	".compare{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:stretch}.sheet{min-width:0;background:var(--paper);border:1px solid var(--line);border-top:4px solid var(--original);border-radius:6px;display:flex;flex-direction:column}.sheet.sent{border-top-color:var(--sent)}.sheet.replay{border-top-color:var(--replay)}.sheet-head{padding:16px 20px 14px;border-bottom:1px solid var(--line);min-height:100px}.sheet-head p{font-size:12px;color:var(--muted);margin-top:4px}.sheet .text{padding:20px;font-size:14px;line-height:1.9}.text{white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}.notice{font-size:13px;padding:14px 18px;margin:16px 0;border-radius:6px;background:#e8eef6;overflow-wrap:anywhere}.notice.failure{background:#f9e9e9;color:#762b2b}.sheet .notice{margin:14px 16px}",
	".block{margin-top:28px}.block>h2{margin-bottom:12px}details{background:var(--paper);border:1px solid var(--line);border-radius:6px;margin:10px 0}summary{cursor:pointer;padding:13px 16px;font-weight:550;font-size:14px;overflow-wrap:anywhere}details[open]>summary{border-bottom:1px solid var(--line)}.detail-body{padding:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace}.feedback{padding:17px 20px;background:var(--paper);border:1px solid var(--line);border-radius:6px;margin:10px 0}.feedback .text{font-size:14px;margin-top:8px}.feedback .meta{font-size:12px;color:var(--muted);margin-bottom:7px}.muted{color:var(--muted);font-size:14px}.phases{display:grid;grid-template-columns:1fr 1fr;gap:20px}.phases>section{min-width:0}footer{margin-top:36px;color:var(--muted);font-size:12px}.skip{position:absolute;left:16px;top:-100px;background:var(--paper);padding:10px;z-index:5}.skip:focus{top:8px}[hidden]{display:none!important}",
	"@media(min-width:1200px){.compare .text{max-height:700px;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}}",
	"@media(max-width:950px){.filters{grid-template-columns:1fr 1fr}.compare{grid-template-columns:1fr}.sheet-head{min-height:0}.phases{grid-template-columns:1fr}}",
	"@media(max-width:560px){main{padding:24px 16px 40px}header{display:block}.local{display:inline-block;margin-top:16px}.filters{padding:14px;gap:12px}.filters label:last-child{grid-column:1/-1}.browse{grid-template-columns:1fr 1fr}.browse label{grid-column:1/-1}.sample-head{display:block}.sample-head .badge{margin-top:10px}.sheet .text{padding:16px}.sheet-head{padding:14px 16px}.request{padding:14px}.metadata{font-size:11px}}",
	"@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}",
].join("\n");

// All sample content is text, including Markdown and HTML. Never execute it.
function reportClient() {
	const { dataset, replay, pairs } = JSON.parse(document.getElementById("report-data").textContent);
	const $ = (id) => document.getElementById(id);
	const text = (tag, value, className) => {
		const node = document.createElement(tag);
		node.textContent = value ?? "";
		if (className) node.className = className;
		return node;
	};
	const format = (value) => typeof value === "string" ? value : JSON.stringify(value, null, 2);
	const detail = (title, value) => {
		const node = document.createElement("details");
		node.append(text("summary", title), text("pre", format(value), "detail-body"));
		return node;
	};
	const modelName = (model) => model ? [model.provider, model.id ?? model.model].filter(Boolean).join(" / ") : "未记录";
	const date = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未记录时间";
	const duration = (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0
		? "未记录" : value >= 1000 ? (value / 1000).toFixed(1) + " 秒" : Math.round(value) + " 毫秒";
	const tagNames = { "lost-facts": "丢事实", unclear: "仍难懂", "too-long": "太长" };
	const ratingNames = { good: "好", bad: "差", failed: "失败" };
	const phaseName = { review: "审阅", lookup: "查看执行背景", rewrite: "改写" };
	const deliveryState = (trace) => trace.final === null ? "未发出" : trace.original === trace.final ? "原样发出" : "改写后发出";
	const models = [...new Set(dataset.samples.map((sample) => modelName(sample.trace.model)))];
	models.forEach((name) => $("model").append(new Option(name, name)));
	let selectedKey = 0;
	let filtered = [];
	function phaseList(phases, heading, empty) {
		const section = document.createElement("section");
		section.append(text("h3", heading));
		if (!phases?.length) section.append(text("p", empty, "muted"));
		for (const [index, phase] of (phases ?? []).entries()) {
			const failed = Boolean(phase.error) || ["aborted", "error", "length"].includes(phase.stopReason);
			const node = document.createElement("details");
			node.append(text("summary", (index + 1) + ". " + (phaseName[phase.phase] ?? phase.phase) + " · " + (failed ? "未成功完成" : "已返回") + " · " + duration(phase.durationMs)));
			const body = text("div", "", "detail-body");
			if (phase.error) body.append(text("p", phase.error, "notice failure"));
			body.append(text("p", "停止原因：" + (phase.stopReason ?? "未记录"), "muted"));
			body.append(detail("调用指令", phase.systemPrompt), detail("请求内容", phase.request), detail("原始返回", phase.response), detail("完整阶段记录", phase));
			node.append(body);
			section.append(node);
		}
		return section;
	}
	function sheet(title, subtitle, body, kind, empty) {
		const section = text("section", "", "sheet " + kind);
		const head = text("div", "", "sheet-head");
		head.append(text("h3", title), text("p", subtitle));
		section.append(head);
		if (body === null || body === undefined) section.append(text("p", empty, "notice"));
		else {
			const content = text("div", body === "" ? "（已记录的文本为空）" : body, "text");
			content.tabIndex = 0;
			content.setAttribute("aria-label", title);
			section.append(content);
		}
		return section;
	}
	function renderSample() {
		const sample = dataset.samples[selectedKey];
		const area = $("sample");
		area.replaceChildren();
		if (!sample || !filtered.includes(selectedKey)) return;
		const trace = sample.trace;
		const result = pairs[selectedKey];
		const incomplete = trace.originalMessage?.stopReason === "length" && !(trace.phases?.length);
		const replayIncomplete = incomplete && result?.status === "failed" && !(result.phases?.length);
		const head = text("div", "", "sample-head");
		const title = text("div", "");
		title.append(text("h2", modelName(trace.model)), text("p", date(trace.createdAt) + " · 会话 " + trace.sessionId + "\ntraceId " + trace.traceId + " · 消息 " + trace.messageEntryId, "metadata text"));
		head.append(title, text("span", (incomplete ? "主模型回复未完成" : trace.status === "approved" ? "原审核通过" : "原审核失败") + " · " + deliveryState(trace), "badge " + trace.status));
		area.append(head);
		const visible = trace.visibleMessages ?? [];
		const request = [...visible].reverse().find((message) => message.role === "user");
		const requestNode = text("section", "", "request");
		requestNode.append(text("h3", "当时用户的最近一条输入"), text("div", request?.text ?? "此记录没有用户输入快照。", "text"));
		area.append(requestNode);
		if (trace.contextSnapshot && (!trace.contextSnapshot.visibleComplete || !trace.contextSnapshot.executionComplete)) {
			area.append(text("p", "这条记录的上下文快照不完整。未保存的背景不会被补造；重放需要的背景不足时应明确失败。", "notice"));
		}
		const compare = text("div", "", "compare");
		const sent = sheet("实际发给用户的回答", deliveryState(trace) + " · 原审阅模型 " + modelName(trace.readerModel), trace.final, "sent", "没有发出回答；原稿仍保存在左侧。空白不表示审核通过。");
		if (incomplete) sent.append(text("p", "主模型回复被长度限制截断，未进入读者审阅。左栏是未完成的原稿。", "notice failure"));
		if (trace.error) sent.append(text("p", trace.error, "notice failure"));
		const replayed = sheet("用新配置重放的回答", result ? (replayIncomplete ? "原稿未完成，未进入读者审阅" : result.status === "approved" ? "重放审核通过" : "重放失败") + " · " + modelName(replay?.readerModel) : "尚无对应的重放结果", result?.newFinal, "replay", result ? "本次重放没有得到可放行的回答。" : "没有重放这条记录，或身份 / 来源校验值不匹配。这里不会展示其他样本的回答。");
		if (replayIncomplete) replayed.append(text("p", "重放保留原稿的未完成状态，没有调用读者模型，也没有补全原来的任务。", "notice failure"));
		if (result?.error) replayed.append(text("p", result.error, "notice failure"));
		compare.append(sheet("模型原稿", "同一条消息进入 Humanize 前的完整文字", trace.original, "original", "没有原稿。"), sent, replayed);
		area.append(compare);
		area.append(text("p", "原审核耗时 " + duration(trace.durationMs) + (result ? " · 重放耗时 " + duration(result.durationMs) : "") + "。调用用量保留在阶段与完整记录中。", "count"));
		if (trace.deliveryChanged) {
			area.append(text("p", "实际发出的内容在 Humanize 批准后又被其他处理改变。中栏展示真实发出稿；引擎批准稿单独保留在下方。", "notice"), detail("Humanize 当时批准的回答（后续又有变化）", trace.reviewedFinal));
		}
		const feedback = text("section", "", "block");
		feedback.append(text("h2", "你留下的反馈"));
		if (!sample.feedback.length) feedback.append(text("p", "没有反馈记录。可以回到 Pi，用 /feedback 为这条回复填写评分和期望表达。", "muted"));
		const orderedFeedback = sample.feedback.map((item, index) => ({ item, index })).sort((a, b) => (Date.parse(b.item.createdAt) || 0) - (Date.parse(a.item.createdAt) || 0) || b.index - a.index);
		for (const [position, { item }] of orderedFeedback.entries()) {
			const card = text("article", "", "feedback");
			card.append(text("p", (position === 0 ? "最新反馈 · " : "之前的反馈 · ") + date(item.createdAt), "meta"), text("h3", [ratingNames[item.rating] ?? item.rating, ...(item.tags ?? []).map((tag) => tagNames[tag] ?? tag)].filter(Boolean).join(" · ")));
			card.append(text("p", "说明：" + (item.note || "未填写"), "text"), text("p", "期望表达：" + (item.expected || "未填写"), "text"));
			feedback.append(card);
		}
		area.append(feedback);
		const stages = text("section", "", "block");
		stages.append(text("h2", "审阅过程中发生了什么"));
		const columns = text("div", "", "phases");
		columns.append(phaseList(trace.phases, "原来的审阅", "未记录阶段调用。"), phaseList(result?.phases, "这次重放", result ? "未记录阶段调用。" : "这条记录没有对应重放。"));
		stages.append(columns);
		area.append(stages);
		const evidence = text("section", "", "block");
		evidence.append(text("h2", "核对背景与来源"), detail("当时用户看得到的对话", visible), detail("执行过程快照（可能含私有工具内容）", trace.executionMessages), detail("模型、设置与来源校验值", { model: trace.model, readerModel: trace.readerModel, settings: trace.settings, contextSnapshot: trace.contextSnapshot, source: sample.source }), detail("完整原始样本与反馈", sample));
		if (result) evidence.append(detail("完整重放结果", result));
		area.append(evidence);
	}
	function refresh() {
		const needle = $("search").value.trim().toLocaleLowerCase();
		filtered = dataset.samples.flatMap((sample, index) => {
			const trace = sample.trace;
			const status = trace.status === "failed" || trace.final === null ? "failed" : trace.original === trace.final ? "unchanged" : "changed";
			const feedback = $("feedback-filter").value;
			if ($("model").value && modelName(trace.model) !== $("model").value) return [];
			if ($("status").value && status !== $("status").value) return [];
			if (feedback === "with" && !sample.feedback.length) return [];
			if (["good", "bad", "failed"].includes(feedback) && !sample.feedback.some((item) => item.rating === feedback)) return [];
			if (needle && !JSON.stringify([trace.original, trace.final, trace.visibleMessages, sample.feedback, trace.traceId, trace.sessionId]).toLocaleLowerCase().includes(needle)) return [];
			return [index];
		});
		if (!filtered.includes(selectedKey)) selectedKey = filtered[0];
		$("sample-select").replaceChildren(...filtered.map((index) => {
			const sample = dataset.samples[index];
			return new Option(modelName(sample.trace.model) + " · " + deliveryState(sample.trace) + " · " + sample.trace.traceId, String(index));
		}));
		$("sample-select").value = String(selectedKey);
		$("sample-select").disabled = filtered.length === 0;
		$("empty").hidden = filtered.length > 0;
		$("sample").hidden = filtered.length === 0;
		$("count").textContent = "符合筛选 " + filtered.length + " / " + dataset.samples.length + " 条；每条回复单独对应原稿、实际稿与重放稿。";
		updateNavigation();
		renderSample();
	}
	function updateNavigation() {
		const position = filtered.indexOf(selectedKey);
		$("prev").disabled = position <= 0;
		$("next").disabled = position < 0 || position === filtered.length - 1;
	}
	for (const id of ["model", "status", "feedback-filter", "search"]) $(id).addEventListener("input", refresh);
	$("sample-select").addEventListener("change", () => { selectedKey = Number($("sample-select").value); updateNavigation(); renderSample(); });
	for (const [id, change] of [["prev", -1], ["next", 1]]) $(id).addEventListener("click", () => {
		selectedKey = filtered[filtered.indexOf(selectedKey) + change];
		$("sample-select").value = String(selectedKey);
		updateNavigation();
		renderSample();
	});
	const paired = pairs.filter(Boolean).length;
	$("export-meta").textContent = "导出于 " + date(dataset.exportedAt) + (replay ? " · 重放匹配 " + paired + " 条 / 原始重放结果 " + replay.results.length + " 条" : " · 未载入重放文件") + "。本页可离线打开，不发起网络请求。";
	refresh();
}

export function renderPersonalReport(dataset, replay = null) {
	validateDataset(dataset, replay);
	const payload = JSON.stringify({ dataset, replay, pairs: dataset.samples.map((sample) => findReplayResult(sample, replay)) })
		.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
	const client = "(" + reportClient.toString() + ")();";
	const hash = createHash("sha256").update(client).digest("base64");
	return [
		'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'sha256-' + hash + '\'; style-src \'unsafe-inline\'; connect-src \'none\'; img-src \'none\'; base-uri \'none\'; form-action \'none\'">',
		"<title>我的回答校样 · Humanize</title><style>" + css + "</style></head>",
		'<body><a class="skip" href="#sample-select">跳到回复选择</a><main><header><div><p class="eyebrow">Humanize · 个人回复记录</p><h1>同一条回答，逐句看变化。</h1><p class="intro">保留原稿、真正发出的内容，再看新配置会怎样改写。反馈留在对应回复旁边；重放只是一份候选结果，不会改动原来的会话。</p></div><span class="local">本地报告 · 含个人数据</span></header>',
		'<section class="filters" aria-label="筛选回复"><label>主模型<select id="model"><option value="">全部模型</option></select></label><label>原来的结果<select id="status"><option value="">全部结果</option><option value="changed">改写后发出</option><option value="unchanged">原样发出</option><option value="failed">失败 / 未发出</option></select></label><label>我的反馈<select id="feedback-filter"><option value="">全部记录</option><option value="with">有反馈</option><option value="good">好</option><option value="bad">差</option><option value="failed">失败</option></select></label><label>搜索输入、回答或备注<input id="search" type="search" placeholder="输入关键词或 traceId" autocomplete="off"></label></section>',
		'<p class="count" id="count" role="status" aria-live="polite"></p><div class="browse"><label>选择一条回复<select id="sample-select"></select></label><button id="prev" type="button">上一条</button><button id="next" type="button">下一条</button></div><section id="empty" class="empty" hidden><h2>没有符合条件的回复</h2><p>可以清空筛选条件；若导出本身为空，请在 Pi 开启轨迹记录并产生回复后重新导出。</p></section><article id="sample" aria-label="所选回复对照"></article><noscript><p class="notice">此离线报告需要浏览器允许本页自带的脚本，才能选择和查看样本。原始数据完整保存在这个 HTML 文件内。</p></noscript><footer><p id="export-meta"></p><p>“审核通过”只表示 Humanize 放行，不能代替你对事实、任务完成情况与表达质量的判断。报告可能包含私有提示词、工具输出和反馈，请只在你决定后分享。</p></footer></main>',
		'<script id="report-data" type="application/json">' + payload + "</script><script>" + client + "</script></body></html>",
	].join("\n");
}

export function runPersonalReport(argv) {
	let input;
	let output;
	let replayPath;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help") return "用法：node scripts/humanize-personal-report.mjs <samples.json> [--replay <replay.json>] --output <new.html>";
		if (["--output", "--replay"].includes(arg)) {
			const value = argv[++i];
			if (!value || value.startsWith("--")) throw new Error(arg + " 缺少文件路径。");
			if (arg === "--output") { if (output) throw new Error("--output 不能重复。"); output = value; }
			else { if (replayPath) throw new Error("--replay 不能重复。"); replayPath = value; }
		} else if (arg.startsWith("--") || input) throw new Error("未知参数：" + arg);
		else input = arg;
	}
	if (!input || !output) throw new Error("必须指定样本 JSON 与 --output 新 HTML 路径。使用 --help 查看用法。");
	const source = readFileSync(input);
	const dataset = JSON.parse(source.toString("utf8"));
	const replay = replayPath ? JSON.parse(readFileSync(replayPath, "utf8")) : null;
	if (replay && replay.sourceDatasetSha256 !== createHash("sha256").update(source).digest("hex")) {
		throw new Error("重放文件与这个导出文件的 SHA-256 不一致。请使用重放时的原始导出文件，不能混合其他批次。");
	}
	writeFileSync(output, renderPersonalReport(dataset, replay), { encoding: "utf8", flag: "wx", mode: 0o600 });
	return "已保存本地报告：" + resolve(output) + "（" + dataset.samples.length + " 条回复）。未发布，也未改动源数据。";
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try { console.log(runPersonalReport(process.argv.slice(2))); }
	catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
