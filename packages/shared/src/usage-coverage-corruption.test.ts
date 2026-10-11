import { describe, expect, it } from 'vitest';
import { CorruptRunEventError, isCorruptRunEventError } from './run-history-errors.js';
import { RunEventSchema, type RunEvent } from './run-event.js';
import { UsageCoverageFold } from './usage-coverage-fold.js';

const envelope = { runId: 'damaged-run', timestamp: '2026-10-11T00:00:00.000Z' };
const basis: RunEvent = {
  ...envelope,
  sequenceNumber: 0,
  type: 'cost:coverage_started',
  basis: 'complete',
};
const pending: RunEvent = {
  ...envelope,
  sequenceNumber: 1,
  type: 'cost:usage_pending',
  nodeId: 'n',
  model: 'm',
  invocation: { producerId: 'p', ordinal: 1, dispatchId: 'd', round: 0, chainAttempt: 1 },
};
function caught(operation: () => void): { readonly thrown: boolean; readonly value: unknown } {
  try {
    operation();
    return { thrown: false, value: undefined };
  } catch (value) {
    return { thrown: true, value };
  }
}
describe('semantic usage history corruption', () => {
  it.each(['duplicate basis', 'repeated ordinal', 'decreased ordinal'] as const)(
    'classifies %s without partially changing coverage',
    (kind) => {
      const fold = new UsageCoverageFold();
      fold.apply(RunEventSchema.parse(basis));
      if (kind !== 'duplicate basis')
        fold.apply(
          RunEventSchema.parse({ ...pending, invocation: { ...pending.invocation, ordinal: 2 } }),
        );
      const invalid = RunEventSchema.parse(
        kind === 'duplicate basis'
          ? { ...basis, sequenceNumber: 2 }
          : {
              ...pending,
              sequenceNumber: 2,
              invocation: { ...pending.invocation, ordinal: kind === 'repeated ordinal' ? 2 : 1 },
            },
      );
      const before = fold.snapshot();
      const result = caught(() => fold.apply(invalid));
      expect(result.thrown).toBe(true);
      expect(isCorruptRunEventError(result.value)).toBe(true);
      expect(result.value).toBeInstanceOf(CorruptRunEventError);
      expect(result.value).toMatchObject({
        code: 'corrupt_run_event',
        runId: envelope.runId,
        sequenceNumber: 2,
        eventType: invalid.type,
      });
      if (isCorruptRunEventError(result.value)) expect(result.value.cause).toBeInstanceOf(Error);
      expect(fold.snapshot()).toEqual(before);
    },
  );
  it.each([new Error('programming fault'), null, undefined])(
    'preserves unrelated thrown value %#',
    (fault) => {
      const fold = new UsageCoverageFold();
      fold.apply(basis);
      fold.pending = () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- External opaque failures must retain their exact identity at this wrapping boundary.
        throw fault;
      };
      const result = caught(() => fold.apply(pending));
      expect(result.thrown).toBe(true);
      expect(result.value).toBe(fault);
      expect(isCorruptRunEventError(result.value)).toBe(false);
    },
  );
  it('keeps valid increasing invocations and qualified retirement readable', () => {
    const fold = new UsageCoverageFold();
    fold.apply(basis);
    fold.apply(pending);
    fold.apply(
      RunEventSchema.parse({
        ...envelope,
        sequenceNumber: 2,
        type: 'cost:usage_disposition',
        nodeId: 'n',
        model: 'm',
        invocation: pending.invocation,
        disposition: { kind: 'not_invoked', reason: 'admission_refused' },
      }),
    );
    fold.apply(
      RunEventSchema.parse({
        ...pending,
        sequenceNumber: 3,
        invocation: { ...pending.invocation, ordinal: 2 },
      }),
    );
    fold.apply(
      RunEventSchema.parse({
        ...envelope,
        sequenceNumber: 4,
        type: 'cost:usage_disposition',
        nodeId: 'n',
        model: 'm',
        invocation: { ...pending.invocation, ordinal: 2 },
        disposition: { kind: 'incomplete', evidence: { kind: 'missing', reason: 'not_reported' } },
      }),
    );
    expect(fold.snapshot().coverage).toEqual({
      unverified: false,
      pendingInvocations: 0,
      unknownCalls: 1,
    });
    expect(fold.retainedInvocations).toBe(0);
  });
});
