import { describe, expect, it, vi } from 'vitest';
import { FallbackChain, type AttemptRecord, type FallbackChainOptions } from './fallback-chain.js';
import { createOpenAiAdapter } from './adapters/openai.js';
import type { LlmProvider, StreamChunk, Usage, UsageEvidence } from './types.js';

const invocation = Object.freeze({
  producerId: 'consumer-return',
  ordinal: 1,
  dispatchId: 'turn',
  round: 0,
  chainAttempt: 1,
});
const complete: UsageEvidence = { kind: 'complete', usage: { inputTokens: 7, outputTokens: 5 } };
const partial: UsageEvidence = {
  kind: 'partial',
  known: { outputTokens: 5 },
  reason: 'interrupted',
};
const missing: UsageEvidence = { kind: 'missing', reason: 'not_reported' };
const request = { model: 'consumer-return-fixture', messages: [] };

function harness(provider: LlmProvider, options: Partial<FallbackChainOptions> = {}) {
  const retained: Promise<unknown>[] = [];
  const records: AttemptRecord[] = [];
  const record = vi.fn((_model: string, usage: Usage) => ({
    ...usage,
    costMicrocents: 12,
    cumulativeCostMicrocents: 12,
  }));
  const stream = vi.fn(provider.stream.bind(provider));
  const chain = new FallbackChain(
    [{ provider: { ...provider, stream }, model: request.model, maxAttempts: 3 }],
    {
      keyFor: () => 'offline',
      sleep: () => Promise.resolve(),
      beginUsageInvocation: () => Promise.resolve(invocation),
      retainWork: (factory) => {
        const raw = factory();
        retained.push(raw);
        return raw;
      },
      costTracker: { record },
      onAttempt: (attempt) => records.push(attempt),
      ...options,
    },
  );
  return { chain, retained, records, record, stream };
}

function providerFor(usage: UsageEvidence, textFirst = false) {
  let finalized = 0,
    resumed = 0;
  const provider: LlmProvider = {
    id: 'openai',
    supports: createOpenAiAdapter().supports,
    generate: () => Promise.reject(new Error('unexpected generate')),
    async *stream(): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      try {
        if (textFirst) yield { type: 'text_delta', text: 'incurred' };
        yield { type: 'stop', stopReason: 'stop', usage };
        resumed++;
      } finally {
        finalized++;
      }
    },
  };
  return { provider, finalized: () => finalized, resumed: () => resumed };
}

async function close(iterator: AsyncIterator<StreamChunk>) {
  if (iterator.return === undefined) throw new Error('missing stream cleanup');
  expect(await iterator.return()).toEqual({ done: true, value: undefined });
}

describe('consumer return settles the engaged attempt', () => {
  for (const terminal of ['text', 'complete', 'partial', 'missing'] as const) {
    it(`return after ${terminal} observes owned evidence once and closes all raw work`, async () => {
      const evidence =
        terminal === 'complete' ? complete : terminal === 'partial' ? partial : missing;
      const p = providerFor(evidence, terminal === 'text');
      const h = harness(p.provider);
      const iterator = h.chain.stream(request)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({
        type: terminal === 'text' ? 'text_delta' : 'stop',
      });
      await close(iterator);
      await Promise.all(h.retained);
      expect(p.finalized()).toBe(1);
      expect(p.resumed()).toBe(terminal === 'text' ? 0 : 1);
      expect(h.records).toHaveLength(1);
      expect(h.records[0]).toMatchObject({
        invocation,
        providerInvoked: true,
        outcome: 'failed',
        error: { kind: 'cancelled' },
        usage: terminal === 'text' ? { kind: 'missing', reason: 'interrupted' } : evidence,
        contentReceived: terminal === 'text',
      });
      expect(h.record).toHaveBeenCalledTimes(terminal === 'complete' ? 1 : 0);
      if (terminal === 'complete') {
        expect(h.record).toHaveBeenCalledWith(request.model, { inputTokens: 7, outputTokens: 5 });
        expect(h.records[0]?.cost?.costMicrocents).toBe(12);
      }
      await close(iterator);
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
      expect(h.records).toHaveLength(1);
      expect(h.stream).toHaveBeenCalledTimes(1);
    });
  }

  for (const accountingThrows of [false, true]) {
    it(`a throwing consumer keeps its original error when accounting throws=${accountingThrows}`, async () => {
      const p = providerFor(complete);
      const primary = new Error('consumer fault'),
        secondary = new Error('accounting observer fault');
      const attempts: AttemptRecord[] = [];
      const h = harness(p.provider, {
        onAttempt: (record) => {
          attempts.push(record);
          if (accountingThrows) throw secondary;
        },
      });
      const consume = async () => {
        for await (const chunk of h.chain.stream(request)) {
          expect(chunk.type).toBe('stop');
          throw primary;
        }
      };
      await expect(consume()).rejects.toBe(primary);
      await Promise.all(h.retained);
      expect(attempts).toHaveLength(1);
      expect(h.record).toHaveBeenCalledTimes(1);
      expect(p.finalized()).toBe(1);
    });
  }

  it('direct return exposes an accounting observer fault without charging twice', async () => {
    const p = providerFor(complete),
      failure = new Error('accounting observer fault');
    const onAttempt = vi.fn(() => {
      throw failure;
    });
    const h = harness(p.provider, { onAttempt });
    const iterator = h.chain.stream(request)[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.return?.()).rejects.toBe(failure);
    await close(iterator);
    await Promise.all(h.retained);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(p.finalized()).toBe(1);
  });

  it('installed OpenAI SDK complete terminal is charged on return after stop', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          `data: ${JSON.stringify({
            id: 'offline',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 5,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    );
    const h = harness(createOpenAiAdapter({ fetch, maxRetries: 0 }));
    const iterator = h.chain.stream(request)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'stop', usage: complete });
    await close(iterator);
    await Promise.all(h.retained);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      invocation,
      usage: complete,
      cost: { costMicrocents: 12 },
    });
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it('public return settles immediately while the registered provider finalizer remains joined', async () => {
    let release: () => void = () => undefined;
    const finalizer = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const enteredFinalizer = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finalized = false;
    const p = providerFor(missing);
    const h = harness({
      ...p.provider,
      async *stream() {
        try {
          yield { type: 'text_delta', text: 'already billed' };
        } finally {
          entered();
          await finalizer;
          finalized = true;
        }
      },
    });
    const iterator = h.chain.stream(request)[Symbol.asyncIterator]();
    await iterator.next();
    await close(iterator);
    await enteredFinalizer;
    let joined = false;
    const joining = Promise.all(h.retained).then(() => {
      joined = true;
    });
    try {
      expect(h.records).toHaveLength(1);
      expect(h.records[0]?.usage).toEqual({ kind: 'missing', reason: 'interrupted' });
      await Promise.resolve();
      expect(finalized).toBe(false);
      expect(joined).toBe(false);
    } finally {
      release();
      await joining;
    }
    expect(finalized).toBe(true);
    expect(h.records).toHaveLength(1);
    expect(h.record).not.toHaveBeenCalled();
  });
});
