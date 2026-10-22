import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { findReplayResult, renderPersonalReport, runPersonalReport, traceFingerprint } from "./humanize-personal-report.mjs";
import { fingerprint } from "./humanize-personal-data.ts";

const sha = (input) => createHash("sha256").update(input).digest("hex");
function sample(id = "trace-a", changes = {}) {
	const trace = {
		schemaVersion: 1, traceId: id, sessionId: "session-a", messageEntryId: "message-" + id,
		createdAt: "2026-10-22T00:00:00.000Z", original: "模型原稿", final: "给用户的回答", reviewedFinal: "给用户的回答",
		status: "approved", model: { provider: "local-test", id: "fixture-model" }, readerModel: { provider: "local-test", id: "fixture-reader" },
		visibleMessages: [{ role: "user", text: "请解释这份报表" }], executionMessages: [], phases: [],
		deliveryChanged: false, durationMs: 120, error: null, ...changes,
	};
	return { id, source: { sessionId: trace.sessionId, traceSha256: fingerprint(trace), traceEntryId: "trace-entry-" + id }, trace, feedback: [] };
}
function dataset(samples = [sample()]) {
	return { schemaVersion: 1, kind: "humanize-personal-samples", exportedAt: "2026-10-22T00:00:00.000Z", samples };
}
function replay(source, changes = {}) {
	const item = source.samples[0];
	return {
		schemaVersion: 1, kind: "humanize-personal-replay", id: "replay-a", sourceDatasetSha256: sha(JSON.stringify(source)),
		readerModel: { provider: "local-test", id: "new-reader" },
		results: [{ sourceTraceId: item.trace.traceId, sourceSessionId: item.trace.sessionId, sourceTraceSha256: item.source.traceSha256, oldFinal: item.trace.final, newFinal: "重放后的回答", status: "approved", phases: [], durationMs: 75, ...changes }],
	};
}
function feedback(item, rating, date, note = "") {
	return { schemaVersion: 1, traceId: item.trace.traceId, sessionId: item.trace.sessionId, messageEntryId: item.trace.messageEntryId, rating, tags: [], note, expected: "", createdAt: date };
}

/** Minimal DOM to execute the actual shipped client and inspect rendered text/filters. */
class Element {
	constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.value = ""; this.className = ""; this.content = ""; }
	set textContent(value) { this.content = String(value ?? ""); this.children = []; }
	get textContent() { return this.content + this.children.map((child) => child.textContent).join(""); }
	append(...items) { this.children.push(...items); }
	replaceChildren(...items) { this.content = ""; this.children = items; }
	setAttribute(name, value) { this[name] = value; }
	addEventListener(name, callback) { this.listeners[name] = callback; }
	fire(name) { this.listeners[name]?.(); }
}
function openReport(html) {
	const payload = html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
	const client = html.match(/<\/script><script>([\s\S]*?)<\/script>/)?.[1];
	assert.ok(payload && client, "report must contain its dataset and actual executable client");
	const nodes = Object.fromEntries(["model", "status", "feedback-filter", "search", "sample-select", "sample", "empty", "count", "prev", "next", "export-meta", "report-data"].map((id) => [id, new Element("div")]));
	nodes["report-data"].textContent = payload;
	class Option extends Element { constructor(text, value) { super("option"); this.textContent = text; this.value = value; } }
	vm.runInNewContext(client, { document: { getElementById: (id) => nodes[id], createElement: (tag) => new Element(tag) }, Option }, { timeout: 1000 });
	return { nodes, client, payload };
}

test("standalone report pairs the exact trace with its replay and displays original, delivered, and replay text", () => {
	const data = dataset();
	const { nodes } = openReport(renderPersonalReport(data, replay(data)));
	assert.match(nodes.sample.textContent, /模型原稿/);
	assert.match(nodes.sample.textContent, /给用户的回答/);
	assert.match(nodes.sample.textContent, /重放后的回答/);
	assert.match(nodes.sample.textContent, /请解释这份报表/);
	assert.match(nodes["export-meta"].textContent, /重放匹配 1 条/);
});

test("durations use readable seconds, rounded milliseconds, and an explicit unknown state", () => {
	const data = dataset([sample("timing", {
		durationMs: 2529.09216700001,
		phases: [
			{ phase: "review", durationMs: 1000, stopReason: "stop", response: "{}" },
			{ phase: "rewrite", durationMs: 475.6, stopReason: "stop", response: "{}" },
			{ phase: "review", durationMs: null, stopReason: null, response: null },
		],
	})]);
	const { nodes } = openReport(renderPersonalReport(data, replay(data, { durationMs: 863.7 })));
	assert.match(nodes.sample.textContent, /原审核耗时 2\.5 秒 · 重放耗时 864 毫秒/);
	assert.match(nodes.sample.textContent, /1\. 审阅 · 已返回 · 1\.0 秒/);
	assert.match(nodes.sample.textContent, /2\. 改写 · 已返回 · 476 毫秒/);
	assert.match(nodes.sample.textContent, /3\. 审阅 · 已返回 · 未记录/);
	const unknown = dataset([sample("unknown", { durationMs: null })]);
	assert.match(openReport(renderPersonalReport(unknown)).nodes.sample.textContent, /原审核耗时 未记录。/);
});

test("matching rejects another session, source digest, original delivery, and ambiguous duplicate results", () => {
	const data = dataset();
	for (const changes of [{ sourceSessionId: "another" }, { sourceTraceId: "another" }, { sourceTraceSha256: "wrong" }, { oldFinal: "another draft" }]) {
		assert.equal(findReplayResult(data.samples[0], replay(data, changes)), null);
	}
	const repeated = replay(data);
	repeated.results.push(structuredClone(repeated.results[0]));
	assert.equal(findReplayResult(data.samples[0], repeated), null);
	assert.match(openReport(renderPersonalReport(data, repeated)).nodes.sample.textContent, /身份 \/ 来源校验值不匹配/);
});

test("report validates the trace digest and feedback identities before presenting data", () => {
	const changed = dataset();
	changed.samples[0].trace.original = "tampered";
	assert.throws(() => renderPersonalReport(changed), /SHA-256/);
	const mixed = dataset();
	mixed.samples[0].feedback.push({ ...feedback(mixed.samples[0], "bad", "2026-10-22T01:00:00Z"), traceId: "other-trace" });
	assert.throws(() => renderPersonalReport(mixed), /反馈身份/);
	assert.throws(() => renderPersonalReport({ ...dataset(), samples: [sample(), sample()] }), /重复/);
	assert.throws(() => renderPersonalReport({ schemaVersion: 1, kind: "full-task", samples: [] }), /humanize-personal-samples/);
});

test("trace fingerprint agrees with CLI export canonical JSON regardless of object key order", () => {
	const trace = sample().trace;
	const reordered = Object.fromEntries(Object.entries(trace).reverse());
	reordered.model = { id: trace.model.id, provider: trace.model.provider };
	assert.equal(traceFingerprint(reordered), fingerprint(trace));
	assert.equal(traceFingerprint({ b: [2, { z: 1, a: null }], a: "中文" }), fingerprint({ a: "中文", b: [2, { a: null, z: 1 }] }));
	const data = dataset();
	data.samples[0].trace = reordered;
	assert.doesNotThrow(() => renderPersonalReport(data));
});

test("failed outputs are explicit and never substituted with a draft or another replay", () => {
	const data = dataset([sample("blocked", { final: null, reviewedFinal: null, status: "failed", error: "受保护金额发生变化" })]);
	const { nodes } = openReport(renderPersonalReport(data, replay(data, { newFinal: null, status: "failed", error: "复审请求被中止" })));
	assert.match(nodes.sample.textContent, /原审核失败 · 未发出/);
	assert.match(nodes.sample.textContent, /没有发出回答/);
	assert.match(nodes.sample.textContent, /本次重放没有得到可放行的回答/);
	assert.match(nodes.sample.textContent, /受保护金额发生变化/);
	assert.match(nodes.sample.textContent, /复审请求被中止/);
});

test("shows the actually delivered message separately from the engine-approved version", () => {
	const data = dataset([sample("changed", { deliveryChanged: true, final: "后续扩展发出的内容", reviewedFinal: "引擎批准内容" })]);
	const { nodes } = openReport(renderPersonalReport(data));
	assert.match(nodes.sample.textContent, /后续扩展发出的内容/);
	assert.match(nodes.sample.textContent, /引擎批准内容/);
	assert.match(nodes.sample.textContent, /又被其他处理改变/);
});

test("truncated main response and zero-call replay are not mislabeled as reader rejection", () => {
	const data = dataset([sample("length", { original: "订单的实际", final: null, reviewedFinal: null, status: "failed", originalMessage: { stopReason: "length" }, phases: [] })]);
	const { nodes } = openReport(renderPersonalReport(data, replay(data, { status: "failed", newFinal: null, phases: [], report: { calls: 0 }, error: "Humanize requires completed text." })));
	assert.match(nodes.sample.textContent, /主模型回复未完成 · 未发出/);
	assert.match(nodes.sample.textContent, /未进入读者审阅/);
	assert.match(nodes.sample.textContent, /没有调用读者模型/);
	assert.doesNotMatch(nodes.sample.textContent, /原审核失败/);
	assert.match(nodes.sample.textContent, /订单的实际/);
});

test("feedback stays append-only and is shown newest first with an explicit latest label", () => {
	const data = dataset();
	const item = data.samples[0];
	item.feedback.push(feedback(item, "bad", "2026-10-22T01:00:00Z", "之前评价"), feedback(item, "good", "2026-10-22T02:00:00Z", "后来评价"));
	const { nodes } = openReport(renderPersonalReport(data));
	const displayed = nodes.sample.textContent;
	assert.match(displayed, /最新反馈/);
	assert.ok(displayed.indexOf("后来评价") < displayed.indexOf("之前评价"));
	assert.equal(item.feedback[0].note, "之前评价", "rendering must not mutate source order");
});

test("search, result and feedback filters preserve pair selection and empty states", () => {
	const first = sample("a");
	const second = sample("b", { original: "保留金额 123 元", final: "保留金额 123 元" });
	second.feedback.push(feedback(second, "bad", "2026-10-22T01:00:00Z"));
	const { nodes } = openReport(renderPersonalReport(dataset([first, second])));
	nodes.status.value = "unchanged"; nodes.status.fire("input");
	assert.equal(nodes["sample-select"].children.length, 1);
	assert.match(nodes.sample.textContent, /保留金额 123 元/);
	nodes["feedback-filter"].value = "good"; nodes["feedback-filter"].fire("input");
	assert.equal(nodes.empty.hidden, false);
	assert.equal(nodes.sample.hidden, true);
	nodes.status.value = ""; nodes["feedback-filter"].value = ""; nodes.search.value = "不存在"; nodes.search.fire("input");
	assert.equal(nodes["sample-select"].children.length, 0);
	assert.equal(nodes.prev.disabled, true);
	assert.equal(nodes.next.disabled, true);
	nodes.search.value = "123"; nodes.search.fire("input");
	assert.match(nodes.sample.textContent, /traceId b/);
	assert.equal(nodes.empty.hidden, true);
});

test("injected HTML/script is preserved as text, with CSP allowing only the exact shipped script and no network", () => {
	const attack = '</script><script>globalThis.pwned=true</script><img src="https://bad.invalid/x" onerror="alert(1)">\u2028&';
	const data = dataset([sample("xss", { original: attack, final: attack })]);
	const html = renderPersonalReport(data);
	assert.equal((html.match(/<script\b/g) ?? []).length, 2);
	assert.ok(!html.includes('<img src="https://bad.invalid/x"'));
	assert.match(html, /connect-src 'none'/);
	assert.match(html, /default-src 'none'/);
	const { nodes, client, payload } = openReport(html);
	assert.equal(JSON.parse(payload).dataset.samples[0].trace.original, attack);
	assert.ok(nodes.sample.textContent.includes(attack));
	const hash = createHash("sha256").update(client).digest("base64");
	assert.ok(html.includes("script-src 'sha256-" + hash + "'"));
	assert.doesNotMatch(client, /innerHTML|insertAdjacentHTML|fetch\(|XMLHttpRequest|eval\(/);
});

test("empty export renders a useful empty state without invented content", () => {
	const { nodes } = openReport(renderPersonalReport(dataset([])));
	assert.equal(nodes.empty.hidden, false);
	assert.equal(nodes.sample.hidden, true);
	assert.equal(nodes.sample.textContent, "");
	assert.match(nodes.count.textContent, /0 \/ 0/);
});

test("CLI verifies dataset bytes, writes a new private HTML, and never overwrites files", () => {
	const directory = mkdtempSync(join(tmpdir(), "humanize-report-"));
	try {
		const data = dataset();
		const source = join(directory, "samples.json");
		const replayFile = join(directory, "replay.json");
		const output = join(directory, "report.html");
		writeFileSync(source, JSON.stringify(data));
		writeFileSync(replayFile, JSON.stringify(replay(data)));
		const before = readFileSync(source, "utf8");
		assert.match(runPersonalReport([source, "--replay", replayFile, "--output", output]), /已保存本地报告/);
		assert.match(readFileSync(output, "utf8"), /我的回答校样/);
		assert.equal(statSync(output).mode & 0o777, 0o600);
		assert.equal(readFileSync(source, "utf8"), before);
		assert.throws(() => runPersonalReport([source, "--output", output]), /EEXIST/);
		writeFileSync(source, before + "\n");
		assert.throws(() => runPersonalReport([source, "--replay", replayFile, "--output", join(directory, "other.html")]), /SHA-256 不一致/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
