import { describe, expect, it } from 'vitest';

import { MEDIA_SURFACES, type StopReason } from '@relavium/shared';

import { LlmProviderError } from '../llm-error.js';
import {
  LlmResultSchema,
  MediaGenResultSchema,
  ModelListingSchema,
  StreamChunkSchema,
} from '../types.js';
import type {
  LlmErrorKind,
  LlmProvider,
  LlmRequest,
  MediaGenRequest,
  StreamChunk,
} from '../types.js';
import type { RecordedResponse } from './replay.js';

/**
 * The single conformance spec **every** `@relavium/llm` adapter must pass (1.F) — the biggest
 * leverage point for the in-house abstraction. It asserts the canonical seam behaviour against
 * recorded fixtures in PR mode (offline, deterministic), checking **concrete** values (the exact
 * stop reason, token counts, tool name) so a normalization regression actually fails the suite —
 * not just that "a chunk exists". Each provider supplies its own `ConformanceFixtures` (recorded
 * responses + the canonical values they should normalize to) and a `MakeReplayAdapter`. See
 * [testing.md](../../../../docs/standards/testing.md).
 */

/** The canonical values a provider's fixtures should normalize to — asserted concretely. */
export interface ConformanceExpectations {
  readonly textGenerate: {
    stopReason: StopReason;
    text: string;
    inputTokens: number;
    outputTokens: number;
    /** The cached prompt tokens that folded into the canonical `Usage` (prompt-cache hit) — providers
     *  whose textGenerate fixture records a cache hit assert this; omit for a no-cache fixture. */
    cacheReadTokens?: number;
  };
  readonly toolGenerate: { toolName: string; stopReason: StopReason };
  readonly textStream: { stopReason: StopReason; inputTokens: number; outputTokens: number };
  readonly toolStream: { toolName: string; stopReason: StopReason };
  /** The classified kind a mid-stream `error` event should yield. */
  readonly streamErrorKind: LlmErrorKind;
  /** Reasoning a thinking model streams (ADR-0030) — only providers that emit reasoning supply this.
   * `reasoningTokens` is the count the terminal `stop` chunk must surface (observability; ADR-0030). */
  readonly reasoningStream?: { text: string; reasoningTokens?: number };
  /** The JSON text a model returns under `responseFormat: json` (ADR-0030) — providers that support it. */
  readonly structuredOutput?: { text: string };
  /** The canonical values a SYNC `generateMedia` image normalizes to (1.AG Section C, A5) — providers that
   *  implement `generateMedia` supply this. `data` is the exact base64 the recorded reply carries, so a
   *  bytes-mangling normalization regression fails the suite (parity with the text/structured scenarios). */
  readonly mediaGenerate?: { mimeType: string; data: string };
  /** The canonical values a `listModels` reply normalizes to (ADR-0064 §1/§3) — providers that implement
   *  `listModels` supply this. `ids` is the EXACT expected id set in order (proves the per-provider filter +
   *  id strip); `sample` pins one row's mapped fields (display name / context / output — and that a `0`/absent
   *  limit is OMITTED, not stored). */
  readonly listModels?: {
    readonly ids: readonly string[];
    readonly sample?: {
      readonly id: string;
      readonly displayName?: string;
      readonly contextWindowTokens?: number;
      readonly maxOutputTokens?: number;
    };
  };
  /** The ids a `listModelsDrift` reply should yield (ADR-0064 §8) — the id-less row dropped, the unknown
   *  extra field ignored, never a throw. */
  readonly listModelsDrift?: { readonly ids: readonly string[] };
}

/** The recorded provider responses a conformance run needs — one per canonical scenario. */
export interface ConformanceFixtures {
  /** A non-streaming text reply. */
  readonly textGenerate: RecordedResponse;
  /** A non-streaming reply containing a tool call. */
  readonly toolGenerate: RecordedResponse;
  /** A streamed text reply (SSE transcript). */
  readonly textStream: RecordedResponse;
  /** A streamed tool call (SSE transcript). */
  readonly toolStream: RecordedResponse;
  /** A 429 rate-limit error response (non-streaming). */
  readonly rateLimit: RecordedResponse;
  /** A stream that emits a mid-stream `error` event after starting. */
  readonly streamError: RecordedResponse;
  /** A streamed reply that includes reasoning (ADR-0030) — omit for providers that emit no reasoning. */
  readonly reasoningStream?: RecordedResponse;
  /** A non-streaming reply produced under `responseFormat: json` (ADR-0030) — omit if unsupported. */
  readonly structuredOutput?: RecordedResponse;
  /** A recorded SYNC media-generation response (e.g. an image-generation reply carrying base64) — omit for
   *  a provider with no `generateMedia` (`media_surface: 'chat'`-only). Drives the generative seam-contract
   *  scenario (1.AG Section C, A5). */
  readonly mediaGenerate?: RecordedResponse;
  /** A recorded `models.list()` reply (ADR-0064 §1). For a `fetch`-based adapter (Anthropic/OpenAI/DeepSeek)
   *  this is the raw HTTP page body the real SDK parses; for Gemini it is the SDK-output `GeminiModelInfo[]`
   *  the fake transport returns. Omit for a provider without `listModels`. Drives the live-discovery scenario. */
  readonly listModels?: RecordedResponse;
  /** A recorded `models.list()` reply carrying an UNKNOWN extra field and an id-less row (ADR-0064 §8) — the
   *  drift-resilience fixture: the extra field is ignored, the id-less row dropped, never a throw. */
  readonly listModelsDrift?: RecordedResponse;
  /**
   * A multi-turn tool loop (the path every agent node exercises): `turn1` is a tool-call reply; `turn2` is
   * the continuation the provider returns AFTER the caller appends the tool result. The conformance test
   * drives two generate() calls against one replay-sequence adapter, so `turn2` exercises the adapter
   * lowering a `tool_result` message back onto the provider's wire format. Omit if not yet recorded.
   */
  readonly toolLoop?: {
    readonly turn1: RecordedResponse;
    readonly turn2: RecordedResponse;
    readonly expected: { readonly toolName: string; readonly finalText: string };
  };
  /** The canonical values the above should normalize to. */
  readonly expected: ConformanceExpectations;
}

/**
 * Build an adapter wired to replay recorded response(s) (provider-specific). A single {@link RecordedResponse}
 * serves the one-shot scenarios; an array serves a multi-turn scenario (the Nth provider round-trip gets
 * the Nth recording) — e.g. the tool-loop scenario's call → continuation. The provider factory normalizes
 * both (a `fetch`-based adapter uses `replayFetch` / `replayFetchSequence`; the Gemini transport indexes the
 * array per call).
 */
export type MakeReplayAdapter = (
  recorded: RecordedResponse | readonly RecordedResponse[],
) => LlmProvider;

const KEY = 'conformance-test-key';

const TEXT_REQUEST: LlmRequest = {
  model: 'conformance-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
};

const TOOL_REQUEST: LlmRequest = {
  model: 'conformance-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] }],
  tools: [
    {
      name: 'get_weather',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  ],
  toolChoice: 'auto',
};

const JSON_REQUEST: LlmRequest = {
  model: 'conformance-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Return JSON.' }] }],
  responseFormat: {
    type: 'json',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  },
};

const MEDIA_GEN_REQUEST: MediaGenRequest = {
  model: 'conformance-image-model',
  prompt: 'a red circle on a white background',
  modality: 'image',
};

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    // Defense-in-depth: every streamed chunk must satisfy the canonical StreamChunk schema (throws
    // loud on a non-conforming shape, incl. the Usage subset invariant on the terminal stop).
    StreamChunkSchema.parse(chunk);
    chunks.push(chunk);
  }
  return chunks;
}

/** Register the conformance suite for one adapter, driven by its recorded fixtures. */
export function defineConformanceSuite(
  name: string,
  makeReplayAdapter: MakeReplayAdapter,
  fixtures: ConformanceFixtures,
): void {
  const { expected } = fixtures;

  describe(`${name} — conformance (replay)`, () => {
    it('generate: returns text content with the exact usage and canonical stop reason', async () => {
      const result = await makeReplayAdapter(fixtures.textGenerate).generate(TEXT_REQUEST, KEY);
      // Defense-in-depth: the whole result must satisfy the canonical LlmResult schema.
      expect(LlmResultSchema.safeParse(result).success).toBe(true);
      const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      expect(text).toBe(expected.textGenerate.text); // exact value, not just presence
      expect(result.usage.inputTokens).toBe(expected.textGenerate.inputTokens);
      expect(result.usage.outputTokens).toBe(expected.textGenerate.outputTokens);
      expect(result.stopReason).toBe(expected.textGenerate.stopReason);
      expect(result.raw).toBeDefined();
      // A prompt-cache hit must fold into the ONE canonical Usage (cacheReadTokens), not be lost or
      // double-counted into inputTokens — asserted for providers whose fixture records a cache hit.
      if (expected.textGenerate.cacheReadTokens !== undefined) {
        expect(result.usage.cacheReadTokens).toBe(expected.textGenerate.cacheReadTokens);
      }
    });

    it('generate: a tool call normalizes to a tool_call part with the expected name + id', async () => {
      const result = await makeReplayAdapter(fixtures.toolGenerate).generate(TOOL_REQUEST, KEY);
      const call = result.content.find((part) => part.type === 'tool_call');
      expect(call?.type).toBe('tool_call');
      if (call?.type === 'tool_call') {
        expect(call.id.length).toBeGreaterThan(0);
        expect(call.name).toBe(expected.toolGenerate.toolName);
      }
      expect(result.stopReason).toBe(expected.toolGenerate.stopReason);
    });

    it('stream: yields text_delta(s) then a terminal stop with the exact reason + usage', async () => {
      const chunks = await collect(
        makeReplayAdapter(fixtures.textStream).stream(TEXT_REQUEST, KEY),
      );
      expect(chunks.some((chunk) => chunk.type === 'text_delta')).toBe(true);
      expect(chunks.every((chunk) => chunk.type !== 'error')).toBe(true);
      const last = chunks.at(-1);
      expect(last?.type).toBe('stop');
      if (last?.type === 'stop') {
        expect(last.stopReason).toBe(expected.textStream.stopReason);
        expect(last.usage.inputTokens).toBe(expected.textStream.inputTokens);
        expect(last.usage.outputTokens).toBe(expected.textStream.outputTokens);
      }
    });

    it('stream: a tool call yields start/delta/end with one stable id + the expected name', async () => {
      const chunks = await collect(
        makeReplayAdapter(fixtures.toolStream).stream(TOOL_REQUEST, KEY),
      );
      const start = chunks.find((chunk) => chunk.type === 'tool_call_start');
      const delta = chunks.find((chunk) => chunk.type === 'tool_call_delta');
      const end = chunks.find((chunk) => chunk.type === 'tool_call_end');
      expect(start?.type).toBe('tool_call_start');
      expect(delta?.type).toBe('tool_call_delta');
      expect(end?.type).toBe('tool_call_end');
      if (
        start?.type === 'tool_call_start' &&
        delta?.type === 'tool_call_delta' &&
        end?.type === 'tool_call_end'
      ) {
        expect(start.name).toBe(expected.toolStream.toolName);
        expect(start.id.length).toBeGreaterThan(0);
        expect(delta.id).toBe(start.id); // a stable id across the streamed turn
        expect(end.id).toBe(start.id);
      }
      const stop = chunks.at(-1);
      expect(stop?.type).toBe('stop');
      if (stop?.type === 'stop') {
        expect(stop.stopReason).toBe(expected.toolStream.stopReason);
      }
    });

    it('errors: a 429 surfaces a classified, retryable LlmError (generate rejects)', async () => {
      const adapter = makeReplayAdapter(fixtures.rateLimit);
      let caught: unknown;
      try {
        await adapter.generate(TEXT_REQUEST, KEY);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LlmProviderError);
      if (caught instanceof LlmProviderError) {
        expect(caught.llmError.kind).toBe('rate_limit');
        expect(caught.llmError.retryable).toBe(true);
        expect(caught.llmError.provider).toBe(name);
      }
    });

    it('errors: a mid-stream error event yields a classified error chunk', async () => {
      const chunks = await collect(
        makeReplayAdapter(fixtures.streamError).stream(TEXT_REQUEST, KEY),
      );
      const errorChunk = chunks.find((chunk) => chunk.type === 'error');
      expect(errorChunk?.type).toBe('error');
      if (errorChunk?.type === 'error') {
        expect(errorChunk.error.kind).toBe(expected.streamErrorKind);
        expect(errorChunk.error.provider).toBe(name);
      }
    });

    it.skipIf(fixtures.reasoningStream === undefined)(
      'reasoning: reasoning_start/delta(s)/end arrive and close before the terminal stop (ADR-0030)',
      async () => {
        const recorded = fixtures.reasoningStream;
        if (recorded === undefined) {
          return; // narrow for skipIf
        }
        const chunks = await collect(makeReplayAdapter(recorded).stream(TEXT_REQUEST, KEY));
        expect(chunks.some((chunk) => chunk.type === 'reasoning_start')).toBe(true);
        expect(chunks.some((chunk) => chunk.type === 'reasoning_delta')).toBe(true);
        const types = chunks.map((chunk) => chunk.type);
        expect(types.lastIndexOf('reasoning_end')).toBeGreaterThanOrEqual(0);
        expect(types.lastIndexOf('reasoning_end')).toBeLessThan(types.indexOf('stop'));
        if (expected.reasoningStream !== undefined) {
          const text = chunks
            .map((chunk) => (chunk.type === 'reasoning_delta' ? chunk.text : ''))
            .join('');
          expect(text).toBe(expected.reasoningStream.text);
        }
        // The terminal stop must surface the reasoning-token count (ADR-0030 observability) — this is
        // what catches a streaming-usage merge that drops reasoningTokens (e.g. the Anthropic message_delta).
        if (expected.reasoningStream?.reasoningTokens !== undefined) {
          const stop = chunks.at(-1);
          expect(stop?.type).toBe('stop');
          if (stop?.type === 'stop') {
            expect(stop.usage.reasoningTokens).toBe(expected.reasoningStream.reasoningTokens);
          }
        }
      },
    );

    it.skipIf(fixtures.structuredOutput === undefined)(
      'structured output: responseFormat json returns parseable JSON text (ADR-0030)',
      async () => {
        const recorded = fixtures.structuredOutput;
        if (recorded === undefined) {
          return; // narrow for skipIf
        }
        const result = await makeReplayAdapter(recorded).generate(JSON_REQUEST, KEY);
        const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
        expect(() => JSON.parse(text) as unknown).not.toThrow();
        // responseFormat: json must yield text, not a tool call, and a canonical terminal stop reason —
        // surfacing any adapter that routes structured output through a forced tool or mis-maps the stop.
        expect(result.stopReason).toBe('stop');
        expect(result.content.every((part) => part.type !== 'tool_call')).toBe(true);
        if (expected.structuredOutput !== undefined) {
          expect(text).toBe(expected.structuredOutput.text);
        }
      },
    );

    it.skipIf(fixtures.toolLoop === undefined)(
      'tool loop: a tool_call then a continuation carrying the tool_result yields final text (call→result→continuation)',
      async () => {
        const loop = fixtures.toolLoop;
        if (loop === undefined) {
          return; // narrow for skipIf
        }
        // One adapter, a replay SEQUENCE: turn 1 → the tool-call reply, turn 2 → the continuation.
        const adapter = makeReplayAdapter([loop.turn1, loop.turn2]);
        const r1 = await adapter.generate(TOOL_REQUEST, KEY);
        const call = r1.content.find((part) => part.type === 'tool_call');
        expect(call?.type).toBe('tool_call');
        if (call?.type !== 'tool_call') {
          return; // narrow
        }
        expect(call.name).toBe(loop.expected.toolName);
        // Turn 2: append the assistant tool_call + the tool RESULT, then continue. SCOPE: this asserts the
        // end-to-end call→result→continuation FLOW — the adapter accepts a tool_result message and produces a
        // continuation without throwing or dropping the turn. The provider-SPECIFIC tool_result WIRE shape
        // (Anthropic tool_result block, OpenAI {role:'tool'}, Gemini functionResponse) is asserted by the
        // per-adapter unit tests (anthropic/openai/gemini .test.ts); the replay serves turn2 by call index,
        // so this shared suite does not (and should not) re-assert each provider's request wire here.
        const r2 = await adapter.generate(
          {
            ...TOOL_REQUEST,
            messages: [
              ...TOOL_REQUEST.messages,
              { role: 'assistant', content: [call] },
              {
                role: 'tool',
                content: [{ type: 'tool_result', toolCallId: call.id, result: 'sunny, 18C' }],
              },
            ],
          },
          KEY,
        );
        expect(LlmResultSchema.safeParse(r2).success).toBe(true);
        const text = r2.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
        expect(text).toBe(loop.expected.finalText);
        expect(r2.content.every((part) => part.type !== 'tool_call')).toBe(true); // a text continuation, not another call
      },
    );

    it('capabilities: media.surface projects to a valid MediaSurface (1.AG, A5)', () => {
      // Every adapter's capability projection must resolve `media.surface` to a member of the closed
      // MediaSurface union (the data-driven routing seam ADR-0045 §1 keys on) — an adapter that emits a
      // garbage/absent surface would silently mis-route. Phase-1 adapters all project 'chat'; the per-adapter
      // capability tests pin the exact value, this asserts the cross-adapter shape contract.
      const surface = makeReplayAdapter(fixtures.textGenerate).supports.media.surface;
      expect(surface).toBeDefined();
      if (surface !== undefined) {
        expect(MEDIA_SURFACES).toContain(surface);
      }
    });

    it.skipIf(fixtures.mediaGenerate === undefined)(
      'generateMedia (sync): normalizes a generated image to a base64 media part, no jobId (1.AG Section C, A5)',
      async () => {
        const recorded = fixtures.mediaGenerate;
        if (recorded === undefined) {
          return; // narrow for skipIf
        }
        const adapter = makeReplayAdapter(recorded);
        if (adapter.generateMedia === undefined) {
          throw new Error(
            'a mediaGenerate fixture requires the adapter to implement generateMedia',
          );
        }
        const result = await adapter.generateMedia(MEDIA_GEN_REQUEST, KEY);
        // Defense-in-depth: the whole result must satisfy the canonical MediaGenResult schema (incl. the
        // exactly-one-of media|jobId refine).
        expect(MediaGenResultSchema.safeParse(result).success).toBe(true);
        // SYNC: an in-flight `media` part the engine de-inlines to a handle; NEVER an async `jobId`.
        expect(result.jobId).toBeUndefined();
        expect(result.media?.type).toBe('media');
        if (result.media !== undefined) {
          expect(result.media.source.kind).toBe('base64'); // no bytes-less url leaks across the seam here
          if (expected.mediaGenerate !== undefined) {
            expect(result.media.mimeType).toBe(expected.mediaGenerate.mimeType);
            // Exact-value parity with the text/structured scenarios: the recorded base64 must round-trip
            // byte-for-byte, so a wrong-but-nonempty normalization regression fails here too.
            expect(result.media.source).toEqual({
              kind: 'base64',
              data: expected.mediaGenerate.data,
            });
          }
        }
        expect(result.raw).toBeDefined();
      },
    );

    it.skipIf(fixtures.listModels === undefined)(
      'listModels: normalizes the live list to validated ModelListing[] with the expected ids + mapping (ADR-0064 §1/§3)',
      async () => {
        const recorded = fixtures.listModels;
        const exp = expected.listModels;
        if (recorded === undefined || exp === undefined) {
          return; // narrow for skipIf
        }
        const adapter = makeReplayAdapter(recorded);
        if (adapter.listModels === undefined) {
          throw new Error('a listModels fixture requires the adapter to implement listModels');
        }
        const listings = await adapter.listModels(KEY);
        // Strict-outbound: every row satisfies the canonical ModelListing schema.
        for (const listing of listings) {
          expect(ModelListingSchema.safeParse(listing).success).toBe(true);
        }
        // Exact id set (order + membership) — proves the per-provider chat-capability filter + id strip.
        expect(listings.map((listing) => listing.id)).toEqual([...exp.ids]);
        if (exp.sample !== undefined) {
          const row = listings.find((listing) => listing.id === exp.sample?.id);
          expect(row).toBeDefined();
          if (row !== undefined) {
            // Exact mapping incl. OMITTED (undefined) fields — a 0/absent limit must not become a stored 0.
            expect(row.displayName).toBe(exp.sample.displayName);
            expect(row.contextWindowTokens).toBe(exp.sample.contextWindowTokens);
            expect(row.maxOutputTokens).toBe(exp.sample.maxOutputTokens);
          }
        }
      },
    );

    it.skipIf(fixtures.listModelsDrift === undefined)(
      'listModels (drift): ignores an unknown field and drops an id-less row, never throwing (ADR-0064 §8)',
      async () => {
        const recorded = fixtures.listModelsDrift;
        const exp = expected.listModelsDrift;
        if (recorded === undefined || exp === undefined) {
          return; // narrow for skipIf
        }
        const adapter = makeReplayAdapter(recorded);
        if (adapter.listModels === undefined) {
          throw new Error('a listModelsDrift fixture requires the adapter to implement listModels');
        }
        // Must resolve, never throw — a breaking row degrades ONE model, not the whole provider.
        const listings = await adapter.listModels(KEY);
        for (const listing of listings) {
          expect(ModelListingSchema.safeParse(listing).success).toBe(true);
        }
        // The id-less row is dropped; the unknown extra field never rode across the seam.
        expect(listings.map((listing) => listing.id)).toEqual([...exp.ids]);
        const allowedKeys = new Set([
          'id',
          'displayName',
          'contextWindowTokens',
          'maxOutputTokens',
          'deprecatedAt',
        ]);
        for (const listing of listings) {
          expect(Object.keys(listing).every((key) => allowedKeys.has(key))).toBe(true);
        }
      },
    );
  });
}
