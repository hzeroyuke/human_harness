import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportPersonalSamples, fingerprint, replayPersonalSamples, sha256, validateDataset } from "./humanize-personal-data.ts";
import { parsePersonalArgs, runPersonalCli } from "./humanize-personal.ts";
import { HumanizeTraceRecorder, takeHumanizeTrace } from "../packages/coding-agent/src/core/humanize-records.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { provider: "test-personal", id: "reader", api: "openai-responses" };
const message = (text, content = []) => ({ role: "assistant", api: model.api, provider: "source-provider", model: "source-model", content: [{ type: "text", text }, ...content], stopReason: content.length ? "toolUse" : "stop", usage: structuredClone(usage), timestamp: 1 });
const answer = value => ({ ...message(typeof value === "string" ? value : JSON.stringify(value)), provider: model.provider, model: model.id });
const clear = { clear: true, needsContext: false, issues: [] };

function trace(id = "trace-1", changes = {}) {
  return {
    schemaVersion: 1, traceId: id, sessionId: "session-1", messageEntryId: `msg-${id}`, contextLeafId: "user-1",
    createdAt: "2026-10-22T00:00:00.000Z", completedAt: "2026-10-22T00:00:01.000Z", durationMs: 1000,
    model: { provider: "source-provider", id: "source-model", api: model.api }, readerModel: model,
    settings: { maxRevisions: 2, timeoutMs: 1000, maxContextChars: 48000 },
    original: "已处理 3 笔退款。", originalMessage: message("已处理 3 笔退款。"),
    visibleMessages: [{ role: "user", text: "退款处理完了吗？" }], executionMessages: [],
    contextSnapshot: { maxChars: 192000, visibleComplete: true, executionComplete: true, executionReason: "complete" },
    phases: [], report: { status: "approved", revisions: 0, calls: 1, lookedUpContext: false, usage },
    status: "approved", error: null, reviewedFinal: "已处理 3 笔退款。", final: "已处理 3 笔退款。", deliveryChanged: false,
    source: { packageVersion: "test", humanizeSha256: "b".repeat(64), format: "typescript" },
    ...changes,
  };
}

function feedback(item, changes = {}) {
  return { schemaVersion: 1, traceId: item.traceId, sessionId: item.sessionId, messageEntryId: item.messageEntryId, rating: "bad", tags: ["unclear"], note: "请解释处理是什么意思", expected: "说明已退款还是仅登记", createdAt: "2026-10-22T00:02:00.000Z", ...changes };
}

function session(traces = [trace()], feedbacks = []) {
  return [
    { type: "session", id: "session-1", version: 3, timestamp: "2026-10-22T00:00:00.000Z", cwd: "/not-exported/private-path" },
    { type: "message", id: "user-1", parentId: null, timestamp: "2026-10-22T00:00:00.000Z", message: { role: "user", content: "退款处理完了吗？", timestamp: 0 } },
    ...traces.flatMap(item => [
      { type: "message", id: item.messageEntryId, parentId: "user-1", message: { ...message(item.final ?? ""), content: item.final === null ? [] : [{ type: "text", text: item.final }], stopReason: item.final === null ? "error" : "stop" } },
      { type: "custom", id: `entry-${item.traceId}`, parentId: item.messageEntryId, customType: "humanize_trace", data: item },
    ]),
    ...feedbacks.map((item, index) => ({ type: "custom", id: `feedback-${index}`, customType: "humanize_feedback", data: item })),
  ].map(item => JSON.stringify(item)).join("\n") + "\n";
}

function replay(dataset, complete, options = {}) {
  return replayPersonalSamples(dataset, { model, complete }, { sourceDatasetSha256: fingerprint(dataset), coreSha256: "a".repeat(64), ...options });
}

test("export associates exact entries and preserves original, reviewed, delivered and feedback separately", () => {
  const item = trace("trace-1", { final: "扩展实际发出：已处理 3 笔退款。", deliveryChanged: true });
  const text = session([item], [feedback(item)]);
  const result = exportPersonalSamples([text]);
  assert.deepEqual(result.samples[0].trace, item);
  assert.equal(result.samples[0].source.traceEntryId, "entry-trace-1");
  assert.equal(result.samples[0].source.traceSha256, fingerprint(item));
  assert.equal(result.samples[0].source.sessionSha256, sha256(text));
  assert.equal(result.samples[0].feedback[0].expected, "说明已退款还是仅登记");
  assert.ok(!JSON.stringify(result).includes("/not-exported/private-path"));
  assert.throws(() => { result.samples[0].trace.original = "changed"; }, TypeError);
});

test("current core recorder traces can be exported and replayed without schema guesses", async () => {
  const originalMessage = message("已处理 3 笔退款。");
  const recorder = new HumanizeTraceRecorder({ sessionId: "session-1", contextLeafId: "user-1", message: originalMessage, visibleMessages: [{ role: "user", text: "处理结果呢？" }], executionMessages: [{ ...message("先前请求失败。"), stopReason: "error" }] });
  recorder.setReaderModel(model);
  recorder.approve(originalMessage, { status: "approved", revisions: 0, calls: 1, lookedUpContext: false, usage });
  recorder.finish(originalMessage);
  const recorded = takeHumanizeTrace(originalMessage, "session-1", "msg-recorded");
  assert.ok(recorded);
  const dataset = exportPersonalSamples([session([recorded], [feedback(recorded)])]);
  assert.equal(dataset.samples[0].trace.contextSnapshot.maxChars, 192000);
  assert.equal(dataset.samples[0].trace.source.format, "typescript");
  assert.equal((await replay(dataset, async () => answer(clear))).results[0].status, "approved");
});

test("a captured length-limited source exports as failed and replay never completes the original task", async () => {
  const item = trace("cut-off", { originalMessage: { ...message("已处理 3 笔退款。"), stopReason: "length" }, status: "failed", reviewedFinal: null, final: null, error: "Humanize requires a completed text message.", report: null });
  const dataset = exportPersonalSamples([session([item])], { problemsOnly: true });
  assert.equal(dataset.samples.length, 1);
  let calls = 0;
  const result = await replay(dataset, async () => { calls++; return answer(clear); });
  assert.equal(calls, 0);
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].error, /requires a completed text message/);
  assert.equal(result.results[0].newFinal, null);
});

test("real fork and branch copies do not duplicate old traces or block directory export", async () => {
  const directory = await mkdtemp(join(tmpdir(), "humanize-personal-branch-"));
  try {
    const source = join(directory, "original.jsonl");
    await writeFile(source, session([trace()], [feedback(trace())]));
    const forked = SessionManager.forkFrom(source, directory, directory);
    const forkText = await readFile(forked.getSessionFile(), "utf8");
    const original = SessionManager.open(source, directory);
    const branchFile = original.createBranchedSession("entry-trace-1");
    const branchText = await readFile(branchFile, "utf8");
    const dataset = exportPersonalSamples([forkText, branchText, await readFile(source, "utf8")]);
    assert.equal(dataset.samples.length, 1);
    assert.equal(dataset.samples[0].source.sessionId, "session-1");
    assert.deepEqual(dataset.sources.map(item => [item.inheritedTraces, item.inheritedFeedback]), [[1, 1], [1, 0], [0, 0]]);
    const nested = join(directory, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "ignore.txt"), "not a session");
    const exported = join(directory, "samples.json");
    await runPersonalCli(["export", directory, "--output", exported], { log: () => {} });
    assert.equal(JSON.parse(await readFile(exported, "utf8")).samples.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("identical text in different messages stays distinct; feedback never joins by text", () => {
  const first = trace("same-1"), second = trace("same-2");
  const dataset = exportPersonalSamples([session([first, second], [feedback(second)])]);
  assert.deepEqual(dataset.samples.map(sample => [sample.id, sample.feedback.length]), [["same-1", 0], ["same-2", 1]]);
});

test("problem selection keeps failures, marked issues and a deterministic normal control", () => {
  const normal = trace("a-normal"), bad = trace("b-bad"), failed = trace("c-failed", { status: "failed", final: null, reviewedFinal: null, error: "review failed", report: null });
  const extra = trace("d-normal");
  const text = session([extra, failed, bad, normal], [feedback(bad)]);
  assert.deepEqual(exportPersonalSamples([text], { problemsOnly: true }).samples.map(sample => sample.id), ["b-bad", "c-failed"]);
  assert.deepEqual(exportPersonalSamples([text], { problemsOnly: true, keepNormal: 1 }).samples.map(sample => sample.id), ["a-normal", "b-bad", "c-failed"]);
  assert.equal(exportPersonalSamples([text]).samples.length, 4);
});

test("replay uses original draft, not the old final, and records source fingerprints", async () => {
  const item = trace("trace-1", { final: "已将 3 笔退款退回原账户。", reviewedFinal: "已将 3 笔退款退回原账户。" });
  const dataset = exportPersonalSamples([session([item])]);
  const before = JSON.stringify(dataset);
  const result = await replay(dataset, async (_system, payload) => {
    assert.equal(payload.draft, item.original);
    assert.deepEqual(payload.visibleMessages, item.visibleMessages);
    assert.ok(!Object.hasOwn(payload, "execution"));
    payload.draft = "provider mutation";
    return answer(clear);
  });
  assert.equal(result.results[0].oldFinal, item.final);
  assert.equal(result.results[0].newFinal, item.original);
  assert.equal(result.results[0].originalSha256, fingerprint(item.originalMessage));
  assert.equal(result.results[0].sourceTraceSha256, fingerprint(item));
  assert.equal(result.results[0].phases[0].request.draft, item.original);
  assert.deepEqual(result.results[0].usage, usage);
  assert.equal(JSON.stringify(dataset), before);
});

test("saved tool calls remain inert and only requested lookup sees saved execution text", async () => {
  const original = "已将 3 笔退款放入待退款名单。";
  const dangerousCall = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "touch /should-never-be-executed" } };
  const item = trace("trace-1", { original, originalMessage: message(original, [dangerousCall]), executionMessages: [message("已登记，尚未退款。", [dangerousCall]), { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "退款名单含 3 笔，尚未执行转账。" }], isError: false, timestamp: 1 }] });
  const phases = [];
  const result = await replay(exportPersonalSamples([session([item])]), async (_system, payload) => {
    phases.push(payload.phase);
    if (payload.phase === "review" && phases.length === 1) {
      assert.ok(!JSON.stringify(payload).includes("should-never"));
      return answer({ clear: false, needsContext: true, issues: ["退款是否已经到账？"] });
    }
    if (payload.phase === "lookup") {
      assert.ok(JSON.stringify(payload.execution).includes("should-never-be-executed"));
      return answer({ facts: ["只是登记 3 笔退款，没有执行转账。"] });
    }
    if (payload.phase === "rewrite") {
      assert.ok(!Object.hasOwn(payload, "execution"));
      return answer({ text: "已将 3 笔退款放入待退款名单，尚未执行转账。" });
    }
    return answer(clear);
  });
  assert.deepEqual(phases, ["review", "lookup", "rewrite", "review"]);
  assert.equal(result.results[0].status, "approved");
  assert.equal(result.results[0].report.lookedUpContext, true);
  assert.equal(result.results[0].report.calls, 4);
});

test("missing execution snapshot fails only when reader requests it; no guessed empty context", async () => {
  const item = trace("trace-1", { executionMessages: null, contextSnapshot: { maxChars: 192000, visibleComplete: true, executionComplete: false, executionReason: "size-limit" } });
  const dataset = exportPersonalSamples([session([item])]);
  assert.equal((await replay(dataset, async () => answer(clear))).results[0].status, "approved");
  let calls = 0;
  const result = await replay(dataset, async () => { calls++; return answer({ clear: false, needsContext: true, issues: ["处理具体意味着什么？"] }); });
  assert.equal(calls, 1);
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].error, /未完整保存/);
  assert.equal(result.results[0].newFinal, null);
});

test("source-bounded visible context is replayed at the same recorded budget", async () => {
  const item = trace("trace-1", { visibleMessages: [{ role: "user", text: "原可见上下文的尾部" }], contextSnapshot: { maxChars: 192000, visibleComplete: false, executionComplete: true, executionReason: "complete" } });
  const result = await replay(exportPersonalSamples([session([item])]), async (_system, payload) => {
    assert.deepEqual(payload.visibleMessages, item.visibleMessages);
    return answer(clear);
  });
  assert.equal(result.results[0].status, "approved");
});

test("one model failure is retained and later samples continue without exposing exception credentials", async () => {
  const dataset = exportPersonalSamples([session([trace("a"), trace("b")])]);
  let calls = 0;
  const result = await replay(dataset, async () => {
    if (++calls === 1) throw new Error("Authorization: Bearer secret-test-key");
    return answer(clear);
  });
  assert.deepEqual(result.results.map(item => item.status), ["failed", "approved"]);
  assert.equal(result.results[0].newFinal, null);
  assert.match(result.results[0].error, /模型调用失败/);
  assert.ok(!JSON.stringify(result).includes("secret-test-key"));
});

test("empty model response has a distinct explanation and retained usage", async () => {
  const result = await replay(exportPersonalSamples([session()]), async () => answer(""));
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].error, /空文本/);
  assert.deepEqual(result.results[0].usage, usage);
  assert.equal(result.results[0].phases[0].response, "");
});

test("core protected-content failure retains candidate but never labels it a final", async () => {
  let calls = 0;
  const result = await replay(exportPersonalSamples([session()]), async () => answer(++calls === 1 ? { clear: false, needsContext: false, issues: ["需要更清楚"] } : { text: "已处理退款。" }));
  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[0].newFinal, null);
  assert.match(result.results[0].error, /protected technical content/);
  assert.equal(result.results[0].phases[1].response, '{"text":"已处理退款。"}');
});

test("timeout snapshot does not change when a late provider response arrives", async () => {
  const item = trace("trace-1", { settings: { maxRevisions: 2, timeoutMs: 5, maxContextChars: 48000 } });
  const result = await replay(exportPersonalSamples([session([item])]), async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return answer(clear);
  });
  assert.match(result.results[0].error, /timed out/);
  const snapshot = JSON.stringify(result);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(JSON.stringify(result), snapshot);
  assert.equal(result.results[0].phases[0].response, null);
});

test("bad JSONL, missing context and wrong source correspondence fail before a reader can run", () => {
  assert.throws(() => exportPersonalSamples(["{invalid"]), /JSONL 第 1 行/);
  assert.throws(() => exportPersonalSamples([JSON.stringify({ type: "message", id: "x" })]), /session header/);
  for (const change of [
    { original: "unrelated draft" }, { visibleMessages: undefined }, { executionMessages: undefined },
    { originalMessage: { ...message("已处理 3 笔退款。"), content: [{ type: "thinking", thinking: "private" }] } },
    { sessionId: "other-session" }, { messageEntryId: "not-saved" },
  ]) {
    const entries = session().trim().split("\n").map(line => JSON.parse(line));
    Object.assign(entries.at(-1).data, change);
    assert.throws(() => exportPersonalSamples([entries.map(entry => JSON.stringify(entry)).join("\n")]), /个人样本无效/);
  }
});

test("delivered-text mismatch, foreign feedback and duplicate IDs are rejected", () => {
  const entries = session().trim().split("\n").map(line => JSON.parse(line));
  entries.find(entry => entry.id === "msg-trace-1").message.content[0].text = "other final";
  assert.throws(() => exportPersonalSamples([entries.map(entry => JSON.stringify(entry)).join("\n")]), /实际文字不一致/);
  assert.throws(() => exportPersonalSamples([session([trace()], [feedback(trace(), { messageEntryId: "another" })])]), /不一致/);
  assert.throws(() => exportPersonalSamples([session([trace()], [feedback(trace(), { traceId: "unknown" })])]), /不存在的 trace/);
  assert.throws(() => exportPersonalSamples([session(), session()]), /重复 sessionId/);
});

test("changed exported trace cannot be replayed using an old fingerprint", async () => {
  const dataset = structuredClone(exportPersonalSamples([session()]));
  dataset.samples[0].trace.visibleMessages[0].text = "changed conversation";
  let calls = 0;
  await assert.rejects(() => replay(dataset, async () => { calls++; return answer(clear); }), /指纹不匹配/);
  assert.equal(calls, 0);
});

test("trace selection is exact and cannot silently run all samples for a missing ID", async () => {
  const dataset = exportPersonalSamples([session([trace("a"), trace("b")])]);
  const result = await replay(dataset, async () => answer(clear), { traceIds: ["b"] });
  assert.deepEqual(result.results.map(item => item.sourceTraceId), ["b"]);
  await assert.rejects(() => replay(dataset, async () => answer(clear), { traceIds: ["missing"] }), /不存在/);
});

test("CLI strictly requires nonempty model selection and rejects contradictory flags", () => {
  for (const args of [
    ["replay", "samples.json", "--output", "new.json"],
    ["replay", "samples.json", "--provider", "p", "--model", "", "--output", "new.json"],
    ["export", "sessions", "--output", "new.json", "--keep-normal", "1"],
    ["export", "sessions", "--output", "new.json", "--problems-only", "--keep-normal", "1.5"],
    ["export", "same.json", "--output", "same.json"],
    ["export", "sessions", "--output", "new.json", "--provider", "p"],
  ]) assert.throws(() => parsePersonalArgs(args));
  assert.equal(parsePersonalArgs(["replay", "samples.json", "--provider", "p", "--model", "m", "--output", "new.json"]).model, "m");
});

test("CLI export and replay leave both inputs byte-identical and refuse existing outputs before calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "humanize-personal-"));
  try {
    const source = join(directory, "session.jsonl"), exported = join(directory, "samples.json"), output = join(directory, "replay.json");
    const text = session();
    await writeFile(source, text);
    const log = () => {};
    await runPersonalCli(["export", source, "--output", exported], { log });
    const originalExport = await readFile(exported, "utf8");
    validateDataset(JSON.parse(originalExport));
    let creates = 0;
    const deps = { log, createReader: async (provider, id) => {
      creates++; assert.equal(provider, "personal"); assert.equal(id, "chosen");
      return { model: { provider, id, api: model.api }, complete: async () => answer(clear) };
    } };
    const args = ["replay", exported, "--provider", "personal", "--model", "chosen", "--output", output];
    await runPersonalCli(args, deps);
    const result = JSON.parse(await readFile(output, "utf8"));
    assert.equal(result.sourceDatasetSha256, sha256(originalExport));
    assert.equal(result.results[0].status, "approved");
    assert.equal(await readFile(source, "utf8"), text);
    assert.equal(await readFile(exported, "utf8"), originalExport);
    await assert.rejects(() => runPersonalCli(args, deps), /已经存在/);
    assert.equal(creates, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI uses personal runtime and SDK-equivalent bounded SSE requests with unique review sessions and no tools", async context => {
  const directory = await mkdtemp(join(tmpdir(), "humanize-personal-reader-"));
  try {
    const input = join(directory, "samples.json");
    await writeFile(input, JSON.stringify(exportPersonalSamples([session([trace("a"), trace("b")])])));
    const sessionIds = new Set();
    const calls = [];
    let maxTokens = 16384;
    context.mock.method(ModelRuntime, "create", async options => {
      assert.deepEqual(options, { allowModelNetwork: false });
      const selected = { ...model, maxTokens };
      return {
        getError: () => undefined,
        getPhysicalModel: (provider, id) => { assert.equal(provider, model.provider); assert.equal(id, model.id); return selected; },
        hasConfiguredAuth: provider => provider === model.provider,
        completeSimple: async (chosen, request, options) => {
          assert.equal(chosen, selected);
          assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
          assert.equal(JSON.parse(request.messages[1].content).phase, "review");
          assert.equal(request.tools, undefined);
          assert.equal(options.maxTokens, Math.min(8192, selected.maxTokens));
          assert.equal(options.transport, "sse");
          assert.equal(options.cacheRetention, "none");
          assert.equal(options.maxRetries, 0);
          assert.ok(options.signal instanceof AbortSignal);
          assert.ok(!sessionIds.has(options.sessionId));
          sessionIds.add(options.sessionId);
          calls.push(options);
          return answer(clear);
        },
      };
    });
    for (const budget of [16384, 4096]) {
      maxTokens = budget;
      await runPersonalCli(["replay", input, "--provider", model.provider, "--model", model.id, "--output", join(directory, `result-${budget}.json`)], { log: () => {} });
    }
    assert.equal(calls.length, 4);
    assert.equal(sessionIds.size, 4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("CLI rejects missing or non-directory output parents before creating a reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "humanize-personal-parent-"));
  try {
    const input = join(directory, "samples.json"), regularFile = join(directory, "not-a-directory");
    await writeFile(input, JSON.stringify(exportPersonalSamples([session()])));
    await writeFile(regularFile, "unchanged");
    let creates = 0;
    const dependencies = { log: () => {}, createReader: async () => {
      creates++;
      return { model, complete: async () => answer(clear) };
    } };
    for (const [output, expected] of [
      [join(directory, "missing", "result.json"), /输出父目录不存在/],
      [join(regularFile, "result.json"), /输出父路径不是目录/],
    ]) {
      await assert.rejects(() => runPersonalCli(["replay", input, "--provider", model.provider, "--model", model.id, "--output", output], dependencies), expected);
      assert.equal(creates, 0);
    }
    assert.equal(await readFile(regularFile, "utf8"), "unchanged");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
