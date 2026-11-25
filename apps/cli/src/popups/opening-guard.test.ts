/**
 * The opening guard ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3), on an
 * injected clock: nothing on a frame nobody has seen, no answer for half a second after it appeared, no answer from a key that was already
 * on its way, and the leaving keys always.
 */
import { describe, expect, it } from 'vitest';

import { createOpeningGuard, POPUP_SELECT_SETTLE_MS } from './opening-guard.js';

function rig(settleMs?: number) {
  let now = 1000;
  const guard = createOpeningGuard({ now: () => now, settleMs });
  return {
    guard,
    at: (ms: number): void => {
      now = ms;
    },
  };
}

describe('before the popup’s first measured and flushed frame', () => {
  it('admits nothing but the keys that leave', () => {
    const { guard } = rig();
    expect(guard.shownAt()).toBeUndefined();
    expect(guard.admits('navigate', 5000)).toBe(false);
    expect(guard.admits('type', 5000)).toBe(false);
    expect(guard.admits('answer', 5000)).toBe(false);
    expect(guard.admits('leave', 5000)).toBe(true);
  });
});

describe('once it appeared', () => {
  it('a key that arrived before or at the moment it appeared is no answer and moves nothing', () => {
    const { guard, at } = rig();
    at(2000);
    guard.shown();
    expect(guard.shownAt()).toBe(2000);
    expect(guard.admits('navigate', 1999)).toBe(false);
    expect(guard.admits('navigate', 2000)).toBe(false);
    expect(guard.admits('answer', 1500)).toBe(false);
    expect(guard.admits('navigate', 2001)).toBe(true);
    expect(guard.admits('type', 2001)).toBe(true);
  });

  it('nothing selects for the settle after it appeared, and an answer counts from then on', () => {
    const { guard, at } = rig();
    at(2000);
    guard.shown();
    expect(POPUP_SELECT_SETTLE_MS).toBe(500);
    expect(guard.admits('answer', 2000 + POPUP_SELECT_SETTLE_MS - 1)).toBe(false);
    expect(guard.admits('answer', 2000 + POPUP_SELECT_SETTLE_MS)).toBe(true);
  });

  it('appears once: a later frame (a repaint, a resize) does not move its origin', () => {
    const { guard, at } = rig();
    at(2000);
    guard.shown();
    at(9000);
    guard.shown();
    expect(guard.shownAt()).toBe(2000);
    expect(guard.admits('answer', 2600)).toBe(true);
  });

  it('a settle of 0 switches the settle off, and nothing else', () => {
    const { guard, at } = rig(0);
    expect(guard.admits('answer', 3000)).toBe(false);
    at(2000);
    guard.shown();
    expect(guard.admits('answer', 2000)).toBe(false);
    expect(guard.admits('answer', 2001)).toBe(true);
  });
});
