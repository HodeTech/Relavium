/**
 * The strip's retry backoff (`strip-backoff.ts`) over a scripted timer: the delay each failure calls for, the timer a failure moves, the
 * resets, and the cancel that leaves nothing behind. `home-strip-refresh.test.ts` drives the same wrapper through the real controller.
 */
import { describe, expect, it } from 'vitest';

import type { ChangeToken } from '../../history/change-probe.js';
import { createStripBackoff, STRIP_BACKOFF_MAX_MS, stripRetryDelay } from './strip-backoff.js';

const BASE = 5000;

/** A timer that only moves when told: every started timer is listed with the delay it was given, and `fire` runs the live ones in order. */
function scriptedTimer() {
  const started: { readonly delayMs: number; live: boolean; readonly run: () => void }[] = [];
  return {
    inner: (callback: () => void, delayMs: number): (() => void) => {
      const timer = { delayMs, live: true, run: callback };
      started.push(timer);
      return () => {
        timer.live = false;
      };
    },
    delays: (): readonly number[] => started.map((timer) => timer.delayMs),
    live: (): number => started.filter((timer) => timer.live).length,
    fireLive: (): void => {
      const timer = started.find((entry) => entry.live);
      if (timer === undefined) throw new Error('no live timer');
      timer.live = false; // a timer that fired is spent
      timer.run();
    },
  };
}
const token = (generation: number): ChangeToken => ({ dataVersion: 1, generation });

describe('stripRetryDelay', () => {
  it('is the base with no failure, then doubles for each, up to the cap', () => {
    expect([0, 1, 2, 3, 4, 5, 50, 5000].map((failures) => stripRetryDelay(BASE, failures))).toEqual(
      [
        5000,
        10_000,
        20_000,
        40_000,
        STRIP_BACKOFF_MAX_MS,
        STRIP_BACKOFF_MAX_MS,
        STRIP_BACKOFF_MAX_MS,
        STRIP_BACKOFF_MAX_MS,
      ],
    );
  });
});

describe('createStripBackoff', () => {
  it('starts the timer with the base delay and fires the callback once', () => {
    const timer = scriptedTimer();
    const backoff = createStripBackoff(timer.inner);
    let fired = 0;
    backoff.schedule(() => (fired += 1), BASE);
    expect(timer.delays()).toEqual([BASE]);
    timer.fireLive();
    expect(fired).toBe(1);
    expect(timer.live()).toBe(0);
  });

  it('a failure moves the pending timer: the old one is cancelled and a new one starts with twice the delay', () => {
    const timer = scriptedTimer();
    const backoff = createStripBackoff(timer.inner);
    backoff.schedule(() => undefined, BASE);
    backoff.failed();
    backoff.failed();
    expect(timer.delays()).toEqual([5000, 10_000, 20_000]);
    expect(timer.live(), 'only the newest is live').toBe(1);
    backoff.succeeded();
    expect(timer.delays().at(-1), 'a success starts one interval again').toBe(5000);
    expect(timer.live()).toBe(1);
  });

  it('the timer a tick arms after the failures starts with the delay they call for', () => {
    const timer = scriptedTimer();
    const backoff = createStripBackoff(timer.inner);
    // The poll's tick arms its next timer from inside the callback of the one that fired.
    backoff.schedule(() => {
      backoff.schedule(() => undefined, BASE);
    }, BASE);
    backoff.failed();
    backoff.failed();
    timer.fireLive();
    expect(timer.delays().at(-1), 'armed again with two failures behind it').toBe(20_000);
  });

  it('resets when the change token moved, and only then', () => {
    const timer = scriptedTimer();
    const backoff = createStripBackoff(timer.inner, token(0));
    backoff.schedule(() => undefined, BASE);
    backoff.failed();
    backoff.observe(token(0));
    expect(timer.delays(), 'the same token resets nothing').toEqual([5000, 10_000]);
    expect(backoff.observe(token(1))).toEqual(token(1));
    expect(timer.delays().at(-1), 'a moved token starts one interval again').toBe(5000);
  });

  it('cancel leaves nothing live, and a failure afterwards starts nothing', () => {
    const timer = scriptedTimer();
    const backoff = createStripBackoff(timer.inner);
    const cancel = backoff.schedule(() => undefined, BASE);
    backoff.failed();
    cancel();
    expect(timer.live()).toBe(0);
    backoff.failed();
    backoff.succeeded();
    expect(timer.live()).toBe(0);
  });
});
