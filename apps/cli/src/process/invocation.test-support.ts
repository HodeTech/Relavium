import { vi } from 'vitest';

import { createInvocationFiniteExit } from './invocation-finite-exit.js';
import { InvocationRegistry } from './invocation-registry.js';

/** Explicit unit-test exit/clock ports; a pending product obligation cannot exit the Vitest worker. */
export function invocationFixture() {
  let now = 0;
  const timers = new Map<() => void, number>();
  const clock = {
    now: () => now,
    schedule: (ms: number, fire: () => void) => {
      timers.set(fire, now + ms);
      return () => {
        timers.delete(fire);
      };
    },
  };
  const exit = vi.fn();
  const registry = new InvocationRegistry(clock);
  const invocation = {
    registry,
    finiteExit: createInvocationFiniteExit(registry, clock, { exit, setExitCode: vi.fn() }),
    seedFileCatalogOnce: () => Promise.resolve(),
  };
  return {
    invocation,
    registry,
    exit,
    advance: (time: number) => {
      now = time;
      for (const [fire, at] of [...timers]) if (at <= time && timers.delete(fire)) fire();
    },
  };
}
