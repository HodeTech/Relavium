import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { createOpenAiAdapter } from '../adapters/openai.js';
import { createGeminiAdapter } from '../adapters/gemini.js';
import { FallbackChain, type AttemptRecord } from '../fallback-chain.js';
import { CostTracker } from '../cost-tracker.js';
import { LlmProviderError } from '../llm-error.js';
import type { LlmProvider, LlmRequest, StreamChunk } from '../types.js';
import { replayFetch, replayGeminiError, type RecordedResponse } from './replay.js';

const fixtureSchema = z.object({
  model: z.string(),
  response: z.object({ status: z.number(), contentType: z.string(), body: z.string() }),
});
const captures = [
  [
    'anthropic',
    '2026-10-04-anthropic-overflow.json',
    '7a0fa5757876281f77903bf2ea96f76729ad10fb6f7b0c6a255ceb575f6593ba',
  ],
  [
    'openai',
    '2026-10-04-openai-overflow.json',
    '968c3b35fe3e2185b3f0fb6a0264041ee732e7ceff1f9164d67b0ccecfa3a553',
  ],
  [
    'deepseek',
    '2026-10-04-deepseek-overflow.json',
    '2b3f9890e9dbcfb5ac621646b150b3e7afc068a6dee02aebac80d197c1c7ac2e',
  ],
  [
    'gemini',
    '2026-10-08-gemini-overflow.json',
    'a00ffc0290206585834730f176ab1871bb91e79eea4e22ac58dfa8372ec56318',
  ],
] as const;
function fixture(file: string, hash: string): z.infer<typeof fixtureSchema> {
  const bytes = readFileSync(new URL(`./fixtures/overflow/${file}`, import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
  return fixtureSchema.parse(JSON.parse(bytes.toString('utf8')));
}
function adapter(provider: string, response: RecordedResponse): LlmProvider {
  const fetch = vi.fn(replayFetch(response));
  if (provider === 'anthropic') return createAnthropicAdapter({ fetch });
  if (provider === 'gemini') {
    // The actual installed SDK parses the captured HTTP response, not a preclassified transport double.
    vi.stubGlobal('fetch', fetch);
    return createGeminiAdapter();
  }
  if (provider !== 'openai' && provider !== 'deepseek') throw new Error('unsupported test dialect');
  return createOpenAiAdapter({ providerId: provider, fetch });
}
function request(model: string): LlmRequest {
  return {
    model,
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'offline synthetic replay' }] }],
  };
}
async function chunks(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of source) out.push(chunk);
  return out;
}
async function errorFrom(provider: LlmProvider, model: string, path: 'generate' | 'stream') {
  if (path === 'stream') {
    const out = await chunks(provider.stream(request(model), 'offline-synthetic-key'));
    expect(out).toHaveLength(1);
    const terminal = out[0];
    if (terminal?.type !== 'error') throw new Error('expected a classified terminal');
    return terminal.error;
  }
  try {
    await provider.generate(request(model), 'offline-synthetic-key');
  } catch (error) {
    if (error instanceof LlmProviderError) return error.llmError;
    throw error;
  }
  throw new Error('overflow returned a successful result');
}

describe('live-captured overflow dialects through actual SDK HTTP parsing (ADR-0096)', () => {
  afterEach(() => vi.unstubAllGlobals());
  for (const [dialect, file, hash] of captures) {
    for (const path of ['generate', 'stream'] as const) {
      it(`${dialect} ${path}: the unchanged recorded rejection is fatal context_overflow`, async () => {
        const capture = fixture(file, hash);
        const error = await errorFrom(adapter(dialect, capture.response), capture.model, path);
        expect(error).toMatchObject({ kind: 'context_overflow', retryable: false, status: 400 });
        expect(error.usage).toBeUndefined();
        expect(error.contentCommitted).not.toBe(true);
      });
      it(`${dialect} ${path}: hostile unmatched 400 and wrong-status controls stay unclassified`, async () => {
        const capture = fixture(file, hash);
        for (const status of [401, 429, 500]) {
          expect(
            (
              await errorFrom(
                adapter(dialect, { ...capture.response, status }),
                capture.model,
                path,
              )
            ).kind,
          ).not.toBe('context_overflow');
        }
        const body = JSON.stringify({
          error: {
            code: 'invalid_request_error',
            type: 'invalid_request_error',
            status: 'INVALID_ARGUMENT',
            message: 'temperature exceeds the maximum; this is not a context-length refusal',
          },
        });
        expect(
          (await errorFrom(adapter(dialect, { status: 400, body }), capture.model, path)).kind,
        ).toBe('bad_request');
      });
    }
  }
  it('Gemini transport replay retains exactly the captured message/body', () => {
    const captured = captures[3];
    const capture = fixture(captured[1], captured[2]);
    const error = replayGeminiError(capture.response);
    expect(error.message).toBe(capture.response.body);
    expect(error.body).toBe(capture.response.body);
    expect(error.status).toBe(400);
  });
});

const nativeSchema = z.object({
  id: z.string(),
  model: z.string(),
  type: z.literal('message'),
  role: z.literal('assistant'),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  stop_reason: z.literal('model_context_window_exceeded'),
  stop_sequence: z.null(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_read_input_tokens: z.number(),
      cache_creation_input_tokens: z.number(),
    })
    .passthrough(),
});
const native = () =>
  fixture(
    '2026-10-08-anthropic-context-stop.json',
    '0f8ed2eb3b5b1f6dc6419e16e25d97ea5ce42b05d06e9f75ef85426a21dabc9e',
  );
/** Re-express the exact captured message as SDK SSE events; this is derived replay, not a live SSE capture. */
function nativeStream(
  response: RecordedResponse,
  tail: readonly { type: string; [key: string]: unknown }[] = [],
  includeContent = true,
): RecordedResponse {
  const message = nativeSchema.parse(JSON.parse(response.body));
  const events: { type: string; [key: string]: unknown }[] = [
    {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { ...message.usage, output_tokens: 0 },
      },
    },
  ];
  (includeContent ? message.content : []).forEach((block, index) =>
    events.push(
      { type: 'content_block_start', index, content_block: { ...block, text: '' } },
      { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
      { type: 'content_block_stop', index },
    ),
  );
  events.push(
    {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence },
      usage: message.usage,
    },
    ...tail,
    { type: 'message_stop' },
  );
  return {
    status: 200,
    contentType: 'text/event-stream',
    body: events
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(''),
  };
}

describe('Anthropic native HTTP 200 context stop is paid failure, never clean stop', () => {
  for (const path of ['generate', 'stream'] as const) {
    it(`${path}: exact captured content and usage survive the failed attempt and stop failover`, async () => {
      const capture = native();
      const message = nativeSchema.parse(JSON.parse(capture.response.body));
      const provider = adapter(
        'anthropic',
        path === 'generate' ? capture.response : nativeStream(capture.response),
      );
      const kind = 'context_overflow';
      const records: AttemptRecord[] = [];
      const tracker = new CostTracker(
        new Map([
          [
            capture.model,
            {
              provider: 'anthropic',
              nativeId: capture.model,
              displayName: 'Captured native response',
              contextWindowTokens: 200000,
              maxOutputTokens: 64000,
              inputPerMtokMicrocents: 1000000,
              outputPerMtokMicrocents: 1000000,
              cachedInputPerMtokMicrocents: 0,
            },
          ],
        ]),
      );
      const fallback = vi.fn(() => {
        throw new Error('overflow must never fail over');
      });
      const chain = new FallbackChain(
        [
          { provider, model: capture.model, maxAttempts: 3 },
          {
            provider: { ...provider, generate: fallback, stream: fallback },
            model: capture.model,
            maxAttempts: 1,
          },
        ],
        {
          keyFor: () => 'offline-synthetic-key',
          sleep: () => Promise.resolve(),
          onAttempt: (r) => records.push(r),
          costTracker: tracker,
        },
      );
      if (path === 'generate') {
        await expect(chain.generate(request(capture.model))).rejects.toMatchObject({
          llmError: { kind, contentCommitted: true },
        });
      } else {
        const out = await chunks(chain.stream(request(capture.model)));
        expect(
          out
            .filter((c) => c.type === 'text_delta')
            .map((c) => c.text)
            .join(''),
        ).toBe(message.content.map((c) => c.text).join(''));
        expect(out.some((c) => c.type === 'stop')).toBe(false);
        expect(out.at(-1)).toMatchObject({
          type: 'error',
          error: { kind, contentCommitted: true },
        });
      }
      expect(fallback).not.toHaveBeenCalled();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        outcome: 'failed',
        contentReceived: true,
        usage: { inputTokens: 199885, outputTokens: 12792 },
        cost: { costMicrocents: 212677 },
        error: { kind },
      });
    });
  }
});

describe('first native overflow owns its final evidence before another SDK read', () => {
  const tails = [
    {
      name: 'overloaded error',
      event: { type: 'error', error: { type: 'overloaded_error', message: 'PRIVATE_TAIL' } },
    },
    {
      name: 'null second stop',
      event: {
        type: 'message_delta',
        delta: { stop_reason: null, stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    },
    {
      name: 'clean second stop',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    },
    {
      name: 'second native stop',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'model_context_window_exceeded', stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    },
    {
      name: 'post-stop content',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'PRIVATE_TAIL' },
      },
    },
  ];
  for (const includeContent of [true, false]) {
    for (const tail of tails) {
      it(`${tail.name}, content=${includeContent}: no success, rewritten usage or failover`, async () => {
        const capture = native();
        const message = nativeSchema.parse(JSON.parse(capture.response.body));
        const provider = adapter(
          'anthropic',
          nativeStream(capture.response, [tail.event], includeContent),
        );
        let fallbackCalls = 0;
        const fallback: LlmProvider = {
          ...provider,
          stream: () => {
            fallbackCalls++;
            throw new Error('native overflow must not advance');
          },
        };
        const records: AttemptRecord[] = [];
        const chain = new FallbackChain(
          [
            { provider, model: capture.model, maxAttempts: 3 },
            { provider: fallback, model: capture.model, maxAttempts: 1 },
          ],
          {
            keyFor: () => 'offline-key',
            sleep: () => Promise.resolve(),
            onAttempt: (record) => records.push(record),
          },
        );
        const out = await chunks(chain.stream(request(capture.model)));
        expect(out.some((chunk) => chunk.type === 'stop')).toBe(false);
        expect(out.at(-1)).toMatchObject({
          type: 'error',
          error: {
            kind: 'context_overflow',
            usage: { inputTokens: 199885, outputTokens: 12792 },
            message: 'generation exceeded the model context window',
          },
        });
        expect(
          out
            .filter((chunk) => chunk.type === 'text_delta')
            .map((chunk) => chunk.text)
            .join(''),
        ).toBe(includeContent ? message.content.map((block) => block.text).join('') : '');
        expect(fallbackCalls).toBe(0);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          outcome: 'failed',
          contentReceived: includeContent,
          error: { kind: 'context_overflow' },
          usage: { inputTokens: 199885, outputTokens: 12792 },
        });
      });
    }
  }

  for (const cleanup of ['immediate', 'held', 'throws'] as const) {
    for (const ending of ['ordinary', 'cancel', 'deadline'] as const) {
      it(`open SDK body, ${cleanup}/${ending}: retains paid evidence during source cancellation`, async () => {
        const capture = native();
        // Explicit derived no-content control; the actual native usage and stop are unchanged.
        const derived = nativeStream(capture.response, [], false);
        const sse = derived.body.slice(0, derived.body.indexOf('event: message_stop'));
        const caller = new AbortController();
        let fire: (() => void) | undefined;
        let release: () => void = () => undefined;
        const cleanupWait = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered: () => void = () => undefined;
        const enteredCleanup = new Promise<void>((resolve) => {
          entered = resolve;
        });
        let acknowledgeCleanup: () => void = () => undefined;
        const cleanupSettled = new Promise<void>((resolve) => {
          acknowledgeCleanup = resolve;
        });
        let acknowledgeAbort: () => void = () => undefined;
        const abortAcknowledged = new Promise<void>((resolve) => {
          acknowledgeAbort = resolve;
        });
        let cancellations = 0;
        let requestAborts = 0;
        let timers = 0;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
          },
          cancel() {
            cancellations++;
            entered();
            if (ending === 'cancel') caller.abort();
            if (ending === 'deadline') {
              if (fire === undefined) throw new Error('attempt deadline not armed');
              fire();
            }
            if (cleanup === 'held') return cleanupWait.finally(acknowledgeCleanup);
            try {
              if (cleanup === 'throws') throw new Error('PRIVATE_CANCEL_CAUSE');
              return undefined;
            } finally {
              acknowledgeCleanup();
            }
          },
        });
        const fetch: typeof globalThis.fetch = (_input, options) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              requestAborts++;
              acknowledgeAbort();
            },
            { once: true },
          );
          return Promise.resolve(
            new Response(body, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
          );
        };
        const provider = createAnthropicAdapter({ fetch });
        const records: AttemptRecord[] = [];
        let folds = 0;
        // One attempt isolates the accounting race. A genuine pre-content timeout may retry;
        // the separate fresh-response control below verifies that preserved ADR-0082 rule.
        const chain = new FallbackChain([{ provider, model: capture.model, maxAttempts: 1 }], {
          keyFor: () => 'offline-key',
          sleep: () => Promise.resolve(),
          newAbortController: () => new AbortController(),
          setTimer: (_ms, callback) => {
            fire = callback;
            timers++;
            return () => {
              timers--;
            };
          },
          onAttempt: (record) => records.push(record),
          costTracker: {
            record: (_model, usage) => {
              folds++;
              return { ...usage, costMicrocents: 212677, cumulativeCostMicrocents: 212677 };
            },
          },
        });
        const collecting = chunks(
          chain.stream({ ...request(capture.model), signal: caller.signal }),
        );
        await enteredCleanup;
        if (ending === 'ordinary') release();
        const out = await collecting;
        const kind =
          ending === 'cancel'
            ? 'cancelled'
            : ending === 'deadline'
              ? 'timeout'
              : 'context_overflow';
        expect(out).toMatchObject([{ type: 'error', error: { kind } }]);
        expect(out).toHaveLength(1);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          outcome: 'failed',
          usage: { inputTokens: 199885, outputTokens: 12792 },
          cost: { costMicrocents: 212677 },
          error: { kind },
        });
        expect(folds).toBe(1);
        expect(cancellations).toBe(1);
        expect(timers).toBe(0);
        expect(records[0]?.error?.message).not.toContain('PRIVATE_CANCEL_CAUSE');
        release();
        await cleanupSettled;
        await abortAcknowledged;
        expect(requestAborts).toBe(1);
        expect(records).toHaveLength(1);
        expect(folds).toBe(1);
      });
    }
  }

  it('an unconfirmed pre-content native terminal may time out, accounting both fresh attempts once', async () => {
    const capture = native();
    const first = nativeStream(capture.response, [], false);
    const prefix = first.body.slice(0, first.body.indexOf('event: message_stop'));
    let fire: (() => void) | undefined;
    let release: () => void = () => undefined;
    const pendingCleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acknowledgeCleanup: () => void = () => undefined;
    const cleanupSettled = new Promise<void>((resolve) => {
      acknowledgeCleanup = resolve;
    });
    let fetches = 0;
    let cancellations = 0;
    const fetch: typeof globalThis.fetch = () => {
      fetches++;
      if (fetches > 1) {
        // Fresh response: never reuse the consumed first body to manufacture a later failure.
        return Promise.resolve(
          new Response(
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(prefix));
        },
        cancel() {
          cancellations++;
          if (fire === undefined) throw new Error('attempt deadline not armed');
          fire();
          return pendingCleanup.finally(acknowledgeCleanup);
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    };
    const provider = createAnthropicAdapter({ fetch });
    const records: AttemptRecord[] = [];
    const quantities: { inputTokens: number; outputTokens: number }[] = [];
    const chain = new FallbackChain([{ provider, model: capture.model, maxAttempts: 2 }], {
      keyFor: () => 'offline-key',
      sleep: () => Promise.resolve(),
      newAbortController: () => new AbortController(),
      setTimer: (_ms, callback) => {
        fire = callback;
        return () => undefined;
      },
      onAttempt: (record) => records.push(record),
      costTracker: {
        record: (_model, usage) => {
          quantities.push({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
          const costMicrocents = usage.inputTokens + usage.outputTokens;
          return { ...usage, costMicrocents, cumulativeCostMicrocents: costMicrocents };
        },
      },
    });
    const out = await chunks(chain.stream(request(capture.model)));
    expect(out).toMatchObject([{ type: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }]);
    expect(fetches).toBe(2);
    expect(cancellations).toBe(1);
    expect(records).toMatchObject([
      {
        outcome: 'failed',
        contentReceived: false,
        error: { kind: 'timeout' },
        usage: { inputTokens: 199885, outputTokens: 12792 },
      },
      { outcome: 'succeeded', contentReceived: false, usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    expect(records).toHaveLength(2);
    expect(quantities).toEqual([
      { inputTokens: 199885, outputTokens: 12792 },
      { inputTokens: 1, outputTokens: 1 },
    ]);
    release();
    await cleanupSettled;
    expect(records).toHaveLength(2);
    expect(quantities).toHaveLength(2);
  });
});

it('native generate with no text still retains the captured paid usage as processed evidence', async () => {
  const capture = native();
  const message = nativeSchema.parse(JSON.parse(capture.response.body));
  // Explicit derived control: only content is removed; the immutable live capture remains untouched.
  const provider = adapter('anthropic', {
    ...capture.response,
    body: JSON.stringify({ ...message, content: [] }),
  });
  const records: AttemptRecord[] = [];
  const chain = new FallbackChain([{ provider, model: capture.model, maxAttempts: 3 }], {
    keyFor: () => 'offline-synthetic-key',
    sleep: () => Promise.resolve(),
    onAttempt: (record) => records.push(record),
  });
  await expect(chain.generate(request(capture.model))).rejects.toMatchObject({
    llmError: { kind: 'context_overflow', contentCommitted: true },
  });
  expect(records).toMatchObject([
    { contentReceived: true, usage: { inputTokens: 199885, outputTokens: 12792 } },
  ]);
  expect(records).toHaveLength(1);
});
