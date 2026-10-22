import assert from 'node:assert/strict';
import test from 'node:test';
import { streamSimple } from '../packages/ai/src/api/openai-responses.ts';
import { normalizeContext } from '../packages/ai/src/utils/transcript.ts';
import { readFullTaskModelOptions } from './humanize-full-task-model-options.ts';

// Intercept the actual provider's serialized HTTP request. No proxy, model or network is contacted.
for (const effort of [undefined, 'low', 'medium', 'high']) {
  test(`Responses sends ${effort ?? 'no'} effort on both main and review requests`, async () => {
    const options = readFullTaskModelOptions(effort === undefined ? {} : { HUMANIZE_TASK_REASONING: effort });
    const model = {
      id: 'grok-4.7', name: 'grok-4.7', api: 'openai-responses', provider: 'humanize-full-task',
      baseUrl: 'http://127.0.0.1:1/v1', reasoning: options.modelReasoning, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 12000,
    };
    for (const sessionId of ['main', 'main:humanize:review']) {
      const requests = [];
      const message = await streamSimple(model, normalizeContext({
        messages: [{ role: 'user', content: 'fixture request', timestamp: 0 }],
      }), {
        apiKey: 'local-proxy', sessionId, cacheRetention: 'none', maxRetries: 0,
        reasoning: options.reasoning.effort ?? undefined,
        fetch: async (_url, init) => {
          requests.push(JSON.parse(String(init.body)));
          const item = {
            type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'fixture response', annotations: [] }],
          };
          const events = [
            { type: 'response.created', response: { id: 'resp_fixture' } },
            { type: 'response.output_item.added', output_index: 0, item },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed' } },
          ];
          return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
            status: 200, headers: { 'content-type': 'text/event-stream' },
          });
        },
      }).result();
      assert.equal(message.stopReason, 'stop', message.errorMessage);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].model, 'grok-4.7');
      if (effort === undefined) {
        assert.equal(Object.hasOwn(requests[0], 'reasoning'), false);
      } else {
        assert.deepEqual(requests[0].reasoning, { effort, summary: 'auto' });
      }
    }
  });
}
