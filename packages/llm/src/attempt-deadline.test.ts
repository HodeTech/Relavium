/**
 * ADR-0082 §12's deadline acceptance — the half that can be proven without the chain.
 *
 * Every test drives a MANUAL timer and a provider-shaped promise that never settles, because the whole point
 * is that a cooperative signal is not a guarantee: the tests that matter are the ones where the provider
 * ignores it.
 */

import type { AbortSignalLike } from '@relavium/shared';
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

/** A promise that never settles — an uncooperative provider, which is the case that matters. */
const NEVER = new Promise<string>(() => undefined);

describe('openDeadline (ADR-0082 §5-§7)', () => {
  it('a step that never settles ends at the DEADLINE, not never', async () => {
    // The whole item: `generate(): Promise<LlmResult> { return new Promise(() => {}) }` used to hang the
    // chain forever, because the abort signal is a request and this provider ignores it.
    const timer = manualTimer();
    const scope = openDeadline(120_000, controller, timer.set);

    const raced = scope.race(NEVER);
    timer.fire();

    expect(await raced).toEqual({ outcome: 'deadline' });
    expect(scope.classify()).toBe('deadline');
    scope.dispose();
  });

  it('the same ABSOLUTE deadline governs every step — it does not reset per chunk', async () => {
    // A per-step reset would let a provider dribble one token per interval forever, which is the hang with
    // extra steps. Once the deadline has tripped, a LATER step is refused without even racing.
    const timer = manualTimer();
    const scope = openDeadline(120_000, controller, timer.set);

    expect(await scope.race(Promise.resolve('chunk 1'))).toEqual({
      outcome: 'settled',
      value: 'chunk 1',
    });
    timer.fire();
    expect(await scope.race(Promise.resolve('chunk 2'))).toEqual({ outcome: 'deadline' });
    scope.dispose();
  });

  it('raises the cooperative abort too — a provider that DOES honour it stops early', () => {
    const timer = manualTimer();
    const scope = openDeadline(120_000, controller, timer.set);

    expect(scope.signal.aborted).toBe(false);
    timer.fire();
    expect(scope.signal.aborted).toBe(true);
    scope.dispose();
  });

  it('a CALLER abort wins a same-tick tie with the deadline', () => {
    // Precedence resolved at classification time, not by listener order — ADR-0036's cancel-wins rule. A
    // test pinning listener order would be pinning a scheduler detail.
    const caller = controller();
    const timer = manualTimer();
    const scope = openDeadline(120_000, controller, timer.set, caller.signal);

    caller.abort();
    timer.fire(); // both fired, same tick

    expect(scope.classify()).toBe('caller');
    scope.dispose();
  });

  it('…and a deadline with no caller abort classifies `deadline` — the negative control', () => {
    const caller = controller();
    const timer = manualTimer();
    const scope = openDeadline(120_000, controller, timer.set, caller.signal);

    timer.fire();

    expect(scope.classify()).toBe('deadline');
    scope.dispose();
  });

  it('a caller that ALREADY aborted is honoured without a listener', () => {
    // Matching a native signal: a listener registered after the abort never fires, so the constructor has
    // to check first or the attempt would run unbounded under an already-cancelled caller.
    const caller = controller();
    caller.abort();
    const timer = manualTimer();
    const scope = openDeadline(120_000, controller, timer.set, caller.signal);

    expect(scope.signal.aborted).toBe(true);
    expect(scope.classify()).toBe('caller');
    scope.dispose();
  });

  it('dispose disarms the timer — including on the SUCCESS path', () => {
    // A leaked timer holds the process awake, which on a CLI is a hang the user cannot explain. The success
    // path is the one most likely to forget.
    const timer = manualTimer();
    const scope = openDeadline(120_000, controller, timer.set);

    expect(timer.armed()).toBe(1);
    scope.dispose();
    expect(timer.armed()).toBe(0);
    scope.dispose(); // idempotent
    expect(timer.armed()).toBe(0);
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

  it('dispose settles anything still racing, so no promise outlives the scope', async () => {
    const timer = manualTimer();
    const scope = openDeadline(120_000, controller, timer.set);

    const raced = scope.race(NEVER);
    scope.dispose();

    expect(await raced).toEqual({ outcome: 'deadline' });
  });

  it('detaches its caller listener on dispose', () => {
    let attached = 0;
    const signal: AbortSignalLike = {
      aborted: false,
      addEventListener: () => {
        attached += 1;
      },
      removeEventListener: () => {
        attached -= 1;
      },
    };
    const timer = manualTimer();
    const scope = openDeadline(120_000, controller, timer.set, signal);

    expect(attached).toBe(1);
    scope.dispose();
    expect(attached).toBe(0);
  });
});
