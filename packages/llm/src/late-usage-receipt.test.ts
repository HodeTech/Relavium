import { describe, expect, it, vi } from 'vitest';
import type { UsageEvidence, UsageInvocation } from '@relavium/shared';
import { CostTracker } from './cost-tracker.js';
import type { ModelPricing } from './pricing.js';
import { createOpenAiAdapter } from './adapters/openai.js';
import { FallbackChain, type AttemptRecord, type FallbackChainOptions } from './fallback-chain.js';
import { LlmProviderError, makeLlmError } from './llm-error.js';
import type { LlmProvider, LlmResult, StreamChunk } from './types.js';

const complete: UsageEvidence = { kind: 'complete', usage: { inputTokens: 3, outputTokens: 2 } };
const partial: UsageEvidence = {
  kind: 'partial',
  known: { outputTokens: 2 },
  reason: 'missing_fields',
};
const missing: UsageEvidence = { kind: 'missing', reason: 'not_reported' };
const invocation: UsageInvocation = {
  producerId: 'late-producer',
  ordinal: 1,
  dispatchId: 'late-dispatch',
  round: 1,
  chainAttempt: 1,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Receipt transition did not occur');
}
function setup(
  streaming: boolean,
  overrides: Partial<FallbackChainOptions> = {},
  source?: LlmProvider['stream'],
) {
  const result = deferred<LlmResult>();
  const records: AttemptRecord[] = [];
  const retained: Promise<unknown>[] = [];
  const abort = new AbortController();
  let invoked = false;
  let fire: () => void = () => {
    throw new Error('timer not armed');
  };
  const provider: LlmProvider = {
    id: 'openai',
    supports: createOpenAiAdapter().supports,
    generate: () => {
      invoked = true;
      return result.promise;
    },
    async *stream(req, key, options) {
      invoked = true;
      if (source !== undefined) {
        yield* source(req, key, options);
        return;
      }
      const value = await result.promise;
      yield { type: 'stop', stopReason: value.stopReason, usage: value.usage };
    },
  };
  const chain = new FallbackChain([{ provider, model: 'late-model', maxAttempts: 1 }], {
    keyFor: () => 'offline-key',
    sleep: () => Promise.resolve(),
    beginUsageInvocation: () => Promise.resolve(invocation),
    newAbortController: () => new AbortController(),
    setTimer: (_ms, callback) => {
      fire = callback;
      return () => undefined;
    },
    retainWork: (factory) => {
      const pending = factory();
      retained.push(pending);
      void pending.catch(() => undefined);
      return pending;
    },
    onAttempt: (record) => records.push(record),
    ...overrides,
  });
  const req = { model: 'late-model', messages: [], signal: abort.signal };
  const chunks: StreamChunk[] = [];
  const call = streaming
    ? (async () => {
        for await (const chunk of chain.stream(req)) chunks.push(chunk);
      })()
    : chain.generate(req).catch(() => undefined);
  return {
    result,
    records,
    chunks,
    abort,
    call,
    fire: () => fire(),
    started: () => until(() => invoked),
    joined: async () => {
      await Promise.allSettled(retained);
    },
  };
}
function accountable(usage: UsageEvidence): LlmProviderError {
  return new LlmProviderError({
    ...makeLlmError({ provider: 'openai', kind: 'transport', message: 'interrupted' }),
    usage,
  });
}

describe('late receipt lifecycle and retained authority', () => {
  for (const streaming of [false, true]) {
    for (const kind of ['missing', 'partial', 'invalid', 'rejected'] as const) {
      it(`${streaming}: final ${kind} receipt retires its pending flag`, async () => {
        const h = setup(streaming);
        await h.started();
        h.fire();
        await h.call;
        expect(h.records[0]?.receiptPending).toBe(true);
        if (kind === 'rejected') h.result.reject(new Error('late rejection'));
        else
          h.result.resolve({
            content: [],
            stopReason: 'stop',
            usage:
              kind === 'missing'
                ? missing
                : kind === 'partial'
                  ? partial
                  : { kind: 'complete', usage: { inputTokens: -1, outputTokens: 2 } },
          });
        await h.joined();
        expect(h.records).toHaveLength(2);
        expect(h.records[1]).toMatchObject({ receiptFinal: true, invocation, coverageOnly: true });
        expect(h.records[1]).not.toHaveProperty('receiptPending');
        expect(h.records[1]?.usage?.kind).toBe(kind === 'partial' ? 'partial' : 'missing');
      });
    }
    it(`${streaming}: late pricing failure preserves final evidence and then signals money health`, async () => {
      const marker = new Error('private pricing failure');
      const order: string[] = [];
      const records: AttemptRecord[] = [];
      const health = vi.fn((error: unknown) => {
        expect(error).toBe(marker);
        order.push('health');
      });
      const overlay = new Map<string, ModelPricing>();
      overlay.get = () => {
        throw marker;
      };
      const tracker = new CostTracker(overlay);
      const recordCost = vi.spyOn(tracker, 'record');
      const h = setup(streaming, {
        costTracker: tracker,
        onAccountingFailure: health,
        onAttempt: (record) => {
          records.push(record);
          order.push(record.receiptFinal ? 'final' : 'pending');
        },
      });
      await h.started();
      h.fire();
      await h.call;
      const priorChunks = [...h.chunks];
      h.result.resolve({ content: [], stopReason: 'stop', usage: complete });
      await h.joined();
      expect(records).toHaveLength(2);
      expect(records[1]).toMatchObject({
        receiptFinal: true,
        usage: complete,
        priced: false,
        error: { kind: 'unknown', retryable: false, cause: marker },
      });
      expect(records[1]).not.toHaveProperty('receiptPending');
      expect(records[1]?.cost).toBeUndefined();
      expect(order).toEqual(['pending', 'final', 'health']);
      expect(health).toHaveBeenCalledTimes(1);
      expect(recordCost).toHaveBeenCalledTimes(1);
      expect(h.chunks).toEqual(priorChunks);
    });
  }
  for (const cancelled of [false, true]) {
    for (const usage of [complete, partial]) {
      it(`stream ${cancelled}/${usage.kind}: late accountable rejection retains evidence`, async () => {
        const h = setup(true);
        await h.started();
        if (cancelled) h.abort.abort();
        else h.fire();
        await h.call;
        h.result.reject(accountable(usage));
        await h.joined();
        expect(h.records).toHaveLength(2);
        expect(h.records[1]).toMatchObject({ receiptFinal: true, usage });
        expect(h.records[1]).not.toHaveProperty('receiptPending');
      });
    }
  }
  it('held terminal evidence remains authoritative over a late accountable rejection', async () => {
    const release = deferred<void>();
    let held = false;
    const h = setup(true, {}, async function* () {
      yield { type: 'stop', stopReason: 'stop', usage: partial };
      held = true;
      await release.promise;
      throw accountable(complete);
    });
    await until(() => held);
    h.fire();
    await h.call;
    release.resolve();
    await h.joined();
    expect(h.records).toHaveLength(2);
    expect(h.records[1]).toMatchObject({ receiptFinal: true, usage: partial });
  });
  it('the correlated generate path reads usage once and keeps its first owned observation', async () => {
    const cost = vi.fn((_model: string, usage: { inputTokens: number; outputTokens: number }) => ({
      ...usage,
      costMicrocents: 5,
      cumulativeCostMicrocents: 5,
    }));
    const h = setup(false, { costTracker: { record: cost } });
    await h.started();
    let reads = 0;
    h.result.resolve({
      content: [],
      stopReason: 'stop',
      get usage() {
        if (++reads > 1) throw new Error('second access');
        return complete;
      },
    });
    await h.call;
    await h.joined();
    expect(reads).toBe(1);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ outcome: 'succeeded', usage: complete });
    expect(cost).toHaveBeenCalledTimes(1);
    expect(cost).toHaveBeenCalledWith('late-model', { inputTokens: 3, outputTokens: 2 });
  });
});
