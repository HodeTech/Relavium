import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGeminiAdapter } from './gemini.js';
import { clearCatalogRefresh, installCatalogRefresh } from '../catalog/lookup.js';
import { catalogModelFixture } from '../conformance/fixtures/catalog.js';
import { FallbackChain } from '../fallback-chain.js';
import { outputTokensReservation, prepareOutputCapPlan } from '../output-cap.js';
import type { LlmProvider, LlmRequest } from '../types.js';

const model = 'w7-gemini-http-cap';
const messages: LlmRequest['messages'] = [
  { role: 'user', content: [{ type: 'text', text: 'offline' }] },
];
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function captureHttp(path: 'generate' | 'stream'): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  const response = {
    candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  };
  // Exercise the installed SDK's config-to-HTTP lowering, rather than only GeminiTransport.
  vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('expected JSON HTTP body');
    const body: unknown = JSON.parse(init.body);
    if (!record(body)) throw new Error('expected JSON object');
    bodies.push(body);
    return Promise.resolve(
      new Response(
        path === 'stream' ? `data: ${JSON.stringify(response)}\n\n` : JSON.stringify(response),
        {
          status: 200,
          headers: {
            'content-type': path === 'stream' ? 'text/event-stream' : 'application/json',
          },
        },
      ),
    );
  });
  return bodies;
}

function configOf(body: Record<string, unknown> | undefined): Record<string, unknown> {
  if (body === undefined) throw new Error('missing HTTP body');
  const config = body['generationConfig'];
  if (config === undefined) return {};
  if (!record(config)) throw new Error('invalid generation config');
  return config;
}

async function call(
  provider: Pick<LlmProvider, 'generate' | 'stream'>,
  request: LlmRequest,
  path: 'generate' | 'stream',
): Promise<void> {
  if (path === 'generate') {
    await provider.generate(request, 'offline-synthetic-key');
    return;
  }
  for await (const chunk of provider.stream(request, 'offline-synthetic-key')) {
    expect(chunk.type).not.toBe('error');
  }
}

describe('Gemini output reservation through actual SDK HTTP JSON (ADR-0101)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearCatalogRefresh();
  });

  for (const path of ['generate', 'stream'] as const) {
    for (const variant of [
      'uncapped',
      'authored',
      'native',
      'boxed',
      'serializer',
      'mapped-wins',
      'measured-refresh',
      'outer-serializer',
    ] as const) {
      it(`${path}: ${variant} retains admission/wire parity across SDK lowering`, async () => {
        installCatalogRefresh({
          [model]: catalogModelFixture({
            modelId: model,
            provider: 'gemini',
            maxOutputTokens: 1024,
          }),
        });
        const bodies = captureHttp(path);
        let amount = 200_000;
        let serializations = 0;
        const native = {
          toJSON: (key: string) => {
            expect(key).toBe('maxOutputTokens');
            serializations++;
            return amount;
          },
        };
        const boxed: unknown = Object(amount);
        const options =
          variant === 'native'
            ? { maxOutputTokens: amount }
            : variant === 'boxed'
              ? { maxOutputTokens: boxed }
              : variant === 'serializer' || variant === 'mapped-wins'
                ? { maxOutputTokens: native }
                : variant === 'outer-serializer'
                  ? {
                      toJSON: () => {
                        throw new Error('outer serializer must not execute');
                      },
                    }
                  : undefined;
        const maxTokens =
          variant === 'authored' || variant === 'measured-refresh'
            ? 4096
            : variant === 'mapped-wins' || variant === 'outer-serializer'
              ? 17
              : undefined;
        const plan =
          variant === 'measured-refresh'
            ? prepareOutputCapPlan({
                model,
                provider: 'gemini',
                endpoint: 'official',
                maxTokens,
                providerOptions: options,
              })
            : undefined;
        let reserved: number | undefined;
        const chain = new FallbackChain(
          [{ provider: createGeminiAdapter(), model, maxAttempts: 1 }],
          {
            keyFor: () => {
              amount = 300_000;
              installCatalogRefresh({
                [model]: catalogModelFixture({
                  modelId: model,
                  provider: 'gemini',
                  maxOutputTokens: 4096,
                }),
              });
              return 'offline-synthetic-key';
            },
            preAttempt: (info) => {
              reserved = outputTokensReservation(info.outputCapPlan, 23);
              amount = 1;
            },
            sleep: () => Promise.resolve(),
          },
        );
        await call(
          chain,
          {
            model,
            messages,
            ...(maxTokens === undefined ? {} : { maxTokens }),
            ...(options === undefined ? {} : { providerOptions: options }),
            ...(plan === undefined ? {} : { preparedOutputCaps: [plan] }),
          },
          path,
        );
        const expected =
          variant === 'uncapped'
            ? undefined
            : variant === 'native' || variant === 'boxed' || variant === 'serializer'
              ? 200_000
              : variant === 'mapped-wins' || variant === 'outer-serializer'
                ? 17
                : 1024;
        expect(bodies).toHaveLength(1);
        expect(configOf(bodies[0])['maxOutputTokens']).toBe(expected);
        expect(reserved).toBe(expected ?? 23);
        expect(serializations).toBe(variant === 'serializer' ? 1 : 0);
      });
    }

    for (const field of ['max_tokens', 'max_completion_tokens'] as const) {
      for (const maxTokens of [undefined, 17]) {
        for (const valueKind of ['cycle', 'serializer', 'bigint'] as const) {
          it(`${path}: SDK-discarded ${field}/${valueKind} is inert with cap ${maxTokens}`, async () => {
            const bodies = captureHttp(path);
            const cycle: Record<string, unknown> = {};
            cycle['self'] = cycle;
            let serializations = 0;
            const value =
              valueKind === 'cycle'
                ? cycle
                : valueKind === 'bigint'
                  ? 1n
                  : {
                      toJSON: () => {
                        serializations++;
                        throw new Error('discarded serializer must not execute');
                      },
                    };
            let reserved: number | undefined;
            const chain = new FallbackChain(
              [{ provider: createGeminiAdapter(), model, maxAttempts: 1 }],
              {
                keyFor: () => 'offline-synthetic-key',
                preAttempt: (info) => {
                  reserved = outputTokensReservation(info.outputCapPlan, 23);
                },
                sleep: () => Promise.resolve(),
              },
            );
            await call(
              chain,
              {
                model,
                messages,
                ...(maxTokens === undefined ? {} : { maxTokens }),
                providerOptions: { [field]: value },
              },
              path,
            );
            expect(bodies).toHaveLength(1);
            const config = configOf(bodies[0]);
            expect(config).not.toHaveProperty(field);
            expect(config['maxOutputTokens']).toBe(maxTokens);
            expect(reserved).toBe(maxTokens ?? 23);
            expect(serializations).toBe(0);
          });
        }
      }
    }
  }
});
