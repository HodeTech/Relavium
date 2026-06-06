import { describe, expect, it } from 'vitest';

import type { StopReason } from '@relavium/shared';

import { LlmProviderError } from '../llm-error.js';
import type { LlmErrorKind, LlmProvider, LlmRequest, StreamChunk } from '../types.js';
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
  };
  readonly toolGenerate: { toolName: string; stopReason: StopReason };
  readonly textStream: { stopReason: StopReason; inputTokens: number; outputTokens: number };
  readonly toolStream: { toolName: string; stopReason: StopReason };
  /** The classified kind a mid-stream `error` event should yield. */
  readonly streamErrorKind: LlmErrorKind;
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
  /** The canonical values the above should normalize to. */
  readonly expected: ConformanceExpectations;
}

/** Build an adapter wired to replay a single recorded response (provider-specific). */
export type MakeReplayAdapter = (recorded: RecordedResponse) => LlmProvider;

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

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
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
      const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      expect(text).toBe(expected.textGenerate.text); // exact value, not just presence
      expect(result.usage.inputTokens).toBe(expected.textGenerate.inputTokens);
      expect(result.usage.outputTokens).toBe(expected.textGenerate.outputTokens);
      expect(result.stopReason).toBe(expected.textGenerate.stopReason);
      expect(result.raw).toBeDefined();
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
  });
}
