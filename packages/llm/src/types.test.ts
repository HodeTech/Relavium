import { describe, expect, expectTypeOf, it } from 'vitest';

import { INLINE_MEDIA_CEILING, MEDIA_MESSAGE_CAPS, StopReasonSchema } from '@relavium/shared';

import {
  CapabilityFlagsSchema,
  LlmErrorKindSchema,
  LlmErrorSchema,
  LlmMessageSchema,
  LlmRequestSchema,
  LlmResultSchema,
  MediaGenRequestSchema,
  MediaGenResultSchema,
  MediaJobStatusSchema,
  ResponseFormatSchema,
  StreamChunkSchema,
  ToolChoiceSchema,
  ToolDefSchema,
  UsageSchema,
} from './types.js';
import type { LlmProvider, LlmResult, MediaGenResult, ProviderId, StreamChunk } from './types.js';

const usage = { inputTokens: 10, outputTokens: 20 };

/** A syntactically valid canonical handle (64 lowercase hex). */
const HANDLE = `media://sha256-${'b'.repeat(64)}`;

/** 'hello' as padded base64 — 5 decoded bytes. */
const TINY_BASE64 = 'aGVsbG8=';

/** A sub-ceiling base64 image part — the legal inline tier. */
const TINY_IMAGE_PART = {
  type: 'media',
  mimeType: 'image/png',
  source: { kind: 'base64', data: TINY_BASE64 },
};

/** The all-false media matrix every Phase-1 adapter advertises at 1.AD (shape only). */
const NO_MEDIA = {
  input: { image: false, audio: false, video: false, document: false },
  outputCombinations: [],
};

describe('seam request/message/tool schemas', () => {
  it('accepts a minimal valid request and rejects an empty model', () => {
    const req = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    expect(LlmRequestSchema.safeParse(req).success).toBe(true);
    expect(LlmRequestSchema.safeParse({ ...req, model: '' }).success).toBe(false);
    expect(LlmRequestSchema.safeParse({ ...req, maxTokens: 0 }).success).toBe(false); // positive
    expect(LlmRequestSchema.safeParse({ ...req, signal: 123 }).success).toBe(false); // not AbortSignalLike
    expect(
      LlmRequestSchema.safeParse({
        ...req,
        signal: {
          aborted: false,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        },
      }).success,
    ).toBe(true); // a structurally valid AbortSignalLike passes
    // The tightening must also reject a PARTIAL object (missing the listeners) and a wrong-typed
    // `aborted` — not just a fully-invalid scalar.
    expect(LlmRequestSchema.safeParse({ ...req, signal: { aborted: false } }).success).toBe(false);
    expect(
      LlmRequestSchema.safeParse({
        ...req,
        signal: {
          aborted: 'yes',
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        },
      }).success,
    ).toBe(false); // `aborted` must be a boolean
  });

  it('accepts a request with tools, toolChoice, and the providerOptions escape hatch', () => {
    expect(
      LlmRequestSchema.safeParse({
        model: 'gpt-5.5',
        system: 'be terse',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [{ name: 'read_file', parameters: { type: 'object' } }],
        toolChoice: { name: 'read_file' },
        temperature: 0.2,
        maxTokens: 256,
        providerOptions: { reasoning: { effort: 'high' } },
      }).success,
    ).toBe(true);
  });

  it('validates a message carries normalized ContentParts, not a raw string', () => {
    expect(LlmMessageSchema.safeParse({ role: 'assistant', content: 'plain string' }).success).toBe(
      false,
    );
    expect(
      LlmMessageSchema.safeParse({
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: {} }],
      }).success,
    ).toBe(true);
  });

  it('accepts an object ToolDef.parameters and rejects a non-object', () => {
    expect(ToolDefSchema.safeParse({ name: 'f', parameters: { type: 'object' } }).success).toBe(
      true,
    );
    expect(ToolDefSchema.safeParse({ name: 'f', parameters: 'nope' }).success).toBe(false);
    expect(ToolDefSchema.safeParse({ name: 'f', parameters: [] }).success).toBe(false); // an array is not an object schema
    expect(ToolDefSchema.safeParse({ name: '', parameters: {} }).success).toBe(false); // non-empty name
  });

  it('accepts the three toolChoice forms', () => {
    for (const tc of ['auto', 'none', 'required', { name: 'f' }]) {
      expect(ToolChoiceSchema.safeParse(tc).success).toBe(true);
    }
    expect(ToolChoiceSchema.safeParse('maybe').success).toBe(false);
  });
});

describe('seam result/usage/error/capability schemas', () => {
  it('pins Usage to non-negative integers', () => {
    expect(UsageSchema.safeParse(usage).success).toBe(true);
    expect(UsageSchema.safeParse({ ...usage, inputTokens: -1 }).success).toBe(false);
    expect(UsageSchema.safeParse({ ...usage, outputTokens: 1.5 }).success).toBe(false);
  });

  it('accepts a result with normalized content + a stop reason', () => {
    expect(
      LlmResultSchema.safeParse({
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
        usage,
        raw: { id: 'msg_1' },
      }).success,
    ).toBe(true);
    // stopReason is the closed StopReason enum (re-exported from @relavium/shared)
    expect(
      LlmResultSchema.safeParse({ content: [], stopReason: 'banana', usage, raw: null }).success,
    ).toBe(false);
  });

  it('classifies LlmError and pins the kind set', () => {
    expect(
      LlmErrorSchema.safeParse({
        kind: 'rate_limit',
        retryable: true,
        status: 429,
        provider: 'anthropic',
        message: 'slow down',
      }).success,
    ).toBe(true);
    expect(LlmErrorKindSchema.options).toHaveLength(9);
    expect(
      LlmErrorSchema.safeParse({ kind: 'boom', retryable: false, provider: 'openai', message: 'x' })
        .success,
    ).toBe(false);
    // provider is the closed seam id set
    expect(
      LlmErrorSchema.safeParse({ kind: 'auth', retryable: false, provider: 'cohere', message: 'x' })
        .success,
    ).toBe(false);
  });

  it('requires every capability flag', () => {
    const flags = {
      tools: true,
      streaming: true,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
      reasoning: false,
      media: NO_MEDIA,
    };
    expect(CapabilityFlagsSchema.safeParse(flags).success).toBe(true);
    const missing = {
      tools: true,
      streaming: true,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
      media: NO_MEDIA,
    };
    expect(CapabilityFlagsSchema.safeParse(missing).success).toBe(false); // missing `reasoning`
    const withoutMedia = Object.fromEntries(
      Object.entries(flags).filter(([key]) => key !== 'media'),
    );
    expect(CapabilityFlagsSchema.safeParse(withoutMedia).success).toBe(false); // missing `media` (ADR-0031)
  });

  it('pins vision as a derived alias of media.input.image — drift is rejected (ADR-0031)', () => {
    const base = {
      tools: true,
      streaming: true,
      parallelToolCalls: false,
      promptCache: false,
      reasoning: false,
    };
    const withImage = {
      input: { image: true, audio: false, video: false, document: false },
      outputCombinations: [['text'], ['text', 'image']],
    };
    expect(
      CapabilityFlagsSchema.safeParse({ ...base, vision: true, media: withImage }).success,
    ).toBe(true);
    expect(
      CapabilityFlagsSchema.safeParse({ ...base, vision: false, media: withImage }).success,
    ).toBe(false); // image-capable but vision says no — drift
    expect(
      CapabilityFlagsSchema.safeParse({ ...base, vision: true, media: NO_MEDIA }).success,
    ).toBe(false); // vision advertised with no image input — the pre-ADR-0031 lie, now rejected
  });
});

describe('StreamChunk union', () => {
  // One entry per union member — the count pin below keeps this table exhaustive.
  const chunks: StreamChunk[] = [
    { type: 'text_delta', text: 'he' },
    { type: 'tool_call_start', id: 'c1', name: 'read_file' },
    { type: 'tool_call_delta', id: 'c1', argsJsonDelta: '{"path":' },
    { type: 'tool_call_end', id: 'c1' },
    { type: 'reasoning_start', id: 'r1' },
    { type: 'reasoning_delta', id: 'r1', text: 'th' },
    { type: 'reasoning_end', id: 'r1' },
    { type: 'media_start', id: 'm1', mimeType: 'image/png' },
    { type: 'media_delta', id: 'm1', progress: 0.5, partialRef: HANDLE },
    {
      type: 'media_end',
      id: 'm1',
      media: { type: 'media', mimeType: 'image/png', source: { kind: 'handle', ref: HANDLE } },
    },
    {
      type: 'tool_result',
      id: 'c2',
      name: 'web_search',
      result: { hits: 1 },
      providerExecuted: true,
    },
    { type: 'stop', stopReason: 'tool_use', usage },
    {
      type: 'error',
      error: { kind: 'overloaded', retryable: true, provider: 'gemini', message: 'busy' },
    },
  ];

  it.each(chunks)('accepts the %o chunk', (chunk) => {
    expect(StreamChunkSchema.safeParse(chunk).success).toBe(true);
  });

  it('pins the union member count to this table (an added/removed arm must update both)', () => {
    // `.innerType()` because the union carries a superRefine (the tool_result no-raw-bytes rule) —
    // the same pattern as RunEventSchema in @relavium/shared.
    expect(StreamChunkSchema.innerType().options).toHaveLength(chunks.length);
  });

  it('rejects an unknown chunk type', () => {
    expect(StreamChunkSchema.safeParse({ type: 'thinking', text: 'x' }).success).toBe(false);
  });
});

describe('seam types are pure Relavium types (no vendor SDK type crosses the seam)', () => {
  it('pins ProviderId to the closed Relavium id set', () => {
    expectTypeOf<ProviderId>().toEqualTypeOf<'anthropic' | 'openai' | 'gemini' | 'deepseek'>();
  });

  it('LlmResult is the Relavium shape end-to-end', () => {
    expectTypeOf<LlmResult['stopReason']>().toEqualTypeOf<
      'stop' | 'length' | 'tool_use' | 'content_filter' | 'error'
    >();
  });

  it('LlmProvider is implementable with only Relavium types', () => {
    // A stub that typechecks proves the interface needs no vendor SDK type — a leaked vendor type
    // would make this fail to compile (and the import-zone fence forbids the import outright).
    const stub: LlmProvider = {
      id: 'anthropic',
      generate: () => Promise.resolve({ content: [], stopReason: 'stop', usage, raw: null }),
      stream: async function* () {
        await Promise.resolve();
        yield { type: 'text_delta', text: 'hi' } satisfies StreamChunk;
      },
      supports: {
        tools: true,
        streaming: true,
        parallelToolCalls: false,
        vision: false,
        promptCache: false,
        reasoning: false,
        media: NO_MEDIA,
      },
    };
    expect(stub.id).toBe('anthropic');
    expectTypeOf<LlmProvider['generate']>().returns.resolves.toEqualTypeOf<LlmResult>();
  });

  it('generateMedia/pollMediaJob are OPTIONAL reserved methods (ADR-0031 A5)', () => {
    // The text-only stub above compiles WITHOUT them (no Phase-1 adapter implements them); a
    // generative provider WITH them typechecks against only Relavium types too.
    const generative: LlmProvider = {
      id: 'openai',
      generate: () => Promise.resolve({ content: [], stopReason: 'stop', usage, raw: null }),
      stream: async function* () {
        await Promise.resolve();
        yield { type: 'text_delta', text: 'hi' } satisfies StreamChunk;
      },
      supports: {
        tools: true,
        streaming: true,
        parallelToolCalls: false,
        vision: false,
        promptCache: false,
        reasoning: false,
        media: NO_MEDIA,
      },
      generateMedia: () => Promise.resolve({ jobId: 'job-1', raw: null }),
      pollMediaJob: () => Promise.resolve({ state: 'pending' as const }),
    };
    expect(typeof generative.generateMedia).toBe('function');
    expectTypeOf<
      NonNullable<LlmProvider['generateMedia']>
    >().returns.resolves.toEqualTypeOf<MediaGenResult>();
  });
});

describe('seam shape amendment (ADR-0030)', () => {
  it('ResponseFormatSchema accepts text and json{schema}', () => {
    expect(ResponseFormatSchema.safeParse({ type: 'text' }).success).toBe(true);
    expect(
      ResponseFormatSchema.safeParse({
        type: 'json',
        schema: { type: 'object' },
        name: 'out',
        strict: true,
      }).success,
    ).toBe(true);
    expect(ResponseFormatSchema.safeParse({ type: 'json', schema: [] }).success).toBe(false); // not an object
  });

  it('LlmRequestSchema accepts an optional responseFormat', () => {
    const req = {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      responseFormat: { type: 'json', schema: { type: 'object' } },
    };
    expect(LlmRequestSchema.safeParse(req).success).toBe(true);
  });

  it('StreamChunkSchema accepts the reasoning triad and a provider-executed tool_result', () => {
    expect(StreamChunkSchema.safeParse({ type: 'reasoning_start', id: 'r0' }).success).toBe(true);
    expect(
      StreamChunkSchema.safeParse({ type: 'reasoning_delta', id: 'r0', text: 'x' }).success,
    ).toBe(true);
    expect(
      StreamChunkSchema.safeParse({
        type: 'reasoning_end',
        id: 'r0',
        signature: 's',
        redacted: true,
      }).success,
    ).toBe(true);
    expect(
      StreamChunkSchema.safeParse({
        type: 'tool_result',
        id: 't1',
        name: 'web_search',
        result: { hits: [] },
        providerExecuted: true,
      }).success,
    ).toBe(true);
  });

  it('UsageSchema accepts an optional reasoningTokens', () => {
    expect(
      UsageSchema.safeParse({ inputTokens: 1, outputTokens: 2, reasoningTokens: 1 }).success,
    ).toBe(true);
    // boundary: equal is allowed
    expect(
      UsageSchema.safeParse({ inputTokens: 1, outputTokens: 2, reasoningTokens: 2 }).success,
    ).toBe(true);
  });

  it('UsageSchema rejects reasoningTokens > outputTokens (ADR-0030 subset invariant)', () => {
    expect(
      UsageSchema.safeParse({ inputTokens: 1, outputTokens: 2, reasoningTokens: 3 }).success,
    ).toBe(false);
  });
});

describe('seam shape amendment (ADR-0031) — multimodal I/O', () => {
  const message = (...content: unknown[]): unknown => ({ role: 'user', content });

  it('LlmMessageSchema accepts a sub-ceiling inline image and a handle for every modality', () => {
    expect(LlmMessageSchema.safeParse(message(TINY_IMAGE_PART)).success).toBe(true);
    for (const mimeType of ['image/png', 'audio/wav', 'video/mp4', 'application/pdf']) {
      expect(
        LlmMessageSchema.safeParse(
          message({ type: 'media', mimeType, source: { kind: 'handle', ref: HANDLE } }),
        ).success,
      ).toBe(true);
    }
  });

  it('rejects an over-ceiling inline part, inline video/document, and the gated url carrier', () => {
    const overCeiling = 'A'.repeat((Math.ceil(INLINE_MEDIA_CEILING.image / 3) + 2) * 4);
    expect(
      LlmMessageSchema.safeParse(
        message({
          type: 'media',
          mimeType: 'image/png',
          source: { kind: 'base64', data: overCeiling },
        }),
      ).success,
    ).toBe(false);
    expect(
      LlmMessageSchema.safeParse(
        message({
          type: 'media',
          mimeType: 'video/mp4',
          source: { kind: 'base64', data: TINY_BASE64 },
        }),
      ).success,
    ).toBe(false);
    expect(
      LlmMessageSchema.safeParse(
        message({
          type: 'media',
          mimeType: 'application/pdf',
          source: { kind: 'base64', data: TINY_BASE64 },
        }),
      ).success,
    ).toBe(false);
    expect(
      LlmMessageSchema.safeParse(
        message({
          type: 'media',
          mimeType: 'image/png',
          source: { kind: 'url', url: 'https://example.com/a.png' },
        }),
      ).success,
    ).toBe(false); // feature-flag-OFF until the shared SSRF primitive lands (1.AE)
  });

  it('result-side content stays representable OVER the ceiling (the boundary asymmetry)', () => {
    // The ceiling/url-gate rules are mounted on LlmMessageSchema (the request boundary) precisely
    // so a generated image — which legitimately exceeds the inline ceiling in flight — survives in
    // LlmResult.content until the engine de-inlines it. A refactor that moves the ceiling onto the
    // pure union or onto LlmResultSchema would break this test.
    const overCeiling = 'A'.repeat((Math.ceil(INLINE_MEDIA_CEILING.image / 3) + 2) * 4);
    const generated = {
      type: 'media',
      mimeType: 'image/png',
      source: { kind: 'base64', data: overCeiling },
    };
    expect(
      LlmResultSchema.safeParse({ content: [generated], stopReason: 'stop', usage, raw: null })
        .success,
    ).toBe(true);
    expect(LlmMessageSchema.safeParse(message(generated)).success).toBe(false);
  });

  it('accepts a message at EXACTLY the per-part ceiling and the aggregate cap (boundary pins)', () => {
    // (ceiling + 2) / 3 * 4 − 2 'A's + '==' decodes to exactly INLINE_MEDIA_CEILING.image bytes;
    // 8 such parts sum to exactly the 2 MiB aggregate cap (and 8 <= the 16-part count cap).
    const exactCeiling = 'A'.repeat(((INLINE_MEDIA_CEILING.image + 2) / 3) * 4 - 2) + '==';
    const part = {
      type: 'media',
      mimeType: 'image/png',
      source: { kind: 'base64', data: exactCeiling },
    };
    expect(LlmMessageSchema.safeParse(message(part)).success).toBe(true);
    const atAggregateCap = Array.from(
      { length: MEDIA_MESSAGE_CAPS.maxInlineBytesPerMessage / INLINE_MEDIA_CEILING.image },
      () => part,
    );
    expect(LlmMessageSchema.safeParse(message(...atAggregateCap)).success).toBe(true);
  });

  it('enforces the per-message count cap (the anti-amplification rule)', () => {
    const cap = MEDIA_MESSAGE_CAPS.maxPartsPerMessage;
    const parts = (n: number): unknown[] => Array.from({ length: n }, () => TINY_IMAGE_PART);
    expect(LlmMessageSchema.safeParse(message(...parts(cap))).success).toBe(true);
    expect(LlmMessageSchema.safeParse(message(...parts(cap + 1))).success).toBe(false);
  });

  it('enforces the per-message aggregate decoded-bytes cap', () => {
    // Each part is individually legal (~205 KB decoded < the 256 KB ceiling), but eleven of them
    // exceed the 2 MiB aggregate — the case the per-part ceiling alone cannot catch.
    const bigPart = {
      type: 'media',
      mimeType: 'image/png',
      source: { kind: 'base64', data: 'A'.repeat(273068) },
    };
    const eleven = Array.from({ length: 11 }, () => bigPart);
    expect(LlmMessageSchema.safeParse(message(...eleven)).success).toBe(false);
    expect(LlmMessageSchema.safeParse(message(...eleven.slice(0, 5))).success).toBe(true);
  });

  it('rejects raw media bytes smuggled inside tool_result.result at every boundary (decision #7)', () => {
    const smuggling = {
      type: 'tool_result',
      toolCallId: 'c1',
      result: { image: { kind: 'base64', data: TINY_BASE64 } },
    };
    expect(LlmMessageSchema.safeParse({ role: 'tool', content: [smuggling] }).success).toBe(false);
    expect(
      LlmResultSchema.safeParse({ content: [smuggling], stopReason: 'stop', usage, raw: null })
        .success,
    ).toBe(false);
    expect(
      StreamChunkSchema.safeParse({
        type: 'tool_result',
        id: 't1',
        name: 'generate_image',
        result: { image: `data:image/png;base64,${TINY_BASE64}` },
        providerExecuted: true,
      }).success,
    ).toBe(false);
  });

  it('media_end carries a handle-only durable part; partialRef must be a handle, never base64', () => {
    expect(
      StreamChunkSchema.safeParse({
        type: 'media_end',
        id: 'm1',
        media: {
          type: 'media',
          mimeType: 'image/png',
          source: { kind: 'base64', data: TINY_BASE64 },
        },
      }).success,
    ).toBe(false);
    expect(
      StreamChunkSchema.safeParse({ type: 'media_delta', id: 'm1', partialRef: TINY_BASE64 })
        .success,
    ).toBe(false);
    expect(
      StreamChunkSchema.safeParse({ type: 'media_delta', id: 'm1', progress: 1.5 }).success,
    ).toBe(false); // progress is a 0..1 fraction
    // media_start.mimeType shares the one bounded bare-MIME schema — a data-URI or oversized
    // value cannot ride the stream through a metadata field.
    expect(
      StreamChunkSchema.safeParse({
        type: 'media_start',
        id: 'm1',
        mimeType: `data:image/png;base64,${TINY_BASE64}`,
      }).success,
    ).toBe(false);
    expect(
      StreamChunkSchema.safeParse({
        type: 'media_start',
        id: 'm1',
        mimeType: `image/${'x'.repeat(300)}`,
      }).success,
    ).toBe(false);
  });

  it('Usage.mediaUnits is a disjoint axis: accepted untied to token counts, closed modality set', () => {
    expect(
      UsageSchema.safeParse({
        ...usage,
        mediaUnits: [
          { modality: 'image', direction: 'output', units: 2, unit: 'count' },
          { modality: 'video', direction: 'output', units: 8, unit: 'second' },
        ],
      }).success,
    ).toBe(true);
    // document/text deliberately bill as tokens, not media units (ADR-0031 §Freeze-criticality).
    expect(
      UsageSchema.safeParse({
        ...usage,
        mediaUnits: [{ modality: 'document', direction: 'input', units: 1, unit: 'count' }],
      }).success,
    ).toBe(false);
  });

  it('LlmRequestSchema accepts outputModalities and rejects an unknown modality', () => {
    const req = {
      model: 'gemini-image',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a cover image' }] }],
    };
    expect(
      LlmRequestSchema.safeParse({ ...req, outputModalities: ['text', 'image'] }).success,
    ).toBe(true);
    expect(LlmRequestSchema.safeParse({ ...req, outputModalities: ['hologram'] }).success).toBe(
      false,
    );
  });

  it("a media-only turn reports 'stop' — content inspection is the signal, NOT a new StopReason", () => {
    const mediaOnly = LlmResultSchema.parse({
      content: [{ type: 'media', mimeType: 'image/png', source: { kind: 'handle', ref: HANDLE } }],
      stopReason: 'stop',
      usage,
      raw: null,
    });
    const emptyTextTurn = LlmResultSchema.parse({
      content: [{ type: 'text', text: '' }],
      stopReason: 'stop',
      usage,
      raw: null,
    });
    const producedMedia = (result: LlmResult): boolean =>
      result.content.some((part) => part.type === 'media');
    expect(producedMedia(mediaOnly)).toBe(true);
    expect(producedMedia(emptyTextTurn)).toBe(false); // distinguishable by content, same stopReason
    expect(StopReasonSchema.options).toHaveLength(5); // the closed enum gained NO media member
  });

  it('round-trips a fully-populated media_end chunk and MediaGenRequest with no drift', () => {
    const chunk = {
      type: 'media_end',
      id: 'm1',
      media: {
        type: 'media',
        mimeType: 'audio/wav',
        source: { kind: 'handle', ref: HANDLE },
        name: 'a.wav',
        transcript: 't',
        byteLength: 9,
        durationMs: 1200,
      },
    };
    expect(StreamChunkSchema.parse(chunk)).toEqual(chunk);
    const genReq = {
      model: 'gpt-image-1',
      prompt: 'a fox',
      modality: 'image',
      mimeType: 'image/png',
      count: 2,
      durationSeconds: 4,
      providerOptions: { quality: 'hd' },
    };
    expect(MediaGenRequestSchema.parse(genReq)).toEqual(genReq);
  });

  it('MediaGenRequest/MediaGenResult/MediaJobStatus parse (reserved shape, A5)', () => {
    expect(
      MediaGenRequestSchema.safeParse({ model: 'gpt-image-1', prompt: 'a fox', modality: 'image' })
        .success,
    ).toBe(true);
    expect(
      MediaGenRequestSchema.safeParse({ model: 'sora', prompt: '', modality: 'video' }).success,
    ).toBe(false); // empty prompt
    expect(
      MediaGenRequestSchema.safeParse({ model: 'm', prompt: 'p', modality: 'document' }).success,
    ).toBe(false); // only the media-billed set is generatable
    // mimeType shares the one bounded bare-MIME schema — every mimeType position does.
    for (const mimeType of [
      'image/png; charset=utf-8',
      `data:image/png;base64,${TINY_BASE64}`,
      `image/${'x'.repeat(300)}`,
    ]) {
      expect(
        MediaGenRequestSchema.safeParse({ model: 'm', prompt: 'p', modality: 'image', mimeType })
          .success,
      ).toBe(false);
    }

    const media = { type: 'media', mimeType: 'image/png', source: { kind: 'handle', ref: HANDLE } };
    expect(MediaGenResultSchema.safeParse({ media, raw: null }).success).toBe(true);
    expect(MediaGenResultSchema.safeParse({ jobId: 'job-1', raw: null }).success).toBe(true);
    expect(MediaGenResultSchema.safeParse({ media, jobId: 'job-1', raw: null }).success).toBe(
      false,
    ); // exactly one
    expect(MediaGenResultSchema.safeParse({ raw: null }).success).toBe(false); // at least one

    expect(MediaJobStatusSchema.safeParse({ state: 'pending', progress: 0.4 }).success).toBe(true);
    expect(MediaJobStatusSchema.safeParse({ state: 'done', media }).success).toBe(true);
    expect(
      MediaJobStatusSchema.safeParse({
        state: 'failed',
        error: {
          kind: 'content_filter',
          retryable: false,
          provider: 'openai',
          message: 'policy',
        },
      }).success,
    ).toBe(true);
    expect(MediaJobStatusSchema.safeParse({ state: 'done' }).success).toBe(false); // done needs media
  });
});
