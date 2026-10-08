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
        expect(
          await errorFrom(adapter(dialect, capture.response), capture.model, path),
        ).toMatchObject({ kind: 'context_overflow', retryable: false, status: 400 });
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
function nativeStream(response: RecordedResponse): RecordedResponse {
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
  message.content.forEach((block, index) =>
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
