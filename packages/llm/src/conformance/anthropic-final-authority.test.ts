import { describe, it, expect, vi } from 'vitest';
import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { FallbackChain, type AttemptRecord } from '../fallback-chain.js';
import type { Usage } from '../types.js';
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
describe('Anthropic actual-SDK final output authority', () => {
  for (const startOutput of [0, 2])
    for (const finalShape of [
      'omitted',
      'empty',
      'input-only',
      'null-usage',
      'null-output',
      'zero',
      'invalid',
      'output',
    ] as const) {
      it(`${startOutput}/${finalShape}: final output must establish settled cumulative output`, async () => {
        const initial = {
          input_tokens: 11,
          output_tokens: startOutput,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        };
        const finalUsage =
          finalShape === 'omitted'
            ? {}
            : {
                usage:
                  finalShape === 'empty'
                    ? {}
                    : finalShape === 'input-only'
                      ? { input_tokens: 11 }
                      : finalShape === 'null-usage'
                        ? null
                        : {
                            output_tokens:
                              finalShape === 'null-output'
                                ? null
                                : finalShape === 'zero'
                                  ? 0
                                  : finalShape === 'invalid'
                                    ? -1
                                    : 7,
                          },
              };
        const body =
          sse('message_start', {
            type: 'message_start',
            message: {
              id: 'msg_review',
              type: 'message',
              role: 'assistant',
              model: 'claude-review',
              content: [],
              stop_reason: null,
              usage: initial,
            },
          }) +
          sse('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }) +
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'completed output' },
          }) +
          sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
          sse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            ...finalUsage,
          }) +
          sse('message_stop', { type: 'message_stop' });
        const fetch = vi.fn(() =>
          Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } })),
        );
        const record = vi.fn((_m: string, u: Usage) => ({
          ...u,
          costMicrocents: u.inputTokens + u.outputTokens,
          cumulativeCostMicrocents: u.inputTokens + u.outputTokens,
        }));
        const attempts: AttemptRecord[] = [];
        const chain = new FallbackChain(
          [{ provider: createAnthropicAdapter({ fetch }), model: 'claude-review', maxAttempts: 1 }],
          {
            keyFor: () => 'offline-review',
            sleep: () => Promise.resolve(),
            costTracker: { record },
            onAttempt: (a) => {
              attempts.push(a);
            },
          },
        );
        for await (const chunk of chain.stream({
          model: 'claude-review',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'offline' }] }],
        }))
          expect(chunk.type).not.toBe('error');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(attempts).toHaveLength(1);
        if (finalShape === 'output' || finalShape === 'zero') {
          const outputTokens = finalShape === 'zero' ? 0 : 7;
          expect(attempts[0]?.usage).toMatchObject({
            kind: 'complete',
            usage: { inputTokens: 11, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
          });
          expect(record).toHaveBeenCalledExactlyOnceWith(
            'claude-review',
            expect.objectContaining({ inputTokens: 11, outputTokens }),
          );
        } else {
          expect(attempts[0]?.usage).toMatchObject({
            kind: 'partial',
            known: {
              inputTokens: 11,
              outputTokens: startOutput,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          });
          expect(record).not.toHaveBeenCalled();
        }
      });
    }
});
