/**
 * The deadline primitive's acceptance — ADR-0082 §12's half that needs no chain, plus the branches a review
 * proved nothing held.
 *
 * Every test drives a MANUAL timer and a step that never settles, because the whole point is that a
 * cooperative signal is not a guarantee: the tests that matter are the ones where the callee ignores it.
 *
 * **Why this file lives here, after first being left in `@relavium/llm`.** ADR-0085 §9 moved `openDeadline`
 * into this package and I kept its suite next to the re-export, reasoning that this package's `types: []`
 * boundary forbids the `process.on('unhandledRejection')` two of the cases need. A review measured what that
 * cost: the tests execute `@relavium/shared` from `dist/`, so V8 attributed **0%** to `deadline.ts` while the
 * 90% floor that used to guard it (`vitest.config.ts`, `packages/llm/src/**`) was left holding a 35-line
 * re-export shell scoring a perfect 100. The enforced branch number went UP while the guarantee went away —
 * and the pre-move report's "uncovered line 102" was `onCallerAbort`'s waiter wake, exactly the branch that
 * turned out to be untested. So the eleven cases that need no platform type live here, where they are
 * measured against the code they exercise; the two that genuinely need `process` stay in
 * `@relavium/llm/src/attempt-deadline.test.ts` and say so.
 */

import { describe, expect, it } from 'vitest';

import type { AbortSignalLike } from './content.js';
import { openDeadline, type AbortControllerLike } from './deadline.js';

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
describe('openDeadline (ADR-0082 §5-§7, ADR-0085 §9)', () => {
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

  it('a PRE-ABORTED caller settles the race IMMEDIATELY — without waiting for the deadline', async () => {
    // The liveness half the neighbouring test does not cover: it asserts `signal.aborted` and `classify()`,
    // both of which were already right, and never races anything. A review measured what that hid — with a
    // provider that ignores its signal, `race()` stayed pending until the ABSOLUTE timer fired, so a cancel
    // landing in the gap between the loop's own check and `openDeadline` (during `preAttempt`, or credential
    // resolution) looked ignored for the shipped default of 120 seconds.
    //
    // The timer is never fired here, and that is the assertion: settling proves the caller latch woke it.
    const caller = controller();
    caller.abort();
    const timer = manualTimer();
    const scope = openDeadline(120_000, controller, timer.set, caller.signal);

    await expect(scope.race(NEVER)).resolves.toEqual({ outcome: 'deadline' });
    expect(timer.armed()).toBe(1); // …still armed: nothing fired it
    expect(scope.classify()).toBe('caller'); // …and the REASON is still caller cancellation
    scope.dispose();
    expect(timer.armed()).toBe(0);
  });

  it('a caller aborting BETWEEN races settles the next one immediately too', async () => {
    // The latch has to survive past the wake: `onCallerAbort` wakes the waiters that exist AT THAT MOMENT,
    // so a race registered afterwards would have had nothing to observe without the stored flag.
    const caller = controller();
    const timer = manualTimer();
    const scope = openDeadline(120_000, controller, timer.set, caller.signal);

    expect(await scope.race(Promise.resolve('chunk 1'))).toEqual({
      outcome: 'settled',
      value: 'chunk 1',
    });
    caller.abort(); // …no race is in flight, so there is no waiter to wake
    await expect(scope.race(NEVER)).resolves.toEqual({ outcome: 'deadline' });
    expect(timer.armed()).toBe(1);
    expect(scope.classify()).toBe('caller');
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

  // ——— The branches a review proved nothing held. Each one below was DELETED from `deadline.ts` and the
  // entire 782-test `@relavium/llm` suite stayed green; that is why they exist. ———

  it('a caller aborting MID-RACE settles that race immediately — not at the deadline', async () => {
    // The gap that mattered most. The suite covered a caller aborting BEFORE a race and BETWEEN races, and
    // nothing covered the common shape: the user hits Ctrl-C while `race()` is already awaiting. Deleting
    // `onCallerAbort`'s `for (const wake of waiters) wake();` left all 782 llm tests green — and that line is
    // literally what the pre-move coverage report flagged as uncovered. The failure it readmits is the one
    // this file's own header records a review catching: the race stays pending to the ABSOLUTE deadline, so
    // a cancel looks ignored for two minutes on the shipped default.
    const timer = manualTimer();
    const caller = controller();
    const scope = openDeadline(120_000, controller, timer.set, caller.signal);
    const raced = scope.race(NEVER);
    await Promise.resolve(); // let `race` register its waiter — the state this test is about
    caller.abort();
    // No `timer.fire()`: if the deadline had to fire for this to settle, the defect is present.
    expect(await raced).toEqual({ outcome: 'deadline' });
    expect(scope.classify()).toBe('caller');
    scope.dispose();
  });

  it('a caller abort mid-race raises the COOPERATIVE abort too', async () => {
    // Asymmetric with the deadline path, which is covered: deleting `controller.abort()` from `trip` reddens
    // a test, deleting the identical call from `onCallerAbort` reddened nothing. Without it the caller still
    // gets liveness from the latch, so the run LOOKS fine — while the provider is never told to stop and a
    // real `fetch` keeps streaming and billing.
    const timer = manualTimer();
    const caller = controller();
    const scope = openDeadline(120_000, controller, timer.set, caller.signal);
    const raced = scope.race(NEVER);
    await Promise.resolve();
    caller.abort();
    await raced;
    expect(scope.signal.aborted).toBe(true);
    scope.dispose();
  });

  it('dispose is idempotent — asserted on the DISARM COUNT, not on a set that cannot say', () => {
    // The prior assertion (`dispose(); dispose(); expect(armed()).toBe(0)`) could not fail: the harness
    // disarm is `pending.delete(fire)`, and `Set.delete` on an absent element is already a no-op, so it
    // proved `Set.delete` idempotent rather than `dispose`. Removing `if (disposed) return;` left 771 green.
    // Counting invocations is what makes the contract at `DeadlineScope.dispose` ("Idempotent; safe on every
    // exit path") an assertion instead of a comment.
    let disarms = 0;
    const counting = (_ms: number, fire: () => void): (() => void) => {
      void fire;
      return () => {
        disarms += 1;
      };
    };
    const scope = openDeadline(120_000, controller, counting);
    scope.dispose();
    scope.dispose();
    scope.dispose();
    expect(disarms).toBe(1);
  });

  // **`waiters.delete(wake)` in `race`'s `finally` is NOT covered, and this is the honest record of why.**
  // A first attempt at a test here was HOLLOW: it ran three settled races, called `dispose()`, and asserted
  // the timer was disarmed. Deleting the line left it green — because a leaked waiter's promise is ALREADY
  // settled, so `dispose()` waking it again changes nothing observable.
  //
  // The consequence of the leak is real (the set grows one closure per `race()` for the scope's lifetime —
  // on a long stream, one per chunk) but it is memory growth, which this public surface cannot express.
  // Reaching it would need a test-only accessor on the scope, and this phase already refused that shape once
  // for `#turnCount` (`CR-02`): production surface added to make a test possible is a worse trade than a
  // named gap.
  //
  // **The mutation that would close it, stated so the next reader does not re-derive it:** replace the
  // `finally { waiters.delete(wake); }` body with a no-op and assert `waiters.size` is 0 after a settled
  // race — which requires that accessor. Recorded rather than asserted, per this phase's discipline rule 3.
});
