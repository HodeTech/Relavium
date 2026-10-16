import { describe, expect, it, vi } from 'vitest';
import { createBackgroundObserver } from './background-observer.js';
import {
  ExitObservations,
  type OrdinaryExit,
  type WorkflowSafetyExit,
} from './exit-observations.js';
import { InvocationRegistry } from './invocation-registry.js';

function fixture(initial: string | number | null | undefined = undefined) {
  const observations = new ExitObservations();
  let exitCode = initial;
  const records: string[] = [];
  const outputFailed = vi.fn();
  const observer = createBackgroundObserver({
    observations,
    policy: { json: true, verbosity: 'verbose' },
    readExitCode: () => exitCode,
    setExitCode: (code) => {
      exitCode = code;
    },
    write: (text) => {
      records.push(text);
      return Promise.resolve();
    },
    outputFailed,
  });
  return { observations, records, outputFailed, observer, exitCode: () => exitCode };
}

describe('bounded background keepalive observer', () => {
  it('does not inspect even hostile Error fields and saturates at five records plus one suppression', () => {
    const f = fixture();
    const touched = vi.fn(() => {
      throw new Error('secret getter');
    });
    const reason = Object.defineProperties(new Error(), {
      message: { get: touched },
      cause: { get: touched },
      stack: { get: touched },
      toString: { get: touched },
      [Symbol.toPrimitive]: { get: touched },
    });
    expect(f.observer.occurred()).toBe(false);
    for (let index = 0; index < 10_000; index++) f.observer.observe(reason);
    expect(touched).not.toHaveBeenCalled();
    expect(f.records, 'BACKGROUND_DIAGNOSTIC_BOUND').toHaveLength(6);
    expect(new Set(f.records.slice(0, 5)).size).toBe(1);
    expect(f.records[5]).toContain('Further background failures suppressed.');
    for (const text of f.records)
      expect(JSON.parse(text)).toMatchObject({ type: 'error', code: 'cli_internal' });
    expect(f.exitCode()).toBe(9);
    expect(f.observations.exitCode()).toBe(9);
    expect(f.observations.hasInfrastructureFailure()).toBe(false);
    expect(f.observer.occurred()).toBe(true);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 130, 143, '2'])(
    'case %#: preserves established native exit %s',
    (code) => {
      const f = fixture(code);
      f.observer.observe(new Error('private'));
      expect(f.exitCode(), 'BACKGROUND_NONZERO_PRESERVATION').toBe(code);
    },
  );

  it.each([undefined, null, 0])('upgrades clean native exit %s only', (code) => {
    const f = fixture(code);
    f.observer.observe(undefined);
    expect(f.exitCode()).toBe(9);
  });

  it('preserves actual ordinary, workflow and signal facts and leaves admission open', () => {
    for (const code of [1, 2, 3, 4, 6] satisfies OrdinaryExit[]) {
      const f = fixture(code);
      f.observations.observeOutcome(code);
      f.observer.observe(null);
      expect(f.observations.exitCode()).toBe(code);
    }
    for (const code of [5, 6, 7, 8] satisfies WorkflowSafetyExit[]) {
      const f = fixture(code);
      f.observations.observeWorkflowSafety(code);
      f.observer.observe(null);
      expect(f.observations.exitCode()).toBe(code);
    }
    const f = fixture(143);
    f.observations.observeTerminatingSignal(15);
    f.observer.observe(null);
    expect(f.observations.exitCode()).toBe(143);
    const registry = new InvocationRegistry(
      { now: () => 0, schedule: () => () => undefined },
      f.observations,
    );
    registry.assertAdmitting();
    expect(registry.termination).toBeUndefined();
  });

  it.each(['reject', 'throw'] as const)(
    'reports %s diagnostic delivery once without recursive records',
    async (mode) => {
      const outputFailed = vi.fn();
      const write = vi.fn(() => {
        if (mode === 'throw') throw new Error('private output error');
        return Promise.reject(new Error('private output error'));
      });
      const observer = createBackgroundObserver({
        observations: new ExitObservations(),
        policy: { json: true, verbosity: 'verbose' },
        readExitCode: () => 0,
        setExitCode: () => undefined,
        write,
        outputFailed,
      });
      observer.observe(new Error('private rejection'));
      await Promise.resolve();
      expect(write).toHaveBeenCalledOnce();
      expect(outputFailed).toHaveBeenCalledOnce();
    },
  );
});
