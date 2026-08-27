/**
 * The two deadline cases that genuinely need a platform type, kept in this package for exactly that reason.
 *
 * `openDeadline` lives in `@relavium/shared` ([ADR-0085](../../../docs/decisions/0085-the-node-executor-owes-liveness-and-the-engine-enforces-it.md) §9)
 * and the other eleven cases live beside it in `packages/shared/src/deadline.test.ts`, where they are
 * MEASURED against the code they exercise. These two cannot follow: proving that an abandoned step is
 * discarded HANDLED requires `process.on('unhandledRejection')`, and `@relavium/shared` sets `types: []` so
 * that a stray `process`/`Buffer` is a compile error — a boundary worth more than file adjacency.
 *
 * They are not decoration. Node's default is `--unhandled-rejections=throw`, so the defect they pin killed
 * the process mid-turn with a stack trace instead of surfacing the `timeout` the caller had just computed;
 * a review reproduced it as `unhandled= 1`.
 */

import { describe, expect, it } from 'vitest';

import { openDeadline, type AbortControllerLike } from './attempt-deadline.js';

/** A platform-free controller — the seam has no ambient `AbortController`. */
function controller(): AbortControllerLike {
  let aborted = false;
  const listeners = new Set<() => void>();
  return {
    signal: {
      get aborted() {
        return aborted;
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
    abort: () => {
      if (aborted) return;
      aborted = true;
      for (const l of [...listeners]) l();
    },
  };
}

/** A manual one-shot timer: `fire()` advances the clock, `armed()` proves cleanup. */
function manualTimer(): {
  set: (ms: number, fire: () => void) => () => void;
  fire: () => void;
  armed: () => number;
} {
  const pending = new Set<() => void>();
  return {
    set: (_ms, fire) => {
      pending.add(fire);
      return () => pending.delete(fire);
    },
    fire: () => {
      for (const f of [...pending]) {
        pending.delete(f);
        f();
      }
    },
    armed: () => pending.size,
  };
}

describe('openDeadline — the unhandled-rejection cases (ADR-0082 §12)', () => {
  it('does not leave the abandoned step UNHANDLED when the caller pre-aborted', async () => {
    // The same hazard the deadline arm documents: the step is already invoked, so returning without a
    // handler leaves a live promise nobody owns, and Node's default is `--unhandled-rejections=throw`.
    const caller = controller();
    caller.abort();
    const timer = manualTimer();
    const scope = openDeadline(120_000, controller, timer.set, caller.signal);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await scope.race(Promise.reject(new Error('late provider rejection')));
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    scope.dispose();
  });

  it('an already-expired scope HANDLES the step it discards', async () => {
    // `step` is `iterator.next()`, already invoked by the caller, so returning without attaching a handler
    // leaves a live promise nobody owns. The likeliest path there is the WELL-BEHAVED one: the provider
    // honours the merged abort and rejects its in-flight `next()`. Node's default is
    // `--unhandled-rejections=throw`, so that killed the process instead of surfacing the timeout.
    const timer = manualTimer();
    const scope = openDeadline(120_000, controller, timer.set);
    timer.fire(); // …the scope is now expired

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      expect(await scope.race(Promise.reject(new Error('provider aborted mid-stream')))).toEqual({
        outcome: 'deadline',
      });
      // Two macrotask turns: an unhandled rejection is reported after the microtask queue drains.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', onUnhandled);
      scope.dispose();
    }

    expect(unhandled).toEqual([]);
  });
});
