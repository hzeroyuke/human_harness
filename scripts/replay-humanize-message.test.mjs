import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { replaySavedHumanize } from './replay-humanize-message.ts';

// These tests use captured provider responses already published with the task;
// mutations exercise refusal paths, and are never written as experiment results.
const dataset = JSON.parse(await readFile(new URL('../site/data/full-task.json', import.meta.url), 'utf8'));
const selection = { runId: 'mai-code-1.1-flash-complete-v1', roundId: '1', messageId: 'r1-message-16' };
const captured = dataset.runs.find(run => run.id === selection.runId);
assert(captured, 'The published MAI attempt is required for the replay regression tests');
const eventOf = run => run.rounds.find(round => round.id === selection.roundId).events.find(event => event.id === selection.messageId);

test('replays the real saved failure without changing the source run', async () => {
  const before = JSON.stringify(captured);
  const result = await replaySavedHumanize(captured, selection);
  assert.equal(result.protectionFailure.engineError, 'Humanize revision changed protected technical content.');
  assert.equal(result.protectionFailure.missingLiterals.length, 13);
  assert.deepEqual(result.protectionFailure.missingLiterals.slice(0, 3), ['430.20', '20.00', '410.20']);
  assert.equal(result.diagnostic.source, 'offline-replay');
  assert.deepEqual(result.protectionFailure.report, eventOf(captured).review.report);
  assert.equal(JSON.stringify(captured), before);
  assert.deepEqual(await replaySavedHumanize(dataset, selection), result);
});

test('refuses a different source version', async () => {
  const run = structuredClone(captured);
  run.source.humanizeSha256 = '0'.repeat(64);
  await assert.rejects(replaySavedHumanize(run, selection), /源码哈希不匹配/);
});

test('refuses missing or duplicate target identities', async () => {
  await assert.rejects(replaySavedHumanize(captured, { ...selection, messageId: 'unknown' }), /必须恰好包含一个/);
  await assert.rejects(replaySavedHumanize({ runs: [captured, captured] }, selection), /必须恰好包含一个/);
});

test('refuses original text that no longer matches the raw response', async () => {
  const run = structuredClone(captured);
  eventOf(run).review.original += '篡改';
  await assert.rejects(replaySavedHumanize(run, selection), /original 与原始响应不同/);
});

test('refuses changed prompts and payloads instead of silently replaying them', async () => {
  const promptRun = structuredClone(captured);
  eventOf(promptRun).review.phases[0].systemPrompt += 'Changed';
  await assert.rejects(replaySavedHumanize(promptRun, selection), /系统提示与已保存请求不一致/);
  const payloadRun = structuredClone(captured);
  eventOf(payloadRun).review.phases[1].request.issues = ['Changed'];
  await assert.rejects(replaySavedHumanize(payloadRun, selection), /载荷与已保存请求不一致/);
});

test('reconstructs visible conversation instead of trusting altered review history', async () => {
  const run = structuredClone(captured);
  eventOf(run).review.phases[0].request.visibleMessages[0].text = 'Different user message';
  await assert.rejects(replaySavedHumanize(run, selection), /载荷与已保存请求不一致/);
});

test('refuses a report that does not match the replay', async () => {
  const run = structuredClone(captured);
  eventOf(run).review.report.usage.output++;
  await assert.rejects(replaySavedHumanize(run, selection), /重放报告与原始报告不一致/);
});

test('refuses lookup and incomplete responses without inventing execution records', async () => {
  const lookupRun = structuredClone(captured);
  eventOf(lookupRun).review.phases.splice(1, 0, { phase: 'lookup' });
  await assert.rejects(replaySavedHumanize(lookupRun, selection), /暂只支持 review/);
  const incompleteRun = structuredClone(captured);
  eventOf(incompleteRun).review.phases[1].stopReason = 'length';
  await assert.rejects(replaySavedHumanize(incompleteRun, selection), /未完整结束/);
});

test('does not label invalid JSON or a candidate preserving literals as this failure', async () => {
  const invalidRun = structuredClone(captured);
  eventOf(invalidRun).review.phases[1].response = 'not JSON';
  await assert.rejects(replaySavedHumanize(invalidRun, selection), SyntaxError);
  const preservedRun = structuredClone(captured);
  const review = eventOf(preservedRun).review;
  review.phases[1].response = JSON.stringify({ text: review.original });
  await assert.rejects(replaySavedHumanize(preservedRun, selection), /没有发现丢失的受保护内容/);
});
