import assert from 'node:assert/strict';
import test from 'node:test';
import { readFullTaskModelOptions } from './humanize-full-task-model-options.ts';

const defaults = {
  modelReasoning: false,
  thinkingLevel: 'off',
  reasoning: { mode: 'upstream-unspecified', effort: null },
};

test('default preserves the old request behavior and records upstream effort as unspecified', () => {
  assert.deepEqual(readFullTaskModelOptions({}), defaults);
  assert.deepEqual(readFullTaskModelOptions({ HUMANIZE_TASK_MODEL: 'grok-4.7' }), defaults);
  assert.deepEqual(JSON.parse(JSON.stringify(readFullTaskModelOptions({}).reasoning)), defaults.reasoning);
});

for (const effort of ['low', 'medium', 'high']) {
  test(`accepts explicit ${effort} consistently for the model and session`, () => {
    assert.deepEqual(readFullTaskModelOptions({ HUMANIZE_TASK_REASONING: effort }), {
      modelReasoning: true,
      thinkingLevel: effort,
      reasoning: { mode: 'explicit', effort },
    });
  });
}

test('rejects unsupported levels, aliases and whitespace instead of silently falling back', () => {
  for (const value of ['', ' ', ' low', 'low ', 'low\n', 'LOW', 'off', 'none', 'minimal', 'xhigh', 'max', 'true', '0']) {
    assert.throws(() => readFullTaskModelOptions({ HUMANIZE_TASK_REASONING: value }), /HUMANIZE_TASK_REASONING/);
  }
});

test('resolves once without mutating the environment and freezes the recorded configuration', () => {
  const env = { HUMANIZE_TASK_REASONING: 'low' };
  const options = readFullTaskModelOptions(env);
  assert.deepEqual(env, { HUMANIZE_TASK_REASONING: 'low' });
  env.HUMANIZE_TASK_REASONING = 'high';
  assert.equal(options.thinkingLevel, 'low');
  assert.throws(() => { options.thinkingLevel = 'high'; }, TypeError);
  assert.throws(() => { options.reasoning.effort = 'high'; }, TypeError);
  assert.equal(readFullTaskModelOptions(env).thinkingLevel, 'high');
  assert.ok(Object.isFrozen(readFullTaskModelOptions({}).reasoning));
});
