import { describe, expect, it, vi } from 'vitest';

import { createAnthropicAdapter } from './anthropic.js';
import { createGeminiAdapter } from './gemini.js';
import { createOpenAiAdapter } from './openai.js';
import { FallbackChain } from '../fallback-chain.js';
import { UnsupportedRequestDataError } from '../errors.js';
import { InvalidOutputCapPlanError } from '../output-cap.js';
import { LlmErrorSchema, type LlmProvider, type LlmRequest } from '../types.js';

const syntheticKey = 'offline-opaque-private-credential';
const failInspection = (): never => {
  throw new Error(syntheticKey, { cause: { credential: syntheticKey } });
};
const routes = ['openai', 'custom-openai', 'deepseek', 'anthropic', 'gemini'] as const;
type Route = (typeof routes)[number];
const faults = ['cap-getter', 'options-getter', 'options-proxy'] as const;
type Fault = (typeof faults)[number];
const messages: LlmRequest['messages'] = [
  { role: 'user', content: [{ type: 'text', text: 'offline' }] },
];

function failingRequest(route: Route, fault: Fault): LlmRequest {
  const model =
    route === 'gemini'
      ? 'gemini-2.5-pro'
      : route === 'anthropic'
        ? 'claude-opus-4-8'
        : 'gpt-5.4-pro';
  if (fault === 'options-getter')
    return {
      model,
      messages,
      get providerOptions() {
        return failInspection();
      },
    };
  if (fault === 'options-proxy')
    return { model, messages, providerOptions: new Proxy({}, { ownKeys: failInspection }) };
  const options: Record<string, unknown> = {};
  Object.defineProperty(options, route === 'gemini' ? 'maxOutputTokens' : 'max_tokens', {
    enumerable: true,
    get: failInspection,
  });
  return { model, messages, providerOptions: options };
}

function adapterFor(route: Route, fetch: () => never): LlmProvider {
  if (route === 'anthropic') return createAnthropicAdapter({ fetch });
  if (route === 'gemini') {
    vi.stubGlobal('fetch', fetch);
    return createGeminiAdapter();
  }
  return createOpenAiAdapter({
    providerId: route === 'deepseek' ? 'deepseek' : 'openai',
    fetch,
    ...(route === 'custom-openai' ? { baseURL: 'https://gateway.example/v1' } : {}),
  });
}

describe('request inspection is content-free before direct adapter egress (ADR-0101/0102)', () => {
  for (const route of routes)
    for (const path of ['generate', 'stream'] as const)
      for (const fault of faults) {
        it(`${route}/${path}/${fault} refuses with a fixed typed error without transport`, async () => {
          let fetches = 0;
          const adapter = adapterFor(route, () => {
            fetches++;
            throw new Error('unexpected transport');
          });
          let failure: unknown;
          try {
            const request = failingRequest(route, fault);
            if (path === 'generate') {
              try {
                await adapter.generate(request, syntheticKey);
              } catch (error) {
                failure = error;
              }
            } else {
              // Capture happens now; refusal still arrives through the iterator, never a throw.
              const stream = adapter.stream(request, syntheticKey);
              let chunks = 0;
              for await (const chunk of stream) {
                chunks++;
                expect(chunk.type).toBe('error');
                if (chunk.type === 'error') failure = chunk.error;
              }
              expect(chunks).toBe(1);
            }
            expect(fetches).toBe(0);
            const expected =
              fault === 'cap-getter'
                ? new InvalidOutputCapPlanError()
                : new UnsupportedRequestDataError();
            const typed = path === 'generate' ? failure : LlmErrorSchema.parse(failure).cause;
            expect(typed).toBeInstanceOf(expected.constructor);
            if (
              !(typed instanceof InvalidOutputCapPlanError) &&
              !(typed instanceof UnsupportedRequestDataError)
            )
              throw new Error('missing typed refusal');
            expect(typed.message).toBe(expected.message);
            expect(Object.hasOwn(typed, 'cause')).toBe(false);
            if (path === 'stream')
              expect(failure).toMatchObject({
                kind: 'bad_request',
                retryable: false,
                message: expected.message,
              });
            expect(`${typed.message}\n${typed.stack}\n${JSON.stringify(failure)}`).not.toContain(
              syntheticKey,
            );
          } finally {
            vi.unstubAllGlobals();
          }
        });
      }
});

describe('cap inspection terminates a chain before admission, key resolution, retry or failover', () => {
  for (const path of ['generate', 'stream'] as const)
    for (const fault of ['cap-getter', 'options-proxy'] as const) {
      it(`${path}/${fault} has a content-free terminal without any external effect`, async () => {
        let fetches = 0;
        let keys = 0;
        let admissions = 0;
        const attempts: string[] = [];
        const adapter = adapterFor('openai', () => {
          fetches++;
          throw new Error('unexpected transport');
        });
        const chain = new FallbackChain(
          [
            { provider: adapter, model: 'gpt-5.4-pro', maxAttempts: 2 },
            { provider: adapter, model: 'gpt-5.4', maxAttempts: 2 },
          ],
          {
            sleep: () => Promise.resolve(),
            keyFor: () => {
              keys++;
              return syntheticKey;
            },
            preAttempt: () => {
              admissions++;
            },
            onAttempt: (attempt) => {
              attempts.push(attempt.model);
            },
          },
        );
        let failure: unknown;
        try {
          if (path === 'generate') await chain.generate(failingRequest('openai', fault));
          else
            for await (const chunk of chain.stream(failingRequest('openai', fault))) {
              if (chunk.type === 'error') failure = chunk.error;
            }
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeDefined();
        const encoded =
          failure instanceof Error
            ? `${failure.message}\n${failure.stack}\n${JSON.stringify(failure)}`
            : JSON.stringify(failure);
        expect(encoded).not.toContain(syntheticKey);
        expect(encoded).toContain(
          fault === 'cap-getter'
            ? new InvalidOutputCapPlanError().message
            : new UnsupportedRequestDataError().message,
        );
        expect(keys).toBe(0);
        expect(admissions).toBe(0);
        expect(fetches).toBe(0);
        expect(attempts).toHaveLength(1);
      });
    }
});
