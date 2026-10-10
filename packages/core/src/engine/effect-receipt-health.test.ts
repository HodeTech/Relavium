import { describe, expect, it } from 'vitest';
import type { EffectDispatchPort, EffectPrepareVerdict } from '@relavium/shared';

import { ToolEffectNeedsAttentionError } from '../tools/errors.js';
import { EffectReceiptHealth } from './effect-receipt-health.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const correlation = { kind: 'run', runId: 'run', nodeId: 'node', attempt: 1 } as const;
function port(overrides: Partial<EffectDispatchPort> = {}): EffectDispatchPort {
  return {
    prepare: () => Promise.resolve({ outcome: 'proceed' }),
    settle: () => Promise.resolve(),
    discard: () => Promise.resolve(),
    ...overrides,
  };
}

describe('EffectReceiptHealth — final joined semantic observations (ADR-0103)', () => {
  it('records a successful tier-3 admission before returning its exact ACK, and requires the committed ACK', async () => {
    const health = new EffectReceiptHealth();
    const prepared = deferred<EffectPrepareVerdict>();
    const settled = deferred<void>();
    const effects = health.bind(
      port({ prepare: () => prepared.promise, settle: () => settled.promise }),
      correlation,
    );
    const preparing = effects.prepare(0, 'run_command', 3, { omittedFromHealth: 'private' });
    expect(preparing).toBe(prepared.promise);
    expect(health.needsAttention).toBe(false);
    prepared.resolve({ outcome: 'proceed' });
    await preparing;
    expect(health.needsAttention).toBe(true);
    const settling = effects.settle(0, 'run_command', 'committed');
    expect(settling).toBe(settled.promise);
    expect(health.needsAttention).toBe(true);
    settled.resolve();
    await settling;
    expect(health.needsAttention).toBe(false);
  });

  it('a different correlation cannot ACK the same slot/tool, while attempts share the canonical identity', async () => {
    const health = new EffectReceiptHealth();
    const original = health.bind(port(), correlation);
    await original.prepare(0, 'run_command', 3, {});
    const other = health.bind(port(), { ...correlation, nodeId: 'other' });
    await other.settle(0, 'run_command', 'committed');
    expect(health.needsAttention).toBe(true);
    const nextAttempt = health.bind(port(), { ...correlation, attempt: 2 });
    await nextAttempt.discard(0, 'run_command');
    expect(health.needsAttention).toBe(false);
  });

  it('pending transfer can be resolved by a child ACK without prematurely making pending attention sticky', async () => {
    const health = new EffectReceiptHealth();
    const done = deferred<void>();
    const effects = health.bind(port({ discard: () => done.promise }), correlation);
    await effects.prepare(7, 'http_request', 3, {});
    const child = health.invocation(() => effects.discard(7, 'http_request'));
    expect(child).toBe(done.promise);
    expect(health.needsAttention).toBe(true);
    done.resolve();
    await child;
    expect(health.needsAttention).toBe(false);
  });

  it('replay, rejected prepare and a reserved lower-tier pending row do not manufacture tier-3 attention', async () => {
    const health = new EffectReceiptHealth();
    const replay = health.bind(
      port({ prepare: () => Promise.resolve({ outcome: 'replay', result: 'existing' }) }),
      correlation,
    );
    await replay.prepare(0, 'run_command', 3, {});
    const refused = health.bind(
      port({ prepare: () => Promise.reject(new Error('no admitted row')) }),
      correlation,
    );
    await expect(refused.prepare(1, 'run_command', 3, {})).rejects.toThrow('no admitted row');
    await health.bind(port(), correlation).prepare(2, 'read', 1, {});
    expect(health.needsAttention).toBe(false);
  });

  it('an acknowledged ambiguous receipt remains attention even after a later committed ACK', async () => {
    const health = new EffectReceiptHealth();
    const effects = health.bind(port(), correlation);
    await effects.prepare(0, 'run_command', 3, {});
    await effects.settle(0, 'run_command', 'ambiguous');
    await effects.settle(0, 'run_command', 'committed');
    expect(health.needsAttention).toBe(true);
  });

  for (const operation of ['settle', 'discard'] as const) {
    it(`retains a caught ${operation} failure independently of the raw caller and a later ACK`, async () => {
      const health = new EffectReceiptHealth();
      let fail = true;
      const write = (): Promise<void> => {
        if (fail) return Promise.reject(new Error('private store cause'));
        return Promise.resolve();
      };
      const effects = health.bind(port({ [operation]: write }), correlation);
      await effects.prepare(0, 'run_command', 3, {});
      const result =
        operation === 'settle'
          ? effects.settle(0, 'run_command', 'committed')
          : effects.discard(0, 'run_command');
      await result.catch(() => undefined);
      fail = false;
      await effects.settle(0, 'run_command', 'committed');
      expect(health.needsAttention).toBe(true);
    });
  }

  it('retains an ignored typed raw rejection without reflecting a generic hostile thrown value', async () => {
    const health = new EffectReceiptHealth();
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          traps += 1;
          throw new Error('no prototype access');
        },
        get: () => {
          traps += 1;
          throw new Error('no property access');
        },
      },
    );
    health.observeFailure(hostile);
    expect(traps).toBe(0);
    expect(health.needsAttention).toBe(false);
    const raw = deferred<void>();
    const returned = health.invocation(() => raw.promise);
    expect(returned).toBe(raw.promise);
    raw.reject(new ToolEffectNeedsAttentionError('run_command', new Error('private')));
    await returned.catch(() => undefined);
    expect(health.needsAttention).toBe(true);
  });

  it('ignores a Promise own then override and observes a late typed outcome before its owner resumes', async () => {
    const health = new EffectReceiptHealth();
    const raw = deferred<{
      kind: 'failed';
      error: { code: 'effect_needs_attention'; message: string; retryable: false };
    }>();
    let thenReads = 0;
    void Object.defineProperty(raw.promise, 'then', {
      get: () => {
        thenReads += 1;
        throw new Error('do not read raw.then');
      },
    });
    const returned = health.invocation(
      () => raw.promise,
      (value) => health.observeOutcome(value),
    );
    expect(returned).toBe(raw.promise);
    raw.resolve({
      kind: 'failed',
      error: { code: 'effect_needs_attention', message: 'fixed', retryable: false },
    });
    await returned;
    expect(health.needsAttention).toBe(true);
    expect(thenReads).toBe(0);
  });
});
