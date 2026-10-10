import { describe, expect, it } from 'vitest';
import { UsageCoverageFold } from './usage-coverage-fold.js';
import type { UsageDisposition, UsageInvocation } from './usage-coverage.js';
const invocation = (ordinal: number): UsageInvocation => ({
  producerId: 'producer',
  ordinal,
  dispatchId: 'dispatch',
  round: 0,
  chainAttempt: ordinal,
});
const unknown = {
  kind: 'incomplete',
  evidence: { kind: 'missing', reason: 'not_reported' },
} as const;
const identityMutations: readonly {
  readonly field: keyof UsageInvocation;
  readonly mutate: (id: UsageInvocation) => void;
}[] = [
  {
    field: 'producerId',
    mutate: (id) => {
      id.producerId = 'observer-producer';
    },
  },
  {
    field: 'ordinal',
    mutate: (id) => {
      id.ordinal = 100;
    },
  },
  {
    field: 'dispatchId',
    mutate: (id) => {
      id.dispatchId = 'observer-dispatch';
    },
  },
  {
    field: 'round',
    mutate: (id) => {
      id.round = 100;
    },
  },
  {
    field: 'chainAttempt',
    mutate: (id) => {
      id.chainAttempt = 100;
    },
  },
];

function pendingInvocation() {
  const fold = new UsageCoverageFold();
  fold.start('complete');
  const published = invocation(1);
  const original = { ...published };
  fold.pending('model', published);
  return { fold, published, original };
}

function expectCoverage(fold: UsageCoverageFold, unknownCalls: number) {
  const coverage = { unverified: false, pendingInvocations: 0, unknownCalls };
  expect(fold.snapshot().coverage).toEqual(coverage);
  expect(fold.snapshot().models).toEqual([{ model: 'model', coverage }]);
  expect(fold.retainedInvocations).toBe(0);
}

describe('usage correlation owned across public identity mutation', () => {
  it.each(identityMutations)('settles complete usage after $field mutation', ({ mutate }) => {
    const { fold, published, original } = pendingInvocation();
    mutate(published);
    expect(fold.complete('model', published)).toBe(false);
    expect(fold.complete('other-model', original)).toBe(false);
    expect(fold.complete('model', original)).toBe(true);
    expect(fold.complete('model', original)).toBe(false);
    expectCoverage(fold, 0);
    expect(fold.highWater).toBe(1);
    expect(() => fold.pending('model', original)).toThrow('ordinal');
    const next = invocation(2);
    fold.pending('model', next);
    expect(fold.highWater).toBe(2);
    expect(fold.complete('model', next)).toBe(true);
    expectCoverage(fold, 0);
  });

  it.each(identityMutations)(
    'records incomplete usage once after $field mutation',
    ({ mutate }) => {
      const { fold, published, original } = pendingInvocation();
      mutate(published);
      expect(fold.disposition('model', published, unknown)).toBe(false);
      expect(fold.disposition('other-model', original, unknown)).toBe(false);
      expect(fold.disposition('model', original, unknown)).toBe(true);
      expect(fold.disposition('model', original, unknown)).toBe(false);
      expect(fold.complete('model', original)).toBe(false);
      expectCoverage(fold, 1);
    },
  );

  for (const disposition of [
    { kind: 'not_invoked', reason: 'admission_refused' },
    { kind: 'official_refusal', reason: 'pre_content_refusal' },
  ] satisfies UsageDisposition[]) {
    it.each(identityMutations)(
      `preserves ${disposition.kind} release after $field mutation`,
      ({ mutate }) => {
        const { fold, published, original } = pendingInvocation();
        mutate(published);
        expect(fold.disposition('model', published, disposition)).toBe(false);
        expect(fold.disposition('other-model', original, disposition)).toBe(false);
        expect(fold.disposition('model', original, disposition)).toBe(true);
        expect(fold.disposition('model', original, disposition)).toBe(false);
        expect(fold.complete('model', original)).toBe(false);
        expectCoverage(fold, 0);
      },
    );
  }

  it.each(identityMutations)(
    'accepts one late complete receipt after $field mutation',
    ({ mutate }) => {
      const { fold, published, original } = pendingInvocation();
      expect(fold.disposition('model', original, unknown, true)).toBe(true);
      expect(fold.snapshot().coverage).toEqual({
        unverified: false,
        pendingInvocations: 0,
        unknownCalls: 1,
      });
      expect(fold.retainedInvocations).toBe(1);
      mutate(published);
      expect(fold.complete('model', published)).toBe(false);
      expect(fold.complete('other-model', original)).toBe(false);
      expect(fold.complete('model', original)).toBe(true);
      expect(fold.complete('model', original)).toBe(false);
      expectCoverage(fold, 0);
    },
  );

  it.each(identityMutations)(
    'retires a late incomplete receipt once after $field mutation',
    ({ mutate }) => {
      const { fold, published, original } = pendingInvocation();
      expect(fold.disposition('model', original, unknown, true)).toBe(true);
      mutate(published);
      expect(fold.disposition('model', published, unknown)).toBe(false);
      expect(fold.disposition('other-model', original, unknown)).toBe(false);
      expect(fold.disposition('model', original, unknown, true)).toBe(false);
      expect(fold.disposition('model', original, unknown)).toBe(true);
      expect(fold.disposition('model', original, unknown)).toBe(false);
      expect(fold.complete('model', original)).toBe(false);
      expectCoverage(fold, 1);
    },
  );
});

describe('bounded incremental usage coverage', () => {
  it('retires 100,000 settlements while retaining at most 64 unresolved identities', () => {
    const fold = new UsageCoverageFold();
    fold.start('complete');
    let writes = 1;
    for (let i = 1; i <= 100_000; i++) {
      const id = invocation(i);
      fold.pending(`model-${i % 4}`, id);
      writes++;
      if (i > 64) {
        const older = invocation(i - 64);
        if (older.ordinal % 3 === 0) fold.disposition(`model-${older.ordinal % 4}`, older, unknown);
        else fold.complete(`model-${older.ordinal % 4}`, older);
        writes++;
      }
      expect(fold.retainedInvocations).toBeLessThanOrEqual(64);
    }
    expect(writes).toBe(199_937);
    expect(fold.snapshot().models).toHaveLength(4);
    expect(fold.snapshot().coverage).toEqual({
      unverified: false,
      pendingInvocations: 64,
      unknownCalls: 33_312,
    });
    expect(fold.complete('model-1', invocation(1))).toBe(false);
    expect(() => fold.pending('model-1', invocation(1))).toThrow('ordinal');
    fold.retire();
    expect(fold.retainedInvocations).toBe(0);
    expect(fold.snapshot().coverage.pendingInvocations).toBe(64);
  });
  it('keeps only a registered incomplete receipt until authoritative completion or retirement', () => {
    const fold = new UsageCoverageFold();
    fold.start('complete');
    const a = invocation(1);
    fold.pending('a', a);
    expect(fold.disposition('a', a, unknown, true)).toBe(true);
    expect(fold.retainedInvocations).toBe(1);
    expect(fold.complete('a', { ...a, dispatchId: 'forged' })).toBe(false);
    expect(fold.complete('a', a)).toBe(true);
    expect(fold.complete('a', a)).toBe(false);
    expect(fold.snapshot().coverage.unknownCalls).toBe(0);
    const b = invocation(2);
    fold.pending('b', b);
    fold.disposition('b', b, unknown, true);
    fold.disposition('b', b, unknown);
    expect(fold.retainedInvocations).toBe(0);
    expect(fold.snapshot().coverage.unknownCalls).toBe(1);
  });
  it('never resets a legacy basis or acquires authority from an orphaned checkpoint', () => {
    const old = new UsageCoverageFold();
    old.start('legacy_unverified');
    old.pending('a', invocation(1));
    const resumed = new UsageCoverageFold(old.snapshot());
    expect(resumed.retainedInvocations).toBe(0);
    expect(resumed.complete('a', invocation(1))).toBe(false);
    expect(() => resumed.start('complete')).toThrow('already established');
    expect(resumed.snapshot().coverage).toEqual({
      unverified: true,
      pendingInvocations: 1,
      unknownCalls: 0,
    });
  });
});
