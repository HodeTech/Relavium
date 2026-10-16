import { describe, expect, it, vi } from 'vitest';

import {
  ExitObservations,
  type OrdinaryExit,
  type WorkflowSafetyExit,
} from './exit-observations.js';

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, other) => other !== index)).map((tail) => [value, ...tail]),
  );
}

const safetyPriority: readonly WorkflowSafetyExit[] = [8, 7, 5, 6];
const ordinaryOutcomes: readonly OrdinaryExit[] = [0, 1, 2, 3, 4, 6];

describe('ExitObservations actual-fact priority', () => {
  for (let offset = 0; offset < safetyPriority.length; offset++) {
    const cohort = safetyPriority.slice(offset);
    it(`keeps safety ${cohort[0]} above all weaker facts in every arrival order`, () => {
      const observations: ((target: ExitObservations) => void)[] = [
        ...cohort.map((value) => (target: ExitObservations) => target.observeWorkflowSafety(value)),
        (target) => target.observeFailure('output_unavailable'),
        (target) => target.observeTerminatingSignal(15),
        (target) => target.observeOutcome(4),
      ];
      for (const order of permutations(observations)) {
        const facts = new ExitObservations();
        for (const observe of order) observe(facts);
        facts.observeWorkflowSafety(undefined);
        facts.observeOutcome(0);
        expect(facts.exitCode()).toBe(cohort[0]);
      }
    });
  }

  it.each(['cli_internal', 'output_unavailable'] as const)(
    '%s outranks signal and session end in either order',
    (code) => {
      for (const order of permutations<(facts: ExitObservations) => void>([
        (facts) => facts.observeFailure(code),
        (facts) => facts.observeTerminatingSignal(15),
        (facts) => facts.observeOutcome(4),
      ])) {
        const facts = new ExitObservations();
        for (const observe of order) observe(facts);
        expect(facts.exitCode()).toBe(9);
        expect(facts.infrastructureCode()).toBe(code);
      }
    },
  );

  it('keeps the first actual terminating signal while stronger faults can still arrive', () => {
    const facts = new ExitObservations();
    facts.observeTerminatingSignal(1);
    facts.observeTerminatingSignal(15);
    facts.observeOutcome(1);
    expect(facts.exitCode()).toBe(129);
    facts.observeFailure('cli_internal');
    expect(facts.exitCode()).toBe(9);
  });

  it.each(ordinaryOutcomes)(
    'background failure only upgrades otherwise-zero outcome %s',
    (outcome) => {
      for (const backgroundFirst of [false, true]) {
        const facts = new ExitObservations();
        if (backgroundFirst) facts.observeBackgroundFailure();
        facts.observeOutcome(outcome);
        if (!backgroundFirst) facts.observeBackgroundFailure();
        expect(facts.exitCode()).toBe(outcome === 0 ? 9 : outcome);
      }
    },
  );

  it('background keepalive preserves signal and actual safety', () => {
    const facts = new ExitObservations();
    facts.observeBackgroundFailure();
    facts.observeTerminatingSignal(2);
    expect(facts.exitCode()).toBe(130);
    facts.observeWorkflowSafety(6);
    expect(facts.exitCode()).toBe(6);
  });

  it.each(ordinaryOutcomes.filter((value) => value !== 0))(
    'keeps established ordinary %s through subsequent success and other outcomes',
    (outcome) => {
      const facts = new ExitObservations();
      facts.observeOutcome(outcome);
      for (const other of ordinaryOutcomes) facts.observeOutcome(other);
      expect(facts.exitCode()).toBe(outcome);
    },
  );

  it('distinguishes operational ownership refusal from actual workflow fencing', () => {
    const refusal = new ExitObservations();
    refusal.observeFailure('run_owned_elsewhere');
    expect(refusal.exitCode()).toBe(6);
    refusal.observeFailure('cli_internal');
    expect(refusal.exitCode()).toBe(9);
    refusal.observeWorkflowSafety(6);
    expect(refusal.exitCode()).toBe(6);
  });

  it.each([
    ['internal', 1],
    ['storage_unavailable', 1],
    ['invalid_invocation', 2],
    ['config_error', 2],
    ['config_write_refused', 2],
    ['not_implemented', 2],
  ] as const)('preserves explicit %s classification', (code, exit) => {
    const facts = new ExitObservations();
    facts.observeFailure(code);
    expect(facts.exitCode()).toBe(exit);
    expect(facts.infrastructureCode()).toBeUndefined();
  });

  it('keeps output diagnosis distinct when unexpected failure also occurs', () => {
    const facts = new ExitObservations();
    facts.observeFailure('output_unavailable');
    facts.observeFailure('cli_internal');
    expect(facts.infrastructureCode()).toBe('output_unavailable');
  });

  it.each([0, -1, 128, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'refuses invalid external signal %s without changing facts',
    (signal) => {
      const facts = new ExitObservations();
      expect(() => facts.observeTerminatingSignal(signal)).toThrow();
      expect(facts.exitCode()).toBe(0);
      facts.observeTerminatingSignal(15);
      expect(facts.exitCode()).toBe(143);
    },
  );
  it.each(['safety', 'outcome', 'failure'] as const)(
    'refuses invalid runtime %s observations without changing existing facts or coercing values',
    (channel) => {
      const touched = vi.fn(() => {
        throw new Error('must not inspect or coerce private observation');
      });
      const canary = Object.defineProperties(
        {},
        {
          code: { get: touched },
          origin: { get: touched },
          valueOf: { get: touched },
          toString: { get: touched },
          [Symbol.toPrimitive]: { get: touched },
        },
      );
      const invalid: readonly unknown[] = [
        null,
        true,
        false,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -1,
        1.5,
        9,
        143,
        '8',
        '__proto__',
        'constructor',
        'toString',
        Symbol('invalid observation'),
        canary,
        new String('internal'),
        ...(channel === 'safety'
          ? [0, 1, 2, 3, 4]
          : channel === 'outcome'
            ? [5, 7, 8, undefined]
            : [0, 1, undefined]),
      ];
      for (const initial of [0, 1] as const) {
        const facts = new ExitObservations();
        facts.observeOutcome(initial);
        const observe =
          channel === 'safety'
            ? facts.observeWorkflowSafety.bind(facts)
            : channel === 'outcome'
              ? facts.observeOutcome.bind(facts)
              : facts.observeFailure.bind(facts);
        for (const value of invalid) {
          expect(() => {
            Reflect.apply(observe, facts, [value]);
          }).toThrow();
          expect(facts.exitCode()).toBe(initial);
          expect(facts.infrastructureCode()).toBeUndefined();
        }
      }
      expect(touched).not.toHaveBeenCalled();
    },
  );
});
