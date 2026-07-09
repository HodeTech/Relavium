import { describe, expect, it } from 'vitest';

import {
  effectiveOffset,
  INITIAL_SCROLL,
  parseMouseScroll,
  reduceScroll,
  scrollMotionForKey,
  type ScrollGeometry,
  type ScrollState,
} from './scroll.js';

// A transcript of 100 lines in a 10-row viewport ⇒ maxOffset 90 (the tail's top-line index).
const geom: ScrollGeometry = { totalLines: 100, height: 10 };
const following: ScrollState = { offset: 0, following: true };
const at = (offset: number): ScrollState => ({ offset, following: false });

describe('effectiveOffset (2.6.F Step 4b-2)', () => {
  it('is the tail (maxOffset) while following, regardless of the stored offset', () => {
    expect(effectiveOffset(following, geom)).toBe(90); // 100 - 10
    expect(effectiveOffset({ offset: 5, following: true }, geom)).toBe(90); // stored offset ignored while following
  });

  it('is the clamped stored offset while not following', () => {
    expect(effectiveOffset(at(30), geom)).toBe(30);
    expect(effectiveOffset(at(999), geom)).toBe(90); // clamped to the tail
    expect(effectiveOffset(at(-5), geom)).toBe(0); // clamped to the top
  });

  it('is 0 when the content fits the viewport (maxOffset 0)', () => {
    expect(effectiveOffset(following, { totalLines: 5, height: 10 })).toBe(0);
  });
});

describe('reduceScroll', () => {
  it('line-up from following starts at the tail, moves up one row, and PAUSES following', () => {
    const next = reduceScroll(following, 'line-up', geom);
    expect(next).toEqual({ offset: 89, following: false }); // tail 90 → 89, paused
  });

  it('page-up from following moves up (height-1) rows with a one-row overlap, paused', () => {
    const next = reduceScroll(following, 'page-up', geom);
    expect(next).toEqual({ offset: 81, following: false }); // 90 - (10 - 1)
  });

  it('page-down toward the bottom RESUMES following when it lands at maxOffset', () => {
    // From offset 85 (paused), a page-down (+9) overshoots 90 ⇒ clamps to 90 ⇒ resumes following.
    expect(reduceScroll(at(85), 'page-down', geom)).toEqual({ offset: 90, following: true });
    // From offset 70, a page-down lands at 79 (still above the tail) ⇒ stays paused.
    expect(reduceScroll(at(70), 'page-down', geom)).toEqual({ offset: 79, following: false });
  });

  it('line-down that reaches the bottom resumes following; one short of it stays paused', () => {
    expect(reduceScroll(at(89), 'line-down', geom)).toEqual({ offset: 90, following: true });
    expect(reduceScroll(at(88), 'line-down', geom)).toEqual({ offset: 89, following: false });
  });

  it('top jumps to 0 and pauses following; bottom jumps to the tail and resumes it', () => {
    expect(reduceScroll(following, 'top', geom)).toEqual({ offset: 0, following: false });
    expect(reduceScroll(at(0), 'bottom', geom)).toEqual({ offset: 90, following: true });
  });

  it('clamps at the top: scrolling up past 0 stays at 0 (paused)', () => {
    expect(reduceScroll(at(3), 'page-up', geom)).toEqual({ offset: 0, following: false });
    expect(reduceScroll(at(0), 'line-up', geom)).toEqual({ offset: 0, following: false });
  });

  it('a page overlaps by exactly one row (height-1), so a full page-up then page-down does not lose a row', () => {
    const up = reduceScroll(following, 'page-up', geom); // 90 → 81
    const down = reduceScroll(up, 'page-down', geom); // 81 + 9 = 90 → resumes following
    expect(down).toEqual({ offset: 90, following: true });
  });

  it('degenerate geometry: content fits (maxOffset 0) ⇒ every motion stays at 0 and FOLLOWING (nothing to scroll)', () => {
    const fits: ScrollGeometry = { totalLines: 4, height: 10 };
    for (const motion of ['line-up', 'page-up', 'top', 'line-down', 'bottom'] as const) {
      const next = reduceScroll(following, motion, fits);
      expect(next.offset).toBe(0);
      expect(next.following).toBe(true); // offset 0 >= max 0 ⇒ at the bottom ⇒ following
    }
  });

  it('degenerate viewport height 0/1 ⇒ a page degrades to a single-row step (never a non-advancing page)', () => {
    const tiny: ScrollGeometry = { totalLines: 100, height: 1 }; // maxOffset 99
    expect(reduceScroll({ offset: 99, following: true }, 'page-up', tiny)).toEqual({
      offset: 98, // 99 - max(1, 1-1) = 99 - 1
      following: false,
    });
    const zero: ScrollGeometry = { totalLines: 100, height: 0 }; // maxOffset 100
    expect(reduceScroll({ offset: 100, following: true }, 'page-up', zero)).toEqual({
      offset: 99, // step of 1 (max(1, 0-1) = 1)
      following: false,
    });
  });

  it('INITIAL_SCROLL follows the tail', () => {
    expect(INITIAL_SCROLL).toEqual({ offset: 0, following: true });
    expect(effectiveOffset(INITIAL_SCROLL, geom)).toBe(90);
  });
});

describe('scrollMotionForKey', () => {
  it('maps PgUp/PgDn to page motions', () => {
    expect(scrollMotionForKey({ pageUp: true })).toBe('page-up');
    expect(scrollMotionForKey({ pageDown: true })).toBe('page-down');
  });

  it('maps Ctrl+Home / Ctrl+End to top / bottom', () => {
    expect(scrollMotionForKey({ ctrl: true, home: true })).toBe('top');
    expect(scrollMotionForKey({ ctrl: true, end: true })).toBe('bottom');
  });

  it('leaves BARE Home/End to the editor (line-start/line-end) — no scroll collision', () => {
    expect(scrollMotionForKey({ home: true })).toBeUndefined();
    expect(scrollMotionForKey({ end: true })).toBeUndefined();
  });

  it('returns undefined for a non-scroll key (the caller falls through to the editor/overlay routing)', () => {
    expect(scrollMotionForKey({})).toBeUndefined();
    expect(scrollMotionForKey({ ctrl: true })).toBeUndefined();
    expect(scrollMotionForKey({ upArrow: true } as never)).toBeUndefined();
  });
});

describe('parseMouseScroll (2.6.F Step 5 — mouse-wheel)', () => {
  const wheelUp = '\x1b[<64;10;5M'; // SGR mouse: button 64 = wheel up
  const wheelDown = '\x1b[<65;10;5M'; // button 65 = wheel down
  const click = '\x1b[<0;10;5M'; // button 0 = left click (a non-wheel report)

  it('maps a wheel notch to a line motion (up reveals older, down toward the tail)', () => {
    expect(parseMouseScroll(wheelUp)).toBe('line-up');
    expect(parseMouseScroll(wheelDown)).toBe('line-down');
  });

  it('parses with OR without the leading ESC (ink may hand the CSI to `input` either way)', () => {
    expect(parseMouseScroll('[<64;10;5M')).toBe('line-up'); // no ESC
    expect(parseMouseScroll('[<65;120;40m')).toBe('line-down'); // release form `m` too
  });

  it('returns `ignore` for a non-wheel mouse report (a click/drag) — CONSUMED, never typed, never scrolls', () => {
    expect(parseMouseScroll(click)).toBe('ignore');
    expect(parseMouseScroll('\x1b[<32;5;5M')).toBe('ignore'); // button 32 = drag
  });

  it('returns undefined for input that is not a mouse report (a normal key / typed text)', () => {
    expect(parseMouseScroll('q')).toBeUndefined();
    expect(parseMouseScroll('\x1b[5~')).toBeUndefined(); // PgUp — a key, not a mouse report
    expect(parseMouseScroll('')).toBeUndefined();
    expect(parseMouseScroll('[<64;10;5X')).toBeUndefined(); // malformed terminator
  });
});
