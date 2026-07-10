import { describe, expect, it } from 'vitest';

import {
  CLEAR_ALT_SCREEN,
  DISABLE_MOUSE,
  ENABLE_MOUSE,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
  createAltScreenController,
} from './alt-screen.js';

const ENTER_SEQ = ENTER_ALT_SCREEN + HIDE_CURSOR + ENABLE_MOUSE;
const EXIT_SEQ = DISABLE_MOUSE + EXIT_ALT_SCREEN + SHOW_CURSOR;

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
    expect(out).toEqual([ENTER_SEQ]); // exactly once (alt + hide cursor + enable mouse)
    expect(c.isEntered()).toBe(true);
  });

  it('active: restores once (exit + show cursor), IDEMPOTENT across many nets', () => {
    const { write, out } = sink();
    const c = createAltScreenController({ write, active: true });
    c.enter();
    c.restore(); // the finally
    c.restore(); // the process.on('exit') net
    c.restore(); // a signal handler
    expect(out).toEqual([ENTER_SEQ, EXIT_SEQ]);
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
    expect(out).toHaveLength(afterRestore);
  });

  it('the byte sequences match ink 7 exactly (so the hoisted toggle is indistinguishable from ink)', () => {
    // DECSET/DECRST 1049 (alt buffer), DECTCEM 25 (cursor), CUP+ED (clear) — verbatim from ink/build.
    expect(ENTER_ALT_SCREEN).toBe('\x1b[?1049h');
    expect(EXIT_ALT_SCREEN).toBe('\x1b[?1049l');
    expect(HIDE_CURSOR).toBe('\x1b[?25l');
    expect(SHOW_CURSOR).toBe('\x1b[?25h');
    expect(CLEAR_ALT_SCREEN).toBe('\x1b[H\x1b[J');
    expect(ENABLE_MOUSE).toBe('\x1b[?1000h\x1b[?1006h'); // X11 button (incl. wheel) + SGR coords
    expect(DISABLE_MOUSE).toBe('\x1b[?1006l\x1b[?1000l'); // symmetric off
  });
});

/**
 * The `mouse` option (2.6.F Step 5e, ADR-0068 §e). `--no-mouse` / `[preferences].mouse = false` must leave the
 * emulator's native click-drag selection working — so `enter()` must not arm DECSET-1000. The DISABLE on `restore()`
 * stays unconditional: disabling a mode that was never enabled is a no-op, and an unconditional teardown can never
 * strand mouse reporting if the option is ever mis-threaded.
 */
describe('createAltScreenController — the mouse opt-out', () => {
  const sink = (): { write: (s: string) => void; out: string[] } => {
    const out: string[] = [];
    return { write: (s) => out.push(s), out };
  };

  it('mouse: false ⇒ enters WITHOUT arming mouse reporting; native selection keeps working', () => {
    const { write, out } = sink();
    const c = createAltScreenController({ write, active: true, mouse: false });
    c.enter();
    expect(out).toEqual([ENTER_ALT_SCREEN + HIDE_CURSOR]);
    expect(out[0]).not.toContain(ENABLE_MOUSE);
    expect(c.isEntered()).toBe(true);
    expect(c.isMouseEnabled()).toBe(false); // …and a hatch suspension must not "restore" what we never set
  });

  it('mouse: false ⇒ restore STILL disables (a no-op on a mode never enabled, but it can never strand DECSET-1000)', () => {
    const { write, out } = sink();
    const c = createAltScreenController({ write, active: true, mouse: false });
    c.enter();
    c.restore();
    expect(out.at(-1)).toBe(DISABLE_MOUSE + EXIT_ALT_SCREEN + SHOW_CURSOR);
  });

  it('mouse defaults to ON when the option is omitted (every pre-Step-5e caller keeps its behaviour)', () => {
    const { write, out } = sink();
    const c = createAltScreenController({ write, active: true });
    c.enter();
    expect(out).toEqual([ENTER_ALT_SCREEN + HIDE_CURSOR + ENABLE_MOUSE]);
    expect(c.isMouseEnabled()).toBe(true);
  });

  it('isMouseEnabled is false before enter and after restore (it tracks the LIVE terminal, not the option)', () => {
    const { write } = sink();
    const c = createAltScreenController({ write, active: true, mouse: true });
    expect(c.isMouseEnabled()).toBe(false);
    c.enter();
    expect(c.isMouseEnabled()).toBe(true);
    c.restore();
    expect(c.isMouseEnabled()).toBe(false);
  });

  it('inactive (inline / non-TTY) ⇒ mouse is never enabled, whatever the option says', () => {
    const { write, out } = sink();
    const c = createAltScreenController({ write, active: false, mouse: true });
    c.enter();
    expect(out).toEqual([]);
    expect(c.isMouseEnabled()).toBe(false);
  });
});
