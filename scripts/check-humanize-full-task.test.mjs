import assert from "node:assert/strict";
import test from "node:test";
import { validateFullTask } from "./check-humanize-full-task.mjs";

const clear = { clear: true, needsContext: false, issues: [] };
const before = "导出已完成，文件保存在 report.csv。";
const prompt = "请导出订单，并告诉我结果。";
const input = [{ role: "user", text: prompt }];
const acceptance = {
	passed: false,
	total: 1,
	passedCount: 0,
	checks: [{ id: "amount", label: "金额", passed: false, expected: 100, actual: 90 }],
	summary: "业务金额仍有差异",
};
function phase(name, request, result) {
	return {
		phase: name,
		request: { phase: name, ...request },
		systemPrompt: "Test-only synthetic prompt",
		response: JSON.stringify(result),
		stopReason: "stop",
		durationMs: 1,
	};
}
function fixture() {
	return structuredClone({
		schemaVersion: 1,
		kind: "full-task",
		complete: true,
		methodology: { comparison: "same-message-before-after" },
		task: { id: "task", rounds: [{ id: "1", prompt }] },
		models: [{ id: "model-a", name: "Model A" }],
		runs: [
			{
				id: "run-a",
				modelId: "model-a",
				enabled: true,
				status: "completed",
				finishedAt: "2026-10-22T01:00:00Z",
				seedHash: "a".repeat(64),
				source: { humanizeSha256: "b".repeat(64), runnerSha256: "c".repeat(64), taskSha256: "d".repeat(64) },
				limits: { maxContextChars: 48_000 },
				rounds: [
					{
						id: "1",
						status: "completed",
						initialAcceptance: acceptance,
						acceptance,
						rawResponses: [
							{
								id: "message-1",
								state: "received",
								text: before,
								toolCalls: [],
								stopReason: "stop",
								durationMs: 5,
							},
						],
						events: [
							{ id: "user-1", type: "user", text: prompt },
							{
								id: "message-1",
								sourceMessageId: "message-1",
								type: "assistant",
								text: before,
								isError: false,
								review: {
									status: "approved",
									original: before,
									final: before,
									report: { status: "approved", calls: 1, revisions: 0, lookedUpContext: false },
									phases: [phase("review", { visibleMessages: input, draft: before }, clear)],
								},
							},
							{ id: "acceptance-1", type: "test", name: "外部业务验收", result: acceptance, isError: true },
						],
					},
				],
			},
		],
	});
}
const roundOf = (data) => data.runs[0].rounds[0];
const messageOf = (data) => roundOf(data).events[1];
const errorsOf = (data, options) => validateFullTask(data, options).errors.join("\n");
function rewritten() {
	const data = fixture();
	const message = messageOf(data);
	const original = "蓝桥已完成。";
	const revised = "订单导出已完成。";
	const issues = ["蓝桥具体指什么工作？"];
	roundOf(data).rawResponses[0].text = original;
	Object.assign(message, {
		text: revised,
		review: {
			status: "approved",
			original,
			final: revised,
			report: { status: "approved", calls: 4, revisions: 1, lookedUpContext: true },
			phases: [
				phase("review", { visibleMessages: input, draft: original }, { clear: false, needsContext: true, issues }),
				phase(
					"lookup",
					{ issues, execution: [{ type: "tool_result", name: "read_file", text: "蓝桥是订单导出。" }] },
					{ facts: ["蓝桥是订单导出。"] },
				),
				phase(
					"rewrite",
					{ visibleMessages: input, draft: original, issues, evidence: ["蓝桥是订单导出。"] },
					{ text: revised },
				),
				phase("review", { visibleMessages: input, draft: revised }, clear),
			],
		},
	});
	return data;
}

test("validates unchanged delivery separately from failed business acceptance", () => {
	const result = validateFullTask(fixture());
	assert.deepEqual(result.errors, []);
	assert.equal(result.summary.unchanged, 1);
	assert.equal(result.summary.businessPassed, 0);
});

test("validates actual lookup, rewrite and a fresh independent approval", () => {
	const result = validateFullTask(rewritten());
	assert.deepEqual(result.errors, []);
	assert.equal(result.summary.rewritten, 1);
});

test("rejects swapping the original with a different main response", () => {
	const data = fixture();
	roundOf(data).rawResponses[0].text = "来自另一次请求的草稿。";
	assert.match(errorsOf(data), /original differs from its same-id raw/);
	messageOf(data).sourceMessageId = "message-other";
	assert.match(errorsOf(data), /no matching same-id raw/);
});

test("rejects duplicated message pairs and duplicate raw ids", () => {
	const data = fixture();
	roundOf(data).rawResponses.push(structuredClone(roundOf(data).rawResponses[0]));
	roundOf(data).events.push(structuredClone(messageOf(data)));
	assert.match(errorsOf(data), /duplicate raw response id/);
	assert.match(errorsOf(data), /duplicates a source message pair/);
});

test("requires both first draft and final approved draft to match delivery", () => {
	const data = fixture();
	messageOf(data).review.phases[0].request.draft = "另写的原稿";
	messageOf(data).text = "审阅后偷偷追加一句。";
	assert.match(errorsOf(data), /first blind review did not use the original/);
	assert.match(errorsOf(data), /approved final differs from actually released/);
	assert.match(errorsOf(data), /lacks matching final independent approval/);
});

test("rejects execution data added to any blind reviewer input", () => {
	const data = rewritten();
	messageOf(data).review.phases[3].request.execution = [{ text: "hidden" }];
	assert.match(errorsOf(data), /blind review contains hidden/);
});

test("later reviewers must receive prior released wording, never prior raw drafts", () => {
	const data = rewritten();
	const first = messageOf(data);
	const second = structuredClone(fixture().runs[0].rounds[0].events[1]);
	second.id = second.sourceMessageId = "message-2";
	second.review.phases[0].request.visibleMessages.push({ role: "assistant", text: first.text });
	roundOf(data).rawResponses.push({
		...structuredClone(roundOf(data).rawResponses[0]),
		id: "message-2",
		text: second.text,
	});
	roundOf(data).events.splice(2, 0, second);
	assert.deepEqual(validateFullTask(data).errors, []);
	second.review.phases[0].request.visibleMessages.at(-1).text = first.review.original;
	assert.match(errorsOf(data), /blind visible history differs from actually released/);
});

test("allows the configured oldest-boundary truncation of public history", () => {
	const data = fixture();
	data.runs[0].limits.maxContextChars = before.length + 4;
	messageOf(data).review.phases[0].request.visibleMessages = [{ role: "user", text: prompt.slice(-4) }];
	assert.deepEqual(validateFullTask(data).errors, []);
});

test("failed reviews retain the same raw original and withhold all output", () => {
	const data = fixture();
	const message = messageOf(data);
	Object.assign(message, { text: "", isError: true });
	Object.assign(message.review, {
		status: "failed",
		final: null,
		report: { status: "failed", calls: 1, revisions: 0, lookedUpContext: false },
	});
	message.review.phases[0].response = JSON.stringify({ clear: false, needsContext: false, issues: ["指代不明"] });
	assert.deepEqual(validateFullTask(data).errors, []);
	assert.equal(validateFullTask(data).summary.withheld, 1);
	message.review.final = before;
	assert.match(errorsOf(data), /failed review exposed an unapproved draft/);
});

test("rejects reusing the previous approved report for a failed message", () => {
	const data = fixture();
	const message = messageOf(data);
	Object.assign(message, { text: "", isError: true });
	Object.assign(message.review, { status: "failed", final: null });
	message.review.phases[0].response = "invalid JSON";
	assert.match(errorsOf(data), /engine report belongs to another result/);
});

test("keeps provider errors outside readability failure counts", () => {
	const data = fixture();
	const message = messageOf(data);
	Object.assign(roundOf(data).rawResponses[0], { stopReason: "error", text: "incomplete prefix" });
	Object.assign(message, { text: "", isError: true, errorStage: "main-response" });
	delete message.review;
	const result = validateFullTask(data);
	assert.deepEqual(result.errors, []);
	assert.equal(result.summary.mainResponseErrors, 1);
	assert.equal(result.summary.withheld, 0);
	message.review = messageOf(fixture()).review;
	assert.match(errorsOf(data), /original provider error or incomplete response/);
});

test("rejects contradictory JSON or truncated final approval", () => {
	for (const mutation of [
		(phase) => {
			phase.response = JSON.stringify({ clear: true, needsContext: true, issues: [] });
		},
		(phase) => {
			phase.stopReason = "length";
		},
	]) {
		const data = fixture();
		mutation(messageOf(data).review.phases[0]);
		assert.match(errorsOf(data), /lacks matching final independent approval/);
	}
});

test("rejects lookup before a blind question and an unrecorded rewritten draft", () => {
	const data = rewritten();
	const phases = messageOf(data).review.phases;
	phases[0].response = JSON.stringify({ clear: false, needsContext: false, issues: phases[1].request.issues });
	phases[3].request.draft = messageOf(data).review.final = messageOf(data).text = "没有出现在改写返回里的版本";
	assert.match(errorsOf(data), /invalid review\/lookup\/rewrite order/);
	assert.match(errorsOf(data), /draft differs from the actual previous draft/);
});

test("does not treat an independent disabled run as a same-message control", () => {
	const data = fixture();
	data.runs[0].enabled = false;
	assert.match(errorsOf(data), /disabled runs cannot count as same-message/);
});

test("requires every received text draft to retain its delivery or withheld record", () => {
	const data = fixture();
	roundOf(data).events.splice(1, 1);
	assert.match(errorsOf(data), /lost the delivery or withheld record/);
});

test("records unstarted follow-up rounds without claiming task completion", () => {
	const data = fixture();
	data.task.rounds.push({ id: "2", prompt: "补单重算。" });
	data.runs[0].status = "interrupted";
	const result = validateFullTask(data);
	assert.deepEqual(result.errors, []);
	assert.equal(result.summary.roundsNotStarted, 1);
	data.runs[0].status = "completed";
	assert.match(errorsOf(data), /claims completion without completing every task round/);
});

test("publishes only ended attempts but allows explicit in-progress local previews", () => {
	const data = fixture();
	data.complete = false;
	data.runs[0].status = "running";
	roundOf(data).status = "running";
	assert.match(errorsOf(data), /Publication requires a complete/);
	assert.match(errorsOf(data), /is still running/);
	assert.deepEqual(validateFullTask(data, { allowPartial: true }).errors, []);
});

test("rejects invented acceptance totals and missing source hashes", () => {
	const data = fixture();
	roundOf(data).acceptance.passed = true;
	delete data.runs[0].source.runnerSha256;
	assert.match(errorsOf(data), /acceptance totals disagree/);
	assert.match(errorsOf(data), /needs source hash runnerSha256/);
});


test("same-model attempts may reuse message ids without sharing their drafts or history", () => {
	const data = fixture();
	const retry = rewritten().runs[0];
	retry.id = "run-b";
	data.runs.push(retry);
	const result = validateFullTask(data);
	assert.deepEqual(result.errors, []);
	assert.equal(result.summary.models, 1);
	assert.equal(result.summary.unchanged, 1);
	assert.equal(result.summary.rewritten, 1);
	// A same message id from another attempt is still a different response.
	retry.rounds[0].events[1] = structuredClone(messageOf(data));
	assert.match(errorsOf(data), /run-b.*original differs from its same-id raw/);
});

test("pure tool responses retain their trace without inventing visible message pairs", () => {
	const data = fixture();
	roundOf(data).rawResponses.unshift({
		id: "tool-only",
		state: "received",
		text: "",
		toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "orders.json" } }],
		stopReason: "toolUse",
		durationMs: 5,
	});
	roundOf(data).events.splice(1, 0, {
		id: "call-1",
		type: "tool",
		name: "read_file",
		arguments: { path: "orders.json" },
		result: "[]",
	});
	const result = validateFullTask(data);
	assert.deepEqual(result.errors, []);
	assert.equal(result.summary.unchanged, 1);
	assert.equal(result.summary.withheld, 0);
});
