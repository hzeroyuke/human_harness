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

test('refuses incomplete lookup and other incomplete responses', async () => {
  const lookupRun = structuredClone(captured);
  eventOf(lookupRun).review.phases.splice(1, 0, { phase: 'lookup' });
  await assert.rejects(replaySavedHumanize(lookupRun, selection), /未完整结束/);
  const incompleteRun = structuredClone(captured);
  eventOf(incompleteRun).review.phases[1].stopReason = 'length';
  await assert.rejects(replaySavedHumanize(incompleteRun, selection), /未完整结束/);
});

const extendedSelection = { runId: 'mai-code-1.1-flash-extended-v1', roundId: '2', messageId: 'r2-message-12' };
const extended = dataset.runs.find(run => run.id === extendedSelection.runId);
assert(extended, 'The published extended MAI attempt is required for lookup replay tests');
const extendedEvent = run => run.rounds.find(round => round.id === extendedSelection.roundId).events.find(event => event.id === extendedSelection.messageId);

test('replays the real lookup failure, including bounded execution and the recorded SDK length refusal', async () => {
  const before = JSON.stringify(extended);
  const result = await replaySavedHumanize(extended, extendedSelection);
  assert.deepEqual(result.protectionFailure.missingLiterals, ['150.00']);
  assert.equal(result.diagnostic.phaseIndex, 2);
  assert.match(result.diagnostic.detail, /150\.00 元/);
  assert.deepEqual(result.protectionFailure.report, extendedEvent(extended).review.report);
  assert.equal(result.protectionFailure.report.lookedUpContext, true);
  assert.equal(result.protectionFailure.report.calls, 3);
  assert.equal(JSON.stringify(extended), before);
  assert.deepEqual(await replaySavedHumanize(dataset, extendedSelection), result);
});

test('rebuilds lookup execution from source tool events instead of trusting the saved payload', async () => {
  const run = structuredClone(extended);
  const lookup = extendedEvent(run).review.phases[1];
  lookup.request.execution.find(record => record.type === 'tool_result' && !record.isError).text = 'Altered result';
  await assert.rejects(replaySavedHumanize(run, extendedSelection), /载荷与已保存请求不一致/);
});

test('requires an exact match for the truncated execution boundary', async () => {
  const run = structuredClone(extended);
  const execution = extendedEvent(run).review.phases[1].request.execution;
  assert.equal(execution[0].type, 'truncated_record');
  execution[0].text = execution[0].text.slice(0, -1);
  await assert.rejects(replaySavedHumanize(run, extendedSelection), /载荷与已保存请求不一致/);
});

test('refuses missing or altered tool events while rebuilding execution', async () => {
  const missing = structuredClone(extended);
  const round = missing.rounds[1];
  round.events = round.events.filter(event => !(event.type === 'tool' && event.name === 'read_file'));
  await assert.rejects(replaySavedHumanize(missing, extendedSelection), /缺少唯一的实际工具执行记录/);
  const altered = structuredClone(extended);
  altered.rounds[1].events.find(event => event.type === 'tool').result = 'Altered source result';
  await assert.rejects(replaySavedHumanize(altered, extendedSelection), /载荷与已保存请求不一致/);
});

test('does not invent a tool result for the earlier output-length failure', async () => {
  const run = structuredClone(extended);
  const lookup = extendedEvent(run).review.phases[1];
  lookup.request.execution = lookup.request.execution.filter(record => !(record.type === 'tool_result' && record.isError));
  await assert.rejects(replaySavedHumanize(run, extendedSelection), /缺少唯一的已保存 SDK length 拒绝记录/);
});

test('checks lookup prompts, issues and rewrite evidence against the actual engine requests', async () => {
  for (const mutate of [
    review => { review.phases[1].systemPrompt += 'Changed'; },
    review => { review.phases[1].request.issues = ['Changed']; },
    review => { review.phases[2].request.evidence = ['Changed']; },
  ]) {
    const run = structuredClone(extended);
    mutate(extendedEvent(run).review);
    await assert.rejects(replaySavedHumanize(run, extendedSelection), /与已保存请求不一致/);
  }
});

test('refuses invalid lookup JSON and facts schema', async () => {
  for (const response of ['not JSON', '{}', '{"facts":[1]}', '{"facts":[],"extra":true}', JSON.stringify({ facts: Array(33).fill('fact') })]) {
    const run = structuredClone(extended);
    extendedEvent(run).review.phases[1].response = response;
    await assert.rejects(replaySavedHumanize(run, extendedSelection), /重放不是内容保护失败/);
  }
});

test('refuses additional lookup or rewrite cycles and incomplete lookup responses', async () => {
  const extra = structuredClone(extended);
  extendedEvent(extra).review.phases.splice(2, 0, structuredClone(extendedEvent(extra).review.phases[1]));
  await assert.rejects(replaySavedHumanize(extra, extendedSelection), /暂只支持 review/);
  const incomplete = structuredClone(extended);
  extendedEvent(incomplete).review.phases[1].stopReason = 'aborted';
  await assert.rejects(replaySavedHumanize(incomplete, extendedSelection), /未完整结束/);
});

test('checks cross-round released history and the lookup report', async () => {
  const history = structuredClone(extended);
  history.rounds[0].events.find(event => event.type === 'assistant' && !event.isError && event.text).text += 'Changed';
  await assert.rejects(replaySavedHumanize(history, extendedSelection), /载荷与已保存请求不一致/);
  const report = structuredClone(extended);
  extendedEvent(report).review.report.lookedUpContext = false;
  await assert.rejects(replaySavedHumanize(report, extendedSelection), /lookup 状态与保存的阶段不同/);
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


const grokSelection = { runId: 'grok-4.7-low-v1', roundId: '2', messageId: 'r2-message-7' };
const grok = dataset.runs.find(run => run.id === grokSelection.runId);
assert(grok, 'The published Grok low attempt is required for second-rewrite replay tests');
const grokEvent = run => run.rounds.find(round => round.id === grokSelection.roundId).events.find(event => event.id === grokSelection.messageId);

test('replays the real second-rewrite failure while preserving exact numeric and time evidence', async () => {
  const before = JSON.stringify(grok);
  const review = grokEvent(grok).review;
  assert.deepEqual(review.phases.map(phase => phase.phase), ['review', 'rewrite', 'review', 'rewrite']);
  assert(JSON.parse(review.phases[1].response).text.includes('23:59:59'));
  assert(!JSON.parse(review.phases[3].response).text.includes('23:59:59'));
  const result = await replaySavedHumanize(grok, grokSelection);
  assert.deepEqual(result.protectionFailure.missingLiterals, ['23', '59']);
  assert.equal(result.protectionFailure.engineError, 'Humanize revision changed protected technical content.');
  assert.equal(result.diagnostic.phaseIndex, 3);
  assert.match(result.diagnostic.detail, /时间 23:59:59/);
  assert.deepEqual(result.protectionFailure.report, review.report);
  assert.equal(result.protectionFailure.report.calls, 4);
  assert.equal(result.protectionFailure.report.revisions, 1);
  assert.equal(result.protectionFailure.report.lookedUpContext, false);
  assert.equal(JSON.stringify(grok), before);
  assert.deepEqual(await replaySavedHumanize(dataset, grokSelection), result);
});

test('requires exact draft continuity, prompts and visible history in the second review cycle', async () => {
  for (const mutate of [
    review => { review.phases[2].request.draft += 'Changed'; },
    review => { review.phases[3].request.draft += 'Changed'; },
    review => { review.phases[2].systemPrompt += 'Changed'; },
    review => { review.phases[2].request.visibleMessages[0].text += 'Changed'; },
    review => { review.phases[3].request.issues = ['Changed']; },
    review => { review.phases[1].response = JSON.stringify({ text: JSON.parse(review.phases[1].response).text + 'Changed' }); },
  ]) {
    const run = structuredClone(grok);
    mutate(grokEvent(run).review);
    await assert.rejects(replaySavedHumanize(run, grokSelection), /与已保存请求不一致/);
  }
});

test('refuses execution or evidence injected into a saved cycle without lookup', async () => {
  for (const mutate of [
    review => { review.phases[2].request.execution = [{ type: 'tool_result', text: 'Not executed' }]; },
    review => { review.phases[3].request.evidence = ['Unsupported evidence']; },
  ]) {
    const run = structuredClone(grok);
    mutate(grokEvent(run).review);
    await assert.rejects(replaySavedHumanize(run, grokSelection), /载荷与已保存请求不一致/);
  }
});

test('does not attribute an earlier protection failure to the second rewrite', async () => {
  const run = structuredClone(grok);
  const review = grokEvent(run).review;
  review.phases[1].response = JSON.stringify({ text: JSON.parse(review.phases[1].response).text.replaceAll('23:59:59', '当天结束前') });
  await assert.rejects(replaySavedHumanize(run, grokSelection), /保存响应未被恰好重放一次/);
});

test('refuses an approval that would have ended the sequence before the second rewrite', async () => {
  const run = structuredClone(grok);
  grokEvent(run).review.phases[2].response = JSON.stringify({ clear: true, needsContext: false, issues: [] });
  await assert.rejects(replaySavedHumanize(run, grokSelection), /本地重放未失败/);
});

test('requires the second-rewrite report counts, lookup state and combined usage to match', async () => {
  for (const mutate of [
    report => { report.revisions = 0; },
    report => { report.calls = 3; },
    report => { report.lookedUpContext = true; },
    report => { report.usage.output++; },
  ]) {
    const run = structuredClone(grok);
    mutate(grokEvent(run).review.report);
    await assert.rejects(replaySavedHumanize(run, grokSelection), /修订次数|调用次数|lookup 状态|重放报告与原始报告不一致/);
  }
});

test('refuses additional cycles, lookup substitutions and incomplete second-cycle responses', async () => {
  const extra = structuredClone(grok);
  grokEvent(extra).review.phases.push(...structuredClone(grokEvent(extra).review.phases.slice(2)));
  await assert.rejects(replaySavedHumanize(extra, grokSelection), /暂只支持 review/);
  const lookup = structuredClone(grok);
  grokEvent(lookup).review.phases[2].phase = 'lookup';
  await assert.rejects(replaySavedHumanize(lookup, grokSelection), /暂只支持 review/);
  for (const index of [2, 3]) {
    const incomplete = structuredClone(grok);
    grokEvent(incomplete).review.phases[index].stopReason = 'length';
    await assert.rejects(replaySavedHumanize(incomplete, grokSelection), /未完整结束/);
  }
});

test('does not diagnose a second candidate that keeps the original protected literals', async () => {
  const run = structuredClone(grok);
  const review = grokEvent(run).review;
  review.phases[3].response = JSON.stringify({ text: review.original });
  await assert.rejects(replaySavedHumanize(run, grokSelection), /没有发现丢失的受保护内容/);
});
