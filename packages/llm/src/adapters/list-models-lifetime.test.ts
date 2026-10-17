import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmInvocationOptions, LlmProvider } from '../types.js';
import { LlmProviderError } from '../llm-error.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createGeminiAdapter, type GeminiTransport } from './gemini.js';
import { createOpenAiAdapter } from './openai.js';
import type { ProviderFetch } from './invocation-work.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function owner() {
  const raw: Promise<unknown>[] = [];
  const options: LlmInvocationOptions = {
    retainWork: (factory) => {
      const pending = factory();
      raw.push(pending);
      return pending;
    },
  };
  return { raw, options };
}
function list(provider: LlmProvider, options: LlmInvocationOptions, signal?: AbortSignal) {
  if (provider.listModels === undefined) throw new Error('missing discovery capability');
  return provider.listModels('synthetic-discovery-key', signal, options);
}
const dialects = [
  {
    name: 'openai',
    create: (fetch: ProviderFetch) => createOpenAiAdapter({ fetch }),
    body: { object: 'list', data: [] },
  },
  {
    name: 'deepseek',
    create: (fetch: ProviderFetch) => createOpenAiAdapter({ fetch, providerId: 'deepseek' }),
    body: { object: 'list', data: [] },
  },
  {
    name: 'anthropic',
    create: (fetch: ProviderFetch) => createAnthropicAdapter({ fetch }),
    body: { data: [], has_more: false },
  },
  {
    name: 'gemini',
    create: (fetch: ProviderFetch) => {
      vi.stubGlobal('fetch', fetch);
      return createGeminiAdapter();
    },
    body: { models: [] },
  },
];
const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('discovery result versus original invocation retirement', () => {
  it('transfers explicit Gemini transport descendants independently of the returned list', async () => {
    const parent = owner();
    const nativeClose = deferred<void>();
    let transferred = false;
    const unused = () => Promise.reject(new Error('unused transport operation'));
    const transport: GeminiTransport = {
      generate: unused,
      stream: unused,
      generateImages: unused,
      generateVideos: unused,
      pollVideo: unused,
      listModels: (_key, _signal, options) => {
        if (options !== undefined) {
          transferred = true;
          void options.retainWork(() => nativeClose.promise);
        }
        return Promise.resolve([]);
      },
    };
    try {
      expect(await list(createGeminiAdapter({ transport }), parent.options)).toEqual([]);
      let retired = false;
      void Promise.all(parent.raw).then(() => {
        retired = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(transferred, 'GEMINI_DISCOVERY_FORWARDS_TRANSPORT_WORK').toBe(true);
      expect(retired).toBe(false);
      nativeClose.resolve();
      await Promise.all(parent.raw);
      expect(retired).toBe(true);
    } finally {
      nativeClose.resolve();
      await Promise.all(parent.raw);
    }
  });

  it.each(dialects)(
    '$name preserves ordinary owned discovery and actual retirement',
    async ({ create, body }) => {
      const parent = owner();
      let registeredBeforeFetch = false;
      const provider = create(() => {
        registeredBeforeFetch = parent.raw.length === 1;
        return Promise.resolve(jsonResponse(body));
      });
      expect(await list(provider, parent.options)).toEqual([]);
      expect(registeredBeforeFetch).toBe(true);
      await Promise.all(parent.raw);
      expect(parent.raw).toHaveLength(1);
    },
  );

  it.each(dialects)(
    '$name retains the real installed SDK collect past the unchanged public timeout',
    async ({ create, body }) => {
      vi.useFakeTimers();
      const parent = owner();
      const response = deferred<Response>();
      const entered = deferred<void>();
      const provider = create(() => {
        entered.resolve();
        return response.promise;
      });
      const outcome = list(provider, parent.options).then(
        (value) => ({ value }),
        (cause: unknown) => ({ cause }),
      );
      let retired = false;
      try {
        await entered.promise;
        void Promise.all(parent.raw).then(() => {
          retired = true;
        });
        await vi.advanceTimersByTimeAsync(15_000);
        const result = await outcome;
        expect(result).toMatchObject({ cause: { llmError: { kind: 'timeout' } } });
        if ('cause' in result && result.cause instanceof LlmProviderError) {
          expect(result.cause.llmError.cause).toBeUndefined();
          expect(result.cause.message).not.toContain('synthetic-discovery-key');
        }
        expect(parent.raw.length, 'DISCOVERY_REGISTERED_BEFORE_SDK_ENTRY').toBe(1);
        expect(retired, 'DISCOVERY_TIMEOUT_DOES_NOT_RETIRE_RAW_COLLECT').toBe(false);
        response.resolve(jsonResponse(body));
        await Promise.all(parent.raw);
        expect(retired).toBe(true);
      } finally {
        response.resolve(jsonResponse(body));
        await outcome;
        await Promise.all(parent.raw);
      }
    },
  );

  it.each(dialects.filter(({ name }) => name !== 'gemini'))(
    '$name retains native descendants after successful SDK collection',
    async ({ create, body }) => {
      const parent = owner();
      const nativeClose = deferred<void>();
      let transferred = false;
      const provider = create((_input, _init, work) => {
        if (work !== undefined) {
          transferred = true;
          void work.retainWork(() => nativeClose.promise);
        }
        return Promise.resolve(jsonResponse(body));
      });
      let retired = false;
      try {
        expect(await list(provider, parent.options)).toEqual([]);
        void Promise.all(parent.raw).then(() => {
          retired = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(transferred, 'DISCOVERY_CLIENT_FORWARDS_TRANSITIVE_WORK').toBe(true);
        expect(retired, 'DISCOVERY_SUCCESS_IS_NOT_NATIVE_CLOSE_ACK').toBe(false);
        nativeClose.resolve();
        await Promise.all(parent.raw);
        expect(retired).toBe(true);
      } finally {
        nativeClose.resolve();
        await Promise.all(parent.raw);
      }
    },
  );

  it.each(dialects)(
    '$name refuses SDK entry for an already-stopped owned request',
    async ({ create }) => {
      const parent = owner();
      const fetch = vi.fn(() => Promise.resolve(jsonResponse({})));
      const stop = new AbortController();
      stop.abort();
      await expect(list(create(fetch), parent.options, stop.signal)).rejects.toBeInstanceOf(
        LlmProviderError,
      );
      expect(fetch).not.toHaveBeenCalled();
      await Promise.all(parent.raw);
    },
  );
});
