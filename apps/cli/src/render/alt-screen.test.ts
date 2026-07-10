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
    // Step 6: 1002 (button-EVENT tracking) not 1000 — it adds motion-while-held, i.e. the DRAG the in-app text
    // selection is built on. Never 1003 (any-motion), which reports every pointer move with no button held.
    expect(ENABLE_MOUSE).toBe('\x1b[?1002h\x1b[?1006h');
    // The disable covers 1000 TOO: a disable of a never-enabled mode is a no-op, and an earlier Relavium — or any
    // other program in this terminal — may have left 1000 armed. Stranding DECSET-1000 ruins the user's shell.
    expect(DISABLE_MOUSE).toBe('\x1b[?1006l\x1b[?1002l\x1b[?1000l');
    expect(DISABLE_MOUSE).toContain('?1000l');
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

/**
 * The idempotence latch and a FAILING terminal write (2.6.F Step 6h, Sonnet review). `restore()` runs from a
 * `finally`, from a `process.on('exit')` listener and from signal handlers, deliberately overlapping. It used to set
 * `restored = true` BEFORE the write, so one transient fault (an EIO on a half-dead TTY) marked the terminal restored
 * and every later net declined to try — leaving the user on the alt buffer with mouse reporting on, permanently.
 */
describe('createAltScreenController — a failed restore must not disarm the later nets', () => {
  /** A write sink that throws on the Nth call (1-based) and records every write that lands. */
  const failOnCall = (n: number): { write: (s: string) => void; writes: string[] } => {
    const writes: string[] = [];
    let call = 0;
    return {
      writes,
      write: (s: string) => {
        call += 1;
        if (call === n) throw new Error('EIO');
        writes.push(s);
      },
    };
  };

  it('a THROWING restore leaves the latch down, so the next net retries and the terminal is reclaimed', () => {
    // Call 1 is `enter`'s write; call 2 is the first `restore`'s, and it fails. Call 3 is the retry — the
    // `process.on('exit')` net, or a signal handler, or the `finally`.
    const sink = failOnCall(2);
    const alt = createAltScreenController({ write: sink.write, active: true });
    alt.enter();
    expect(sink.writes).toHaveLength(1);

    alt.restore(); // the write throws; swallowed, and the latch stays DOWN
    expect(sink.writes).toHaveLength(1);

    alt.restore(); // the retry
    expect(sink.writes).toHaveLength(2);
    expect(sink.writes[1]).toContain(EXIT_ALT_SCREEN);
    expect(sink.writes[1]).toContain(DISABLE_MOUSE);
  });

  it('restore() NEVER throws — it runs from an `exit` listener, where a throw is an uncaught exception', () => {
    const alt = createAltScreenController({
      write: () => {
        throw new Error('EIO');
      },
      active: true,
    });
    expect(() => alt.enter()).toThrow(); // enter may throw: the caller decides
    expect(() => alt.restore()).not.toThrow(); // restore may not
  });

  it('a SUCCESSFUL restore still latches — the overlapping nets write exactly once', () => {
    const sink = failOnCall(0); // never fails
    const alt = createAltScreenController({ write: sink.write, active: true });
    alt.enter();
    alt.restore();
    alt.restore();
    alt.restore();
    expect(sink.writes.filter((w) => w.includes(EXIT_ALT_SCREEN))).toHaveLength(1);
  });

  it('a THROWING enter does not latch, so restore never exits a buffer the terminal is not in', () => {
    const flaky = failOnCall(1);
    const alt = createAltScreenController({ write: flaky.write, active: true });
    expect(() => alt.enter()).toThrow();
    alt.restore();
    expect(flaky.writes).toEqual([]); // nothing was entered, so nothing is exited
    expect(alt.isEntered()).toBe(false);
  });
});
