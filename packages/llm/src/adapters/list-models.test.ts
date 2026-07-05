import { describe, expect, it, vi } from 'vitest';

import { LlmProviderError, makeLlmError } from '../llm-error.js';
import type { ModelListing } from '../types.js';

import { createAnthropicAdapter, mapAnthropicModel } from './anthropic.js';
import { mapGeminiModel } from './gemini.js';
import { keepOpenAiModelId, pricedModelIdsFor } from './openai.js';
import {
  assertListModelsShape,
  boundedListModels,
  positiveModelInt,
  redactKey,
  toModelListing,
} from './shared.js';

/**
 * Unit tests for the ADR-0064 `listModels` mapping/filter helpers + the shared bounded/secret-free
 * substrate. The end-to-end SDK-parse path is covered by the conformance suite (recorded fixtures); these
 * pin the pure helpers directly and the harder-to-record robustness paths (pagination, timeout, redaction).
 */

describe('positiveModelInt', () => {
  it('keeps a finite positive integer and omits everything else', () => {
    expect(positiveModelInt(128_000)).toBe(128_000);
    expect(positiveModelInt(0)).toBeUndefined(); // 0 = "unknown" (Anthropic) → OMITTED
    expect(positiveModelInt(-5)).toBeUndefined();
    expect(positiveModelInt(1.5)).toBeUndefined();
    expect(positiveModelInt(null)).toBeUndefined();
    expect(positiveModelInt(undefined)).toBeUndefined();
    expect(positiveModelInt('100')).toBeUndefined();
    expect(positiveModelInt(Number.NaN)).toBeUndefined();
  });
});

describe('redactKey', () => {
  it('masks every occurrence of the key and is a no-op for an empty key', () => {
    expect(redactKey('failed for sk-abc and sk-abc again', 'sk-abc')).toBe(
      'failed for •••• and •••• again',
    );
    expect(redactKey('no secret here', '')).toBe('no secret here'); // empty key → unchanged
  });
});

describe('toModelListing', () => {
  it('validates a candidate and drops one with no id (strict outbound)', () => {
    expect(toModelListing({ id: 'gpt-5.5' })).toEqual({ id: 'gpt-5.5' });
    expect(toModelListing({ id: '' })).toBeUndefined(); // min(1) → dropped
    expect(toModelListing({ id: 'x', contextWindowTokens: 0 })).toBeUndefined(); // .positive() → dropped
  });
});

describe('mapAnthropicModel', () => {
  it('maps the rich shape and omits a 0/absent limit', () => {
    expect(
      mapAnthropicModel({
        id: 'claude-opus-4-8',
        display_name: 'Claude Opus 4.8',
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
      }),
    ).toEqual({
      id: 'claude-opus-4-8',
      displayName: 'Claude Opus 4.8',
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
    });
    // 0 (Anthropic's "unknown") → the limit fields are OMITTED, but the row is still listed.
    expect(
      mapAnthropicModel({ id: 'm', display_name: 'M', max_input_tokens: 0, max_tokens: 0 }),
    ).toEqual({ id: 'm', displayName: 'M' });
  });

  it('drops an id-less row and ignores unknown/extra vendor fields', () => {
    expect(mapAnthropicModel({ display_name: 'No Id' })).toBeUndefined();
    // Extra fields (a `capabilities` object, a future field) are lenient-inbound ignored.
    const withExtra = { id: 'm', display_name: 'M', capabilities: { foo: true } } as unknown as {
      id?: string;
      display_name?: string | null;
    };
    expect(mapAnthropicModel(withExtra)).toEqual({ id: 'm', displayName: 'M' });
  });
});

describe('mapGeminiModel', () => {
  it('keeps a generateContent model, strips the models/ prefix, maps the limits', () => {
    expect(
      mapGeminiModel({
        name: 'models/gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        inputTokenLimit: 1_048_576,
        outputTokenLimit: 65_536,
        supportedActions: ['generateContent', 'countTokens'],
      }),
    ).toEqual({
      id: 'gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 65_536,
    });
  });

  it('filters out a non-chat model and drops a name-less row', () => {
    expect(
      mapGeminiModel({ name: 'models/text-embedding-004', supportedActions: ['embedContent'] }),
    ).toBeUndefined();
    expect(mapGeminiModel({ supportedActions: undefined })).toBeUndefined(); // no supportedActions
    expect(
      mapGeminiModel({ displayName: 'No Name', supportedActions: ['generateContent'] }),
    ).toBeUndefined(); // chat-capable but no id
  });
});

describe('keepOpenAiModelId / pricedModelIdsFor', () => {
  it('keeps the chat families and denies the non-chat ones', () => {
    const none = new Set<string>();
    for (const id of ['gpt-5.5', 'gpt-5.4-mini', 'o3', 'chatgpt-4o-latest', 'deepseek-chat']) {
      expect(keepOpenAiModelId(id, none)).toBe(true);
    }
    for (const id of [
      'text-embedding-3-large',
      'gpt-image-1', // deny wins over the gpt allow-family
      'whisper-1',
      'tts-1',
      'gpt-4o-realtime-preview',
      'omni-moderation-latest',
      'gpt-4o-audio-preview',
      'ft:gpt-4o:acme',
    ]) {
      expect(keepOpenAiModelId(id, none)).toBe(false);
    }
  });

  it('unions-in a priced id even if the family heuristic would miss it', () => {
    const priced = new Set(['weird-priced-model']);
    expect(keepOpenAiModelId('weird-priced-model', priced)).toBe(true);
    expect(keepOpenAiModelId('weird-priced-model', new Set())).toBe(false);
  });

  it('pins priced-beats-DENY ordering and the FIX A/B boundary denies', () => {
    const none = new Set<string>();
    // A priced id that also matches a DENY token is KEPT (cost-eligibility wins); unpriced → dropped.
    expect(keepOpenAiModelId('gpt-4o-audio-x', new Set(['gpt-4o-audio-x']))).toBe(true);
    expect(keepOpenAiModelId('gpt-4o-audio-x', none)).toBe(false);
    // FIX A: `search` denies only on a `-`/`_` segment boundary, so deep-research reasoning models survive
    // (re**search** is not a `search` segment) while `-search-` is still denied.
    expect(keepOpenAiModelId('o3-deep-research', none)).toBe(true);
    expect(keepOpenAiModelId('o4-mini-deep-research', none)).toBe(true);
    expect(keepOpenAiModelId('gpt-4o-search-preview', none)).toBe(false);
    // FIX B: non-chat completion families denied (they otherwise pass the gpt/deepseek allow-family).
    expect(keepOpenAiModelId('gpt-3.5-turbo-instruct', none)).toBe(false);
    expect(keepOpenAiModelId('deepseek-ocr', none)).toBe(false);
    expect(keepOpenAiModelId('davinci-002', none)).toBe(false);
    expect(keepOpenAiModelId('babbage-002', none)).toBe(false);
  });

  it('pricedModelIdsFor returns only that provider s ids', () => {
    const openai = pricedModelIdsFor('openai');
    const deepseek = pricedModelIdsFor('deepseek');
    expect(openai.has('gpt-5.5')).toBe(true);
    expect(openai.has('deepseek-chat')).toBe(false);
    expect(deepseek.has('deepseek-chat')).toBe(true);
    expect(deepseek.has('gpt-5.5')).toBe(false);
  });
});

// A minimal 2-page Anthropic /v1/models sequence — proves the SDK paginator is iterated (has_more/last_id).
function page(id: string, hasMore: boolean): string {
  return JSON.stringify({
    data: [
      {
        id,
        type: 'model',
        display_name: id.toUpperCase(),
        created_at: '2026-01-01T00:00:00Z',
        max_input_tokens: 1_000,
        max_tokens: 500,
        capabilities: null,
      },
    ],
    has_more: hasMore,
    first_id: id,
    last_id: id,
  });
}

describe('Anthropic listModels — pagination', () => {
  it('follows has_more/last_id across pages and returns every mapped row', async () => {
    const bodies = [page('m1', true), page('m2', false)];
    let call = 0;
    const fetchSeq = (): Promise<Response> => {
      const body = bodies[Math.min(call, bodies.length - 1)];
      call += 1;
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    };
    const adapter = createAnthropicAdapter({ fetch: fetchSeq, maxRetries: 0 });
    const listings = await (adapter.listModels?.('key') ?? Promise.resolve([]));
    expect(listings.map((l) => l.id)).toEqual(['m1', 'm2']);
    expect(call).toBeGreaterThanOrEqual(2); // two page fetches
  });
});

describe('assertListModelsShape (ADR-0064 §8)', () => {
  it('throws a bad_request LlmProviderError only when rows exist, none are kept, and some broke shape', () => {
    // The one throwing case: a systemic id-removal (every row shape-broken).
    let caught: unknown;
    try {
      assertListModelsShape('anthropic', { rawCount: 2, kept: 0, droppedForShape: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmProviderError);
    if (caught instanceof LlmProviderError) {
      expect(caught.llmError.kind).toBe('bad_request');
      expect(caught.llmError.provider).toBe('anthropic');
    }
  });

  it('returns normally for an empty list, an all-content-filtered list, and a partial-drop list', () => {
    // A well-formed EMPTY list (no rows) is a genuine [] — never a throw.
    expect(() =>
      assertListModelsShape('openai', { rawCount: 0, kept: 0, droppedForShape: 0 }),
    ).not.toThrow();
    // Every row content-filtered but shape-valid (droppedForShape 0) is a genuine [] — never a throw.
    expect(() =>
      assertListModelsShape('openai', { rawCount: 3, kept: 0, droppedForShape: 0 }),
    ).not.toThrow();
    // At least one row kept — never a throw, whatever was dropped.
    expect(() =>
      assertListModelsShape('gemini', { rawCount: 3, kept: 1, droppedForShape: 2 }),
    ).not.toThrow();
  });
});

/** A single-page Anthropic `/v1/models` body from raw row objects (a row may be `null` to exercise the
 *  per-row non-object drop). Serves one 200 response through the adapter's injected fetch. */
function anthropicModelsFetch(rows: readonly unknown[]): () => Promise<Response> {
  const body = JSON.stringify({ data: rows, has_more: false, first_id: null, last_id: null });
  return () =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
}

describe('listModels — per-row drop + systemic drift (ADR-0064 §8, FIX C/D)', () => {
  it('drops a single non-object (null) row and still resolves the valid rows (FIX C)', async () => {
    const validRow = {
      id: 'claude-opus-4-8',
      type: 'model',
      display_name: 'Claude Opus 4.8',
      created_at: '2026-01-01T00:00:00Z',
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      capabilities: null,
    };
    // A `null` row would THROW a TypeError if dereferenced in the mapper — the isRecord guard drops it.
    const adapter = createAnthropicAdapter({
      fetch: anthropicModelsFetch([validRow, null]),
      maxRetries: 0,
    });
    const listings = await (adapter.listModels?.('key') ?? Promise.resolve([]));
    expect(listings.map((l) => l.id)).toEqual(['claude-opus-4-8']);
  });

  it('rejects bad_request when every row lacks a usable id — never a silent [] (FIX D)', async () => {
    const key = 'sk-live-secret-abcdefghijklmnop';
    const adapter = createAnthropicAdapter({
      // Two rows, each id-less → rawCount 2, kept 0, droppedForShape 2 → the systemic-drift throw.
      fetch: anthropicModelsFetch([
        { type: 'model', display_name: 'No Id A', created_at: '2026-01-01T00:00:00Z' },
        { type: 'model', display_name: 'No Id B', created_at: '2026-01-01T00:00:00Z' },
      ]),
      maxRetries: 0,
    });
    let caught: unknown;
    try {
      await (adapter.listModels?.(key) ?? Promise.resolve([]));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmProviderError);
    if (caught instanceof LlmProviderError) {
      expect(caught.llmError.kind).toBe('bad_request');
      expect(caught.llmError.message).not.toContain(key); // redacted on the re-wrap
      expect(caught.llmError.cause).toBeUndefined();
    }
  });

  it('resolves [] for a well-formed EMPTY list — never a throw (FIX D)', async () => {
    const adapter = createAnthropicAdapter({ fetch: anthropicModelsFetch([]), maxRetries: 0 });
    const listings = await (adapter.listModels?.('key') ?? Promise.resolve([]));
    expect(listings).toEqual([]);
  });
});

describe('boundedListModels', () => {
  it('rejects with a classified timeout when collect never settles', async () => {
    const result = boundedListModels({
      provider: 'gemini',
      key: 'k',
      signal: undefined,
      classify: () => makeLlmError({ provider: 'gemini', kind: 'unknown', message: 'unused' }),
      collect: () => new Promise<ModelListing[]>(() => undefined), // never settles
      timeoutMs: 20,
    });
    await expect(result).rejects.toBeInstanceOf(LlmProviderError);
    await expect(result).rejects.toMatchObject({ llmError: { kind: 'timeout', retryable: true } });
  });

  it('redacts the key and attaches no cause on a failed collect (ADR-0064 §3)', async () => {
    const key = 'sk-supersecret-abcdefghijklmnop';
    const result = boundedListModels({
      provider: 'openai',
      key,
      signal: undefined,
      classify: (err) =>
        makeLlmError({
          provider: 'openai',
          kind: 'auth',
          message: err instanceof Error ? err.message : 'x',
          cause: err, // a classifier that (wrongly) carried a cause must still be stripped
        }),
      collect: () => Promise.reject(new Error(`401 for ${key}`)),
    });
    let caught: unknown;
    try {
      await result;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmProviderError);
    if (caught instanceof LlmProviderError) {
      expect(caught.llmError.kind).toBe('auth');
      expect(caught.llmError.message).not.toContain(key);
      expect(caught.llmError.message).not.toContain('supersecret');
      expect(caught.llmError.cause).toBeUndefined(); // no cause can carry the key/raw payload across the seam
    }
  });

  it('cancels via an already-aborted caller signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = boundedListModels({
      provider: 'anthropic',
      key: 'k',
      signal: controller.signal,
      classify: () =>
        makeLlmError({ provider: 'anthropic', kind: 'cancelled', message: 'aborted' }),
      collect: (signal) =>
        new Promise<ModelListing[]>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('aborted'));
          }
        }),
    });
    await expect(result).rejects.toMatchObject({ llmError: { kind: 'cancelled' } });
  });

  it('the hard timeout ABORTS the in-flight collect via the threaded signal (FIX H)', async () => {
    // The collect settles ONLY when its threaded signal fires — so a passing result proves the timeout
    // path actually called controller.abort() (deleting it would leave the collect pending; the flag would
    // stay false). Closes the mutation hole the old "collect ignores its signal" timeout test left open.
    let collectAborted = false;
    const result = boundedListModels({
      provider: 'gemini',
      key: 'k',
      signal: undefined,
      classify: () => makeLlmError({ provider: 'gemini', kind: 'unknown', message: 'unused' }),
      collect: (signal) =>
        new Promise<ModelListing[]>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            collectAborted = true;
            reject(new Error('aborted-by-timeout'));
          });
        }),
      timeoutMs: 20,
    });
    await expect(result).rejects.toBeInstanceOf(LlmProviderError);
    await expect(result).rejects.toMatchObject({ llmError: { kind: 'timeout' } });
    expect(collectAborted).toBe(true);
  });

  it('propagates a MID-FLIGHT caller abort to the threaded collect signal (FIX I)', async () => {
    const controller = new AbortController(); // NOT yet aborted → exercises the addEventListener branch
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const result = boundedListModels({
      provider: 'anthropic',
      key: 'k',
      signal: controller.signal,
      classify: () =>
        makeLlmError({ provider: 'anthropic', kind: 'cancelled', message: 'aborted' }),
      collect: (signal) =>
        new Promise<ModelListing[]>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await Promise.resolve(); // let boundedListModels install its listener before we abort
    controller.abort();
    await expect(result).rejects.toMatchObject({ llmError: { kind: 'cancelled' } });
    expect(removeSpy).toHaveBeenCalled(); // the caller-signal listener is detached on settle (finally)
  });

  it('passes a pre-classified LlmProviderError THROUGH with its kind (FIX D drift path)', async () => {
    const key = 'sk-drift-secret-abcdefghijklmnop';
    const result = boundedListModels({
      provider: 'openai',
      key,
      signal: undefined,
      // classify would (wrongly) flatten to `unknown` — proving the pre-classified error is NOT reclassified.
      classify: () =>
        makeLlmError({ provider: 'openai', kind: 'unknown', message: 'should-not-win' }),
      collect: () =>
        Promise.reject(
          new LlmProviderError(
            makeLlmError({
              provider: 'openai',
              kind: 'bad_request',
              message: `model list shape unexpected for ${key}`,
            }),
          ),
        ),
    });
    let caught: unknown;
    try {
      await result;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmProviderError);
    if (caught instanceof LlmProviderError) {
      expect(caught.llmError.kind).toBe('bad_request'); // kept, not reclassified to `unknown`
      expect(caught.llmError.message).not.toContain(key); // still redacted on the re-wrap
      expect(caught.llmError.cause).toBeUndefined();
    }
  });
});
