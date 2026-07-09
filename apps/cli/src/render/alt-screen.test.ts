import { describe, expect, it } from 'vitest';

import {
  CLEAR_ALT_SCREEN,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
  createAltScreenController,
} from './alt-screen.js';

/**
 * The hoisted DECSET-1049 controller (2.6.F Step 4b-3, ADR-0068 §c). These pin the two guarantees the flicker fix
 * rests on: (1) the alt buffer is entered ONCE and exited ONCE (no per-session flip), and (2) `restore()` is
 * IDEMPOTENT + safe from every exit net, and NEVER exits a buffer it never entered (the inline / non-TTY path writes
 * nothing at all).
 */
describe('createAltScreenController (2.6.F Step 4b-3)', () => {
  const sink = (): { write: (s: string) => void; out: string[] } => {
    const out: string[] = [];
    return { write: (s) => out.push(s), out };
  };

  it('active: enters once (alt + hide cursor), a repeat enter is a no-op', () => {
    const { write, out } = sink();
    const c = createAltScreenController({ write, active: true });
    c.enter();
    c.enter(); // repeat
    expect(out).toEqual([ENTER_ALT_SCREEN + HIDE_CURSOR]); // exactly once
    expect(c.isEntered()).toBe(true);
  });

  it('active: restores once (exit + show cursor), IDEMPOTENT across many nets', () => {
    const { write, out } = sink();
    const c = createAltScreenController({ write, active: true });
    c.enter();
    c.restore(); // the finally
    c.restore(); // the process.on('exit') net
    c.restore(); // a signal handler
    expect(out).toEqual([ENTER_ALT_SCREEN + HIDE_CURSOR, EXIT_ALT_SCREEN + SHOW_CURSOR]);
    expect(c.isEntered()).toBe(false);
  });

  it('NEVER exits a buffer it never entered (a restore with no prior enter writes nothing)', () => {
    const { write, out } = sink();
    const c = createAltScreenController({ write, active: true });
    c.restore(); // no enter happened (e.g. a fault before the loop entered)
    expect(out).toEqual([]);
  });

  it('inactive (inline / non-TTY / --json / CI): every method writes NOTHING (byte-identical opt-out)', () => {
    const { write, out } = sink();
    const c = createAltScreenController({ write, active: false });
    c.enter();
    c.clearBetween();
    c.restore();
    expect(out).toEqual([]);
    expect(c.isEntered()).toBe(false);
  });

  it('clearBetween clears the persistent buffer while entered, and is a no-op once restored', () => {
    const { write, out } = sink();
    const c = createAltScreenController({ write, active: true });
    c.clearBetween(); // before enter → no-op
    expect(out).toEqual([]);
    c.enter();
    c.clearBetween(); // between sessions → clears
    expect(out.at(-1)).toBe(CLEAR_ALT_SCREEN);
    c.restore();
    const afterRestore = out.length;
    c.clearBetween(); // after restore → no-op (buffer is gone)
    expect(out.length).toBe(afterRestore);
  });

  it('the byte sequences match ink 7 exactly (so the hoisted toggle is indistinguishable from ink)', () => {
    // DECSET/DECRST 1049 (alt buffer), DECTCEM 25 (cursor), CUP+ED (clear) — verbatim from ink/build.
    expect(ENTER_ALT_SCREEN).toBe('\x1b[?1049h');
    expect(EXIT_ALT_SCREEN).toBe('\x1b[?1049l');
    expect(HIDE_CURSOR).toBe('\x1b[?25l');
    expect(SHOW_CURSOR).toBe('\x1b[?25h');
    expect(CLEAR_ALT_SCREEN).toBe('\x1b[H\x1b[J');
  });
});
