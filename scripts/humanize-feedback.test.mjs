import assert from "node:assert/strict";
import test from "node:test";
import humanizeFeedback, { feedbackTargets, parseFeedbackArguments } from "../packages/coding-agent/examples/extensions/humanize-feedback.ts";

function record(id, overrides = {}) {
	return {
		type: "custom", id: "entry-" + id, parentId: "message-" + id, customType: "humanize_trace",
		data: { schemaVersion: 1, traceId: id, sessionId: "session-a", messageEntryId: "message-" + id, original: "原稿 " + id, final: "回答 " + id, status: "approved", ...overrides },
	};
}
function messages(...records) {
	return records.flatMap((entry) => [{ type: "message", id: entry.data.messageEntryId, message: { role: "assistant" } }, entry]);
}
function setup(initial = messages(record("a"))) {
	const writes = [];
	const notices = [];
	const hooks = {};
	let command;
	let branch = initial;
	let sessionId = "session-a";
	const api = {
		registerCommand(name, options) { assert.equal(name, "feedback"); command = options; },
		appendEntry(customType, data) { writes.push({ customType, data }); },
		on(name, handler) { hooks[name] = handler; },
		getCommands() { return [{ name: "feedback" }]; },
	};
	const ctx = {
		hasUI: true,
		sessionManager: { getBranch: () => branch, getSessionId: () => sessionId },
		ui: {
			notify: (message, type) => notices.push({ message, type }),
			select: async () => "好",
			input: async () => "",
		},
	};
	humanizeFeedback(api);
	return { api, ctx, writes, notices, hooks, command, setBranch: (value) => { branch = value; }, setSession: (value) => { sessionId = value; } };
}

test("parses Chinese ratings, quoted notes, expected text, optional identity and multiple tags", () => {
	const result = parseFeedbackArguments('trace-a 丢事实 --tags 丢事实,太长 --note "退款金额 不见了" --expected \'退款 20 元\'');
	assert.deepEqual(result, { traceId: "trace-a", rating: "bad", tags: ["lost-facts", "too-long"], note: "退款金额 不见了", expected: "退款 20 元", choose: false, help: false });
	assert.equal(parseFeedbackArguments('--trace trace-a failed --note ""').rating, "failed");
	assert.equal(parseFeedbackArguments("--choose").choose, true);
});

test("rejects malformed or ambiguous arguments without silently dropping content", () => {
	for (const input of ['好 --note "未闭合', "好 --unknown x", "好 --tags nope", "好 --tags __proto__", "好 --tags constructor", "好 差", "--choose --trace a", "a --trace b", "好 --note x --note y", "好 --expected", "a 好 extra"]) {
		assert.throws(() => parseFeedbackArguments(input), undefined, input);
	}
	assert.equal(parseFeedbackArguments("constructor").rating, undefined);
	assert.equal(parseFeedbackArguments("__proto__").rating, undefined);
});

test("only targets exact assistant messages in this session branch, including failed review records", () => {
	const a = record("a");
	const failed = record("b", { status: "failed", final: null });
	const foreign = record("foreign", { sessionId: "session-b" });
	const missing = record("missing");
	const customMessage = { ...record("in-context"), type: "custom_message" };
	const badSchema = record("version", { schemaVersion: 2 });
	const branch = [...messages(a, failed, foreign, badSchema), missing, customMessage];
	assert.deepEqual(feedbackTargets(branch, "session-a").map((entry) => entry.traceId), ["a", "b"]);
	assert.deepEqual(feedbackTargets(messages(a), "session-b"), []);
});

test("default uses the latest recorded reply and appends feedback without creating any model message", async () => {
	const harness = setup(messages(record("a"), record("b")));
	await harness.command.handler('差 --tags 仍难懂 --note "解释缩写" --expected "写全称"', harness.ctx);
	assert.equal(harness.writes.length, 1);
	assert.equal(harness.writes[0].customType, "humanize_feedback");
	const feedback = harness.writes[0].data;
	assert.equal(feedback.traceId, "b");
	assert.equal(feedback.messageEntryId, "message-b");
	assert.equal(feedback.sessionId, "session-a");
	assert.equal(feedback.rating, "bad");
	assert.deepEqual(feedback.tags, ["unclear"]);
	assert.equal(feedback.note, "解释缩写");
	assert.ok(Number.isFinite(Date.parse(feedback.createdAt)));
	assert.match(harness.notices.at(-1).message, /回答 b/);
	assert.match(harness.notices.at(-1).message, /不发送给模型/);
});

test("latest unrecorded assistant failure does not accidentally rate an older reply", async () => {
	const harness = setup([...messages(record("a")), { type: "message", id: "new-failure", message: { role: "assistant", stopReason: "error" } }]);
	await harness.command.handler("差", harness.ctx);
	assert.equal(harness.writes.length, 0);
	assert.match(harness.notices.at(-1).message, /最近一条助手消息没有可评轨迹/);
	await harness.command.handler("a 差", harness.ctx);
	assert.equal(harness.writes[0].data.traceId, "a");
});

test("explicit trace may select an older failure but cannot cross branches", async () => {
	const harness = setup(messages(record("a", { status: "failed", final: null }), record("b")));
	await harness.command.handler("a 失败", harness.ctx);
	assert.equal(harness.writes[0].data.traceId, "a");
	harness.setBranch(messages(record("b")));
	await harness.command.handler("a 失败", harness.ctx);
	assert.equal(harness.writes.length, 1);
	assert.match(harness.notices.at(-1).message, /当前会话分支没有/);
});

test("interactive selection records note and expected wording and supports cancellation", async () => {
	const harness = setup(messages(record("a"), record("b")));
	let selects = 0;
	harness.ctx.ui.select = async (_title, options) => ++selects === 1 ? options[1] : "太长";
	const inputs = ["用一句话说明", "先给结论"];
	harness.ctx.ui.input = async () => inputs.shift();
	await harness.command.handler("--choose", harness.ctx);
	assert.equal(harness.writes[0].data.traceId, "a");
	assert.deepEqual(harness.writes[0].data.tags, ["too-long"]);
	assert.equal(harness.writes[0].data.expected, "先给结论");
	harness.ctx.ui.select = async () => undefined;
	await harness.command.handler("", harness.ctx);
	assert.equal(harness.writes.length, 1);
	assert.match(harness.notices.at(-1).message, /已取消/);
});

test("branch or session changes during a dialog cannot attach feedback to another sample", async () => {
	for (const switchSession of [false, true]) {
		const harness = setup();
		harness.ctx.ui.select = async () => {
			if (switchSession) harness.setSession("session-b");
			else harness.setBranch(messages(record("b")));
			return "差";
		};
		await harness.command.handler("", harness.ctx);
		assert.equal(harness.writes.length, 0);
		assert.match(harness.notices.at(-1).message, /会话或分支已切换/);
	}
});

test("noninteractive arguments work and notices use stderr, never stdout or a model message", async () => {
	const harness = setup();
	harness.ctx.hasUI = false;
	let output = "";
	const originalWrite = process.stderr.write;
	try {
		process.stderr.write = (value) => { output += value; return true; };
		await harness.command.handler("好 --note 确认", harness.ctx);
		await harness.command.handler("", harness.ctx);
	} finally { process.stderr.write = originalWrite; }
	assert.equal(harness.writes.length, 1);
	assert.equal(harness.writes[0].data.note, "确认");
	assert.match(output, /已保存反馈/);
	assert.match(output, /无交互界面时必须提供评分/);
	assert.equal(harness.notices.length, 0);
});

test("duplicate trace IDs are rejected; repeated feedback is append-only", async () => {
	const harness = setup(messages(record("a")));
	await harness.command.handler("好", harness.ctx);
	await harness.command.handler("差", harness.ctx);
	assert.deepEqual(harness.writes.map((item) => item.data.rating), ["good", "bad"]);
	harness.setBranch(messages(record("a"), record("a", { messageEntryId: "message-other" })));
	await harness.command.handler("a 差", harness.ctx);
	assert.equal(harness.writes.length, 2);
	assert.match(harness.notices.at(-1).message, /身份有歧义/);
});

test("registration preserves Pi collision handling and warns about invocation suffixes", () => {
	const harness = setup();
	harness.api.getCommands = () => [{ name: "feedback:1" }, { name: "feedback:2" }];
	harness.hooks.session_start({}, harness.ctx);
	assert.match(harness.notices[0].message, /数字后缀/);
});
