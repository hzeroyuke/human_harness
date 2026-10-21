import assert from "node:assert/strict";
import test from "node:test";
import { validateBenchmark } from "./check-humanize-benchmark.mjs";

function fixture() {
	const input = [{ role: "user", text: "导出完成了吗？" }];
	const before = "导出已完成。";
	const parsed = { clear: true, needsContext: false, issues: [] };
	const phase = {
		phase: "review",
		request: { phase: "review", visibleMessages: input, draft: before },
		response: JSON.stringify(parsed),
		parsed,
		durationMs: 5,
		stopReason: "stop",
	};
	const fixed = {
		id: "model-a/export/fixed",
		modelId: "model-a",
		taskId: "export",
		mode: "fixed",
		state: "complete",
		status: "approved",
		before,
		after: before,
		input,
		executionFixture: [],
		phases: [phase],
		durationMs: 5,
		report: { status: "approved", calls: 1, revisions: 0, lookedUpContext: false },
	};
	return JSON.parse(
		JSON.stringify({
			schemaVersion: 1,
			generatedAt: "2026-10-21T10:00:00.000Z",
			methodology: { complete: true, expectedRuns: 2, generatedTaskIds: ["export"] },
			models: [{ id: "model-a", name: "Model A", type: "chat" }],
			tasks: [{ id: "export", title: "导出进度", input, fixedDraft: before }],
			runs: [
				fixed,
				{
					...fixed,
					id: "model-a/export/generated",
					mode: "generated",
					durationMs: 10,
					phases: [
						{ phase: "generation", request: {}, response: before, durationMs: 5, stopReason: "stop" },
						phase,
					],
				},
			],
		}),
	);
}

test("accepts complete coverage and counts generation separately from review", () => {
	const result = validateBenchmark(fixture());
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.summary, {
		models: 1,
		excludedModels: 0,
		tasks: 1,
		runs: 2,
		expected: 2,
		approved: 2,
		failed: 0,
		unavailable: 0,
		pending: 0,
	});
});

test("preserves a failed model attempt as coverage without claiming it is approved", () => {
	const data = fixture();
	Object.assign(data.runs[0], { status: "unavailable", after: null, error: "Provider rejected model", report: null });
	assert.deepEqual(validateBenchmark(data).errors, []);
});

test("requires every model/task/mode combination for publication", () => {
	const data = fixture();
	data.runs.pop();
	assert.match(validateBenchmark(data).errors.join("\n"), /Missing generated run/);
	data.methodology.complete = false;
	assert.match(validateBenchmark(data).errors.join("\n"), /requires a complete benchmark/);
	assert.deepEqual(validateBenchmark(data, { allowPartial: true }).errors, []);
});

test("rejects hidden execution evidence in any blind review", () => {
	const data = fixture();
	data.runs[1].phases[1].request.execution = [{ text: "hidden definition" }];
	assert.match(validateBenchmark(data).errors.join("\n"), /blind review contains hidden/);
});

test("rejects an altered disabled baseline and an output different from the approved text", () => {
	const data = fixture();
	data.runs[0].before = "rewritten baseline";
	data.runs[0].after = "unreviewed addition";
	const errors = validateBenchmark(data).errors.join("\n");
	assert.match(errors, /changed the fixed baseline/);
	assert.match(errors, /output differs from the approved draft/);
});

test("rejects publishing a draft after failed review", () => {
	const data = fixture();
	Object.assign(data.runs[0], { status: "failed", error: "Review timed out" });
	assert.match(validateBenchmark(data).errors.join("\n"), /exposed an unapproved draft/);
});

test("requires approval to agree with the raw model response", () => {
	const data = fixture();
	data.runs[0].phases[0].response = '{"clear":false,"needsContext":true,"issues":["unknown term"]}';
	assert.match(validateBenchmark(data).errors.join("\n"), /parsed response differs/);
});

test("rejects silently duplicated runs instead of reporting them as extra coverage", () => {
	const data = fixture();
	data.runs.push(structuredClone(data.runs[0]));
	assert.match(validateBenchmark(data).errors.join("\n"), /duplicate id/);
	assert.match(validateBenchmark(data).errors.join("\n"), /duplicates a model\/task\/mode/);
});

test("rejects a lookup that bypasses the blind reader", () => {
	const data = fixture();
	const lookup = {
		phase: "lookup",
		request: { phase: "lookup", issues: ["term"], execution: [] },
		response: '{"facts":[]}',
		parsed: { facts: [] },
		durationMs: 2,
		stopReason: "stop",
	};
	data.runs[0].phases.unshift(lookup);
	Object.assign(data.runs[0].report, { calls: 2, lookedUpContext: true });
	assert.match(validateBenchmark(data).errors.join("\n"), /did not start by blindly reviewing/);
});

test("accepts a strict fenced approval without treating the fence as invalid JSON", () => {
	const data = fixture();
	data.runs[0].phases[0].response = `\x60\x60\x60json\n${data.runs[0].phases[0].response}\n\x60\x60\x60`;
	assert.deepEqual(validateBenchmark(data).errors, []);
});

test("requires the next independent review to see the actual rewrite", () => {
	const data = fixture();
	const run = data.runs[0];
	const first = structuredClone(run.phases[0]);
	first.parsed = { clear: false, needsContext: false, issues: ["Name the exported file"] };
	first.response = JSON.stringify(first.parsed);
	const text = "报表已经导出。";
	const rewritten = {
		phase: "rewrite",
		request: { phase: "rewrite", draft: run.before, visibleMessages: run.input, issues: first.parsed.issues },
		response: JSON.stringify({ text }),
		parsed: { text },
		durationMs: 4,
		stopReason: "stop",
	};
	const final = structuredClone(run.phases[0]);
	final.request.draft = text;
	run.phases = [first, rewritten, final];
	run.after = text;
	Object.assign(run.report, { calls: 3, revisions: 1 });
	assert.deepEqual(validateBenchmark(data).errors, []);
	final.request.draft = "Unrecorded replacement";
	run.after = final.request.draft;
	assert.match(validateBenchmark(data).errors.join("\n"), /did not use the actual previous draft/);
});

test("does not call a truncated generated baseline an approved comparison", () => {
	const data = fixture();
	data.runs[1].phases[0].stopReason = "length";
	assert.match(validateBenchmark(data).errors.join("\n"), /incomplete original generation/);
});

test("includes embedding catalog entries without requiring text generation attempts", () => {
	const data = fixture();
	data.models.push({
		id: "embedding-a",
		name: "Embedding A",
		type: "embeddings",
		excludedReason: "Cannot generate text",
	});
	const result = validateBenchmark(data);
	assert.deepEqual(result.errors, []);
	assert.equal(result.summary.models, 1);
	assert.equal(result.summary.excludedModels, 1);
	assert.equal(result.summary.expected, 2);
});

test("allows collecting runs locally but never publishes them as complete attempts", () => {
	const data = fixture();
	Object.assign(data.runs[0], { state: "running", status: "failed", after: null, report: null, phases: [] });
	data.methodology.complete = false;
	const partial = validateBenchmark(data, { allowPartial: true });
	assert.deepEqual(partial.errors, []);
	assert.equal(partial.summary.pending, 1);
	assert.equal(partial.summary.failed, 0);
	assert.match(validateBenchmark(data).errors.join("\n"), /is still running/);
	data.methodology.complete = true;
	assert.match(validateBenchmark(data, { allowPartial: true }).errors.join("\n"), /is still running/);
});
