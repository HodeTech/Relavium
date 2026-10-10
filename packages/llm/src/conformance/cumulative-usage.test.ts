import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGeminiAdapter } from '../adapters/gemini.js';
import { createOpenAiAdapter } from '../adapters/openai.js';
import type { StreamChunk } from '../types.js';
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
describe('installed SDK cumulative evidence never erases independent observations', () => {
  afterEach(() => vi.unstubAllGlobals());
  for (const provider of ['openai', 'deepseek', 'gemini'] as const)
    for (const ending of ['stop', 'truncated', 'error'] as const)
      for (const invalid of [false, true]) {
        it(`${provider}/${ending}/${invalid}: later incomplete usage retains earlier known quantities without becoming complete`, async () => {
          const terminal = ending === 'stop';
          const initial =
            provider === 'gemini'
              ? {
                  promptTokenCount: 10,
                  cachedContentTokenCount: 0,
                  candidatesTokenCount: 3,
                  thoughtsTokenCount: 0,
                }
              : {
                  prompt_tokens: 10,
                  prompt_tokens_details: { cached_tokens: 0 },
                  completion_tokens: 3,
                  ...(provider === 'deepseek'
                    ? { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 }
                    : {}),
                };
          const later =
            provider === 'gemini'
              ? { candidatesTokenCount: invalid ? -1 : 7 }
              : { completion_tokens: invalid ? -1 : 7 };
          const frame = (usage: unknown, done: boolean) =>
            provider === 'gemini'
              ? {
                  candidates: [
                    { content: { parts: [] }, ...(done ? { finishReason: 'STOP' } : {}) },
                  ],
                  usageMetadata: usage,
                }
              : {
                  id: 'cumulative',
                  choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : null }],
                  usage,
                };
          const body =
            sse(frame(initial, false)) +
            sse(frame(later, terminal)) +
            (ending === 'error'
              ? sse({ error: { code: 500, status: 'INTERNAL', message: 'stream failure' } })
              : provider === 'gemini'
                ? ''
                : 'data: [DONE]\n\n');
          const fetch = () =>
            Promise.resolve(
              new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
            );
          if (provider === 'gemini') vi.stubGlobal('fetch', fetch);
          const adapter =
            provider === 'gemini'
              ? createGeminiAdapter()
              : createOpenAiAdapter({ providerId: provider, fetch });
          let last: StreamChunk | undefined;
          for await (const chunk of adapter.stream(
            {
              model: provider === 'gemini' ? 'gemini-2.5-flash' : 'cumulative',
              messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
            },
            'offline',
          ))
            last = chunk;
          expect(last?.type).toBe(terminal ? 'stop' : 'error');
          const usage =
            last?.type === 'stop'
              ? last.usage
              : last?.type === 'error'
                ? last.error.usage
                : undefined;
          expect(usage).toMatchObject({
            kind: 'partial',
            known: {
              inputTokens: 10,
              cacheReadTokens: 0,
              outputTokens: invalid || provider === 'gemini' ? 3 : 7,
            },
          });
          if (invalid) expect(usage).toMatchObject({ reason: 'invalid_fields' });
          else if (provider === 'gemini')
            expect(usage).toMatchObject({ known: { reasoningTokens: 0 } });
          expect(Object.isFrozen(usage)).toBe(true);
        });
      }
});
