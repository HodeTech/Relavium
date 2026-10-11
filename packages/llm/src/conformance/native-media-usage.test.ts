import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGeminiAdapter } from '../adapters/gemini.js';
import { createOpenAiAdapter } from '../adapters/openai.js';
import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { FallbackChain } from '../fallback-chain.js';
import type { LlmProvider, LlmRequest, StreamChunk, UsageEvidence } from '../types.js';

type Provider = 'openai' | 'deepseek' | 'gemini';
type Counter = 'absent' | 'zero' | 'malformed';
type Position = 'same' | 'earlier' | 'later' | 'none';
const key = 'offline-media-usage';
const media = { data: 'YQ==', mimeType: 'audio/wav' };
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function req(provider: Provider, native = false): LlmRequest {
  return {
    model: provider === 'gemini' ? 'gemini-2.5-flash' : 'w8-native-media',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...(native
      ? {
          providerOptions:
            provider === 'gemini'
              ? { responseModalities: ['TEXT', 'AUDIO'] }
              : { modalities: ['text', 'audio'], audio: { voice: 'alloy', format: 'wav' } },
        }
      : {}),
  };
}
function wire(
  provider: Provider,
  streaming: boolean,
  position: Position,
  counter: Counter,
): Response {
  let body: string;
  if (provider === 'gemini') {
    const usage = {
      promptTokenCount: 5,
      cachedContentTokenCount: 0,
      candidatesTokenCount: counter === 'malformed' ? -1 : counter === 'zero' ? 0 : 3,
      thoughtsTokenCount: 0,
    };
    const frame = (withMedia: boolean, withUsage: boolean) => ({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'hello' }, ...(withMedia ? [{ inlineData: media }] : [])],
          },
          ...(withUsage ? { finishReason: 'STOP' } : {}),
        },
      ],
      ...(withUsage ? { usageMetadata: usage } : {}),
    });
    body = streaming
      ? (position === 'earlier' ? sse(frame(true, false)) : '') +
        sse(frame(position === 'same', true)) +
        (position === 'later' ? sse(frame(true, false)) : '')
      : JSON.stringify(frame(position !== 'none', true));
  } else {
    const usage = {
      prompt_tokens: 5,
      completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 0 },
      ...(counter === 'absent'
        ? {}
        : { completion_tokens_details: { audio_tokens: counter === 'zero' ? 0 : -1 } }),
      ...(provider === 'deepseek'
        ? { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 5 }
        : {}),
    };
    const base = {
      id: 'native-media',
      object: streaming ? 'chat.completion.chunk' : 'chat.completion',
      created: 1,
      model: 'w8-native-media',
    };
    const frame = (withMedia: boolean, withUsage: boolean) => ({
      ...base,
      choices: [
        {
          index: 0,
          delta: { content: 'hello', ...(withMedia ? { audio: media } : {}) },
          finish_reason: withUsage ? 'stop' : null,
        },
      ],
      ...(withUsage ? { usage } : {}),
    });
    body = streaming
      ? (position === 'earlier' ? sse(frame(true, false)) : '') +
        sse(frame(position === 'same', true)) +
        (position === 'later' ? sse(frame(true, false)) : '') +
        'data: [DONE]\n\n'
      : JSON.stringify({
          ...base,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'hello',
                ...(position === 'none' ? {} : { audio: media }),
              },
              finish_reason: 'stop',
            },
          ],
          usage,
        });
  }
  return new Response(body, {
    headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' },
  });
}
function adapter(provider: Provider, response: () => Response): LlmProvider {
  const fetch = vi.fn(() => Promise.resolve(response()));
  if (provider === 'gemini') {
    vi.stubGlobal('fetch', fetch);
    return createGeminiAdapter();
  }
  return createOpenAiAdapter({ providerId: provider, fetch });
}
async function collect(source: AsyncIterable<StreamChunk>): Promise<UsageEvidence> {
  let last: StreamChunk | undefined;
  for await (const chunk of source) last = chunk;
  expect(last?.type).toBe('stop');
  if (last?.type !== 'stop') throw new Error('Expected stop');
  return last.usage;
}
function expectedKind(provider: Provider, counter: Counter): UsageEvidence['kind'] {
  return provider !== 'gemini' && counter === 'zero' ? 'complete' : 'partial';
}

describe('native media applicability through installed SDK HTTP', () => {
  afterEach(() => vi.unstubAllGlobals());
  for (const provider of ['openai', 'deepseek', 'gemini'] as const) {
    for (const counter of ['absent', 'zero', 'malformed'] as const) {
      for (const position of ['same', 'earlier', 'later'] as const) {
        it(`${provider}/${counter}/${position}: observed stream media remains accountable across frames`, async () => {
          const native = adapter(provider, () => wire(provider, true, position, counter));
          const record = vi.fn(
            (_model: string, usage: { inputTokens: number; outputTokens: number }) => ({
              ...usage,
              costMicrocents: 0,
              cumulativeCostMicrocents: 0,
            }),
          );
          const chain = new FallbackChain(
            [{ provider: native, model: req(provider).model, maxAttempts: 1 }],
            { keyFor: () => key, sleep: () => Promise.resolve(), costTracker: { record } },
          );
          const evidence = await collect(chain.stream(req(provider)));
          expect(evidence.kind).toBe(expectedKind(provider, counter));
          if (evidence.kind === 'partial') {
            expect(evidence.known.inputTokens).toBe(5);
            expect(evidence.reason).toBe(
              counter === 'malformed' ? 'invalid_fields' : 'missing_fields',
            );
            expect(record).not.toHaveBeenCalled();
          } else if (evidence.kind === 'complete') {
            expect(evidence.usage.mediaUnits).toContainEqual({
              modality: 'audio',
              direction: 'output',
              units: 0,
              unit: 'count',
            });
            expect(record).toHaveBeenCalledTimes(1);
          }
        });
      }
      it(`${provider}/${counter}: generate preserves media evidence and explicit native zero`, async () => {
        const result = await adapter(provider, () =>
          wire(provider, false, 'same', counter),
        ).generate(req(provider), key);
        expect(result.usage.kind).toBe(expectedKind(provider, counter));
      });
    }
    for (const streaming of [false, true]) {
      it(`${provider}/${streaming}: lowered native modalities require counters without an emitted media part`, async () => {
        const native = adapter(provider, () => wire(provider, streaming, 'none', 'absent'));
        const request = req(provider, true);
        const evidence = streaming
          ? await collect(native.stream(request, key))
          : (await native.generate(request, key)).usage;
        expect(evidence).toMatchObject({
          kind: 'partial',
          known: { inputTokens: 5, outputTokens: 3 },
          reason: 'missing_fields',
        });
      });
    }
    it(`${provider}: native stream modality applicability belongs to the owned request`, async () => {
      const modalities = provider === 'gemini' ? ['TEXT', 'AUDIO'] : ['text', 'audio'];
      const request: LlmRequest = {
        ...req(provider),
        providerOptions:
          provider === 'gemini' ? { responseModalities: modalities } : { modalities },
      };
      const source = adapter(provider, () => wire(provider, true, 'none', 'absent')).stream(
        request,
        key,
      );
      modalities.splice(1);
      expect((await collect(source)).kind).toBe('partial');
    });
  }
  it('Anthropic text stream has no output-media billing axis', async () => {
    const usage = {
      input_tokens: 5,
      output_tokens: 3,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const frame = (event: string, value: unknown) => `event: ${event}\n${sse(value)}`;
    const body =
      frame('message_start', {
        type: 'message_start',
        message: { id: 'a', type: 'message', role: 'assistant', content: [], model: 'w8', usage },
      }) +
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 3 },
      }) +
      frame('message_stop', { type: 'message_stop' });
    const native = createAnthropicAdapter({
      fetch: () =>
        Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } })),
    });
    expect(
      (await collect(native.stream({ ...req('openai'), model: 'w8-anthropic' }, key))).kind,
    ).toBe('complete');
    expect(native.supports.media?.outputCombinations).toEqual([]);
  });
});

it('Gemini owns usage once before an inline media content getter resumes provider code', async () => {
  const usage = {
    promptTokenCount: 5,
    cachedContentTokenCount: 0,
    candidatesTokenCount: 3,
    thoughtsTokenCount: 0,
  };
  let reads = 0;
  const native = createGeminiAdapter({
    transport: {
      generate: () =>
        Promise.resolve({
          get usageMetadata() {
            if (++reads > 1) throw new Error('second usage read');
            return usage;
          },
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  {
                    get inlineData() {
                      usage.promptTokenCount = 999;
                      return media;
                    },
                  },
                ],
              },
            },
          ],
        }),
      stream: () => Promise.reject(new Error('unused stream')),
      listModels: () => Promise.resolve([]),
      generateImages: () => Promise.reject(new Error('unused images')),
      generateVideos: () => Promise.reject(new Error('unused videos')),
      pollVideo: () => Promise.reject(new Error('unused poll')),
    },
  });
  const result = await native.generate(req('gemini'), key);
  expect(reads).toBe(1);
  expect(result.usage).toMatchObject({
    kind: 'partial',
    known: { inputTokens: 5, outputTokens: 3 },
    reason: 'missing_fields',
  });
});
