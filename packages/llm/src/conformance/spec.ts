import { describe, expect, it } from 'vitest';

import { LlmProviderError } from '../llm-error.js';
import type { LlmProvider, LlmRequest, StreamChunk } from '../types.js';
import type { RecordedResponse } from './replay.js';

/**
 * The single conformance spec **every** `@relavium/llm` adapter must pass (1.F) — the biggest
 * leverage point for the in-house abstraction. It asserts the canonical seam behaviour (text +
 * tools + usage + stop reasons + classified errors), driven by recorded fixtures in PR mode
 * (offline, deterministic). Each provider supplies its own `ConformanceFixtures` and a
 * `MakeReplayAdapter` that wires them via a replay `fetch`. See
 * [testing.md](../../../../docs/standards/testing.md).
 */

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
  /** A 429 rate-limit error response. */
  readonly rateLimit: RecordedResponse;
}

/** Build an adapter wired to replay a single recorded response (provider-specific). */
export type MakeReplayAdapter = (recorded: RecordedResponse) => LlmProvider;

/** The canonical 5-value stop-reason set (mirrors `@relavium/shared` STOP_REASONS). */
const STOP_REASONS = ['stop', 'length', 'tool_use', 'content_filter', 'error'] as const;

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
  describe(`${name} — conformance (replay)`, () => {
    it('generate: returns text content, usage, and a canonical stop reason', async () => {
      const result = await makeReplayAdapter(fixtures.textGenerate).generate(TEXT_REQUEST, KEY);
      expect(result.content.some((part) => part.type === 'text')).toBe(true);
      expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0);
      expect(STOP_REASONS).toContain(result.stopReason);
      expect(result.raw).toBeDefined();
    });

    it('generate: a tool call normalizes to a tool_call part with non-empty id + name', async () => {
      const result = await makeReplayAdapter(fixtures.toolGenerate).generate(TOOL_REQUEST, KEY);
      const call = result.content.find((part) => part.type === 'tool_call');
      expect(call?.type).toBe('tool_call');
      if (call?.type === 'tool_call') {
        expect(call.id.length).toBeGreaterThan(0);
        expect(call.name.length).toBeGreaterThan(0);
      }
      expect(result.stopReason).toBe('tool_use');
    });

    it('stream: yields text_delta(s) then a terminal stop chunk with usage', async () => {
      const chunks = await collect(
        makeReplayAdapter(fixtures.textStream).stream(TEXT_REQUEST, KEY),
      );
      expect(chunks.some((chunk) => chunk.type === 'text_delta')).toBe(true);
      expect(chunks.every((chunk) => chunk.type !== 'error')).toBe(true);
      const last = chunks.at(-1);
      expect(last?.type).toBe('stop');
      if (last?.type === 'stop') {
        expect(STOP_REASONS).toContain(last.stopReason);
        expect(last.usage.outputTokens).toBeGreaterThanOrEqual(0);
      }
    });

    it('stream: a tool call yields start/delta/end with one stable id', async () => {
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
        expect(start.id.length).toBeGreaterThan(0);
        expect(delta.id).toBe(start.id); // a stable id across the streamed turn
        expect(end.id).toBe(start.id);
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
  });
}
