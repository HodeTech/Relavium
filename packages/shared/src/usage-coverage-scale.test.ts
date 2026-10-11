import { describe, expect, it } from 'vitest';
import { UsageCoverageFold } from './usage-coverage-fold.js';
import type { UsageInvocation } from './usage-coverage.js';
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

describe('bounded incremental usage coverage', () => {
  // This is a structural 100,000-settlement control, not a five-second throughput promise.
  // Keep the complete workload and every assertion under a finite, test-local bound on CI.
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
  }, 30_000);
});
