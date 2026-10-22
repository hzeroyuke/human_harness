import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const uiURL = new URL("../site/full-task.js", import.meta.url);
const source = readFileSync(uiURL, "utf8");
const initializationMarker = '$("#model-select").addEventListener("change"';
const initializationIndex = source.indexOf(initializationMarker);
assert.ok(initializationIndex > 0, "The UI initialization marker must exist before extracting its helpers");
assert.equal(source.lastIndexOf(initializationMarker), initializationIndex, "The UI initialization marker must be unique");
assert.equal(source.match(/^const DATA_URL = .*$/gm)?.length, 1, "The UI data URL declaration must exist exactly once");
// Evaluate the actual helpers without installing DOM handlers or fetching public data.
const helperSource = source.slice(0, initializationIndex).replace(/^const DATA_URL = .*\n/m, "");
const helperNames = [
	"modelRuns",
	"currentRun",
	"currentRound",
	"currentMessage",
	"restoreQuery",
	"updateQuery",
	"responseCounts",
	"mainResponseFailures",
	"messagesInRound",
	"reviewStatus",
	"runDifferences",
	"reasoningLabel",
	"attemptNumber",
];
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
	const previous = {
		id: "attempt-1",
		modelId: "model-a",
		enabled: true,
		startedAt: "2026-10-21T01:00:00Z",
		limits: {
			maxRevisions: 2,
			reviewTimeoutMs: 120_000,
			requestTimeoutMs: 90_000,
			roundTimeoutMs: 720_000,
			maxAgentCallsPerRound: 45,
		},
		rounds: [
			{
				id: "1",
				events: [
					{
						id: "r1-message-1",
						type: "assistant",
						review: { status: "approved", original: "第一次原稿", final: "第一次原稿" },
					},
				],
			},
		],
	};
	const latest = structuredClone(previous);
	Object.assign(latest, {
		id: "attempt-2",
		startedAt: "2026-10-22T01:00:00Z",
		limits: {
			maxRevisions: 2,
			reviewTimeoutMs: 300_000,
			requestTimeoutMs: 180_000,
			roundTimeoutMs: 1_800_000,
			maxAgentCallsPerRound: 60,
		},
	});
	latest.rounds[0].events[0].review = { status: "approved", original: "第二次原稿", final: "第二次改稿" };
	return {
		task: { rounds: [{ id: "1" }, { id: "2" }] },
		models: [{ id: "model-a" }, { id: "model-b" }],
		// Test-only attempts are deliberately stored newest first, not in chronological order.
		runs: [latest, previous],
	};
}

function loadUI(query = "", dataset = fixture()) {
	const url = new URL(query, "https://example.test/human-harness/");
	const location = { href: url.href, search: url.search };
	const context = createContext({
		URL,
		URLSearchParams,
		Intl,
		location,
		history: {
			replaceState(_state, _title, value) {
				const next = new URL(String(value), location.href);
				Object.assign(location, { href: next.href, search: next.search });
			},
		},
	});
	runInContext(`${helperSource}\nglobalThis.ui = { state, ${helperNames.join(", ")} };`, context, {
		filename: uiURL.pathname,
		timeout: 1_000,
	});
	for (const name of helperNames) assert.equal(typeof context.ui[name], "function", `Missing real UI helper: ${name}`);
	context.ui.state.dataset = dataset;
	context.ui.restoreQuery();
	return { ui: context.ui, location, dataset };
}

for (const [roundId, total, toolsOnly, tools] of [
	["1", 22, 21, 28],
	["2", 7, 6, 6],
]) {
	test(`Gemini round ${roundId} counts tool-only responses without inventing visible text`, () => {
		const data = JSON.parse(readFileSync(new URL("../site/data/full-task.json", import.meta.url), "utf8"));
		const run = data.runs.find((entry) => entry.id === "gemini-3.8-flash-complete-v1");
		assert.ok(run, "The original Gemini attempt must remain in the published dataset");
		const round = run.rounds.find((entry) => entry.id === roundId);
		assert.ok(round, `The original Gemini round ${roundId} must remain available`);
		const { ui } = loadUI();
		assert.deepEqual(plain(ui.responseCounts(round)), { recorded: true, total, withText: 1, toolsOnly, other: 0, incomplete: 0, tools });
	});
}

test("selects the latest enabled attempt chronologically without mutating storage order", () => {
	const dataset = fixture();
	dataset.runs.push({
		...structuredClone(dataset.runs[0]),
		id: "disabled-attempt",
		enabled: false,
		startedAt: "2026-10-23T01:00:00Z",
	});
	const order = dataset.runs.map((run) => run.id);
	const { ui } = loadUI("?model=model-a&round=1", dataset);
	assert.equal(ui.currentRun().id, "attempt-2");
	assert.equal(ui.attemptNumber(ui.currentRun()), 2);
	assert.deepEqual(plain(ui.modelRuns().map((run) => run.id)), ["attempt-1", "attempt-2"]);
	assert.deepEqual(dataset.runs.map((run) => run.id), order);
});

test("an explicit runId takes precedence over a conflicting model and a reused message id", () => {
	const { ui } = loadUI("?model=model-b&runId=attempt-1&round=1&message=r1-message-1");
	assert.equal(ui.state.modelId, "model-a");
	assert.equal(ui.currentRun().id, "attempt-1");
	assert.equal(ui.currentMessage().review.original, "第一次原稿");
});

test("legacy message links resolve to the earliest matching attempt", () => {
	const { ui } = loadUI("?model=model-a&round=1&message=r1-message-1");
	assert.equal(ui.currentRun().id, "attempt-1");
	assert.equal(ui.currentMessage().review.original, "第一次原稿");
});

test("a legacy link can select a newer attempt when only that attempt contains its message", () => {
	const dataset = fixture();
	dataset.runs[0].rounds[0].events[0].id = "new-message";
	const { ui } = loadUI("?model=model-a&round=1&message=new-message", dataset);
	assert.equal(ui.currentRun().id, "attempt-2");
	assert.equal(ui.currentMessage().review.original, "第二次原稿");
});

test("shared URLs include runId and preserve the selected model, round and message", () => {
	const { ui, location } = loadUI("?model=model-a&round=1&message=r1-message-1#comparison");
	ui.updateQuery();
	const url = new URL(location.href);
	assert.equal(url.searchParams.get("runId"), "attempt-1");
	assert.equal(url.searchParams.get("model"), "model-a");
	assert.equal(url.searchParams.get("round"), "1");
	assert.equal(url.searchParams.get("message"), "r1-message-1");
	assert.equal(url.hash, "#comparison");
	const restored = loadUI(`${url.search}${url.hash}`);
	assert.equal(restored.ui.currentRun().id, "attempt-1");
	assert.equal(restored.ui.currentMessage().review.original, "第一次原稿");
});

test("an unexecuted round does not borrow a message from another round or attempt", () => {
	const dataset = fixture();
	dataset.runs[1].rounds.push({ ...structuredClone(dataset.runs[1].rounds[0]), id: "2" });
	const { ui } = loadUI("?model=model-a&runId=attempt-2&round=2&message=r1-message-1", dataset);
	assert.equal(ui.currentRun().id, "attempt-2");
	assert.equal(ui.state.roundId, "2");
	assert.equal(ui.currentRound(), undefined);
	assert.equal(ui.state.messageId, null);
	assert.equal(ui.currentMessage(), undefined);
});

test("shows the recorded limit differences without changing either attempt", () => {
	const dataset = fixture();
	const before = structuredClone(dataset);
	const { ui } = loadUI("?model=model-a", dataset);
	assert.deepEqual(plain(ui.runDifferences(dataset.runs[1], dataset.runs[0])), [
		"单条消息审阅时限：前次 2 分 0 秒 → 本次 5 分 0 秒",
		"单次请求超时参数：前次 1 分 30 秒 → 本次 3 分 0 秒",
		"每轮执行时限：前次 12 分 0 秒 → 本次 30 分 0 秒",
		"每轮主模型调用上限：前次 45 → 本次 60",
	]);
	assert.deepEqual(dataset, before);
});

test("the default rewrite example comes from a model's latest attempt", () => {
	const { ui } = loadUI();
	assert.equal(ui.state.runId, "attempt-2");
	assert.equal(ui.state.showExample, true);
	assert.equal(ui.currentMessage().review.original, "第二次原稿");
	assert.equal(ui.currentMessage().review.final, "第二次改稿");
});

test("distinguishes an unrecorded reasoning setting from an unspecified or explicit upstream effort", () => {
	const { ui } = loadUI();
	assert.equal(ui.reasoningLabel(undefined), "未记录");
	assert.equal(ui.reasoningLabel({ mode: "upstream-unspecified", effort: null }), "未指定上游推理强度");
	assert.equal(ui.reasoningLabel({ mode: "explicit", effort: "low" }), "low（较低）");
	assert.equal(ui.reasoningLabel({ mode: "explicit", effort: "medium" }), "medium（中等）");
	assert.equal(ui.reasoningLabel({ mode: "explicit", effort: "high" }), "high（较高）");
	assert.equal(ui.reasoningLabel({ mode: "upstream-unspecified", effort: "low" }), "无法识别该记录");
	assert.equal(ui.reasoningLabel({ mode: "explicit", effort: "off" }), "无法识别该记录");
});

test("reasoning differences preserve the distinction between missing and explicitly unspecified settings", () => {
	const { ui, dataset } = loadUI();
	const previous = structuredClone(dataset.runs[0]);
	const current = structuredClone(previous);
	current.reasoning = { mode: "explicit", effort: "low" };
	assert.deepEqual(plain(ui.runDifferences(previous, current)), ["上游推理强度：前次 未记录 → 本次 low（较低）"]);
	previous.reasoning = { mode: "upstream-unspecified", effort: null };
	assert.deepEqual(plain(ui.runDifferences(previous, current)), [
		"上游推理强度：前次 未指定上游推理强度 → 本次 low（较低）",
	]);
	current.reasoning = { effort: null, mode: "upstream-unspecified" };
	assert.deepEqual(plain(ui.runDifferences(previous, current)), []);
});

test("Grok's truncated main response remains separate from its approved reviewed messages", () => {
	const data = JSON.parse(readFileSync(new URL("../site/data/full-task.json", import.meta.url), "utf8"));
	const run = data.runs.find((entry) => entry.id === "grok-4.7-extended-v1");
	assert.ok(run, "The extended Grok attempt must retain its unfinished response");
	const round = run.rounds.find((entry) => entry.id === "2");
	assert.ok(round, "Grok's second round must remain available");
	const { ui } = loadUI();
	assert.deepEqual(plain(ui.responseCounts(round)), {
		recorded: true, total: 8, withText: 3, toolsOnly: 5, other: 0, incomplete: 1, tools: 16,
	});
	const failures = ui.mainResponseFailures(round);
	assert.equal(failures.length, 1);
	assert.equal(failures[0].event.id, "r2-message-8");
	assert.equal(failures[0].response.id, failures[0].event.sourceMessageId);
	assert.equal(failures[0].response.stopReason, "length");
	assert.equal(failures[0].response.text, "补单已按北京时间 2026-10-20 的实际");
	assert.equal(failures[0].event.text, "");
	assert.equal(failures[0].event.review, undefined);
	assert.equal(failures[0].title, "主模型生成被截断");
	assert.match(failures[0].detail, /没有发送给用户.*没有进入表达审核.*不计作审核失败/);
	assert.equal(ui.messagesInRound(round).length, 2);
	assert.ok(ui.messagesInRound(round).every((event) => event.review.status === "approved"));
	assert.equal(ui.reviewStatus(round, true).text, "2 条回复获准展示");
});

test("review failures, tool errors and pending main calls do not count as unfinished main responses", () => {
	const data = JSON.parse(readFileSync(new URL("../site/data/full-task.json", import.meta.url), "utf8"));
	const run = data.runs.find((entry) => entry.id === "grok-4.7-complete-v1");
	assert.ok(run, "The original Grok review failure must remain available");
	const round = structuredClone(run.rounds[0]);
	round.events.push({ id: "tool-error", type: "tool", isError: true });
	round.rawResponses.push({ id: "pending-call", state: "pending", text: "", toolCalls: [] });
	const { ui } = loadUI();
	assert.equal(ui.responseCounts(round).incomplete, 0);
	assert.equal(ui.mainResponseFailures(round).length, 0);
	assert.equal(ui.messagesInRound(round).filter((event) => event.review.status === "failed").length, 1);
});
