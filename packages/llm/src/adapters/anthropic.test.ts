import { describe, expect, it } from 'vitest';

import { anthropicAdapter, createAnthropicAdapter, mapStopReason, mapUsage } from './anthropic.js';

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
        const raw = typeof init?.body === 'string' ? init.body : '{}';
        sentBody = JSON.parse(raw) as Record<string, unknown>;
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
