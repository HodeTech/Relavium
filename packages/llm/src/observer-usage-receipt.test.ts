import { describe, expect, it, vi } from 'vitest';
import type { UsageEvidence, UsageInvocation } from '@relavium/shared';
import { createOpenAiAdapter } from './adapters/openai.js';
import { FallbackChain, type AttemptRecord } from './fallback-chain.js';
import type { LlmProvider, LlmResult, StreamChunk } from './types.js';
import { LlmProviderError, makeLlmError } from './llm-error.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const invocation: UsageInvocation = {
  producerId: 'observer-receipt',
  ordinal: 1,
  dispatchId: 'dispatch',
  round: 1,
  chainAttempt: 1,
};
const complete = {
  kind: 'complete',
  usage: { inputTokens: 3, outputTokens: 2 },
} satisfies UsageEvidence;
const zero = {
  kind: 'complete',
  usage: { inputTokens: 0, outputTokens: 0 },
} satisfies UsageEvidence;
const partial: UsageEvidence = {
  kind: 'partial',
  known: { outputTokens: 2 },
  reason: 'missing_fields',
};
const missing: UsageEvidence = { kind: 'missing', reason: 'not_reported' };
const invalid: UsageEvidence = { kind: 'complete', usage: { inputTokens: -1, outputTokens: 2 } };

function fixture(
  streaming: boolean,
  throws: boolean,
  secondaryThrows = false,
  healthThrows = false,
) {
  const raw = deferred<LlmResult>();
  const entered = deferred<void>();
  const records: AttemptRecord[] = [];
  const retained: Promise<unknown>[] = [];
  const primary = Object.freeze({ primary: 'opaque observer fault' });
  const secondary = Object.freeze({ secondary: 'opaque observer fault' });
  const healthFailure = Object.freeze({ health: 'opaque diagnostic fault' });
  const health = vi.fn(() => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Supported callback throwables are opaque, including non-Errors.
    if (healthThrows) throw healthFailure;
  });
  let reads = 0;
  let calls = 0;
  let expireOnReadSettlement = false;
  let retaining = 0;
  let firstReadRegistered = false;
  let finalInsidePrimary = false;
  let primaryEscaped = false;
  let fire: () => void = () => {
    throw new Error('deadline not armed');
  };
  const provider: LlmProvider = {
    id: 'openai',
    supports: createOpenAiAdapter().supports,
    generate: () => {
      calls++;
      entered.resolve();
      return raw.promise;
    },
    async *stream() {
      calls++;
      entered.resolve();
      const result = await raw.promise;
      yield { type: 'stop', stopReason: result.stopReason, usage: result.usage };
    },
  };
  const cost = vi.fn((_model: string, usage: { inputTokens: number; outputTokens: number }) => ({
    ...usage,
    costMicrocents: usage.inputTokens + usage.outputTokens,
    cumulativeCostMicrocents: usage.inputTokens + usage.outputTokens,
  }));
  const chain = new FallbackChain([{ provider, model: 'late-model', maxAttempts: 1 }], {
    keyFor: () => 'offline',
    sleep: () => Promise.resolve(),
    beginUsageInvocation: () => Promise.resolve(invocation),
    newAbortController: () => new AbortController(),
    setTimer: (_ms, callback) => {
      fire = callback;
      return () => undefined;
    },
    retainWork: (factory) => {
      const outer = retaining++ === 0;
      let work: ReturnType<typeof factory>;
      try {
        work = factory();
      } finally {
        retaining--;
      }
      if (outer && !firstReadRegistered) {
        firstReadRegistered = true;
        // Attach before the chain's receipt/race reactions. A deadline fired at this raw-read
        // settlement wins the transformed race while its accountable error is already observable.
        void work.then(
          () => undefined,
          () => {
            if (expireOnReadSettlement) fire();
          },
        );
      }
      retained.push(work);
      void work.catch(() => undefined);
      return work;
    },
    costTracker: { record: cost },
    onAccountingFailure: health,
    onAttempt: (record) => {
      records.push(record);
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Pin exact non-Error identity across accounting and cleanup.
      if (record.receiptPending && throws) throw primary;
      if (record.receiptFinal) {
        finalInsidePrimary = !primaryEscaped;
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- A second opaque observer failure must not replace the first.
        if (secondaryThrows) throw secondary;
      }
    },
  });
  const abort = new AbortController();
  const chunks: StreamChunk[] = [];
  const call = (
    streaming
      ? (async () => {
          for await (const chunk of chain.stream({
            model: 'late-model',
            messages: [],
            signal: abort.signal,
          }))
            chunks.push(chunk);
        })()
      : chain.generate({ model: 'late-model', messages: [], signal: abort.signal })
  ).catch((error: unknown) => {
    primaryEscaped = true;
    return error;
  });
  return {
    entered: entered.promise,
    records,
    retained,
    primary,
    secondary,
    health,
    cost,
    chunks,
    call,
    reads: () => reads,
    calls: () => calls,
    finalInsidePrimary: () => finalInsidePrimary,
    expire: () => fire(),
    settleAlreadyObserved: (usage: UsageEvidence) => {
      if (streaming) {
        expireOnReadSettlement = true;
        raw.reject(
          new LlmProviderError({
            ...makeLlmError({ provider: 'openai', kind: 'transport', message: 'interrupted' }),
            usage,
          }),
        );
      } else {
        fire();
        raw.resolve({
          content: [],
          stopReason: 'stop',
          get usage() {
            reads++;
            return usage;
          },
        });
      }
    },
    resolve: (usage: UsageEvidence) =>
      raw.resolve({
        content: [],
        stopReason: 'stop',
        get usage() {
          reads++;
          return usage;
        },
      }),
    join: () => Promise.allSettled(retained),
  };
}

describe('primary observer failures retain registered usage receipts', () => {
  for (const streaming of [false, true]) {
    for (const throws of [false, true]) {
      for (const [name, evidence] of Object.entries({
        complete,
        zero,
        partial,
        missing,
        invalid,
      })) {
        it(`${streaming}/${throws}/${name}: later evidence settles and retires once`, async () => {
          const h = fixture(streaming, throws);
          await h.entered;
          h.expire();
          const outcome = await h.call;
          if (throws) expect(outcome).toBe(h.primary);
          expect(h.records).toHaveLength(1);
          expect(h.records[0]).toMatchObject({ invocation, receiptPending: true });
          const publishedChunks = [...h.chunks];
          h.resolve(evidence);
          const joined = await h.join();
          expect(joined.filter((entry) => entry.status === 'rejected')).toHaveLength(
            streaming && name === 'invalid' ? 1 : 0,
          );
          expect(h.records).toHaveLength(2);
          expect(h.records[1]).toMatchObject({
            invocation,
            receiptFinal: true,
            coverageOnly: true,
          });
          expect(h.records[1]).not.toHaveProperty('receiptPending');
          expect(h.records[1]?.usage).toEqual(
            name === 'invalid'
              ? { kind: 'missing', reason: streaming ? 'interrupted' : 'invalid_fields' }
              : evidence,
          );
          expect(h.cost).toHaveBeenCalledTimes(
            evidence.kind === 'complete' && name !== 'invalid' ? 1 : 0,
          );
          expect(h.calls()).toBe(1);
          expect(h.reads()).toBe(1);
          expect(h.chunks).toEqual(publishedChunks);
        });
      }
    }
    for (const primaryThrows of [false, true]) {
      for (const secondaryThrows of [false, true]) {
        for (const evidence of [complete, zero]) {
          it(`${streaming}/${primaryThrows}/${secondaryThrows}/${evidence.usage.outputTokens}: already observed receipt preserves failure precedence`, async () => {
            const h = fixture(streaming, primaryThrows, secondaryThrows);
            await h.entered;
            h.settleAlreadyObserved(evidence);
            const outcome = await h.call;
            if (primaryThrows) expect(outcome).toBe(h.primary);
            else if (secondaryThrows) expect(outcome).toBe(h.secondary);
            await h.join();
            expect(h.records).toHaveLength(2);
            expect(h.records[1]).toMatchObject({ invocation, receiptFinal: true, usage: evidence });
            expect(h.finalInsidePrimary()).toBe(true);
            expect(h.cost).toHaveBeenCalledExactlyOnceWith('late-model', evidence.usage);
            expect(h.calls()).toBe(1);
            expect(h.reads()).toBe(streaming ? 0 : 1);
            expect(h.health).toHaveBeenCalledTimes(primaryThrows && secondaryThrows ? 1 : 0);
            if (primaryThrows && secondaryThrows)
              expect(h.health).toHaveBeenCalledWith(h.secondary);
          });
        }
      }
    }
    it(`${streaming}: a throwing secondary diagnostic sink cannot replace the original observer fault`, async () => {
      const h = fixture(streaming, true, true, true);
      await h.entered;
      h.settleAlreadyObserved(complete);
      expect(await h.call).toBe(h.primary);
      await h.join();
      expect(h.records).toHaveLength(2);
      expect(h.health).toHaveBeenCalledExactlyOnceWith(h.secondary);
      expect(h.finalInsidePrimary()).toBe(true);
      expect(h.cost).toHaveBeenCalledExactlyOnceWith('late-model', complete.usage);
    });
  }
});
