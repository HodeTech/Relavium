import { describe, expect, it } from 'vitest';
import { CostTracker } from './cost-tracker.js';
import { ProviderInvocationWork } from './adapters/invocation-work.js';
import { FallbackChain, type AttemptRecord, type FallbackChainOptions } from './fallback-chain.js';
import { LlmProviderError, makeLlmError } from './llm-error.js';
import type {
  LlmProvider,
  LlmRequest,
  LlmResult,
  StreamChunk,
  LlmInvocationOptions,
} from './types.js';

// Deliberate arbitrary host throwable: its exact identity is the regression oracle.
function throwHostFailure(original: unknown): never {
  throw original;
}

function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await Promise.resolve();
  }
  expect.fail('producer transition did not complete');
}
function tracking() {
  const pending = new Set<Promise<unknown>>();
  const captured: Promise<unknown>[] = [];
  const retain: NonNullable<FallbackChainOptions['retainWork']> = <T>(
    factory: () => Promise<T>,
  ) => {
    const raw = factory();
    captured.push(raw);
    pending.add(raw);
    void raw.then(
      () => pending.delete(raw),
      () => pending.delete(raw),
    );
    return raw;
  };
  return { pending, captured, retain };
}
function timer() {
  const callbacks = new Set<() => void>();
  return {
    set: (_ms: number, callback: () => void): (() => void) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    fire: () => {
      for (const callback of [...callbacks]) {
        callbacks.delete(callback);
        callback();
      }
    },
  };
}
const request: LlmRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'offline' }] }],
};
const result: LlmResult = {
  content: [{ type: 'text', text: 'done' }],
  stopReason: 'stop',
  usage: { inputTokens: 3, outputTokens: 2 },
};
const stop: StreamChunk = { type: 'stop', stopReason: 'stop', usage: result.usage };
function source(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: 'openai',
    supports: {
      tools: true,
      streaming: true,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
      reasoning: false,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [],
      },
    },
    generate: () => Promise.resolve(result),
    stream: async function* () {
      await Promise.resolve();
      yield stop;
    },
    ...overrides,
  };
}
function chain(provider: LlmProvider, options: Partial<FallbackChainOptions> = {}): FallbackChain {
  return new FallbackChain([{ provider, model: 'gpt-4o', maxAttempts: 1 }], {
    keyFor: () => 'offline-placeholder',
    sleep: () => Promise.resolve(),
    ...options,
  });
}
async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const output: StreamChunk[] = [];
  for await (const chunk of chunks) output.push(chunk);
  return output;
}

describe('exact producer lifetime before bounded wrappers (ADR-0103)', () => {
  it('retains the exact generation promise past timeout with one authoritative attempt', async () => {
    const raw = latch<LlmResult>();
    const entered = latch<void>();
    const tracked = tracking();
    const clock = timer();
    const records: AttemptRecord[] = [];
    const p = source({
      generate: () => {
        entered.resolve();
        return raw.promise;
      },
    });
    const running = chain(p, {
      retainWork: tracked.retain,
      onAttempt: (r) => records.push(r),
      newAbortController: () => new AbortController(),
      setTimer: clock.set,
    }).generate(request);
    const failed = expect(running).rejects.toMatchObject({ llmError: { kind: 'timeout' } });
    try {
      await entered.promise;
      expect(tracked.captured).toHaveLength(2); // Invocation aggregate plus the exact raw generation.
      expect(tracked.captured).toContain(raw.promise);
      clock.fire();
      await failed;
      expect(tracked.pending.has(raw.promise)).toBe(true);
      expect(records).toHaveLength(1);
      expect(records[0]?.providerInvoked).toBe(true);
      raw.resolve(result);
      await until(() => tracked.pending.size === 0);
      expect(records).toHaveLength(1); // Lifetime completion creates no second money observation.
    } finally {
      clock.fire();
      raw.resolve(result);
      await running.catch(() => undefined);
      await until(() => tracked.pending.size === 0);
    }
  });

  it('refuses a host entry before generation without laundering its identity or retrying', async () => {
    const sentinel = Object.freeze({ marker: 'host-entry' });
    let calls = 0;
    const records: AttemptRecord[] = [];
    const p = source({
      generate: () => {
        calls++;
        return Promise.resolve(result);
      },
    });
    await expect(
      chain(p, {
        retainWork: () => {
          throwHostFailure(sentinel);
        },
        onAttempt: (r) => records.push(r),
      }).generate(request),
    ).rejects.toBe(sentinel);
    expect(calls).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.providerInvoked).toBe(false);
    expect(records[0]?.error?.message).toBe('host work registration failed');
  });

  it('refuses a host entry before constructing the first stream or observing egress', async () => {
    const sentinel = Object.freeze({ marker: 'first-stream-entry' });
    let calls = 0;
    const records: AttemptRecord[] = [];
    const p = source({
      stream: () => {
        calls++;
        return {
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield stop;
          },
        };
      },
    });
    await expect(
      collect(
        chain(p, {
          retainWork: () => {
            throwHostFailure(sentinel);
          },
          onAttempt: (r) => records.push(r),
        }).stream(request),
      ),
    ).rejects.toBe(sentinel);
    expect(calls).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.providerInvoked).toBe(false);
    expect(records[0]?.error?.message).toBe('host work registration failed');
  });

  it.each([false, true])(
    'synchronous stream construction remains a provider fault (retainer=%s)',
    async (retained) => {
      const original = new LlmProviderError(
        makeLlmError({ provider: 'openai', kind: 'bad_request', message: 'stream refused' }),
      );
      let calls = 0;
      const records: AttemptRecord[] = [];
      const p = source({
        stream: () => {
          calls++;
          throw original;
        },
      });
      const chunks = await collect(
        chain(p, {
          ...(retained ? { retainWork: tracking().retain } : {}),
          onAttempt: (r) => records.push(r),
        }).stream(request),
      );
      expect(chunks).toMatchObject([
        {
          type: 'error',
          error: { kind: 'bad_request', message: 'stream refused' },
        },
      ]);
      expect(calls).toBe(1);
      expect(records).toHaveLength(1);
      expect(records[0]?.providerInvoked).toBe(true);
    },
  );

  it.each([false, true])(
    'a synchronous provider fault keeps its provider classification (retainer=%s)',
    async (retained) => {
      const original = new LlmProviderError(
        makeLlmError({ provider: 'openai', kind: 'bad_request', message: 'provider refused' }),
      );
      let calls = 0;
      const records: AttemptRecord[] = [];
      const p = source({
        generate: () => {
          calls++;
          throw original;
        },
      });
      await expect(
        chain(p, {
          ...(retained ? { retainWork: tracking().retain } : {}),
          onAttempt: (r) => records.push(r),
        }).generate(request),
      ).rejects.toMatchObject({ llmError: { kind: 'bad_request', message: 'provider refused' } });
      expect(calls).toBe(1);
      expect(records).toHaveLength(1);
      expect(records[0]?.providerInvoked).toBe(true);
    },
  );

  it('standalone callers without a retainer preserve generation and stream completion', async () => {
    expect(await chain(source()).generate(request)).toEqual(result);
    expect(await collect(chain(source()).stream(request))).toEqual([stop]);
  });

  it('keeps blocked next and both queued return promises owed after stream timeout', async () => {
    const read = latch<void>();
    const close = latch<void>();
    let closing = false;
    const tracked = tracking();
    const clock = timer();
    const records: AttemptRecord[] = [];
    const p = source({
      stream: async function* () {
        try {
          await read.promise;
          yield stop;
        } finally {
          closing = true;
          await close.promise;
        }
      },
    });
    const running = collect(
      chain(p, {
        retainWork: tracked.retain,
        onAttempt: (r) => records.push(r),
        newAbortController: () => new AbortController(),
        setTimer: clock.set,
      }).stream(request),
    );
    try {
      await until(() => tracked.pending.size === 2);
      clock.fire();
      const chunks = await running;
      expect(chunks.at(-1)).toMatchObject({ type: 'error', error: { kind: 'timeout' } });
      expect(tracked.captured).toHaveLength(4);
      expect(new Set(tracked.captured).size).toBe(4);
      expect(tracked.pending.size).toBe(4);
      expect(records).toHaveLength(1);
      read.resolve();
      await until(() => closing);
      expect(tracked.pending.size).toBe(4); // A begun cleanup is not a completion acknowledgement.
      close.resolve();
      await until(() => tracked.pending.size === 0);
      expect(records).toHaveLength(1);
    } finally {
      clock.fire();
      read.resolve();
      close.resolve();
      await running;
      await until(() => tracked.pending.size === 0);
    }
  });

  it('retains next and final return also when no deadline port was supplied', async () => {
    const tracked = tracking();
    expect(await collect(chain(source(), { retainWork: tracked.retain }).stream(request))).toEqual([
      stop,
    ]);
    expect(tracked.captured).toHaveLength(4); // Invocation aggregate, held terminal, EOF read, independent final return.
    await until(() => tracked.pending.size === 0);
  });

  it('the held terminal usage is accounted once when its confirming read times out', async () => {
    const tail = latch<void>();
    let confirming = false;
    const tracked = tracking();
    const clock = timer();
    const records: AttemptRecord[] = [];
    const p = source({
      stream: async function* () {
        yield stop;
        confirming = true;
        await tail.promise;
      },
    });
    const running = collect(
      chain(p, {
        retainWork: tracked.retain,
        onAttempt: (r) => records.push(r),
        newAbortController: () => new AbortController(),
        setTimer: clock.set,
      }).stream(request),
    );
    try {
      await until(() => confirming);
      clock.fire();
      await running;
      expect(records).toHaveLength(1);
      expect(records[0]?.usage).toEqual(result.usage);
      expect(tracked.pending.size).toBe(4);
      tail.resolve();
      await until(() => tracked.pending.size === 0);
      expect(records).toHaveLength(1);
    } finally {
      clock.fire();
      tail.resolve();
      await running;
      await until(() => tracked.pending.size === 0);
    }
  });

  it('a refused cleanup entry preserves an earlier provider diagnosis and its one record', async () => {
    const original = new LlmProviderError(
      makeLlmError({
        provider: 'openai',
        kind: 'bad_request',
        message: 'primary provider refusal',
      }),
    );
    const sentinel = Object.freeze({ marker: 'cleanup-entry' });
    const records: AttemptRecord[] = [];
    let entries = 0;
    const retain: NonNullable<FallbackChainOptions['retainWork']> = <T>(
      factory: () => Promise<T>,
    ) => {
      entries++;
      if (entries > 2) throwHostFailure(sentinel);
      return factory();
    };
    const p = source({
      stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(original) }) }),
    });
    const chunks = await collect(
      chain(p, { retainWork: retain, onAttempt: (r) => records.push(r) }).stream(request),
    );
    expect(chunks.at(-1)).toMatchObject({
      type: 'error',
      error: { kind: 'bad_request', message: 'primary provider refusal' },
    });
    expect(entries).toBe(3);
    expect(records).toHaveLength(1);
  });

  it('a cleanup-only host refusal preserves its exact cause after accounting known usage', async () => {
    const sentinel = Object.freeze({ marker: 'successful-cleanup-entry' });
    const records: AttemptRecord[] = [];
    let entries = 0;
    const retain: NonNullable<FallbackChainOptions['retainWork']> = <T>(
      factory: () => Promise<T>,
    ) => {
      entries++;
      if (entries === 4) throwHostFailure(sentinel);
      return factory();
    };
    await expect(
      collect(
        chain(source(), { retainWork: retain, onAttempt: (r) => records.push(r) }).stream(request),
      ),
    ).rejects.toBe(sentinel);
    expect(entries).toBe(4);
    expect(records).toHaveLength(1);
    expect(records[0]?.usage).toEqual(result.usage);
  });
});

for (const path of ['generate', 'stream'] as const)
  it(`hostile retainer cause needs no prototype reflection (${path})`, async () => {
    let reflection = 0;
    const original = new Proxy(new Error('private host cause'), {
      getPrototypeOf: () => {
        reflection++;
        throw new Error('reflection is forbidden');
      },
    });
    let calls = 0;
    const p = source({
      generate: () => {
        calls++;
        return Promise.resolve(result);
      },
      stream: () => {
        calls++;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true, value: undefined }),
          }),
        };
      },
    });
    const retained = chain(p, { retainWork: () => throwHostFailure(original) });
    await expect(
      path === 'generate' ? retained.generate(request) : collect(retained.stream(request)),
    ).rejects.toBe(original);
    expect(reflection).toBe(0);
    expect(calls).toBe(0); // Synchronous stream construction requires accepted lifetime entry.
  });

for (const afterStop of [false, true])
  it(`public iterator return preserves cleanup admission refusal after ${afterStop ? 'confirmed stop' : 'text'}`, async () => {
    const refusal = Object.freeze({ marker: 'return-cleanup-entry' });
    const records: AttemptRecord[] = [];
    let entries = 0;
    let nexts = 0;
    let providerCalls = 0;
    const yielded: StreamChunk = afterStop ? stop : { type: 'text_delta', text: 'partial' };
    const p = source({
      stream: () => {
        providerCalls++;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              Promise.resolve(
                ++nexts === 1 ? { done: false, value: yielded } : { done: true, value: undefined },
              ),
            return: () => Promise.resolve({ done: true, value: undefined }),
          }),
        };
      },
    });
    const iterator = chain(p, {
      retainWork: <T>(factory: () => Promise<T>): Promise<T> => {
        if (++entries === 3) throwHostFailure(refusal);
        return factory();
      },
      onAttempt: (record) => records.push(record),
    })
      .stream(request)
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done !== false) throw new Error('missing first stream chunk');
    expect(first.value.type).toBe(yielded.type);
    if (iterator.return === undefined) throw new Error('missing public iterator return');
    await expect(iterator.return()).rejects.toBe(refusal);
    expect(providerCalls).toBe(1);
    expect(entries).toBe(3);
    expect(records).toHaveLength(1);
    expect(records[0]?.providerInvoked).toBe(true);
    expect(records[0]?.usage).toEqual(afterStop ? result.usage : undefined);
  });

describe('custom provider invocation authority (ADR-0103)', () => {
  it.each(['generate', 'stream'] as const)(
    'retires %s authority before entering a fallback and retains earlier children',
    async (mode) => {
      const earlier = latch<void>();
      const fallback = latch<void>();
      const tracked = tracking();
      let saved: LlmInvocationOptions | undefined;
      let enteredFallback = false;
      let lateEntries = 0;
      const rejected = makeLlmError({
        provider: 'openai',
        kind: 'protocol',
        message: 'offline refusal',
      });
      const first = source({
        generate: (_req, _key, work) => {
          saved = work;
          void work?.retainWork(() => earlier.promise);
          return Promise.reject(new LlmProviderError(rejected));
        },
        stream: (_req, _key, work) => {
          saved = work;
          void work?.retainWork(() => earlier.promise);
          return {
            async *[Symbol.asyncIterator]() {
              yield Promise.resolve({ type: 'error', error: rejected } satisfies StreamChunk);
            },
          };
        },
      });
      const second = source({
        generate: async () => {
          enteredFallback = true;
          await fallback.promise;
          return result;
        },
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            enteredFallback = true;
            await fallback.promise;
            yield stop;
          },
        }),
      });
      const owned = new FallbackChain(
        [
          { provider: first, model: 'gpt-4o', maxAttempts: 1 },
          { provider: second, model: 'gpt-4o-mini', maxAttempts: 1 },
        ],
        {
          keyFor: () => 'offline-placeholder',
          sleep: () => Promise.resolve(),
          retainWork: tracked.retain,
        },
      );
      const running =
        mode === 'generate' ? owned.generate(request) : collect(owned.stream(request));
      try {
        await until(() => enteredFallback);
        expect(saved).toBeDefined();
        expect(() =>
          saved?.retainWork(() => {
            lateEntries++;
            return Promise.resolve();
          }),
        ).toThrow();
        expect(lateEntries).toBe(0);
        expect(tracked.pending.size).toBeGreaterThan(0);
        fallback.resolve();
        await running;
        await Promise.resolve();
        expect(tracked.pending.size).toBeGreaterThan(0);
        earlier.resolve();
        await until(() => tracked.pending.size === 0);
      } finally {
        fallback.resolve();
        earlier.resolve();
        await running.catch(() => undefined);
      }
    },
  );

  it.each(['generate', 'stream'] as const)(
    'retires timed-out %s authority while its raw operation still owes ACK',
    async (mode) => {
      const raw = latch<void>();
      const entered = latch<void>();
      const clock = timer();
      const tracked = tracking();
      let saved: LlmInvocationOptions | undefined;
      let lateEntries = 0;
      const p = source({
        generate: async (_req, _key, work) => {
          saved = work;
          entered.resolve();
          await raw.promise;
          return result;
        },
        stream: (_req, _key, work) => {
          saved = work;
          return {
            async *[Symbol.asyncIterator]() {
              entered.resolve();
              await raw.promise;
              yield stop;
            },
          };
        },
      });
      const owned = chain(p, {
        retainWork: tracked.retain,
        newAbortController: () => new AbortController(),
        setTimer: clock.set,
      });
      const running =
        mode === 'generate'
          ? owned.generate(request).catch(() => undefined)
          : collect(owned.stream(request));
      try {
        await entered.promise;
        clock.fire();
        await running;
        expect(() =>
          saved?.retainWork(() => {
            lateEntries++;
            return Promise.resolve();
          }),
        ).toThrow();
        expect(lateEntries).toBe(0);
        expect(tracked.pending.size).toBeGreaterThan(0);
      } finally {
        raw.resolve();
        clock.fire();
        await running;
        await until(() => tracked.pending.size === 0);
      }
    },
  );

  it('consumer return immediately retires a custom stream while next and actual return are held', async () => {
    const raw = latch<IteratorResult<StreamChunk>>();
    const close = latch<IteratorResult<StreamChunk>>();
    const entered = latch<void>();
    const tracked = tracking();
    let saved: LlmInvocationOptions | undefined;
    let lateEntries = 0;
    const p = source({
      stream: (_req, _key, work) => {
        saved = work;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                entered.resolve();
                return raw.promise;
              },
              return: () => close.promise,
            };
          },
        };
      },
    });
    const iterator = chain(p, { retainWork: tracked.retain })
      .stream(request)
      [Symbol.asyncIterator]();
    const next = iterator.next();
    await entered.promise;
    const returned = iterator.return?.();
    try {
      expect(() =>
        saved?.retainWork(() => {
          lateEntries++;
          return Promise.resolve();
        }),
      ).toThrow();
      expect(lateEntries).toBe(0);
      expect(tracked.pending.size).toBeGreaterThan(0);
    } finally {
      raw.resolve({ done: true, value: undefined });
      close.resolve({ done: true, value: undefined });
      await next;
      await returned;
      await until(() => tracked.pending.size === 0);
    }
  });
});

for (const mode of ['generate', 'stream'] as const)
  for (const stopAt of ['live', 'outer-cancel', 'aggregate-cancel', 'aggregate-deadline'] as const)
    it(`${mode} rechecks cancellation after invocation transfer: ${stopAt}`, async () => {
      const abort = new AbortController();
      const clock = timer();
      const attempts: AttemptRecord[] = [];
      const captured: Promise<unknown>[] = [];
      let entries = 0;
      let calls = 0;
      const p = source({
        generate: () => {
          calls++;
          return Promise.resolve(result);
        },
        stream: () => {
          calls++;
          return {
            async *[Symbol.asyncIterator]() {
              await Promise.resolve();
              yield stop;
            },
          };
        },
      });
      const c = chain(p, {
        newAbortController: () => new AbortController(),
        setTimer: clock.set,
        onAttempt: (attempt) => {
          attempts.push(attempt);
        },
        retainWork: <T>(factory: () => Promise<T>): Promise<T> => {
          entries++;
          if (
            (stopAt === 'outer-cancel' && entries === 1) ||
            (stopAt === 'aggregate-cancel' && entries === 2)
          )
            abort.abort();
          if (stopAt === 'aggregate-deadline' && entries === 2) clock.fire();
          const raw = factory();
          captured.push(raw);
          return raw;
        },
      });
      let errorKind: string | undefined;
      if (mode === 'generate') {
        try {
          await c.generate({ ...request, signal: abort.signal });
        } catch (error) {
          if (!(error instanceof LlmProviderError)) throw error;
          errorKind = error.llmError.kind;
        }
      } else {
        for await (const chunk of c.stream({ ...request, signal: abort.signal }))
          if (chunk.type === 'error') errorKind = chunk.error.kind;
      }
      await Promise.allSettled(captured);
      expect(calls).toBe(stopAt === 'live' ? 1 : 0);
      expect(errorKind).toBe(
        stopAt === 'live' ? undefined : stopAt === 'aggregate-deadline' ? 'timeout' : 'cancelled',
      );
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.providerInvoked).toBe(stopAt === 'live');
      if (stopAt !== 'live') expect(attempts[0]?.usage).toBeUndefined();
    });

for (const mode of ['generate', 'stream'] as const)
  for (const failed of [false, true])
    for (const cleanup of ['live', 'mutate', 'throw'] as const)
      it(`${mode} owns response evidence and joins retirement: failed=${failed}, cleanup=${cleanup}`, async () => {
        const text = { type: 'text' as const, text: 'owned before cleanup' };
        const counts = { inputTokens: 3, outputTokens: 2 };
        const original = makeLlmError({
          provider: 'openai',
          kind: 'context_overflow',
          message: 'original provider refusal',
        });
        const cleanupFailure = new Error('private caller cleanup failure');
        let releases = 0;
        const signal = {
          aborted: false,
          addEventListener: () => undefined,
          removeEventListener: () => {
            releases++;
            if (cleanup === 'throw') throw cleanupFailure;
            if (cleanup === 'mutate') {
              text.text = 'cleanup mutation';
              counts.inputTokens = 0;
              counts.outputTokens = 0;
            }
          },
        };
        const tracked = tracking();
        const attempts: AttemptRecord[] = [];
        const p = source({
          generate: () =>
            failed
              ? Promise.reject(new LlmProviderError({ ...original, usage: counts }))
              : Promise.resolve({ content: [text], usage: counts, stopReason: 'stop' }),
          stream: async function* () {
            await Promise.resolve();
            if (failed) yield { type: 'error', error: { ...original, usage: counts } };
            else {
              yield { type: 'text_delta', text: text.text };
              yield { type: 'stop', stopReason: 'stop', usage: counts };
            }
          },
        });
        const c = chain(p, {
          costTracker: new CostTracker(),
          retainWork: tracked.retain,
          onAttempt: (attempt) => {
            attempts.push(attempt);
          },
        });
        let errorKind: string | undefined;
        if (mode === 'generate') {
          try {
            const output = await c.generate({ ...request, signal });
            expect(output.content).toEqual([{ type: 'text', text: 'owned before cleanup' }]);
            expect(output.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
          } catch (error) {
            if (!(error instanceof LlmProviderError)) throw error;
            errorKind = error.llmError.kind;
          }
        } else {
          const chunks = await collect(c.stream({ ...request, signal }));
          const error = chunks.find((chunk) => chunk.type === 'error');
          if (error?.type === 'error') errorKind = error.error.kind;
          if (!failed) {
            expect(chunks.find((chunk) => chunk.type === 'text_delta')).toMatchObject({
              text: 'owned before cleanup',
            });
            expect(chunks.find((chunk) => chunk.type === 'stop')).toMatchObject({
              usage: { inputTokens: 3, outputTokens: 2 },
            });
          }
        }
        expect(errorKind).toBe(
          failed ? 'context_overflow' : cleanup === 'throw' ? 'unknown' : undefined,
        );
        expect(releases).toBe(1);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          providerInvoked: true,
          contentReceived: mode === 'generate' || !failed,
          usage: { inputTokens: 3, outputTokens: 2 },
        });
        expect(attempts[0]?.cost?.costMicrocents).toBeGreaterThan(0);
        await until(() => tracked.pending.size === 0);
        expect(tracked.pending.size).toBe(0);
      });

it('captures generated content and accountable usage before invocation abort observers', async () => {
  const text = { type: 'text' as const, text: 'original output' };
  const usage = { inputTokens: 3, outputTokens: 2 };
  let aborted = 0;
  const tracked = tracking();
  const attempts: AttemptRecord[] = [];
  const c = chain(
    source({
      generate: (_request, _key, work) => {
        if (!(work instanceof ProviderInvocationWork)) throw new Error('missing invocation scope');
        work.signal.addEventListener('abort', () => {
          aborted++;
          text.text = 'abort mutation';
          usage.inputTokens = 0;
          usage.outputTokens = 0;
        });
        return Promise.resolve({ content: [text], usage, stopReason: 'stop' });
      },
    }),
    {
      retainWork: tracked.retain,
      costTracker: new CostTracker(),
      onAttempt: (attempt) => {
        attempts.push(attempt);
      },
    },
  );
  const output = await c.generate(request);
  expect(aborted).toBe(1);
  expect(output.content).toEqual([{ type: 'text', text: 'original output' }]);
  expect(output.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  expect(attempts).toHaveLength(1);
  expect(attempts[0]?.usage).toEqual(output.usage);
  expect(attempts[0]?.cost?.costMicrocents).toBeGreaterThan(0);
  await until(() => tracked.pending.size === 0);
});
