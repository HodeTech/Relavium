import { afterEach, describe, expect, it } from 'vitest';

import { clearCatalogRefresh, installCatalogRefresh } from '../catalog/lookup.js';
import { catalogModelFixture } from '../conformance/fixtures/catalog.js';

import type { AbortSignalLike, ReasoningEffort } from '@relavium/shared';

import { UnsupportedCapabilityError } from '../errors.js';
import { LlmProviderError } from '../llm-error.js';
import { GeminiToolCallIds } from '../tool-normalizer.js';
import { MediaGenResultSchema, MediaJobStatusSchema } from '../types.js';
import type {
  LlmProvider,
  LlmRequest,
  MediaGenRequest,
  MediaGenResult,
  MediaJobStatus,
  StreamChunk,
} from '../types.js';
import { encodeMediaJobId } from './shared.js';
import {
  buildGeminiRequest,
  createGeminiAdapter,
  geminiAdapter,
  geminiErrorToLlmError,
  mapContent,
  mapStopReason,
  mapUsage,
  type GeminiImageRequest,
  type GeminiImageResponse,
  type GeminiRequest,
  type GeminiResponse,
  type GeminiTransport,
  type GeminiVideoOperation,
  type GeminiVideoPoll,
  type GeminiVideoRequest,
} from './gemini.js';

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

/** The generative-endpoint transport methods stubbed to reject — spread into a text/image fake that never
 *  calls the OTHER generative arms. A new transport method needs adding only here, not at every fake. */
const unusedGenerative: Pick<
  GeminiTransport,
  'generateImages' | 'generateVideos' | 'pollVideo' | 'listModels'
> = {
  generateImages: () => Promise.reject(new Error('unused')),
  generateVideos: () => Promise.reject(new Error('unused')),
  pollVideo: () => Promise.reject(new Error('unused')),
  listModels: () => Promise.reject(new Error('unused')),
};

/** A transport that returns a fixed response and captures the request it was handed. */
function fakeTransport(
  response: GeminiResponse,
  stream: readonly GeminiResponse[] = [response],
): GeminiTransport & { lastRequest?: GeminiRequest } {
  const holder: GeminiTransport & { lastRequest?: GeminiRequest } = {
    ...unusedGenerative, // text-fold tests never call the generative endpoints
    generate: (request) => {
      holder.lastRequest = request;
      return Promise.resolve(response);
    },
    stream: (request) => {
      holder.lastRequest = request;
      return Promise.resolve(
        (async function* () {
          await Promise.resolve();
          for (const item of stream) {
            yield item;
          }
        })(),
      );
    },
  };
  return holder;
}

/** A transport whose `generateImages` returns a fixed Imagen response and captures the request. */
function fakeImageTransport(
  response: GeminiImageResponse,
): GeminiTransport & { lastImageRequest?: GeminiImageRequest } {
  const holder: GeminiTransport & { lastImageRequest?: GeminiImageRequest } = {
    ...unusedGenerative,
    generate: () => Promise.reject(new Error('unused')),
    stream: () => Promise.reject(new Error('unused')),
    generateImages: (request) => {
      holder.lastImageRequest = request;
      return Promise.resolve(response);
    },
  };
  return holder;
}

/** A transport whose `generateVideos`/`pollVideo` drive a Veo flow; other methods reject. `poll` may be a
 *  single status or a sequence served by call index (pending → done). */
function fakeVideoTransport(opts: {
  operation?: GeminiVideoOperation;
  poll?: GeminiVideoPoll | readonly GeminiVideoPoll[];
}): GeminiTransport & {
  lastVideoRequest?: GeminiVideoRequest;
  lastOperationName?: string;
  lastPollSignal?: AbortSignalLike | undefined;
} {
  let polls: readonly GeminiVideoPoll[];
  if (opts.poll === undefined) {
    polls = [];
  } else if ('done' in opts.poll) {
    polls = [opts.poll]; // a single status (has the `done` discriminant) → one-element sequence
  } else {
    polls = opts.poll; // already a sequence
  }
  let call = 0;
  const holder: GeminiTransport & {
    lastVideoRequest?: GeminiVideoRequest;
    lastOperationName?: string;
    lastPollSignal?: AbortSignalLike | undefined;
  } = {
    ...unusedGenerative,
    generate: () => Promise.reject(new Error('unused')),
    stream: () => Promise.reject(new Error('unused')),
    generateVideos: (request) => {
      holder.lastVideoRequest = request;
      return Promise.resolve(opts.operation ?? { name: 'operations/veo-1' });
    },
    pollVideo: (operationName, _key, signal) => {
      holder.lastOperationName = operationName; // the decoded op-name the adapter threads (re-attach, §3)
      holder.lastPollSignal = signal;
      const status = polls[Math.min(call, polls.length - 1)];
      call += 1;
      return status === undefined
        ? Promise.reject(new Error('no poll status scripted'))
        : Promise.resolve(status);
    },
  };
  return holder;
}

/** Call the adapter's optional `generateMedia` via `?.()` — a call (binds `this`), never an extraction,
 *  so the unbound-method lint stays happy; the `??` branch asserts the method is implemented. */
function genMedia(
  adapter: LlmProvider,
  req: MediaGenRequest,
  key: string,
): Promise<MediaGenResult> {
  return (
    adapter.generateMedia?.(req, key) ??
    Promise.reject(new Error('adapter implements no generateMedia'))
  );
}

/** Call the adapter's optional `pollMediaJob` via `?.()` (same unbound-method-safe pattern as genMedia). */
function pollMedia(
  adapter: LlmProvider,
  jobId: string,
  key: string,
  signal?: AbortSignalLike,
): Promise<MediaJobStatus> {
  return (
    adapter.pollMediaJob?.(jobId, key, signal) ??
    Promise.reject(new Error('adapter implements no pollMediaJob'))
  );
}

const REQ: LlmRequest = {
  model: 'gemini-2.5-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

describe('Gemini adapter', () => {
  it('exposes the gemini id and capability surface', () => {
    expect(geminiAdapter.id).toBe('gemini');
    expect(geminiAdapter.supports.tools).toBe(true);
    expect(geminiAdapter.supports.streaming).toBe(true);
    expect(geminiAdapter.supports.vision).toBe(true);
    expect(geminiAdapter.supports.media).toEqual({
      // video/document stay false until handle resolution lands (1.AF) — base64 video/document are
      // blocked by the seam ceiling, so advertising them would be "advertised-but-unsendable" (ADR-0031).
      input: { image: true, audio: true, video: false, document: false },
      outputCombinations: [['text'], ['text', 'image'], ['text', 'audio']],
      surface: 'chat',
    });
  });

  it('accepts base64 media parts and rejects handle/url sources with an explicit error', async () => {
    const transport = fakeTransport({ candidates: [] });
    const adapter = createGeminiAdapter({ transport });
    const base64Modalities: Array<{ mimeType: string; kind: 'image' | 'audio' }> = [
      { mimeType: 'image/png', kind: 'image' },
      { mimeType: 'audio/wav', kind: 'audio' },
    ];
    for (const { mimeType } of base64Modalities) {
      const req: LlmRequest = {
        model: 'gemini-2.5-flash',
        messages: [
          {
            role: 'user',
            content: [{ type: 'media', mimeType, source: { kind: 'base64', data: 'aGVsbG8=' } }],
          },
        ],
      };
      await expect(adapter.generate(req, 'k')).resolves.toBeDefined();
      expect(() => adapter.stream(req, 'k')).not.toThrow();
    }
    // A handle source on a SUPPORTED modality reaches the mapper, which rejects it (base64-only at 1.AE).
    for (const { mimeType } of [{ mimeType: 'image/png' }, { mimeType: 'audio/wav' }]) {
      const req: LlmRequest = {
        model: 'gemini-2.5-flash',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'media',
                mimeType,
                source: { kind: 'handle', ref: `media://sha256-${'a'.repeat(64)}` },
              },
            ],
          },
        ],
      };
      await expect(adapter.generate(req, 'k')).rejects.toThrowError(LlmProviderError);
    }
  });

  it('rejects media on an assistant turn rather than silently forwarding it (M2 parity)', async () => {
    const adapter = createGeminiAdapter({ transport: fakeTransport({ candidates: [] }) });
    await expect(
      adapter.generate(
        {
          model: 'gemini-2.5-flash',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            {
              role: 'assistant',
              content: [
                {
                  type: 'media',
                  mimeType: 'image/png',
                  source: { kind: 'base64', data: 'aW1hZ2U=' },
                },
              ],
            },
          ],
        },
        'k',
      ),
    ).rejects.toThrow('assistant-role media is not supported');
  });

  it('gates document input off until 1.AF (a handle-source PDF is rejected — H3)', async () => {
    const adapter = createGeminiAdapter({ transport: fakeTransport({ candidates: [] }) });
    await expect(
      adapter.generate(
        {
          model: 'gemini-2.5-flash',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'media',
                  mimeType: 'application/pdf',
                  source: { kind: 'handle', ref: `media://sha256-${'a'.repeat(64)}` },
                },
              ],
            },
          ],
        },
        'k',
      ),
    ).rejects.toThrowError(UnsupportedCapabilityError);
  });

  it('rejects an unsupported output modality with a typed capability error', async () => {
    const transport = fakeTransport({ candidates: [] });
    const adapter = createGeminiAdapter({ transport });
    const req: LlmRequest = { ...REQ, outputModalities: ['text', 'image', 'audio'] };
    await expect(adapter.generate(req, 'k')).rejects.toThrowError(UnsupportedCapabilityError);
    expect(() => adapter.stream(req, 'k')).toThrowError(UnsupportedCapabilityError);
    expect(transport.lastRequest).toBeUndefined();
  });

  it('allows supported output modalities (text, text+image, text+audio)', async () => {
    const transport = fakeTransport({ candidates: [] });
    const adapter = createGeminiAdapter({ transport });
    for (const modalities of [['text'], ['text', 'image'], ['text', 'audio']] as (
      | 'text'
      | 'image'
      | 'audio'
    )[][]) {
      const req: LlmRequest = { ...REQ, outputModalities: modalities };
      await expect(adapter.generate(req, 'k')).resolves.toBeDefined();
    }
  });

  it('rejects a supported media output on the STREAM path — media-out is generate()-only (1.AG/ADR-0046)', () => {
    // Even a model-supported combination (text+image) is rejected on stream(): the streaming media triad is
    // host-deferred (ADR-0046 §4) and the streaming fold drops media, so streaming media output would be a
    // silent loss. generate() is the only media-out path.
    const adapter = createGeminiAdapter({ transport: fakeTransport({ candidates: [] }) });
    const req: LlmRequest = { ...REQ, outputModalities: ['text', 'image'] };
    expect(() => adapter.stream(req, 'k')).toThrowError(UnsupportedCapabilityError);
  });

  it('maps finish reasons (STOP+tools → tool_use; SAFETY → content_filter; MALFORMED → error)', () => {
    expect(mapStopReason('STOP', false)).toBe('stop');
    expect(mapStopReason('STOP', true)).toBe('tool_use');
    expect(mapStopReason(undefined, true)).toBe('tool_use');
    expect(mapStopReason('MAX_TOKENS', false)).toBe('length');
    expect(mapStopReason('SAFETY', false)).toBe('content_filter');
    expect(mapStopReason('RECITATION', false)).toBe('content_filter');
    expect(mapStopReason('MALFORMED_FUNCTION_CALL', false)).toBe('error');
    expect(mapStopReason('UNEXPECTED_TOOL_CALL', false)).toBe('error');
    expect(mapStopReason('SOMETHING_NEW', false)).toBe('stop');
  });

  it('maps usage to NET, subtracting cached content from the prompt count', () => {
    expect(
      mapUsage({ promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 30 }),
    ).toEqual({ inputTokens: 70, outputTokens: 20, cacheReadTokens: 30 });
    expect(mapUsage({ promptTokenCount: 12, candidatesTokenCount: 7 })).toEqual({
      inputTokens: 12,
      outputTokens: 7,
    });
    expect(mapUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('mapContent maps thought parts → reasoning, text, and a synthesized tool call', () => {
    const response: GeminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              { text: 'thinking...', thought: true, thoughtSignature: 'sig' },
              { text: 'here' },
              { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
            ],
          },
        },
      ],
    };
    const parts = mapContent(response, new GeminiToolCallIds());
    expect(parts[0]).toEqual({ type: 'reasoning', text: 'thinking...', signature: 'sig' }); // ADR-0030
    expect(parts[1]).toEqual({ type: 'text', text: 'here' });
    expect(parts[2]).toMatchObject({
      type: 'tool_call',
      name: 'get_weather',
      args: { city: 'Paris' },
    });
    if (parts[2]?.type === 'tool_call') {
      expect(parts[2].id.length).toBeGreaterThan(0); // synthesized
    }
  });

  it('mapContent surfaces inline media-out (inlineData) as an in-flight base64 media part (1.AG/ADR-0046)', () => {
    const response: GeminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              { text: 'here is your image' },
              { inlineData: { mimeType: 'image/png', data: 'aW1nLWJ5dGVz' } },
            ],
          },
        },
      ],
    };
    const parts = mapContent(response, new GeminiToolCallIds());
    expect(parts[0]).toEqual({ type: 'text', text: 'here is your image' });
    expect(parts[1]).toEqual({
      type: 'media',
      mimeType: 'image/png',
      source: { kind: 'base64', data: 'aW1nLWJ5dGVz' },
    });
  });

  it('mapContent skips an empty inlineData part (no data)', () => {
    const response: GeminiResponse = {
      candidates: [
        {
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: '' } }, { text: 'x' }] },
        },
      ],
    };
    const parts = mapContent(response, new GeminiToolCallIds());
    expect(parts).toEqual([{ type: 'text', text: 'x' }]);
  });

  it('mapContent skips a mimeType-less inlineData part rather than emitting a doomed octet-stream (Opus-fix)', () => {
    // A mimeType-less media part would HARD-FAIL the engine de-inline (mediaModalityOf undefined → run:failed),
    // so it is dropped symmetric with the empty-data skip — never defaulted to application/octet-stream.
    const response: GeminiResponse = {
      candidates: [{ content: { parts: [{ inlineData: { data: 'aW1n' } }, { text: 'x' }] } }],
    };
    expect(mapContent(response, new GeminiToolCallIds())).toEqual([{ type: 'text', text: 'x' }]);
  });
});

describe('geminiErrorToLlmError — classification', () => {
  it('classifies abort, status-bearing, and unknown throwables', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(geminiErrorToLlmError(abort)).toMatchObject({ kind: 'cancelled', retryable: false });
    expect(geminiErrorToLlmError({ status: 429, message: 'rate' })).toMatchObject({
      kind: 'rate_limit',
      retryable: true,
      status: 429,
    });
    expect(geminiErrorToLlmError({ status: 401, message: 'auth' })).toMatchObject({
      kind: 'auth',
      retryable: false,
    });
    expect(geminiErrorToLlmError('boom')).toMatchObject({ kind: 'unknown', retryable: false });
  });
});

describe('Gemini adapter — per-model request-capability gating (ADR-0071 amendment)', () => {
  afterEach(clearCatalogRefresh);
  const catModel = catalogModelFixture; // the shared fixture; each row below pins `provider: 'gemini'`
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];

  it('WITHHOLDS temperature for a model that rejects it, SENDS it when accepted', () => {
    installCatalogRefresh({
      'cap-gemini': catModel({
        modelId: 'cap-gemini',
        provider: 'gemini',
        requestCapabilities: { temperature: false },
      }),
      'cap-gemini-ok': catModel({ modelId: 'cap-gemini-ok', provider: 'gemini' }),
    });
    expect(
      buildGeminiRequest({ model: 'cap-gemini', temperature: 0.4, messages }).config,
    ).not.toHaveProperty('temperature');
    expect(
      buildGeminiRequest({ model: 'cap-gemini-ok', temperature: 0.4, messages }).config[
        'temperature'
      ],
    ).toBe(0.4);
  });

  it('WITHHOLDS structured output (responseJsonSchema) for a model that rejects it', () => {
    installCatalogRefresh({
      'cap-gemini-so': catModel({
        modelId: 'cap-gemini-so',
        provider: 'gemini',
        requestCapabilities: { structuredOutput: false },
      }),
    });
    const config = buildGeminiRequest({
      model: 'cap-gemini-so',
      messages,
      responseFormat: { type: 'json', schema: { type: 'object' } },
    }).config;
    expect(config).not.toHaveProperty('responseJsonSchema');
    expect(config).not.toHaveProperty('responseMimeType');
  });
});

describe('Gemini adapter — request building (buildGeminiRequest)', () => {
  it('routes system → systemInstruction, tools → functionDeclarations, and tool choice modes', () => {
    const request = buildGeminiRequest({
      model: 'gemini-2.5-flash',
      system: 'be terse',
      temperature: 0.4,
      maxTokens: 64,
      stopSequences: ['END'],
      toolChoice: 'required',
      tools: [
        {
          name: 'get_weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(request.config['systemInstruction']).toBe('be terse');
    expect(request.config['temperature']).toBe(0.4);
    expect(request.config['maxOutputTokens']).toBe(64);
    expect(request.config['stopSequences']).toEqual(['END']);
    expect(request.config['toolConfig']).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    expect(request.config['tools']).toMatchObject([
      { functionDeclarations: [{ name: 'get_weather' }] },
    ]);
    expect(request.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('maps a named tool choice to ANY + allowedFunctionNames', () => {
    const request = buildGeminiRequest({ ...REQ, toolChoice: { name: 'get_weather' } });
    expect(request.config['toolConfig']).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    });
  });

  it('lowers non-text output_modalities to responseModalities (inline media-out, 1.AG/ADR-0046)', () => {
    const request = buildGeminiRequest({ ...REQ, outputModalities: ['text', 'image'] });
    expect(request.config['responseModalities']).toEqual(['TEXT', 'IMAGE']);
  });

  it('omits responseModalities for a text-only output (default behavior unchanged)', () => {
    const request = buildGeminiRequest({ ...REQ, outputModalities: ['text'] });
    expect('responseModalities' in request.config).toBe(false);
  });

  it('threads a real AbortSignal into config.abortSignal', () => {
    const controller = new AbortController();
    const request = buildGeminiRequest({ ...REQ, signal: controller.signal });
    expect(request.config['abortSignal']).toBe(controller.signal);
  });

  it('maps none/auto tool choice modes', () => {
    expect(buildGeminiRequest({ ...REQ, toolChoice: 'none' }).config['toolConfig']).toEqual({
      functionCallingConfig: { mode: 'NONE' },
    });
    expect(buildGeminiRequest({ ...REQ, toolChoice: 'auto' }).config['toolConfig']).toEqual({
      functionCallingConfig: { mode: 'AUTO' },
    });
  });

  /**
   * THE LIVE BUG, and its fix (ADR-0071 §6). The reasoning field is chosen PER MODEL, not per adapter.
   *
   * The test these replace asserted `thinkingLevel` for every tier on `gemini-2.5-flash` — and its own comment
   * said "a Pro model rejects budget 0", so the author already suspected the shape was not universal. It is not:
   * Google's docs for the `generateContent` API this adapter calls state that **Gemini 2.5 does not support
   * `thinkingLevel` at all** and takes `thinkingBudget` instead. `gemini-2.5-flash` and `gemini-2.5-pro` are the
   * only two Gemini rows we ship, so `/effort` on Gemini has been sending a parameter the models do not take.
   */
  it('a BUDGET-shaped model (gemini-2.5-*) gets thinkingBudget — NOT thinkingLevel', () => {
    // Catalog: gemini-2.5-flash → { toggle, budgetTokens: { min: 0, max: 24576 } }. No effort axis.
    const built = (effort: ReasoningEffort): unknown =>
      buildGeminiRequest({ ...REQ, reasoningEffort: effort, maxTokens: 8192 }).config[
        'thinkingConfig'
      ];

    // The tiers scale across the range under a ceiling that RESERVES ROOM FOR THE ANSWER: floor(8192 * 0.8) = 6553,
    // not the whole 8192. `max` used to hand the entire output cap to the thoughts, so the model thought to the
    // limit and then had nothing left to reply with — a request the API happily accepts and that returns no answer.
    expect(built('low')).toEqual({ thinkingBudget: 1638, includeThoughts: true }); // 25% of [0, 6553]
    expect(built('high')).toEqual({ thinkingBudget: 4915, includeThoughts: true }); // 75%
    expect(built('max')).toEqual({ thinkingBudget: 6553, includeThoughts: true }); // the ceiling, not maxTokens
    // `off` on Gemini is `thinkingBudget: 0` — the real disable — never MINIMAL, which still thinks and still bills.
    expect(built('off')).toEqual({ thinkingBudget: 0 });
    expect('thinkingConfig' in buildGeminiRequest(REQ).config).toBe(false); // unset ⇒ omitted
  });

  it('CLAMPS maxOutputTokens to the model ceiling — and the thinking budget follows the CLAMPED cap', () => {
    // ADR-0071 §7. `gemini-2.5-pro`'s ceiling is 65_536; an authored 200_000 is a 400 on every turn.
    //
    // The coupling is the sharp edge: the thinking budget is carved OUT of the output cap, so clamping the cap and
    // deriving the budget from the RAW one would hand the model a budget larger than the cap we actually send.
    const request = buildGeminiRequest({
      ...REQ,
      model: 'gemini-2.5-pro',
      maxTokens: 200_000,
      reasoningEffort: 'max',
    });
    expect(request.config['maxOutputTokens']).toBe(65_536); // clamped to the model's real ceiling
    const thinking = request.config['thinkingConfig'] as { thinkingBudget: number };
    // 80% of the CLAMPED cap (52_428), not of the 200 000 asked for — and capped by the model's own budget max.
    expect(thinking.thinkingBudget).toBeLessThanOrEqual(52_429);
    expect(thinking.thinkingBudget).toBeLessThan(65_536); // the answer keeps room, which is the whole point
  });

  it("leaves a cap BELOW the ceiling alone — the author's budget is not a mistake to correct", () => {
    const request = buildGeminiRequest({ ...REQ, model: 'gemini-2.5-pro', maxTokens: 4_096 });
    expect(request.config['maxOutputTokens']).toBe(4_096);
  });

  it('a TOGGLE model with a non-zero floor can still be turned OFF — picker and wire agree', () => {
    // gemini-2.5-flash-lite publishes BOTH a toggle and `budgetTokens: { min: 512, … }`. The picker offers `off`
    // (a toggle IS a disable switch); the adapter used to test only `min === 0` and silently withhold the field —
    // so the user turned reasoning off, was billed for it anyway, and nothing told them. Both sides now ask the
    // one predicate, {@link canDisableReasoning}, so they cannot drift apart again.
    expect(
      buildGeminiRequest({
        ...REQ,
        model: 'gemini-2.5-flash-lite',
        reasoningEffort: 'off',
        maxTokens: 8192,
      }).config['thinkingConfig'],
    ).toEqual({ thinkingBudget: 0 });
  });

  it('withholds the budget when even the model floor will not fit under the cap', () => {
    // gemini-2.5-pro's floor is 128 thought tokens. A 64-token answer cap leaves a ceiling of floor(64 * 0.8) = 51,
    // under the floor — no budget in the range is sendable, so the field is omitted and the model uses its default,
    // rather than us putting a value on the wire that the API will reject outright.
    const request = buildGeminiRequest({
      ...REQ,
      model: 'gemini-2.5-pro',
      reasoningEffort: 'low',
      maxTokens: 64,
    });
    expect('thinkingConfig' in request.config).toBe(false);
  });

  it('an EFFORT-shaped model (gemini-3.x) gets thinkingLevel — the shape follows the model', () => {
    const req: LlmRequest = { ...REQ, model: 'gemini-3.5-flash' }; // catalog: effortValues
    expect(
      buildGeminiRequest({ ...req, reasoningEffort: 'high' }).config['thinkingConfig'],
    ).toEqual({ thinkingLevel: 'HIGH', includeThoughts: true });
    // Gemini's ladder stops at HIGH — `max` coarsens onto it, honestly.
    expect(buildGeminiRequest({ ...req, reasoningEffort: 'max' }).config['thinkingConfig']).toEqual(
      {
        thinkingLevel: 'HIGH',
        includeThoughts: true,
      },
    );
  });

  it('gemini-2.5-pro CANNOT be turned off — the field is WITHHELD, never downgraded to MINIMAL', () => {
    // Google: "N/A: Cannot disable thinking". Catalog: budgetTokens.min = 128. `acceptedTiers` never offers `off`
    // for it, and if one arrives anyway the adapter withholds rather than substituting a value that neither
    // disables thinking nor is one the model takes. Silently billing a user for reasoning they switched OFF is
    // the worst reading of this bug, and it is the one the old code shipped.
    const built = buildGeminiRequest({
      ...REQ,
      model: 'gemini-2.5-pro',
      reasoningEffort: 'off',
    }).config;
    expect('thinkingConfig' in built).toBe(false);
  });

  it('a model the catalog does not know gets NO reasoning field — a guess is what broke this', () => {
    const built = buildGeminiRequest({
      ...REQ,
      model: 'some-custom-endpoint-model',
      reasoningEffort: 'high',
    }).config;
    expect('thinkingConfig' in built).toBe(false);
  });

  it('deep-merges onto a caller providerOptions.thinkingConfig — sibling keys survive (ADR-0066)', () => {
    // A caller who set thought output must not lose it when effort is also set: the canonical key wins on ITS
    // key, and a non-colliding sibling survives.
    const built = buildGeminiRequest({
      ...REQ,
      model: 'gemini-3.5-flash', // effort-shaped, so `thinkingLevel` is the canonical key here
      reasoningEffort: 'high',
      providerOptions: { thinkingConfig: { includeThoughts: false, topK: 5 } },
    });
    expect(built.config['thinkingConfig']).toEqual({
      thinkingLevel: 'HIGH', // canonical wins on this key
      includeThoughts: false, // the caller's explicit choice is NOT overridden
      topK: 5, // a non-colliding sibling survives
    });
  });

  it('round-trips tool_call → functionCall and tool_result → functionResponse by name', () => {
    const request = buildGeminiRequest({
      model: 'gemini-2.5-flash',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: 'gemini-tool-0-get_weather',
              name: 'get_weather',
              args: { city: 'Paris' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', toolCallId: 'gemini-tool-0-get_weather', result: { tempC: 18 } },
          ],
        },
      ],
    });
    expect(request.contents[0]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }],
    });
    // the tool result resolves the function name from the matching tool_call id (Gemini has no id)
    expect(request.contents[1]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: { tempC: 18 } } }],
    });
  });

  it('wraps a non-object tool result and lets providerOptions only ADD (mapped fields win)', () => {
    const request = buildGeminiRequest({
      model: 'gemini-2.5-flash',
      providerOptions: { cachedContent: 'abc', temperature: 99 },
      temperature: 0.1,
      messages: [
        { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'x', result: 'plain text' }] },
      ],
    });
    expect(request.contents[0]?.parts[0]).toEqual({
      functionResponse: { name: 'x', response: { result: 'plain text' } },
    });
    expect(request.config['cachedContent']).toBe('abc'); // escape-hatch field
    expect(request.config['temperature']).toBe(0.1); // mapped field wins over providerOptions
  });

  it('strips httpOptions from providerOptions to prevent SSRF via baseUrl redirect', () => {
    const request = buildGeminiRequest({
      ...REQ,
      providerOptions: {
        httpOptions: { baseUrl: 'https://attacker.example' },
        cachedContent: 'kept',
      },
    });
    expect(request.config['httpOptions']).toBeUndefined();
    expect(request.config['cachedContent']).toBe('kept'); // only transport keys are stripped
  });

  it('maps base64 media parts to Gemini inlineData', () => {
    const request = buildGeminiRequest({
      model: 'gemini-2.5-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe these' },
            { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'aW1hZ2U=' } },
            { type: 'media', mimeType: 'audio/wav', source: { kind: 'base64', data: 'YXVkaW8=' } },
            { type: 'media', mimeType: 'video/mp4', source: { kind: 'base64', data: 'dmlkZW8=' } },
            {
              type: 'media',
              mimeType: 'application/pdf',
              source: { kind: 'base64', data: 'cGRm' },
            },
          ],
        },
      ],
    });
    expect(request.contents).toHaveLength(1);
    const parts = request.contents[0]!.parts;
    expect(parts[0]).toEqual({ text: 'describe these' });
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } });
    expect(parts[2]).toEqual({ inlineData: { mimeType: 'audio/wav', data: 'YXVkaW8=' } });
    expect(parts[3]).toEqual({ inlineData: { mimeType: 'video/mp4', data: 'dmlkZW8=' } });
    expect(parts[4]).toEqual({ inlineData: { mimeType: 'application/pdf', data: 'cGRm' } });
  });

  it('rejects handle and url media sources with an explicit bad_request error', () => {
    for (const source of [
      { kind: 'handle' as const, ref: `media://sha256-${'a'.repeat(64)}` },
      { kind: 'url' as const, url: 'https://example.com/img.png' },
    ]) {
      expect(() =>
        buildGeminiRequest({
          model: 'gemini-2.5-flash',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'media', mimeType: 'image/png', source },
                { type: 'text', text: 'what is this' },
              ],
            },
          ],
        }),
      ).toThrowError(LlmProviderError);
    }
  });
});

describe('Gemini adapter — generate / stream via injected transport', () => {
  const textResponse: GeminiResponse = {
    candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  };

  it('generate folds a response into an LlmResult', async () => {
    const adapter = createGeminiAdapter({ transport: fakeTransport(textResponse) });
    const result = await adapter.generate(REQ, 'k');
    expect(result.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(result.stopReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it('generate surfaces a transport rejection as a classified LlmProviderError', async () => {
    // Built at runtime so no contiguous key-like literal sits in source (the llm-error.test.ts
    // convention). A Gemini-shaped key (`AIza` + ≥20 chars) so it matches the real scrub pattern,
    // ECHOED in the vendor error message (security-review.md: each adapter plants a secret in a
    // vendor error) — the scrubSecrets backstop must actually fire, not merely find a message the
    // key never reached.
    const SECRET = ['AI', 'za', 'SECRET_DO_NOT_LEAK_123'].join('');
    const transport: GeminiTransport = {
      generate: () => Promise.reject(Object.assign(new Error(`rl: ${SECRET}`), { status: 429 })),
      stream: () => Promise.reject(new Error('unused')),
      ...unusedGenerative,
    };
    const adapter = createGeminiAdapter({ transport });
    let caught: unknown;
    try {
      await adapter.generate(REQ, SECRET);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmProviderError);
    if (caught instanceof LlmProviderError) {
      expect(caught.llmError.kind).toBe('rate_limit');
      expect(JSON.stringify(caught.llmError)).not.toContain('SECRET');
      // Positive proof the scrub fired (the echoed key reached the message and was masked).
      expect(caught.llmError.message).toContain('[REDACTED]');
    }
  });

  it('stream folds text + a tool call (start/delta/end) then a terminal stop', async () => {
    const toolChunk: GeminiResponse = {
      candidates: [
        {
          content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15 },
    };
    const adapter = createGeminiAdapter({ transport: fakeTransport(toolChunk, [toolChunk]) });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks.find((c) => c.type === 'tool_call_start')).toMatchObject({ name: 'get_weather' });
    expect(chunks.some((c) => c.type === 'tool_call_delta')).toBe(true);
    expect(chunks.some((c) => c.type === 'tool_call_end')).toBe(true);
    const stop = chunks.at(-1);
    expect(stop?.type).toBe('stop');
    if (stop?.type === 'stop') {
      expect(stop.stopReason).toBe('tool_use');
    }
  });

  it('stream yields a single error chunk when the transport fails to start', async () => {
    const transport: GeminiTransport = {
      generate: () => Promise.reject(new Error('unused')),
      stream: () => Promise.reject(Object.assign(new Error('overloaded'), { status: 503 })),
      ...unusedGenerative,
    };
    const adapter = createGeminiAdapter({ transport });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe('error');
    if (chunks[0]?.type === 'error') {
      expect(chunks[0].error.kind).toBe('overloaded');
    }
  });
});

describe('Gemini adapter — remaining branches', () => {
  it('maps all content-filter finish reasons', () => {
    for (const reason of ['BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'] as const) {
      expect(mapStopReason(reason, false)).toBe('content_filter');
    }
  });

  it('generate tolerates a response with no usage metadata', async () => {
    const adapter = createGeminiAdapter({
      transport: {
        generate: () =>
          Promise.resolve({
            candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
          }),
        stream: () => Promise.reject(new Error('unused')),
        ...unusedGenerative,
      },
    });
    const result = await adapter.generate(REQ, 'k');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('folds a mid-stream iteration error into an error chunk', async () => {
    const adapter = createGeminiAdapter({
      transport: {
        generate: () => Promise.reject(new Error('unused')),
        stream: () =>
          Promise.resolve(
            (async function* () {
              await Promise.resolve();
              yield { candidates: [{ content: { parts: [{ text: 'partial' }] } }] };
              throw Object.assign(new Error('mid-stream'), { status: 500 });
            })(),
          ),
        ...unusedGenerative,
      },
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks.some((c) => c.type === 'text_delta')).toBe(true);
    expect(chunks.at(-1)?.type).toBe('error');
  });

  it('drops a message that lowers to zero parts', () => {
    const request = buildGeminiRequest({
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: [] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    });
    expect(request.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });
});

describe('Gemini adapter — reasoning + structured output (ADR-0030)', () => {
  it('lowers responseFormat json to responseMimeType + responseJsonSchema', () => {
    const request = buildGeminiRequest({
      ...REQ,
      responseFormat: { type: 'json', schema: { type: 'object' } },
    });
    expect(request.config['responseMimeType']).toBe('application/json');
    expect(request.config['responseJsonSchema']).toEqual({ type: 'object' });
  });

  it('mapUsage adds thoughtsTokenCount into outputTokens (Gemini bills them separately)', () => {
    expect(
      mapUsage({ promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 6 }),
    ).toEqual({ inputTokens: 10, outputTokens: 26, reasoningTokens: 6 });
  });

  it('stream folds thought parts into reasoning_start/delta/end (signature) then text', async () => {
    const response: GeminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              { text: 'pondering', thought: true, thoughtSignature: 'sig' },
              { text: 'final answer' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, thoughtsTokenCount: 2 },
    };
    const adapter = createGeminiAdapter({ transport: fakeTransport(response, [response]) });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks.find((c) => c.type === 'reasoning_start')).toMatchObject({ id: 'reasoning-0' });
    expect(chunks.find((c) => c.type === 'reasoning_delta')).toMatchObject({ text: 'pondering' });
    expect(chunks.find((c) => c.type === 'reasoning_end')).toMatchObject({ signature: 'sig' });
    const types = chunks.map((c) => c.type);
    expect(types.indexOf('reasoning_end')).toBeLessThan(types.indexOf('text_delta'));
    const stop = chunks.at(-1);
    expect(stop?.type).toBe('stop');
    if (stop?.type === 'stop') {
      expect(stop.usage.reasoningTokens).toBe(2);
    }
  });
});

describe('Gemini adapter — reasoning close edges', () => {
  it('closes reasoning before a tool call', async () => {
    const r: GeminiResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'think', thought: true }, { functionCall: { name: 'f', args: {} } }],
          },
          finishReason: 'STOP',
        },
      ],
    };
    const types = (
      await collect(createGeminiAdapter({ transport: fakeTransport(r, [r]) }).stream(REQ, 'k'))
    ).map((c) => c.type);
    expect(types.indexOf('reasoning_end')).toBeLessThan(types.indexOf('tool_call_start'));
  });

  it('closes reasoning after a thought-only stream (before stop)', async () => {
    const r: GeminiResponse = {
      candidates: [
        { content: { parts: [{ text: 'just thinking', thought: true }] }, finishReason: 'STOP' },
      ],
    };
    const chunks = await collect(
      createGeminiAdapter({ transport: fakeTransport(r, [r]) }).stream(REQ, 'k'),
    );
    expect(chunks.some((c) => c.type === 'reasoning_end')).toBe(true);
    expect(chunks.at(-1)?.type).toBe('stop');
  });
});

describe('Gemini adapter — usage, truncation, refusal, malformed tool (review fixes)', () => {
  it('mapUsage adds toolUsePromptTokenCount to input (disjoint from prompt tokens)', () => {
    expect(
      mapUsage({ promptTokenCount: 10, candidatesTokenCount: 4, toolUsePromptTokenCount: 6 }),
    ).toEqual({ inputTokens: 16, outputTokens: 4 });
  });

  it('emits a transport error when a stream ends without a finishReason (truncated)', async () => {
    const r: GeminiResponse = { candidates: [{ content: { parts: [{ text: 'partial' }] } }] };
    const chunks = await collect(
      createGeminiAdapter({ transport: fakeTransport(r, [r]) }).stream(REQ, 'k'),
    );
    expect(chunks.some((c) => c.type === 'text_delta')).toBe(true);
    const last = chunks.at(-1);
    expect(last?.type).toBe('error');
    if (last?.type === 'error') {
      expect(last.error.kind).toBe('transport');
      expect(last.error.retryable).toBe(true);
    }
  });

  it('maps a blocked-prompt generate (no candidate + promptFeedback) to content_filter', async () => {
    const r: GeminiResponse = { promptFeedback: { blockReason: 'SAFETY' } };
    const result = await createGeminiAdapter({ transport: fakeTransport(r) }).generate(REQ, 'k');
    expect(result.content).toEqual([]);
    expect(result.stopReason).toBe('content_filter');
  });

  it('maps a blocked-prompt stream to a content_filter stop (terminal, not truncation)', async () => {
    const r: GeminiResponse = { promptFeedback: { blockReason: 'SAFETY' } };
    const chunks = await collect(
      createGeminiAdapter({ transport: fakeTransport(r, [r]) }).stream(REQ, 'k'),
    );
    const stop = chunks.at(-1);
    expect(stop?.type).toBe('stop');
    if (stop?.type === 'stop') {
      expect(stop.stopReason).toBe('content_filter');
    }
  });

  it('treats BLOCKED_REASON_UNSPECIFIED as NOT blocked (the sentinel is not a real block)', async () => {
    // A normal response that happens to carry the unspecified sentinel must not be mis-mapped to
    // content_filter. Here it rides alongside a real candidate.
    const r: GeminiResponse = {
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      promptFeedback: { blockReason: 'BLOCKED_REASON_UNSPECIFIED' },
    };
    const result = await createGeminiAdapter({ transport: fakeTransport(r) }).generate(REQ, 'k');
    expect(result.stopReason).toBe('stop');
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('skips a nameless functionCall in a stream (no invalid name:"" tool_call_start)', async () => {
    const r: GeminiResponse = {
      candidates: [{ content: { parts: [{ functionCall: { args: {} } }] }, finishReason: 'STOP' }],
    };
    const chunks = await collect(
      createGeminiAdapter({ transport: fakeTransport(r, [r]) }).stream(REQ, 'k'),
    );
    expect(chunks.some((c) => c.type === 'tool_call_start')).toBe(false);
    expect(chunks.at(-1)?.type).toBe('stop');
  });
});

describe('Gemini adapter — generateMedia (Imagen, sync, 1.AH A2)', () => {
  const IMG_REQ: MediaGenRequest = {
    model: 'imagen-4.0-generate-001',
    prompt: 'a red circle on a white background',
    modality: 'image',
  };
  const B64 = 'aGVsbG8taW1hZ2Vu'; // "hello-imagen"

  it('normalizes a generated image to a base64 media part (no jobId, raw retained)', async () => {
    const fixture: GeminiImageResponse = {
      generatedImages: [{ image: { imageBytes: B64, mimeType: 'image/png' } }],
    };
    const transport = fakeImageTransport(fixture);
    const result = await genMedia(createGeminiAdapter({ transport }), IMG_REQ, 'k');
    expect(result.jobId).toBeUndefined(); // SYNC arm
    expect(result.media?.type).toBe('media');
    expect(result.media?.mimeType).toBe('image/png');
    expect(result.media?.source).toEqual({ kind: 'base64', data: B64 });
    expect(result.raw).toBe(fixture); // internal diagnostic (the exact transport response) — sinks strip it (I3)
    // The single-artifact seam: numberOfImages is pinned to 1, and the prompt/model are threaded.
    expect(transport.lastImageRequest?.config['numberOfImages']).toBe(1);
    expect(transport.lastImageRequest?.prompt).toBe(IMG_REQ.prompt);
    expect(transport.lastImageRequest?.model).toBe(IMG_REQ.model);
  });

  it('defaults the MIME to image/png when the vendor omits it', async () => {
    const transport = fakeImageTransport({ generatedImages: [{ image: { imageBytes: B64 } }] });
    const result = await genMedia(createGeminiAdapter({ transport }), IMG_REQ, 'k');
    expect(result.media?.mimeType).toBe('image/png');
  });

  it('strips MIME parameters to the canonical bare MIME (image/png; q=1.0 → image/png)', async () => {
    const transport = fakeImageTransport({
      generatedImages: [{ image: { imageBytes: B64, mimeType: 'image/png; q=1.0' } }],
    });
    const result = await genMedia(createGeminiAdapter({ transport }), IMG_REQ, 'k');
    expect(result.media?.mimeType).toBe('image/png');
  });

  it('rejects an illegal (CR/LF-injected) vendor MIME → falls back to image/png (bareMimeType validates)', async () => {
    const transport = fakeImageTransport({
      generatedImages: [{ image: { imageBytes: B64, mimeType: 'image/png\nX-Injected: 1' } }],
    });
    const result = await genMedia(createGeminiAdapter({ transport }), IMG_REQ, 'k');
    expect(result.media?.mimeType).toBe('image/png'); // the injected MIME never reaches media_objects.mimeType
  });

  it('strips a caller-supplied httpOptions from the Imagen config (SSRF: no baseUrl/key redirect)', async () => {
    const transport = fakeImageTransport({
      generatedImages: [{ image: { imageBytes: B64, mimeType: 'image/png' } }],
    });
    await genMedia(
      createGeminiAdapter({ transport }),
      {
        ...IMG_REQ,
        providerOptions: {
          httpOptions: { baseUrl: 'https://attacker.example' },
          abortSignal: new AbortController().signal,
          aspectRatio: '16:9',
        },
      },
      'k',
    );
    // httpOptions (SSRF) + an author-injected abortSignal are stripped; benign knobs survive.
    expect(transport.lastImageRequest?.config['httpOptions']).toBeUndefined();
    expect(transport.lastImageRequest?.config['abortSignal']).toBeUndefined();
    expect(transport.lastImageRequest?.config['aspectRatio']).toBe('16:9');
  });

  it('threads providerOptions into config but pins numberOfImages to 1 (count can not be smuggled)', async () => {
    const transport = fakeImageTransport({
      generatedImages: [{ image: { imageBytes: B64, mimeType: 'image/png' } }],
    });
    await genMedia(
      createGeminiAdapter({ transport }),
      { ...IMG_REQ, providerOptions: { aspectRatio: '16:9', numberOfImages: 5 } },
      'k',
    );
    expect(transport.lastImageRequest?.config['aspectRatio']).toBe('16:9');
    expect(transport.lastImageRequest?.config['numberOfImages']).toBe(1); // the pin wins over providerOptions
  });

  it('threads an AbortSignal into the Imagen config so a run cancel reaches the in-flight call', async () => {
    const transport = fakeImageTransport({
      generatedImages: [{ image: { imageBytes: B64, mimeType: 'image/png' } }],
    });
    const controller = new AbortController();
    await genMedia(
      createGeminiAdapter({ transport }),
      { ...IMG_REQ, signal: controller.signal },
      'k',
    );
    expect(transport.lastImageRequest?.config['abortSignal']).toBe(controller.signal);
  });

  it('rejects count > 1 (single-artifact SYNC seam) with a typed bad_request before any egress', async () => {
    const transport = fakeImageTransport({ generatedImages: [] });
    await expect(
      genMedia(createGeminiAdapter({ transport }), { ...IMG_REQ, count: 3 }, 'k'),
    ).rejects.toMatchObject({ llmError: { kind: 'bad_request' } });
    expect(transport.lastImageRequest).toBeUndefined(); // rejected before the transport call
  });

  it('maps a safety-filtered candidate (raiFilteredReason, no image) to content_filter', async () => {
    const transport = fakeImageTransport({
      generatedImages: [{ raiFilteredReason: 'Unsafe content detected' }],
    });
    await expect(genMedia(createGeminiAdapter({ transport }), IMG_REQ, 'k')).rejects.toMatchObject({
      llmError: { kind: 'content_filter' },
    });
  });

  it('maps a no-image response to a typed bad_request LlmProviderError', async () => {
    const transport = fakeImageTransport({ generatedImages: [] });
    await expect(genMedia(createGeminiAdapter({ transport }), IMG_REQ, 'k')).rejects.toMatchObject({
      llmError: { kind: 'bad_request' },
    });
  });

  it('maps an entirely-absent generatedImages field to bad_request (optional-chain short-circuit)', async () => {
    const transport = fakeImageTransport({});
    await expect(genMedia(createGeminiAdapter({ transport }), IMG_REQ, 'k')).rejects.toMatchObject({
      llmError: { kind: 'bad_request' },
    });
  });

  it('does NOT mistake a present-but-empty raiFilteredReason for content_filter (→ bad_request)', async () => {
    // The content_filter guard requires a NON-empty reason; an empty one is a contract violation, not a
    // safety block, so it must fall through to the generic no-data bad_request.
    const transport = fakeImageTransport({ generatedImages: [{ raiFilteredReason: '' }] });
    await expect(genMedia(createGeminiAdapter({ transport }), IMG_REQ, 'k')).rejects.toMatchObject({
      llmError: { kind: 'bad_request' },
    });
  });

  it('surfaces a transport rejection as a classified LlmProviderError', async () => {
    const transport: GeminiTransport = {
      ...unusedGenerative,
      generate: () => Promise.reject(new Error('unused')),
      stream: () => Promise.reject(new Error('unused')),
      generateImages: () => Promise.reject(Object.assign(new Error('overloaded'), { status: 503 })),
    };
    await expect(genMedia(createGeminiAdapter({ transport }), IMG_REQ, 'k')).rejects.toMatchObject({
      llmError: { kind: 'overloaded' },
    });
  });

  it('rejects audio modality with a typed capability error (image is Imagen; video is the async Veo arm)', async () => {
    const transport = fakeImageTransport({ generatedImages: [] });
    const adapter = createGeminiAdapter({ transport });
    await expect(genMedia(adapter, { ...IMG_REQ, modality: 'audio' }, 'k')).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
  });
});

describe('Gemini adapter — generateMedia/pollMediaJob (Veo video, async LRO, 1.AH A4)', () => {
  const VIDEO_REQ: MediaGenRequest = {
    model: 'veo-3.0-generate-001',
    prompt: 'a wave breaking on a beach',
    modality: 'video',
    durationSeconds: 6,
  };
  const B64 = 'dmVvLWJ5dGVz'; // "veo-bytes"

  it('generateMedia (video) ALWAYS returns an opaque jobId from the operation name (no media, raw byte-free)', async () => {
    const transport = fakeVideoTransport({ operation: { name: 'operations/veo-42' } });
    const result = await genMedia(createGeminiAdapter({ transport }), VIDEO_REQ, 'k');
    expect(result.media).toBeUndefined(); // ASYNC arm
    expect(result.jobId).toBe(encodeMediaJobId('operations/veo-42'));
    expect(result.jobId).not.toContain('operations/veo-42'); // base64url-opaque
    expect(MediaGenResultSchema.safeParse(result).success).toBe(true);
    expect(result.raw).toEqual({ name: 'operations/veo-42' }); // no bytes in raw (I3)
    // Single-artifact pin + durationSeconds threaded into the typed config.
    expect(transport.lastVideoRequest?.config['numberOfVideos']).toBe(1);
    expect(transport.lastVideoRequest?.config['durationSeconds']).toBe(6);
    expect(transport.lastVideoRequest?.prompt).toBe(VIDEO_REQ.prompt);
  });

  it('generateMedia (video) strips httpOptions + pins numberOfVideos to 1 (SSRF + single-artifact guards)', async () => {
    const transport = fakeVideoTransport({ operation: { name: 'operations/veo-42' } });
    await genMedia(
      createGeminiAdapter({ transport }),
      {
        ...VIDEO_REQ,
        providerOptions: {
          httpOptions: { baseUrl: 'https://attacker.example' },
          numberOfVideos: 5, // must be force-pinned back to 1 (the A2 single-artifact lesson)
          aspectRatio: '16:9',
        },
      },
      'k',
    );
    expect(transport.lastVideoRequest?.config['httpOptions']).toBeUndefined();
    expect(transport.lastVideoRequest?.config['numberOfVideos']).toBe(1); // pin wins over providerOptions
    expect(transport.lastVideoRequest?.config['aspectRatio']).toBe('16:9'); // benign knob survives
  });

  it('generateMedia (video) threads the AbortSignal into the Veo create config', async () => {
    const transport = fakeVideoTransport({ operation: { name: 'operations/veo-42' } });
    const controller = new AbortController();
    await genMedia(
      createGeminiAdapter({ transport }),
      { ...VIDEO_REQ, signal: controller.signal },
      'k',
    );
    expect(transport.lastVideoRequest?.config['abortSignal']).toBe(controller.signal);
  });

  it('generateMedia (video) omits durationSeconds from the config when not requested', async () => {
    const transport = fakeVideoTransport({ operation: { name: 'operations/veo-42' } });
    await genMedia(
      createGeminiAdapter({ transport }),
      { ...VIDEO_REQ, durationSeconds: undefined },
      'k',
    );
    expect(transport.lastVideoRequest?.config['durationSeconds']).toBeUndefined();
  });

  it('generateMedia (video) maps a missing operation name to a typed bad_request', async () => {
    const transport = fakeVideoTransport({ operation: { name: '' } });
    await expect(
      genMedia(createGeminiAdapter({ transport }), VIDEO_REQ, 'k'),
    ).rejects.toMatchObject({
      llmError: { kind: 'bad_request' },
    });
  });

  it('pollMediaJob maps an in-progress operation (done:false) to pending + threads the DECODED op-name', async () => {
    const transport = fakeVideoTransport({ poll: { done: false } });
    expect(
      await pollMedia(
        createGeminiAdapter({ transport }),
        encodeMediaJobId('operations/veo-42'),
        'k',
      ),
    ).toEqual({ state: 'pending' });
    // The opaque jobId is decoded back to the vendor op-name and threaded to the transport (re-attach, §3).
    expect(transport.lastOperationName).toBe('operations/veo-42');
  });

  it('pollMediaJob walks a pending → done sequence across successive polls (clamps on the last status)', async () => {
    const transport = fakeVideoTransport({
      poll: [{ done: false }, { done: true, video: { videoBytes: B64, mimeType: 'video/mp4' } }],
    });
    const adapter = createGeminiAdapter({ transport });
    const jobId = encodeMediaJobId('op');
    expect(await pollMedia(adapter, jobId, 'k')).toEqual({ state: 'pending' });
    expect(await pollMedia(adapter, jobId, 'k')).toMatchObject({ state: 'done' });
    expect(await pollMedia(adapter, jobId, 'k')).toMatchObject({ state: 'done' }); // clamps on the last
  });

  it('pollMediaJob delivers inline videoBytes as a base64 video/mp4 media part (done)', async () => {
    const transport = fakeVideoTransport({
      poll: { done: true, video: { videoBytes: B64, mimeType: 'video/mp4' } },
    });
    const status = await pollMedia(createGeminiAdapter({ transport }), encodeMediaJobId('op'), 'k');
    expect(MediaJobStatusSchema.safeParse(status).success).toBe(true);
    expect(status).toEqual({
      state: 'done',
      media: { type: 'media', mimeType: 'video/mp4', source: { kind: 'base64', data: B64 } },
    });
  });

  it('pollMediaJob strips MIME parameters from the vendor video MIME (video/mp4;codecs=h264 → video/mp4)', async () => {
    const transport = fakeVideoTransport({
      poll: { done: true, video: { videoBytes: B64, mimeType: 'video/mp4; codecs=h264' } },
    });
    const status = await pollMedia(createGeminiAdapter({ transport }), encodeMediaJobId('op'), 'k');
    expect(status).toMatchObject({ media: { mimeType: 'video/mp4' } });
  });

  it('pollMediaJob delivers a uri-only result as a re-hostable url media source (engine de-inlines it)', async () => {
    const transport = fakeVideoTransport({
      poll: { done: true, video: { uri: 'https://generativelanguage.googleapis.com/v1/files/x' } },
    });
    const status = await pollMedia(createGeminiAdapter({ transport }), encodeMediaJobId('op'), 'k');
    expect(MediaJobStatusSchema.safeParse(status).success).toBe(true); // url source is a valid done state
    expect(status).toEqual({
      state: 'done',
      media: {
        type: 'media',
        mimeType: 'video/mp4',
        source: { kind: 'url', url: 'https://generativelanguage.googleapis.com/v1/files/x' },
      },
    });
  });

  it('pollMediaJob maps a safety-filtered completion (raiFilteredCount > 0, no video) to content_filter', async () => {
    const transport = fakeVideoTransport({ poll: { done: true, raiFilteredCount: 1 } });
    expect(
      await pollMedia(createGeminiAdapter({ transport }), encodeMediaJobId('op'), 'k'),
    ).toMatchObject({ state: 'failed', error: { kind: 'content_filter' } });
  });

  it('pollMediaJob maps an operation error to a fatal unknown failed', async () => {
    const transport = fakeVideoTransport({ poll: { done: true, error: { message: 'quota' } } });
    expect(
      await pollMedia(createGeminiAdapter({ transport }), encodeMediaJobId('op'), 'k'),
    ).toMatchObject({ state: 'failed', error: { kind: 'unknown' } });
  });

  it('pollMediaJob maps a completion with no video/error/rai to bad_request', async () => {
    const transport = fakeVideoTransport({ poll: { done: true } });
    expect(
      await pollMedia(createGeminiAdapter({ transport }), encodeMediaJobId('op'), 'k'),
    ).toMatchObject({ state: 'failed', error: { kind: 'bad_request' } });
  });

  it('pollMediaJob returns a FATAL failed (not a throw) for an unrecognized jobId token', async () => {
    const transport = fakeVideoTransport({ poll: { done: false } });
    const status = await pollMedia(createGeminiAdapter({ transport }), 'not-a-relavium-token', 'k');
    expect(status).toMatchObject({ state: 'failed', error: { kind: 'bad_request' } });
    expect(transport.lastPollSignal).toBeUndefined(); // never reached the transport — decode failed first
  });

  it('pollMediaJob threads the AbortSignal into the Veo poll', async () => {
    const transport = fakeVideoTransport({ poll: { done: false } });
    const controller = new AbortController();
    await pollMedia(
      createGeminiAdapter({ transport }),
      encodeMediaJobId('op'),
      'k',
      controller.signal,
    );
    expect(transport.lastPollSignal).toBe(controller.signal);
  });

  it('surfaces a generateVideos transport rejection as a classified LlmProviderError', async () => {
    const transport: GeminiTransport = {
      ...unusedGenerative,
      generate: () => Promise.reject(new Error('unused')),
      stream: () => Promise.reject(new Error('unused')),
      generateVideos: () => Promise.reject(Object.assign(new Error('overloaded'), { status: 503 })),
    };
    await expect(
      genMedia(createGeminiAdapter({ transport }), VIDEO_REQ, 'k'),
    ).rejects.toMatchObject({
      llmError: { kind: 'overloaded' },
    });
  });

  it('surfaces a pollVideo transport rejection as a classified LlmProviderError', async () => {
    const transport: GeminiTransport = {
      ...unusedGenerative,
      generate: () => Promise.reject(new Error('unused')),
      stream: () => Promise.reject(new Error('unused')),
      pollVideo: () => Promise.reject(Object.assign(new Error('overloaded'), { status: 503 })),
    };
    await expect(
      pollMedia(createGeminiAdapter({ transport }), encodeMediaJobId('op'), 'k'),
    ).rejects.toMatchObject({
      llmError: { kind: 'overloaded' },
    });
  });
});
