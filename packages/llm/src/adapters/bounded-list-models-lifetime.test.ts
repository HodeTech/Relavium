import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmInvocationOptions } from '../types.js';
import { makeLlmError } from '../llm-error.js';
import { boundedListModels } from './shared.js';
import type { AbortSignalLike } from '@relavium/shared';
import { LlmProviderError } from '../llm-error.js';

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

afterEach(() => {
  vi.useRealTimers();
});

describe('bounded model-list collector ownership', () => {
  it.each([false, true])(
    'keeps caller cancellation primary through SDK and cleanup refusal (already stopped=%s)',
    async (alreadyStopped) => {
      const stop = new AbortController();
      if (alreadyStopped) stop.abort();
      const classify = vi.fn(() =>
        makeLlmError({ provider: 'anthropic', kind: 'unknown', message: 'SDK abort differs' }),
      );
      const removal = vi.spyOn(stop.signal, 'removeEventListener').mockImplementation(() => {
        throw new Error('private listener cleanup refusal');
      });
      const outcome = boundedListModels({
        provider: 'anthropic',
        key: 'synthetic',
        signal: stop.signal,
        classify,
        collect: (signal) =>
          new Promise((_resolve, reject) => {
            const refuse = () => reject(new Error('private SDK abort'));
            if (signal.aborted) refuse();
            else signal.addEventListener('abort', refuse, { once: true });
          }),
      });
      if (!alreadyStopped) stop.abort();
      await expect(outcome).rejects.toMatchObject({
        message: 'model list cancelled',
        llmError: { kind: 'cancelled', retryable: false },
      });
      expect(classify).not.toHaveBeenCalled();
      expect(removal).toHaveBeenCalledOnce();
    },
  );

  it('keeps the hard timeout primary when abort also reaches the caller signal', async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const outcome = boundedListModels({
      provider: 'gemini',
      key: 'synthetic',
      signal: stop.signal,
      classify: () => makeLlmError({ provider: 'gemini', kind: 'unknown', message: 'unused' }),
      collect: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              stop.abort();
              reject(new Error('private SDK abort'));
            },
            { once: true },
          );
        }),
    }).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await outcome).toMatchObject({ llmError: { kind: 'timeout', retryable: true } });
    expect(stop.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans an attempted host listener and empty aggregate after partial setup refuses', async () => {
    const parent = owner();
    const cause = new Error('private listener setup');
    let attached = false;
    const remove = vi.fn(() => {
      attached = false;
    });
    const signal: AbortSignalLike = {
      aborted: false,
      addEventListener: () => {
        attached = true;
        throw cause;
      },
      removeEventListener: remove,
    };
    const collect = vi.fn(() => Promise.resolve([]));
    await expect(
      boundedListModels({
        provider: 'openai',
        key: 'synthetic',
        signal,
        options: parent.options,
        collect,
        classify: () => makeLlmError({ provider: 'openai', kind: 'unknown', message: 'fixed' }),
      }),
    ).rejects.toBe(cause);
    expect(remove).toHaveBeenCalledOnce();
    expect(attached).toBe(false);
    expect(collect).not.toHaveBeenCalled();
    await Promise.all(parent.raw);
  });

  it.each([false, true])(
    'attempts retirement while caller cleanup refuses (primary=%s)',
    async (primary) => {
      const parent = owner();
      const cause = new Error('private caller cleanup');
      const stop = new AbortController();
      const removal = vi.spyOn(stop.signal, 'removeEventListener').mockImplementation(() => {
        throw cause;
      });
      try {
        const outcome = await boundedListModels({
          provider: 'openai',
          key: 'synthetic',
          signal: stop.signal,
          options: parent.options,
          collect: () =>
            primary
              ? Promise.reject(
                  new LlmProviderError(
                    makeLlmError({
                      provider: 'openai',
                      kind: 'auth',
                      message: 'fixed provider refusal',
                    }),
                  ),
                )
              : Promise.resolve([]),
          classify: () => makeLlmError({ provider: 'openai', kind: 'unknown', message: 'fixed' }),
        }).catch((error: unknown) => error);
        expect(outcome).toMatchObject({ llmError: { kind: primary ? 'auth' : 'unknown' } });
        if (outcome instanceof LlmProviderError) {
          expect(outcome.llmError.cause).toBeUndefined();
          expect(outcome.message).not.toContain('private caller cleanup');
        }
        expect(removal).toHaveBeenCalledOnce();
        await Promise.all(parent.raw);
      } finally {
        removal.mockRestore();
      }
    },
  );

  it('joins empty synchronous collector refusal without leaving its timer or original owner pending', async () => {
    vi.useFakeTimers();
    const parent = owner();
    await expect(
      boundedListModels({
        provider: 'openai',
        key: 'synthetic',
        signal: undefined,
        options: parent.options,
        collect: () => {
          throw new Error('private synchronous SDK entry');
        },
        classify: () =>
          makeLlmError({ provider: 'openai', kind: 'auth', message: 'fixed entry refusal' }),
      }),
    ).rejects.toMatchObject({ llmError: { kind: 'auth' } });
    await Promise.all(parent.raw);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('transfers original ownership before a successful collector enters', async () => {
    const parent = owner();
    const collect = vi.fn(() => Promise.resolve([]));
    const result = boundedListModels({
      provider: 'openai',
      key: 'synthetic',
      signal: undefined,
      options: parent.options,
      collect,
      classify: () => makeLlmError({ provider: 'openai', kind: 'unknown', message: 'fixed' }),
    });
    try {
      expect(parent.raw.length, 'BOUNDED_DISCOVERY_OWNER_TRANSFER').toBe(1);
      expect(await result).toEqual([]);
      expect(collect).toHaveBeenCalledOnce();
    } finally {
      await result;
      await Promise.all(parent.raw);
    }
  });
  it('retains a collector independently of a shorter public result and joins late rejection', async () => {
    vi.useFakeTimers();
    const parent = owner();
    let reject: (cause: unknown) => void = () => undefined;
    const raw = new Promise<never>((_yes, no) => {
      reject = no;
    });
    const classified = vi.fn(() =>
      makeLlmError({ provider: 'openai', kind: 'unknown', message: 'fixed' }),
    );
    const outcome = boundedListModels({
      provider: 'openai',
      key: 'synthetic',
      signal: undefined,
      options: parent.options,
      classify: classified,
      collect: () => raw,
    }).catch((cause: unknown) => cause);
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await outcome).toMatchObject({ llmError: { kind: 'timeout' } });
      let complete = false;
      void Promise.all(parent.raw).then(() => {
        complete = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(complete, 'DISCOVERY_RETAINS_EXACT_COLLECT').toBe(false);
      reject(new Error('late synthetic rejection'));
      await Promise.all(parent.raw);
      expect(complete).toBe(true);
      expect(classified).not.toHaveBeenCalled();
    } finally {
      reject(new Error('fixture release'));
      await outcome;
      await Promise.all(parent.raw);
    }
  });

  it('refuses an opaque original-owner transfer before SDK construction or classification', async () => {
    let reflected = 0;
    const cause = new Proxy(new Error('opaque host refusal'), {
      get() {
        reflected += 1;
        throw new Error('reflection');
      },
      getPrototypeOf() {
        reflected += 1;
        throw new Error('reflection');
      },
    });
    const collect = vi.fn(() => Promise.resolve([]));
    const classify = vi.fn(() =>
      makeLlmError({ provider: 'openai', kind: 'unknown', message: 'fixed' }),
    );
    let actual: unknown;
    try {
      await boundedListModels({
        provider: 'openai',
        key: 'synthetic',
        signal: undefined,
        options: {
          retainWork: () => {
            throw cause;
          },
        },
        collect,
        classify,
      });
    } catch (error) {
      actual = error;
    }
    expect(Object.is(actual, cause)).toBe(true);
    expect(reflected).toBe(0);
    expect(collect).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });
});
