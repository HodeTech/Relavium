import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { LlmProviderError } from '../llm-error.js';
import type { StreamChunk } from '../types.js';
import {
  anthropicErrorToLlmError,
  anthropicAdapter,
  createAnthropicAdapter,
  mapContent,
  mapStopReason,
  mapUsage,
} from './anthropic.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parse a captured request body into a record at runtime — no unsafe `as`. */
function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  const raw = typeof init?.body === 'string' ? init.body : '{}';
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('expected a JSON object request body');
  }
  return parsed;
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('AnthropicAdapter', () => {
  it('exposes the anthropic id and the full capability surface', () => {
    expect(anthropicAdapter.id).toBe('anthropic');
    expect(anthropicAdapter.supports).toEqual({
      tools: true,
      streaming: true,
      parallelToolCalls: true,
      vision: true,
      promptCache: true,
      reasoning: true,
    });
  });

  it('maps every Anthropic stop reason to the canonical 5-value enum', () => {
    expect(mapStopReason('end_turn')).toBe('stop');
    expect(mapStopReason('stop_sequence')).toBe('stop');
    expect(mapStopReason('pause_turn')).toBe('stop');
    expect(mapStopReason(null)).toBe('stop');
    expect(mapStopReason('max_tokens')).toBe('length');
    expect(mapStopReason('tool_use')).toBe('tool_use');
    expect(mapStopReason('refusal')).toBe('content_filter');
    // A future/unknown reason the pinned SDK doesn't type degrades to 'stop' instead of throwing.
    expect(mapStopReason('future_reason' as Anthropic.StopReason)).toBe('stop');
  });

  it('maps usage with input net of cache, surfacing cache tokens only when present', () => {
    expect(mapUsage({ input_tokens: 100, output_tokens: 20 })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(
      mapUsage({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 10 });
    // null cache fields are omitted, not surfaced as 0.
    expect(
      mapUsage({
        input_tokens: 5,
        output_tokens: 5,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      }),
    ).toEqual({ inputTokens: 5, outputTokens: 5 });
  });

  it('createAnthropicAdapter accepts injected transport deps (for the conformance replayer)', () => {
    const adapter = createAnthropicAdapter({
      fetch: () => Promise.reject(new Error('not invoked at construction')),
      maxRetries: 0,
    });
    expect(adapter.id).toBe('anthropic');
    expect(adapter.supports.streaming).toBe(true);
  });

  it('merges providerOptions into the request body (the typed escape hatch)', async () => {
    let sentBody: Record<string, unknown> = {};
    const adapter = createAnthropicAdapter({
      fetch: (_input, init) => {
        sentBody = parseJsonBody(init);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'msg',
              type: 'message',
              role: 'assistant',
              model: 'claude-opus-4-8',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
      maxRetries: 0,
    });
    await adapter.generate(
      {
        model: 'claude-opus-4-8',
        maxTokens: 16,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: { thinking: { type: 'adaptive' } },
      },
      'k',
    );
    expect(sentBody['thinking']).toEqual({ type: 'adaptive' }); // escape-hatch field reached the wire
    expect(sentBody['model']).toBe('claude-opus-4-8'); // mapped common-path fields still present
  });
});

describe('anthropicErrorToLlmError — classification', () => {
  it('classifies the connection/abort error classes', () => {
    expect(anthropicErrorToLlmError(new Anthropic.APIUserAbortError())).toMatchObject({
      kind: 'cancelled',
      retryable: false,
    });
    expect(anthropicErrorToLlmError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({
      kind: 'timeout',
      retryable: true,
    });
    expect(
      anthropicErrorToLlmError(new Anthropic.APIConnectionError({ message: 'down' })),
    ).toMatchObject({ kind: 'transport', retryable: true });
  });

  it('classifies an APIError by HTTP status (rate limit retryable, auth fatal)', () => {
    expect(
      anthropicErrorToLlmError(new Anthropic.APIError(429, undefined, 'rate limited', undefined)),
    ).toMatchObject({ kind: 'rate_limit', retryable: true, status: 429 });
    expect(
      anthropicErrorToLlmError(new Anthropic.APIError(401, undefined, 'unauthorized', undefined)),
    ).toMatchObject({ kind: 'auth', retryable: false, status: 401 });
  });

  it('classifies a status-less APIError by its error type, and sets code from the type', () => {
    const err = new Anthropic.APIError(
      undefined,
      undefined,
      'overloaded',
      undefined,
      'overloaded_error',
    );
    expect(anthropicErrorToLlmError(err)).toMatchObject({
      kind: 'overloaded',
      retryable: true,
      code: 'overloaded_error',
    });
  });

  it('falls back to unknown (fatal) for a non-Error throwable', () => {
    expect(anthropicErrorToLlmError('boom')).toMatchObject({ kind: 'unknown', retryable: false });
  });
});

describe('AnthropicAdapter — request building + secret safety', () => {
  const okResponse = (): Response =>
    new Response(
      JSON.stringify({
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('maps tool_call / tool_result content + tool_choice + system onto the Anthropic body', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createAnthropicAdapter({
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
      maxRetries: 0,
    });
    await adapter.generate(
      {
        model: 'claude-opus-4-8',
        maxTokens: 16,
        system: 'be terse',
        toolChoice: 'required',
        tools: [{ name: 'get_weather', parameters: { type: 'object' } }],
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', id: 'c1', name: 'get_weather', args: { city: 'Paris' } },
            ],
          },
          {
            role: 'tool',
            content: [{ type: 'tool_result', toolCallId: 'c1', result: { tempC: 18 } }],
          },
        ],
      },
      'k',
    );
    expect(sent['system']).toBe('be terse');
    expect(sent['tool_choice']).toEqual({ type: 'any' }); // 'required' → any
    expect(sent['tools']).toMatchObject([
      { name: 'get_weather', input_schema: { type: 'object' } },
    ]);
    const messages = sent['messages'] as { role: string; content: { type: string }[] }[];
    expect(messages[0]?.content[0]).toMatchObject({
      type: 'tool_use',
      id: 'c1',
      name: 'get_weather',
    });
    // tool role → user; non-string result stringified.
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'c1',
      content: JSON.stringify({ tempC: 18 }),
    });
  });

  it('never leaks the API key into the surfaced LlmError', async () => {
    const SECRET = 'sk-ant-SECRET-DO-NOT-LEAK';
    const adapter = createAnthropicAdapter({
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'error',
              error: { type: 'authentication_error', message: 'bad key' },
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
        ),
      maxRetries: 0,
    });
    let caught: unknown;
    try {
      await adapter.generate(
        {
          model: 'm',
          maxTokens: 8,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        },
        SECRET,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmProviderError);
    if (caught instanceof LlmProviderError) {
      expect(caught.llmError.kind).toBe('auth');
      expect(JSON.stringify(caught.llmError)).not.toContain('SECRET');
    }
  });
});

describe('AnthropicAdapter — stream edge cases', () => {
  const REQ = {
    model: 'm',
    maxTokens: 8,
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  };
  const ev = (type: string, data: unknown): string =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const sse = (body: string): Response =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

  it('yields a single error chunk when the stream fails to start (429)', async () => {
    const adapter = createAnthropicAdapter({
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rl' } }),
            { status: 429, headers: { 'content-type': 'application/json' } },
          ),
        ),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe('error');
    if (chunks[0]?.type === 'error') {
      expect(chunks[0].error.kind).toBe('rate_limit');
    }
  });

  it('ignores unknown events and deltas/stops for an untracked tool index', async () => {
    const body =
      ev('message_start', {
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'm',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }) +
      ev('ping', { type: 'ping' }) + // unknown event -> default case
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 9, // no tool_use was started at index 9 -> id-missing branch
        delta: { type: 'input_json_delta', partial_json: '{}' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 9 }) + // id-missing branch
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      }) +
      ev('message_stop', { type: 'message_stop' }) +
      '\n';
    const adapter = createAnthropicAdapter({
      fetch: () => Promise.resolve(sse(body)),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks.some((c) => c.type === 'tool_call_delta')).toBe(false); // no id at index 9
    expect(chunks.some((c) => c.type === 'tool_call_end')).toBe(false);
    expect(chunks.some((c) => c.type === 'text_delta')).toBe(true);
    expect(chunks.at(-1)?.type).toBe('stop');
  });

  it('forwards temperature and stopSequences onto the body', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createAnthropicAdapter({
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'm',
              type: 'message',
              role: 'assistant',
              model: 'm',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
      maxRetries: 0,
    });
    await adapter.generate({ ...REQ, temperature: 0.5, stopSequences: ['STOP'] }, 'k');
    expect(sent['temperature']).toBe(0.5);
    expect(sent['stop_sequences']).toEqual(['STOP']);
  });

  it('merges the cumulative cache/input usage the message_delta carries into the stop chunk', async () => {
    const body =
      ev('message_start', {
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'm',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        // cumulative usage the SDK delivers on the delta — must reach the stop chunk, including the
        // authoritative thinking count carried in output_tokens_details (ADR-0030).
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 8,
          cache_creation_input_tokens: 3,
          output_tokens_details: { thinking_tokens: 4 },
        },
      }) +
      ev('message_stop', { type: 'message_stop' }) +
      '\n';
    const adapter = createAnthropicAdapter({
      fetch: () => Promise.resolve(sse(body)),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    const stop = chunks.at(-1);
    expect(stop?.type).toBe('stop');
    if (stop?.type === 'stop') {
      expect(stop.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 8,
        cacheWriteTokens: 3,
        reasoningTokens: 4, // read from the message_delta's output_tokens_details, not dropped
      });
    }
  });

  it('emits a transport error (not a clean stop) when the stream ends before message_delta', async () => {
    // A stream cut after some content but before the terminal message_delta — must surface as an
    // error, never a successful stop that hides the truncation.
    const body =
      ev('message_start', {
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'm',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'partial' },
      }) +
      '\n';
    const adapter = createAnthropicAdapter({
      fetch: () => Promise.resolve(sse(body)),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks.some((c) => c.type === 'text_delta')).toBe(true);
    const last = chunks.at(-1);
    expect(last?.type).toBe('error');
    if (last?.type === 'error') {
      expect(last.error.kind).toBe('transport');
      expect(last.error.retryable).toBe(true);
    }
  });

  it('carries the redacted flag onto a streamed reasoning_end (asymmetry fix)', async () => {
    const body =
      ev('message_start', {
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'm',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'redacted_thinking', data: 'opaque' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      }) +
      ev('message_stop', { type: 'message_stop' }) +
      '\n';
    const adapter = createAnthropicAdapter({
      fetch: () => Promise.resolve(sse(body)),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    const end = chunks.find((c) => c.type === 'reasoning_end');
    expect(end).toMatchObject({ type: 'reasoning_end', redacted: true });
  });
});

describe('AnthropicAdapter — content mapping + cancellation', () => {
  it('mapContent maps thinking → reasoning (with signature) + text + tool_use', () => {
    // A fixture of the vendor content-block union (ToolUseBlock has extra fields) — cast at the
    // test boundary; mapContent reads type/text/id/name/input + thinking/signature.
    const parts = mapContent([
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'hi', citations: null },
      { type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } },
    ] as Anthropic.ContentBlock[]);
    expect(parts).toEqual([
      { type: 'reasoning', text: 'hmm', signature: 'sig' }, // ADR-0030
      { type: 'reasoning', text: '', redacted: true },
      { type: 'text', text: 'hi' },
      { type: 'tool_call', id: 't1', name: 'f', args: { a: 1 } },
    ]);
  });

  it('threads an AbortSignal to the request options', async () => {
    let sawSignal = false;
    const adapter = createAnthropicAdapter({
      fetch: (_input, init) => {
        sawSignal = init?.signal instanceof AbortSignal;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'm',
              type: 'message',
              role: 'assistant',
              model: 'm',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
      maxRetries: 0,
    });
    const controller = new AbortController();
    await adapter.generate(
      {
        model: 'm',
        maxTokens: 8,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: controller.signal,
      },
      'k',
    );
    expect(sawSignal).toBe(true);
  });
});

describe('anthropicErrorToLlmError — error-type table (status-less)', () => {
  const cases: ReadonlyArray<readonly [Anthropic.ErrorType, string]> = [
    ['rate_limit_error', 'rate_limit'],
    ['overloaded_error', 'overloaded'],
    ['api_error', 'overloaded'],
    ['timeout_error', 'timeout'],
    ['authentication_error', 'auth'],
    ['permission_error', 'auth'],
    ['invalid_request_error', 'bad_request'],
    ['not_found_error', 'bad_request'],
  ];
  it.each(cases)('maps %s -> %s', (type, kind) => {
    const err = new Anthropic.APIError(undefined, undefined, 'm', undefined, type);
    expect(anthropicErrorToLlmError(err).kind).toBe(kind);
  });
  it('falls back to unknown for an unmapped error type with no status', () => {
    // billing_error is a valid ErrorType that kindFromErrorType doesn't map → unknown.
    const err = new Anthropic.APIError(undefined, undefined, 'm', undefined, 'billing_error');
    expect(anthropicErrorToLlmError(err).kind).toBe('unknown');
  });
});

describe('AnthropicAdapter — reasoning + structured output (ADR-0030)', () => {
  const REQ2 = {
    model: 'm',
    maxTokens: 8,
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  };
  const ev = (type: string, data: unknown): string =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const sse = (body: string): Response =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

  it('folds thinking blocks into reasoning_start/delta/end carrying the signature', async () => {
    const body =
      ev('message_start', {
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'm',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'let me think' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-abc' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'answer' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 1 }) +
      ev('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 9 },
      }) +
      ev('message_stop', { type: 'message_stop' }) +
      '\n';
    const adapter = createAnthropicAdapter({
      fetch: () => Promise.resolve(sse(body)),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ2, 'k'));
    expect(chunks.find((c) => c.type === 'reasoning_start')).toMatchObject({ id: 'reasoning-0' });
    expect(chunks.find((c) => c.type === 'reasoning_delta')).toMatchObject({
      id: 'reasoning-0',
      text: 'let me think',
    });
    const end = chunks.find((c) => c.type === 'reasoning_end');
    expect(end).toMatchObject({ id: 'reasoning-0', signature: 'sig-abc' });
    expect(chunks.some((c) => c.type === 'text_delta')).toBe(true);
  });

  it('mapUsage surfaces thinking tokens as reasoningTokens (billing unchanged)', () => {
    expect(
      mapUsage({
        input_tokens: 10,
        output_tokens: 20,
        output_tokens_details: { thinking_tokens: 8 },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 20, reasoningTokens: 8 });
  });

  it('lowers responseFormat json to output_config', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createAnthropicAdapter({
      fetch: (_i, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'm',
              type: 'message',
              role: 'assistant',
              model: 'm',
              content: [{ type: 'text', text: '{}' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
      maxRetries: 0,
    });
    await adapter.generate(
      { ...REQ2, responseFormat: { type: 'json', schema: { type: 'object' } } },
      'k',
    );
    expect(sent['output_config']).toEqual({
      format: { type: 'json_schema', schema: { type: 'object' } },
    });
  });
});
