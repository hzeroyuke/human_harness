import assert from 'node:assert/strict';
import test from 'node:test';
import { readFullTaskLimits } from './humanize-full-task-limits.ts';

const defaults = {
  maxRevisions: 2,
  reviewTimeoutMs: 120000,
  requestTimeoutMs: 90000,
  roundTimeoutMs: 720000,
  maxAgentCallsPerRound: 45,
};
const settings = [
  ['HUMANIZE_TASK_REVIEW_TIMEOUT_MS', 'reviewTimeoutMs', 300000],
  ['HUMANIZE_TASK_REQUEST_TIMEOUT_MS', 'requestTimeoutMs', 300000],
  ['HUMANIZE_TASK_ROUND_TIMEOUT_MS', 'roundTimeoutMs', 3600000],
  ['HUMANIZE_TASK_MAX_AGENT_CALLS', 'maxAgentCallsPerRound', 200],
];

test('keeps the original runtime limits when no override is provided', () => {
  assert.deepEqual(readFullTaskLimits({}), defaults);
  assert.deepEqual(readFullTaskLimits({ PATH: '/unused', HUMANIZE_TASK_MODEL: 'irrelevant' }), defaults);
});

test('accepts the requested longer batch without changing the revision limit', () => {
  assert.deepEqual(readFullTaskLimits({
    HUMANIZE_TASK_REVIEW_TIMEOUT_MS: '300000',
    HUMANIZE_TASK_REQUEST_TIMEOUT_MS: '180000',
    HUMANIZE_TASK_ROUND_TIMEOUT_MS: '1800000',
    HUMANIZE_TASK_MAX_AGENT_CALLS: '60',
  }), {
    maxRevisions: 2,
    reviewTimeoutMs: 300000,
    requestTimeoutMs: 180000,
    roundTimeoutMs: 1800000,
    maxAgentCallsPerRound: 60,
  });
});

for (const [key, field, maximum] of settings) {
  test(`${key}: inclusive bounds and independent defaults`, () => {
    assert.deepEqual(readFullTaskLimits({ [key]: '1' }), { ...defaults, [field]: 1 });
    assert.deepEqual(readFullTaskLimits({ [key]: String(maximum) }), { ...defaults, [field]: maximum });
  });

  test(`${key}: rejects malformed, zero, excessive and unsafe values`, () => {
    for (const value of ['', ' ', ' 60', '60 ', '+60', '-1', '0', '01', '1.5', '1e3', '0x10', 'NaN', 'Infinity', String(maximum + 1), '9007199254740993', '9'.repeat(1000)]) {
      assert.throws(() => readFullTaskLimits({ [key]: value }), error => error.message.includes(key));
    }
  });
}

test('resolves once without mutating the environment and freezes the result', () => {
  const env = { HUMANIZE_TASK_MAX_AGENT_CALLS: '60' };
  const limits = readFullTaskLimits(env);
  assert.deepEqual(env, { HUMANIZE_TASK_MAX_AGENT_CALLS: '60' });
  env.HUMANIZE_TASK_MAX_AGENT_CALLS = '70';
  assert.equal(limits.maxAgentCallsPerRound, 60);
  assert.throws(() => { limits.maxAgentCallsPerRound = 70; }, TypeError);
  assert.equal(readFullTaskLimits(env).maxAgentCallsPerRound, 70);
});
