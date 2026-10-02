import { afterEach, describe, expect, it } from 'vitest';
import { createAnthropicAdapter } from './anthropic.js';
import { createOpenAiAdapter } from './openai.js';
import { createGeminiAdapter, type GeminiRequest, type GeminiTransport } from './gemini.js';
import { createCustomOpenAiProvider } from '../providers.js';
import { clearCatalogRefresh, installCatalogRefresh } from '../catalog/lookup.js';
import { catalogModelFixture } from '../conformance/fixtures/catalog.js';
import { FallbackChain } from '../fallback-chain.js';
import { outputTokensReservation, prepareOutputCapPlan } from '../output-cap.js';
import type { LlmProvider, LlmRequest, ProviderId } from '../types.js';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const messages: LlmRequest['messages'] = [
  { role: 'user', content: [{ type: 'text', text: 'go' }] },
];

function captureAdapter(
  provider: ProviderId,
  custom = false,
): { adapter: LlmProvider; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  if (provider === 'gemini') {
    const capture = (request: GeminiRequest): void => {
      bodies.push({ ...request.config });
    };
    const response = {
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    };
    const transport: GeminiTransport = {
      generate: (req) => {
        capture(req);
        return Promise.resolve(response);
      },
      stream: (req) => {
        capture(req);
        return Promise.resolve(
          (async function* () {
            await Promise.resolve();
            yield response;
          })(),
        );
      },
      generateImages: () => Promise.reject(new Error('unused')),
      generateVideos: () => Promise.reject(new Error('unused')),
      pollVideo: () => Promise.reject(new Error('unused')),
      listModels: () => Promise.reject(new Error('unused')),
    };
    return { adapter: createGeminiAdapter({ transport }), bodies };
  }
  const fetch = (_input: unknown, init?: RequestInit): Promise<Response> => {
    const parsed: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    if (!record(parsed)) throw new Error('expected wire body');
    bodies.push(parsed);
    if (parsed['stream'] === true) {
      const sse =
        provider === 'anthropic'
          ? 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
          : 'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      return Promise.resolve(
        new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    }
    const body =
      provider === 'anthropic'
        ? {
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'm',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        : {
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
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  const adapter =
    provider === 'anthropic'
      ? createAnthropicAdapter({ fetch, maxRetries: 0 })
      : custom
        ? createCustomOpenAiProvider({
            providerId: provider,
            baseURL: 'https://gateway.example/v1',
            fetch,
          })
        : createOpenAiAdapter({ providerId: provider, fetch });
  return { adapter, bodies };
}

async function call(
  adapter: Pick<LlmProvider, 'generate' | 'stream'>,
  request: LlmRequest,
  path: 'generate' | 'stream',
): Promise<void> {
  if (path === 'generate') {
    await adapter.generate(request, 'test-key');
    return;
  }
  for await (const chunk of adapter.stream(request, 'test-key')) {
    if (chunk.type === 'error') throw new Error(`unexpected adapter error ${chunk.error.kind}`);
  }
}

describe('wire/admission parity through actual adapter paths (ADR-0101)', () => {
  afterEach(clearCatalogRefresh);
  for (const provider of ['openai', 'deepseek', 'anthropic', 'gemini'] as const) {
    for (const path of ['generate', 'stream'] as const) {
      const field =
        provider === 'gemini'
          ? 'maxOutputTokens'
          : provider === 'openai'
            ? 'max_completion_tokens'
            : 'max_tokens';
      const id = `w7-${provider}-wire`;
      const cases = [
        {
          name: 'uncapped',
          maxTokens: undefined,
          native: undefined,
          expected: provider === 'anthropic' ? 4096 : undefined,
        },
        { name: 'authored below ceiling', maxTokens: 17, native: undefined, expected: 17 },
        { name: 'authored above ceiling', maxTokens: 9000, native: undefined, expected: 4096 },
        {
          name: 'native above ceiling',
          maxTokens: undefined,
          native: { [field]: 20_000 },
          expected: provider === 'anthropic' ? 4096 : 20_000,
        },
        {
          name: 'mapped cap wins native',
          maxTokens: 17,
          native: { [field]: 20_000 },
          expected: 17,
        },
        {
          name: 'invalid native survives',
          maxTokens: undefined,
          native: { [field]: '20000' },
          expected: provider === 'anthropic' ? 4096 : '20000',
        },
      ];
      it.each(cases)(`${provider} ${path}: $name`, async ({ maxTokens, native, expected }) => {
        installCatalogRefresh({
          [id]: catalogModelFixture({ modelId: id, provider, maxOutputTokens: 4096 }),
        });
        const { adapter, bodies } = captureAdapter(provider);
        const request: LlmRequest = {
          model: id,
          messages,
          ...(maxTokens === undefined ? {} : { maxTokens }),
          ...(native === undefined ? {} : { providerOptions: native }),
        };
        const plan = prepareOutputCapPlan({
          model: id,
          provider,
          endpoint: 'official',
          maxTokens,
          providerOptions: native,
        });
        await call(adapter, { ...request, preparedOutputCaps: [plan] }, path);
        expect(bodies).toHaveLength(1);
        expect(bodies[0]?.[field]).toBe(expected);
        const reserved = typeof expected === 'number' ? expected : 23;
        expect(outputTokensReservation(plan, 23)).toBe(reserved);
        if (expected === undefined) expect(bodies[0]).not.toHaveProperty(field);
      });

      it(`${provider} ${path}: measured plan survives credential-await catalog refresh`, async () => {
        installCatalogRefresh({
          [id]: catalogModelFixture({ modelId: id, provider, maxOutputTokens: 1024 }),
        });
        const plan = prepareOutputCapPlan({
          model: id,
          provider,
          endpoint: 'official',
          maxTokens: 4096,
          providerOptions: undefined,
        });
        const { adapter, bodies } = captureAdapter(provider);
        const chain = new FallbackChain([{ provider: adapter, model: id, maxAttempts: 1 }], {
          sleep: () => Promise.resolve(),
          keyFor: () => {
            installCatalogRefresh({
              [id]: catalogModelFixture({ modelId: id, provider, maxOutputTokens: 4096 }),
            });
            return 'test-key';
          },
          preAttempt: (info) => {
            expect(info.outputCapPlan).toBe(plan);
            expect(info.endpoint).toBe('official');
            expect(Object.hasOwn(info, 'providerOptions')).toBe(true);
            expect(outputTokensReservation(info.outputCapPlan, 1)).toBe(1024);
          },
        });
        await call(
          chain,
          { model: id, messages, maxTokens: 4096, preparedOutputCaps: [plan] },
          path,
        );
        expect(bodies[0]?.[field]).toBe(1024);
      });
    }
  }

  it.each(['openai', 'deepseek'] as const)(
    'custom %s route exposes actual factory identity and retains full canonical caps',
    async (provider) => {
      const { adapter, bodies } = captureAdapter(provider, true);
      expect(adapter.customEndpoint).toBe(true);
      for (const path of ['generate', 'stream'] as const)
        await call(
          adapter,
          {
            model: 'gpt-5.4-pro',
            messages,
            maxTokens: 200_000,
            providerOptions: { max_completion_tokens: 1 },
          },
          path,
        );
      expect(bodies.map((body) => body['max_tokens'])).toEqual([200_000, 200_000]);
      expect(bodies.every((body) => !Object.hasOwn(body, 'max_completion_tokens'))).toBe(true);
    },
  );
});
