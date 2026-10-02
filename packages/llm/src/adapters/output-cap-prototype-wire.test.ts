import { describe, expect, it, vi } from 'vitest';

import { createOpenAiAdapter } from './openai.js';
import { createGeminiAdapter } from './gemini.js';
import { FallbackChain } from '../fallback-chain.js';
import { outputTokensReservation } from '../output-cap.js';
import type { LlmProvider, LlmRequest } from '../types.js';

const messages: LlmRequest['messages'] = [
  { role: 'user', content: [{ type: 'text', text: 'offline' }] },
];
const routes = [
  { provider: 'openai', field: 'max_tokens' },
  { provider: 'openai', field: 'max_completion_tokens' },
  { provider: 'custom-openai', field: 'max_tokens' },
  { provider: 'custom-openai', field: 'max_completion_tokens' },
  { provider: 'deepseek', field: 'max_tokens' },
  { provider: 'gemini', field: 'maxOutputTokens' },
] as const;
type Route = (typeof routes)[number]['provider'];
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function captureHttp(
  provider: Route,
  path: 'generate' | 'stream',
): { adapter: LlmProvider; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const openai = {
    id: 'c',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok', refusal: null },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  const gemini = {
    candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  };
  const fetch = (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (typeof init?.body !== 'string') throw new Error('expected JSON HTTP body');
    const parsed: unknown = JSON.parse(init.body);
    if (!record(parsed)) throw new Error('expected JSON object');
    bodies.push(parsed);
    const streamBody =
      provider === 'gemini'
        ? `data: ${JSON.stringify(gemini)}\n\n`
        : 'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    return Promise.resolve(
      new Response(
        path === 'stream' ? streamBody : JSON.stringify(provider === 'gemini' ? gemini : openai),
        {
          headers: { 'content-type': path === 'stream' ? 'text/event-stream' : 'application/json' },
        },
      ),
    );
  };
  if (provider === 'gemini') {
    // Use the installed SDK's actual config-to-HTTP lowering, rather than GeminiTransport.
    vi.stubGlobal('fetch', fetch);
    return { adapter: createGeminiAdapter(), bodies };
  }
  return {
    adapter: createOpenAiAdapter({
      providerId: provider === 'deepseek' ? 'deepseek' : 'openai',
      fetch,
      ...(provider === 'custom-openai' ? { baseURL: 'https://gateway.example/v1' } : {}),
    }),
    bodies,
  };
}

describe('captured native JSON resists inherited serializers across SDK awaits (ADR-0101)', () => {
  for (const path of ['generate', 'stream'] as const) {
    for (const shape of ['array', 'object'] as const) {
      for (const { provider, field } of routes) {
        for (const variant of ['control', 'new-property', 'existing-property'] as const) {
          it(`${provider}/${field} ${path} ${shape} ${variant} preserves the captured JSON shape`, async () => {
            const { adapter, bodies } = captureHttp(provider, path);
            const prototype = shape === 'array' ? Array.prototype : Object.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
            let late = false;
            let reserved: number | undefined;
            const serializer = function (this: unknown, key: string): unknown {
              return key === field && late ? 200_000 : this;
            };
            const install = (): void => {
              Object.defineProperty(prototype, 'toJSON', { configurable: true, value: serializer });
            };
            try {
              if (variant === 'existing-property') install();
              const model = provider === 'gemini' ? 'gemini-2.5-pro' : 'gpt-5.4-pro';
              const chain = new FallbackChain([{ provider: adapter, model, maxAttempts: 1 }], {
                preAttempt: (info) => {
                  reserved = outputTokensReservation(info.outputCapPlan, 17);
                },
                keyFor: async () => {
                  await Promise.resolve();
                  if (variant === 'new-property') install();
                  late = true;
                  return 'offline-synthetic-key';
                },
                sleep: () => Promise.resolve(),
              });
              const cap = shape === 'array' ? [] : { limit: 1 };
              const request: LlmRequest = { model, messages, providerOptions: { [field]: cap } };
              if (path === 'generate') await chain.generate(request);
              else
                for await (const chunk of chain.stream(request))
                  expect(chunk.type).not.toBe('error');
              expect(reserved).toBe(17);
              expect(bodies).toHaveLength(1);
              const native = provider === 'gemini' ? bodies[0]?.['generationConfig'] : bodies[0];
              if (!record(native)) throw new Error('missing native config');
              expect(native[field]).toEqual(shape === 'array' ? [] : { limit: 1 });
              // Invalid native JSON is preserved; the mock does not certify upstream acceptance.
            } finally {
              if (descriptor === undefined) Reflect.deleteProperty(prototype, 'toJSON');
              else Object.defineProperty(prototype, 'toJSON', descriptor);
              vi.unstubAllGlobals();
            }
          });
        }
      }
    }
  }
});
