import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageInvocation } from '@relavium/shared';
import { createOpenAiAdapter, clearLearnedParamRejections } from './adapters/openai.js';
import { FallbackChain, type AttemptRecord, type PreAttemptInfo } from './fallback-chain.js';
import type { LlmError } from './types.js';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Expected repair transition');
}
const identity = (ordinal: number): UsageInvocation => ({
  producerId: 'p',
  ordinal,
  dispatchId: 'd',
  round: 1,
  chainAttempt: 1,
});
const rejected = () =>
  new Response(
    JSON.stringify({
      error: {
        message: 'Unsupported parameter: temperature',
        param: 'temperature',
        code: 'unsupported_parameter',
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );

describe('native repair admission and acknowledgement lifetime', () => {
  afterEach(() => clearLearnedParamRejections());
  for (const streaming of [false, true])
    for (const cancel of [false, true])
      for (const stage of ['admission', 'pending'] as const) {
        it(`${streaming}/${cancel}/${stage}: an acknowledgement after public closure cannot orphan or invoke`, async () => {
          const gate = deferred<void>();
          const abort = new AbortController();
          const records: AttemptRecord[] = [];
          const admissions: PreAttemptInfo[] = [];
          const retained: Promise<unknown>[] = [];
          let fire: () => void = () => {
            throw new Error('timer unarmed');
          };
          let begins = 0;
          let entered = false;
          const fetch = vi.fn(() => Promise.resolve(rejected()));
          const provider = createOpenAiAdapter({
            baseURL: 'https://repair-lifecycle.test/v1',
            fetch,
          });
          const chain = new FallbackChain(
            [{ provider, model: 'repair-lifecycle', maxAttempts: 1 }],
            {
              keyFor: () => 'offline',
              sleep: () => Promise.resolve(),
              newAbortController: () => new AbortController(),
              setTimer: (_ms, callback) => {
                fire = callback;
                return () => undefined;
              },
              retainWork: (factory) => {
                const promise = factory();
                retained.push(promise);
                void promise.catch(() => undefined);
                return promise;
              },
              preAttempt: async (info) => {
                admissions.push(info);
                if (stage === 'admission' && admissions.length === 2) {
                  entered = true;
                  await gate.promise;
                }
              },
              beginUsageInvocation: async () => {
                const ordinal = ++begins;
                if (stage === 'pending' && ordinal === 2) {
                  entered = true;
                  await gate.promise;
                }
                return identity(ordinal);
              },
              onAttempt: (record) => records.push(record),
            },
          );
          const request = {
            model: 'repair-lifecycle',
            messages: [],
            temperature: 0.5,
            maxTokens: 7,
            signal: abort.signal,
          };
          const call = streaming
            ? (async () => {
                for await (const chunk of chain.stream(request)) expect(chunk.type).toBe('error');
              })()
            : chain.generate(request).catch(() => undefined);
          await until(() => entered);
          if (cancel) abort.abort();
          else fire();
          await call;
          expect(records).toHaveLength(2);
          expect(records[1]).toMatchObject({ providerInvoked: false });
          expect(records[1]?.invocation).toBeUndefined();
          expect(records[1]?.preAttemptInfo).toBe(admissions[1]);
          expect(admissions[0]).not.toBe(admissions[1]);
          expect(admissions[0]?.outputCapPlan).toBe(admissions[1]?.outputCapPlan);
          gate.resolve();
          await Promise.allSettled(retained);
          expect(fetch).toHaveBeenCalledTimes(1);
          expect(begins).toBe(stage === 'pending' ? 2 : 1);
          expect(records).toHaveLength(stage === 'pending' ? 3 : 2);
          if (stage === 'pending') {
            expect(records[2]).toMatchObject({
              invocation: identity(2),
              providerInvoked: false,
              coverageOnly: true,
              receiptFinal: true,
            });
            expect(records[2]?.preAttemptInfo).toBe(admissions[1]);
            expect(records[2]).not.toHaveProperty('usage');
            expect(records[2]).not.toHaveProperty('receiptPending');
          }
        });
      }
  for (const streaming of [false, true]) {
    it(`${streaming}: a native repair admission rejection preserves its exact opaque cause`, async () => {
      const marker = new Error('private admission cause');
      let checks = 0;
      const records: AttemptRecord[] = [];
      const fetch = vi.fn(() => Promise.resolve(rejected()));
      const provider = createOpenAiAdapter({ baseURL: 'https://repair-lifecycle.test/v1', fetch });
      const chain = new FallbackChain([{ provider, model: 'repair-lifecycle', maxAttempts: 2 }], {
        keyFor: () => 'offline',
        sleep: () => Promise.resolve(),
        preAttempt: () => {
          if (++checks === 2) throw marker;
        },
        onAttempt: (record) => records.push(record),
      });
      const request = { model: 'repair-lifecycle', messages: [], temperature: 0.5 };
      let error: LlmError | undefined;
      if (streaming) {
        for await (const chunk of chain.stream(request))
          if (chunk.type === 'error') error = chunk.error;
      } else await chain.generate(request).catch(() => undefined);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(records.at(-1)?.error?.cause).toBe(marker);
      expect(records.at(-1)?.error?.message).not.toContain(marker.message);
      if (streaming) expect(error?.cause).toBe(marker);
    });
  }
});
