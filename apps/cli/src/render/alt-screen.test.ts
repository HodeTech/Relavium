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
  homeAfterInkEnter,
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

  it('the first frame starts at the top of the alternate screen: the enter homes the cursor and clears, before the cursor is hidden and the mouse armed', () => {
    // xterm's 1049 leaves the cursor at the shell's row, so with twelve shell lines above the launch a frame drawn after a bare 1049h started at
    // row twelve and snapped up at the next full redraw (a popup opening or closing).
    const { write, out } = sink();
    createAltScreenController({ write, active: true }).enter();
    expect(out).toEqual(['\x1b[?1049h\x1b[H\x1b[J\x1b[?25l\x1b[?1002h\x1b[?1006h']);
    const plain = sink();
    createAltScreenController({ write: plain.write, active: true, mouse: false }).enter();
    expect(plain.out).toEqual(['\x1b[?1049h\x1b[H\x1b[J\x1b[?25l']);
  });

  it('the reclaim after a job-control stop enters the same way: the cursor home and the clear follow the 1049h', () => {
    const { write, out } = sink();
    const c = createAltScreenController({ write, active: true });
    c.enter();
    expect(c.releaseForSuspend()).toBe(true);
    c.reclaimAfterSuspend();
    expect(out.at(-1)).toBe('\x1b[?1049h\x1b[H\x1b[J\x1b[?25l\x1b[?1002h\x1b[?1006h');
  });

  it('the byte sequences match ink 7 exactly (so the hoisted toggle is indistinguishable from ink)', () => {
    // DECSET/DECRST 1049 (alt buffer), DECTCEM 25 (cursor), CUP+ED (clear) — verbatim from ink/build, except the ENTER: ink's is the
    // 1049h alone, and the hoisted toggle follows it with the cursor home and the clear (see the first-frame test below).
    expect(ENTER_ALT_SCREEN).toBe('\x1b[?1049h\x1b[H\x1b[J');
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

/** The chat REPL has a tiny no-Ink interval between `/clear`/reseat sessions while its hoisted 1049 controller stays
 * alive. G0 uses this reversible pair there: job control must hand the shell a normal primary buffer, then reclaim
 * the exact state on SIGCONT — never call the FINAL `restore()` just because the process was briefly stopped. */
describe('createAltScreenController — reversible job-control release', () => {
  it('temporarily releases and reclaims the live buffer without tripping the final restore latch', () => {
    const out: string[] = [];
    const alt = createAltScreenController({
      write: (sequence) => out.push(sequence),
      active: true,
    });
    alt.enter();

    expect(alt.releaseForSuspend()).toBe(true);
    expect(out).toEqual([ENTER_SEQ, EXIT_SEQ]);
    expect(alt.isEntered()).toBe(false);
    expect(alt.isMouseEnabled()).toBe(false);

    alt.reclaimAfterSuspend();
    expect(out).toEqual([ENTER_SEQ, EXIT_SEQ, ENTER_SEQ]);
    expect(alt.isEntered()).toBe(true);
    expect(alt.isMouseEnabled()).toBe(true);

    alt.restore(); // still a live controller — final teardown remains available after a suspend/resume cycle
    expect(out).toEqual([ENTER_SEQ, EXIT_SEQ, ENTER_SEQ, EXIT_SEQ]);
  });

  it('does not double-release, and a failed temporary release never invents a reclaim', () => {
    const writes: string[] = [];
    let failRelease = true;
    const alt = createAltScreenController({
      write: (sequence) => {
        if (sequence === EXIT_SEQ && failRelease) {
          failRelease = false;
          throw new Error('EIO');
        }
        writes.push(sequence);
      },
      active: true,
    });
    alt.enter();

    expect(alt.releaseForSuspend()).toBe(false);
    alt.reclaimAfterSuspend();
    expect(writes).toEqual([ENTER_SEQ]);

    expect(alt.releaseForSuspend()).toBe(true);
    expect(alt.releaseForSuspend()).toBe(false);
    expect(writes).toEqual([ENTER_SEQ, EXIT_SEQ]);
  });

  it('a final restore while temporarily released keeps the primary buffer visible', () => {
    const out: string[] = [];
    const alt = createAltScreenController({
      write: (sequence) => out.push(sequence),
      active: true,
    });
    alt.enter();
    alt.releaseForSuspend();
    alt.restore();
    alt.reclaimAfterSuspend(); // final state wins: a process that exits while stopped must not re-enter 1049

    expect(out).toEqual([ENTER_SEQ, EXIT_SEQ]);
    expect(alt.isEntered()).toBe(false);
  });
});

/**
 * The bare Home mounts ink with its own `alternateScreen` option, and ink writes the enter without a cursor home (xterm's 1049 leaves the cursor
 * where the shell had it): the Home's first frame started at the shell's row. The Home gives ink its stdout through this wrapper.
 */
describe('homeAfterInkEnter', () => {
  const INK_ENTER = '\x1b[?1049h';
  const fakeStream = (): {
    readonly stream: {
      write: (chunk: unknown, ...rest: unknown[]) => boolean;
      columns: number;
      isTTY: boolean;
      mark: () => string;
    };
    readonly written: unknown[][];
  } => {
    const written: unknown[][] = [];
    const stream = {
      columns: 97,
      isTTY: true,
      write(chunk: unknown, ...rest: unknown[]): boolean {
        written.push([chunk, ...rest]);
        return true;
      },
      // A method that needs its own `this`: the wrapper must bind it to the stream, not to the proxy.
      mark(this: { columns: number }): string {
        return `cols=${String(this.columns)}`;
      },
    };
    return { stream, written };
  };

  it("writes ink's enter as the full enter (the cursor home and the clear follow it)", () => {
    const { stream, written } = fakeStream();
    homeAfterInkEnter(stream).write(INK_ENTER);
    expect(written).toEqual([[ENTER_ALT_SCREEN]]);
    expect(ENTER_ALT_SCREEN).toBe(INK_ENTER + CLEAR_ALT_SCREEN);
  });

  it('keeps the other arguments of the write (encoding, callback) and every other write untouched', () => {
    const { stream, written } = fakeStream();
    const callback = (): void => undefined;
    const wrapped = homeAfterInkEnter(stream);
    wrapped.write(INK_ENTER, 'utf8', callback);
    wrapped.write('a frame');
    wrapped.write(`${INK_ENTER}x`);
    wrapped.write(EXIT_ALT_SCREEN);
    expect(written).toEqual([
      [ENTER_ALT_SCREEN, 'utf8', callback],
      ['a frame'],
      [`${INK_ENTER}x`],
      [EXIT_ALT_SCREEN],
    ]);
  });

  it("is the stream otherwise: properties are the stream's, a method runs on the stream", () => {
    const { stream } = fakeStream();
    const wrapped = homeAfterInkEnter(stream);
    expect(wrapped.columns).toBe(97);
    expect(wrapped.isTTY).toBe(true);
    expect(wrapped.mark()).toBe('cols=97');
  });

  it("takes ink's real enter: a mounted ink with the alternate screen writes the home and the clear right after it", async () => {
    const { render, Text } = await import('ink');
    const { createElement } = await import('react');
    const chunks: string[] = [];
    const stdout = Object.assign(new (await import('node:events')).EventEmitter(), {
      isTTY: true,
      columns: 80,
      rows: 24,
      write(chunk: unknown): boolean {
        chunks.push(String(chunk));
        return true;
      },
    });
    // `homeAfterInkEnter` is typed over any object; ink takes the stream it is given.
    const instance = render(createElement(Text, null, 'hello'), {
      stdout: homeAfterInkEnter(stdout) as unknown as NodeJS.WriteStream,
      alternateScreen: true,
      interactive: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    instance.unmount();
    const all = chunks.join('');
    expect(all).toContain(ENTER_ALT_SCREEN);
    expect(all.indexOf(ENTER_ALT_SCREEN)).toBeLessThan(all.indexOf('hello'));
  });
});
