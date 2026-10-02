import { describe, expect, it, vi } from 'vitest';

import { createAnthropicAdapter } from './anthropic.js';
import { createGeminiAdapter } from './gemini.js';
import { createOpenAiAdapter } from './openai.js';
import { FallbackChain } from '../fallback-chain.js';
import { InvalidOutputCapPlanError } from '../output-cap.js';
import type { LlmProvider, LlmRequest } from '../types.js';

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

describe('cap inspection is content-free before direct adapter egress (ADR-0101)', () => {
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
            try {
              const request = failingRequest(route, fault);
              if (path === 'generate') await adapter.generate(request, syntheticKey);
              else
                for await (const chunk of adapter.stream(request, syntheticKey)) {
                  if (chunk.type === 'error') failure = chunk.error;
                }
            } catch (error) {
              failure = error;
            }
            expect(fetches).toBe(0);
            expect(failure).toBeInstanceOf(InvalidOutputCapPlanError);
            if (!(failure instanceof InvalidOutputCapPlanError))
              throw new Error('missing typed refusal');
            expect(failure.message).toBe(new InvalidOutputCapPlanError().message);
            expect(Object.hasOwn(failure, 'cause')).toBe(false);
            expect(
              `${failure.message}\n${failure.stack}\n${JSON.stringify(failure)}`,
            ).not.toContain(syntheticKey);
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
        expect(encoded).toContain(new InvalidOutputCapPlanError().message);
        expect(keys).toBe(0);
        expect(admissions).toBe(0);
        expect(fetches).toBe(0);
        expect(attempts).toHaveLength(1);
      });
    }
});
