import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { UnsupportedCapabilityError } from '../errors.js';
import { LlmProviderError } from '../llm-error.js';
import { canDisableReasoning } from '../reasoning-wire.js';
import type { LlmMessage, StreamChunk } from '../types.js';
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

/** Capture the wire request body the adapter sends for a given message list (the ADR-0039 replay tests). */
function captureBody(messages: LlmMessage[]): Promise<string> {
  let body = '{}';
  const adapter = createAnthropicAdapter({
    fetch: (_input, init) => {
      body = JSON.stringify(parseJsonBody(init));
      return Promise.resolve(
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
        ),
      );
    },
    maxRetries: 0,
  });
  return adapter
    .generate({ model: 'claude-opus-4-8', maxTokens: 16, messages }, 'k')
    .then(() => body);
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
      reasoning: false,
      media: {
        // document stays false until handle resolution lands (1.AF) — base64 document is blocked by the
        // seam ceiling, so advertising it would be "advertised-but-unsendable" (ADR-0031).
        input: { image: true, audio: false, video: false, document: false },
        outputCombinations: [],
        surface: 'chat',
      },
    });
  });

  it('rejects an unsupported media modality (audio) with a typed capability error', async () => {
    const adapter = createAnthropicAdapter({
      fetch: () => Promise.reject(new Error('must fail fast before any egress')),
    });
    const req = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'media' as const,
              mimeType: 'audio/wav',
              source: { kind: 'base64' as const, data: 'aGVsbG8=' },
            },
          ],
        },
      ],
    };
    await expect(adapter.generate(req, 'k')).rejects.toThrowError(UnsupportedCapabilityError);
    expect(() => adapter.stream(req, 'k')).toThrowError(UnsupportedCapabilityError);
  });

  it('wires image media parts onto the Anthropic wire format (document uses handle, deferred to 1.AF)', async () => {
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
              model: 'claude-sonnet-4-6',
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
        model: 'claude-sonnet-4-6',
        maxTokens: 16,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this' },
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
    );
    const messages = sent['messages'] as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    const content = messages[0]?.['content'] as Record<string, unknown>[];
    expect(content[0]).toEqual({ type: 'text', text: 'describe this' });
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
    });
  });

  /**
   * THE OTHER HALF OF THE LIVE BUG (ADR-0071 §6). The reasoning field is chosen PER MODEL.
   *
   * `claude-haiku-4-5` publishes a token BUDGET and **no effort axis at all** — the maintainer confirmed this
   * independently against Anthropic. ADR-0066 filed the budget shape as "legacy", and it is, for the industry;
   * it is not legacy for one of the four Claude models we ship. The adapter sent `output_config.effort` to it
   * anyway, which is a parameter that model does not take.
   */
  it('a BUDGET-shaped Claude (haiku-4-5) gets thinking.budget_tokens — NOT output_config.effort', async () => {
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
              model: 'claude-haiku-4-5',
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
    const base = {
      model: 'claude-haiku-4-5', // catalog: { budgetTokens: { min: 1024 } } — no `max`, no effort values
      maxTokens: 8192,
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }],
    };

    await adapter.generate({ ...base, reasoningEffort: 'high' }, 'k');
    // The ceiling is 80% of the request's own cap — NOT the whole cap. Thinking that eats every token leaves no
    // ANSWER: `budget_tokens: max_tokens - 1` is accepted by Anthropic and returns one token of reply, which is
    // a turn the user pays for in full and gets nothing from. floor(8192 * 0.8) = 6553.
    expect(sent['thinking']).toEqual({ type: 'enabled', budget_tokens: 5171 }); // 1024 + 75% of [1024, 6553]
    expect('output_config' in sent).toBe(false); // the field this model does not take is NEVER sent

    await adapter.generate({ ...base, reasoningEffort: 'low' }, 'k');
    expect(sent['thinking']).toEqual({ type: 'enabled', budget_tokens: 2406 }); // 25% of [1024, 6553]

    // `off` is the independent disable switch on BOTH shapes.
    await adapter.generate({ ...base, reasoningEffort: 'off' }, 'k');
    expect(sent['thinking']).toEqual({ type: 'disabled' });
  });

  it('NEVER sends budget_tokens >= max_tokens — Anthropic rejects it, and we were doing it', async () => {
    // Found by an adversarial review, and it was real: `reasoningBudgetFor` used to return the model's FLOOR when
    // the range was degenerate ("the least thinking it can do"). With `max_tokens: 256` on a model whose minimum
    // budget is 1024, that put `budget_tokens: 1024` on the wire — a guaranteed 400.
    //
    // The honest answer is that reasoning cannot be enabled under that cap at all, so the field is WITHHELD. The
    // tempting alternative — quietly raising `max_tokens` to make room — would change what the user asked for AND
    // what they pay, without telling them.
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
              model: 'claude-haiku-4-5',
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

    // The full matrix the review swept — extended, because the answer-headroom raises the floor: a cap of 1024 can
    // no longer afford 1024 tokens of thinking AND a reply. The first viable cap is 1280 (floor(1280*0.8) = 1024).
    for (const maxTokens of [1, 256, 512, 1000, 1024, 1279]) {
      for (const tier of ['low', 'medium', 'high', 'max'] as const) {
        await adapter.generate(
          {
            model: 'claude-haiku-4-5',
            maxTokens,
            messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }],
            reasoningEffort: tier,
          },
          'k',
        );
        expect('thinking' in sent, `maxTokens=${maxTokens} ${tier}: no valid budget exists`).toBe(
          false,
        );
      }
    }

    // …and the first cap that CAN hold the floor AND leave room for an answer enables it.
    await adapter.generate(
      {
        model: 'claude-haiku-4-5',
        maxTokens: 1280,
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }],
        reasoningEffort: 'max',
      },
      'k',
    );
    const thinking = sent['thinking'] as { type: string; budget_tokens: number };
    expect(thinking.type).toBe('enabled');
    expect(thinking.budget_tokens).toBe(1024); // the model's floor — all the headroom allows
    expect(thinking.budget_tokens).toBeLessThan(1280); // the invariant Anthropic enforces
    expect(1280 - thinking.budget_tokens).toBeGreaterThanOrEqual(256); // …and the ANSWER still has room
  });

  it('a model the catalog does not know gets NO reasoning field — a guess is what broke this', async () => {
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
              model: 'x',
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
        model: 'some-custom-endpoint-model',
        maxTokens: 1024,
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }],
        reasoningEffort: 'high',
      },
      'k',
    );
    expect('thinking' in sent).toBe(false);
    expect('output_config' in sent).toBe(false);
  });

  it('maps the reasoning-effort tier to output_config.effort + adaptive thinking; off disables; unset omits (ADR-0066)', async () => {
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
    const base = {
      model: 'claude-opus-4-8',
      maxTokens: 1024,
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }],
    };
    // All five tiers, so a valid-but-wrong within-domain swap on any row is caught (medium is the picker default).
    await adapter.generate({ ...base, reasoningEffort: 'low' }, 'k');
    expect(sent['thinking']).toEqual({ type: 'adaptive' });
    expect(sent['output_config']).toEqual({ effort: 'low' });
    await adapter.generate({ ...base, reasoningEffort: 'medium' }, 'k');
    expect(sent['output_config']).toEqual({ effort: 'medium' });
    await adapter.generate({ ...base, reasoningEffort: 'high' }, 'k');
    expect(sent['thinking']).toEqual({ type: 'adaptive' });
    expect(sent['output_config']).toEqual({ effort: 'high' });
    await adapter.generate({ ...base, reasoningEffort: 'max' }, 'k');
    expect(sent['output_config']).toEqual({ effort: 'max' }); // Anthropic has a native `max` — 1:1, no coarsening
    await adapter.generate({ ...base, reasoningEffort: 'off' }, 'k');
    expect(sent['thinking']).toEqual({ type: 'disabled' });
    expect('output_config' in sent).toBe(false); // off never sets output_config
    await adapter.generate({ ...base }, 'k'); // unset ⇒ no thinking, no output_config (provider default)
    expect('thinking' in sent).toBe(false);

    // A tier the LADDER omits is served from the model's OTHER axis, not dropped. `claude-opus-4-5` publishes
    // ['low','medium','high'] AND `budgetTokens: {min: 1024}`; `max` is not an effort level it takes, so it goes
    // out as a budget. Reading the two axes as mutually exclusive would have withheld reasoning entirely from a
    // model that serves the tier perfectly well — including on the failover path, where the rescue turn would
    // then run with no reasoning at all.
    await adapter.generate(
      { ...base, model: 'claude-opus-4-5', maxTokens: 8192, reasoningEffort: 'max' },
      'k',
    );
    expect('output_config' in sent).toBe(false);
    expect(sent['thinking']).toEqual({ type: 'enabled', budget_tokens: 6553 }); // 80% of 8192
  });

  it('an EMPTY descriptor is NOT disable-able — `thinking: {disabled}` is still a field, and still a 400', async () => {
    // The `off` branch answered a question about the PROVIDER ("Anthropic can always disable") instead of about the
    // MODEL. A model whose descriptor is `{}` reasons but publishes no knob at all; sending it a disable is the same
    // guess, in the opposite direction, as sending it an effort level. The picker offers `off` for no such model,
    // and now neither does the wire.
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
              model: 'x',
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
    expect(canDisableReasoning('anthropic', {})).toBe(false); // the predicate the branch now asks
    await adapter.generate(
      {
        model: 'claude-opus-4-8',
        maxTokens: 1024,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
        reasoningEffort: 'off',
      },
      'k',
    );
    // …and the real catalog model, which DOES publish a knob, still disables — the guard is a filter, not a mute.
    expect(sent['thinking']).toEqual({ type: 'disabled' });
  });

  it('rejects handle and url media sources with an explicit bad_request error (1.AF)', async () => {
    const adapter = createAnthropicAdapter({
      fetch: () => Promise.resolve(new Response('unused', { status: 200 })),
      maxRetries: 0,
    });
    await expect(
      adapter.generate(
        {
          model: 'claude-sonnet-4-6',
          maxTokens: 16,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'media',
                  mimeType: 'image/png',
                  source: { kind: 'handle', ref: 'media://sha256-' + 'a'.repeat(64) },
                },
                { type: 'text', text: 'what is this' },
              ],
            },
          ],
        },
        'k',
      ),
    ).rejects.toThrow('Anthropic does not support handle-source image input — use base64 (1.AF)');

    const adapter2 = createAnthropicAdapter({
      fetch: () => Promise.resolve(new Response('unused', { status: 200 })),
      maxRetries: 0,
    });
    await expect(
      adapter2.generate(
        {
          model: 'claude-sonnet-4-6',
          maxTokens: 16,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'media',
                  mimeType: 'image/png',
                  source: { kind: 'url', url: 'https://example.com/photo.png' },
                },
                { type: 'text', text: 'describe this' },
              ],
            },
          ],
        },
        'k',
      ),
    ).rejects.toThrow('Anthropic does not support url-source image input — use base64 (1.AF)');
  });

  it('rejects media on an assistant turn rather than silently dropping it (M2)', async () => {
    const adapter = createAnthropicAdapter({
      fetch: () => Promise.resolve(new Response('unused', { status: 200 })),
      maxRetries: 0,
    });
    await expect(
      adapter.generate(
        {
          model: 'claude-sonnet-4-6',
          maxTokens: 16,
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
    const adapter = createAnthropicAdapter({
      fetch: () => Promise.reject(new Error('must fail fast before any egress')),
    });
    await expect(
      adapter.generate(
        {
          model: 'claude-sonnet-4-6',
          maxTokens: 16,
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

  it('rejects an unsupported image subtype pre-egress (image/tiff is not jpeg/png/gif/webp)', async () => {
    const adapter = createAnthropicAdapter({
      fetch: () => Promise.reject(new Error('must fail fast before any egress')),
    });
    await expect(
      adapter.generate(
        {
          model: 'claude-sonnet-4-6',
          maxTokens: 16,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'media', mimeType: 'image/tiff', source: { kind: 'base64', data: 'aW1n' } },
              ],
            },
          ],
        },
        'k',
      ),
    ).rejects.toThrow(/image input supports only/);
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

  it('classifies a native AbortError (name-based, outside the SDK wrapper) as cancelled', () => {
    // A mid-stream/body-read abort can surface as a raw Error named 'AbortError' (not an APIUserAbortError) —
    // classify by name → cancelled, mirroring the OpenAI adapter, not the catch-all `unknown`.
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(anthropicErrorToLlmError(aborted)).toMatchObject({
      kind: 'cancelled',
      retryable: false,
    });
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
    // Built at runtime so no contiguous key-like literal sits in source (the llm-error.test.ts
    // convention — avoids secret-scanner false positives); ≥16 chars after `sk-` so it matches
    // the real scrub pattern.
    const SECRET = ['sk-', 'ant-', 'SECRET-DO-NOT-LEAK'].join('');
    // The vendor error body ECHOES the planted key (security-review.md: each adapter plants a
    // secret in a vendor error) — so the scrubSecrets backstop must actually fire, not merely
    // find a message the key never reached.
    const adapter = createAnthropicAdapter({
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'error',
              error: { type: 'authentication_error', message: `bad key: ${SECRET}` },
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
      // Positive proof the scrub fired (the echoed key reached the message and was masked) —
      // an empty/dropped message would also be "secret-free", but vacuously.
      expect(caught.llmError.message).toContain('[REDACTED]');
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

  it('rejects a temperature above Anthropic max (1) with a bad_request, never reaching the transport', async () => {
    let reached = false;
    const adapter = createAnthropicAdapter({
      fetch: () => {
        reached = true;
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
      maxRetries: 0,
    });
    let caught: unknown;
    try {
      await adapter.generate({ ...REQ, temperature: 1.5 }, 'k');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmProviderError);
    if (caught instanceof LlmProviderError) {
      expect(caught.llmError.kind).toBe('bad_request');
    }
    expect(reached).toBe(false); // failed fast, before egress
  });

  it('emits a bad_request error chunk for temperature > max via STREAM (never reaching the transport)', async () => {
    let reached = false;
    const adapter = createAnthropicAdapter({
      fetch: () => {
        reached = true;
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream({ ...REQ, temperature: 1.5 }, 'k'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe('error');
    if (chunks[0]?.type === 'error') {
      expect(chunks[0].error.kind).toBe('bad_request');
    }
    expect(reached).toBe(false); // failed fast, before egress
  });

  it('rejects a negative or NaN temperature (not only > max) before egress', async () => {
    let reached = false;
    const adapter = createAnthropicAdapter({
      fetch: () => {
        reached = true;
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
      maxRetries: 0,
    });
    for (const bad of [-0.5, Number.NaN]) {
      let caught: unknown;
      try {
        await adapter.generate({ ...REQ, temperature: bad }, 'k');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LlmProviderError);
      if (caught instanceof LlmProviderError) {
        expect(caught.llmError.kind).toBe('bad_request');
      }
    }
    expect(reached).toBe(false);
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

describe('toAnthropicMessage — signed-reasoning replay (ADR-0039)', () => {
  it('lowers a SIGNED reasoning part back to a thinking block on the wire', async () => {
    const body = await captureBody([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'deliberating', signature: 'sig-1' },
          { type: 'tool_call', id: 'c1', name: 'echo', args: {} },
        ],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c1', result: 'ok' }] },
    ]);
    expect(body).toContain('"type":"thinking"');
    expect(body).toContain('"signature":"sig-1"');
    expect(body).toContain('"thinking":"deliberating"');
  });

  it('drops a redacted or signatureless reasoning part (no opaque carrier — deferred)', async () => {
    const body = await captureBody([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', redacted: true },
          { type: 'reasoning', text: 'unsigned' },
          { type: 'text', text: 'hi' },
        ],
      },
    ]);
    expect(body).not.toContain('thinking');
    expect(body).not.toContain('redacted_thinking');
    expect(body).toContain('"text":"hi"'); // the non-reasoning content still rides the wire
  });
});

describe('toAnthropicMessage — adjacent same-role merge (parallel tool results)', () => {
  it('folds two consecutive tool-result messages into one user message (no non-alternating 400)', async () => {
    const body = await captureBody([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'c1', name: 'a', args: {} },
          { type: 'tool_call', id: 'c2', name: 'b', args: {} },
        ],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c1', result: 'r1' }] },
      { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c2', result: 'r2' }] },
    ]);
    // The two adjacent tool (→user) messages merge into ONE user message: roles are [user, assistant,
    // user], i.e. exactly two user messages — not the three a 1:1 mapping would 400 on.
    expect((body.match(/"role":"user"/g) ?? []).length).toBe(2);
    expect(body).toContain('c1'); // both tool_result blocks survive in the single trailing user message
    expect(body).toContain('c2');
  });
});
