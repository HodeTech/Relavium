import { useEffect, useState } from 'react';

import { waitClockText, waitSinceText } from './sheet-frame.js';

/**
 * The wait clock of a sheet ([ADR-0147](../../../../../docs/decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md)
 * §2) as its host draws it: display state that is in NO snapshot and that no guard reads.
 *
 * - **Derived at render.** The text is computed from the display clock each time the host renders ({@link waitClockFor}); nothing stores it.
 * - **One timer, owned by the sheet's host.** In the alternate screen one unref'd one-second timer re-renders the host, and only when the
 *   quantised text changed: once a second for the first minute, then once a minute. It is cleared when the sheet closes (its origin goes) and
 *   when the host unmounts, and a tick that arrives after either does nothing.
 * - **Inline nothing ticks.** The inline form is the static `waiting since HH:MM`; no timer is started at all.
 *
 * The host re-renders its own state, so no store is flushed for the clock and no snapshot changes: the measured-frame acknowledgement compares
 * the card's own state by reference, and a tick leaves it the same object.
 */

/** How the clock is drawn: ticking in the alternate screen, the static `waiting since` inline. */
export type WaitClockForm = 'ticking' | 'static';

/** The timer's period: the smallest unit the clock shows. */
export const WAIT_CLOCK_TICK_MS = 1000;

/** How a host's sheets draw the clock: ticking in the alternate screen, static inline (a host that does not say is inline). */
export function waitClockForm(alternateScreen: boolean | undefined): WaitClockForm {
  return alternateScreen === true ? 'ticking' : 'static';
}

/** The clock's text for a sheet waiting since `sinceMs` (wall clock), at `nowMs`; empty with no origin. */
export function waitClockFor(
  sinceMs: number | undefined,
  form: WaitClockForm,
  nowMs: number,
): string {
  if (sinceMs === undefined) return '';
  return form === 'static' ? waitSinceText(sinceMs) : waitClockText(nowMs - sinceMs);
}

/**
 * The clock's text, derived now, and the one timer that re-renders the host when the text would change. `now` is the display clock (a test
 * injects one); it must be a stable function, or the timer restarts on every render.
 */
export function useWaitClock(
  sinceMs: number | undefined,
  form: WaitClockForm = 'static',
  now: () => number = Date.now,
): string {
  const [, repaint] = useState('');
  useEffect(() => {
    if (sinceMs === undefined || form === 'static') return undefined;
    let live = true;
    let shown = waitClockFor(sinceMs, form, now());
    const timer = setInterval(() => {
      if (!live) return;
      const next = waitClockFor(sinceMs, form, now());
      // Skipped when the quantised text did not change: after the first minute a frame is drawn only at the minute boundary.
      if (next === shown) return;
      shown = next;
      repaint(next);
    }, WAIT_CLOCK_TICK_MS);
    timer.unref();
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [sinceMs, form, now]);
  return waitClockFor(sinceMs, form, now());
}
