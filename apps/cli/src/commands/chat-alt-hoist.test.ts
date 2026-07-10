import { createSuspendPort, type SuspendPort } from '../render/suspend.js';
import { describe, expect, it, vi } from 'vitest';

import {
  CLEAR_ALT_SCREEN,
  DISABLE_MOUSE,
  ENABLE_MOUSE,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from '../render/alt-screen.js';
import { DISABLE_BRACKETED_PASTE } from '../render/tui/home-input.js';
import { defaultReplLifecycle, withHoistedAltScreen, type ReplLifecycle } from './chat.js';

const ENTER_SEQ = ENTER_ALT_SCREEN + HIDE_CURSOR + ENABLE_MOUSE;
const EXIT_SEQ = DISABLE_MOUSE + EXIT_ALT_SCREEN + SHOW_CURSOR;

/**
 * `withHoistedAltScreen` — the alt-buffer HOIST + its EXIT-SAFETY net (2.6.F Step 4b-3, ADR-0068 §c). This is the
 * highest-risk seam of the flicker fix: with ink's render option `alternateScreen:false`, ink no longer restores the
 * primary buffer on ANY path, so this wrapper must restore on every one. These pin: the buffer is entered once /
 * exited once, the summary prints AFTER the exit (primary buffer), a `process.exit` force-quit + a SIGTERM/SIGHUP are
 * both restored, and the inline / non-TTY path writes nothing at all. The real-TTY signal paths (double-Ctrl-C, kill
 * -TERM) are validated by hand at PR time — here we pin the pure orchestration around injected seams.
 */
describe('withHoistedAltScreen (2.6.F Step 4b-3, ADR-0068 §c)', () => {
  interface Harness {
    readonly writes: string[];
    readonly outs: string[];
    readonly errs: string[];
    readonly events: string[]; // a COMBINED, ordered log across write/out/err so cross-sink ordering is assertable
    readonly lifecycle: ReplLifecycle;
    readonly fireExit: () => void; // the captured process.on('exit') listener
    readonly fireSignal: (signo: number) => void; // the captured SIGTERM/SIGHUP/SIGQUIT listener
    readonly fireInterrupt: () => void; // the captured SIGINT listener (the rebuild-window net)
    readonly removeExit: ReturnType<typeof vi.fn>;
    readonly removeSignal: ReturnType<typeof vi.fn>;
    readonly removeInterrupt: ReturnType<typeof vi.fn>;
    readonly setRawMode: ReturnType<typeof vi.fn>;
    readonly exit: ReturnType<typeof vi.fn>;
    readonly onProcessExit: ReturnType<typeof vi.fn>;
    readonly onTerminationSignal: ReturnType<typeof vi.fn>;
    readonly onInterrupt: ReturnType<typeof vi.fn>;
  }

  const harness = (): Harness => {
    const writes: string[] = [];
    const outs: string[] = [];
    const errs: string[] = [];
    const events: string[] = [];
    let exitCb: () => void = () => {};
    let signalCb: (signo: number) => void = () => {};
    const removeExit = vi.fn();
    const removeSignal = vi.fn();
    const setRawMode = vi.fn();
    const exit = vi.fn();
    const onProcessExit = vi.fn((cb: () => void) => {
      exitCb = cb;
      return removeExit;
    });
    const onTerminationSignal = vi.fn((cb: (signo: number) => void) => {
      signalCb = cb;
      return removeSignal;
    });
    let interruptCb: () => void = () => undefined;
    const removeInterrupt = vi.fn();
    const onInterrupt = vi.fn((cb: () => void) => {
      interruptCb = cb;
      return removeInterrupt;
    });
    return {
      writes,
      outs,
      errs,
      events,
      lifecycle: { onProcessExit, onTerminationSignal, onInterrupt, setRawMode, exit },
      fireExit: () => exitCb(),
      fireSignal: (signo) => signalCb(signo),
      fireInterrupt: () => interruptCb(),
      removeExit,
      removeSignal,
      removeInterrupt,
      onInterrupt,
      setRawMode,
      exit,
      onProcessExit,
      onTerminationSignal,
    };
  };

  const opts = (h: Harness, active: boolean) => ({
    active,
    write: (s: string) => {
      h.writes.push(s);
      h.events.push(`write:${s}`);
    },
    lifecycle: h.lifecycle,
    writeOut: (t: string) => {
      h.outs.push(t);
      h.events.push(`out:${t}`);
    },
    writeErr: (t: string) => {
      h.errs.push(t);
      h.events.push(`err:${t}`);
    },
  });

  it('active: enters once, runs the loop (which clears between swaps), exits once, prints the summary AFTER the exit', async () => {
    const h = harness();
    await withHoistedAltScreen(opts(h, true), (alt) => {
      alt.clearBetween(); // a /clear swap mid-loop
      return Promise.resolve({ summaryText: 'session over' });
    });
    // Enter → clear (swap) → exit, THEN the summary. Asserted on the COMBINED `events` log, not on `writes` and `outs`
    // separately: the whole claim of this test is a CROSS-SINK order, and two per-sink assertions cannot see it — the
    // summary could print into the still-entered alt buffer (where DECRST-1049 discards it) and both arrays would be
    // unchanged. That is the regression this test exists to catch, and it could not (whole-phase Opus review).
    expect(h.events).toEqual([
      `write:${ENTER_SEQ}`,
      `write:${CLEAR_ALT_SCREEN}`,
      `write:${EXIT_SEQ}`,
      'out:session over\n',
    ]);
    expect(h.removeExit).toHaveBeenCalledTimes(1); // the exit net was removed (cannot outlive the loop)
    expect(h.removeSignal).toHaveBeenCalledTimes(1);
  });

  it('a process.exit force-quit (the 2nd-SIGINT path) restores via the onProcessExit net — and the finally is a NO-OP (idempotent)', async () => {
    const h = harness();
    await withHoistedAltScreen(opts(h, true), () => {
      h.fireExit(); // simulate driveInk's onSigint → process.exit firing the 'exit' net mid-loop
      return Promise.resolve({ summaryText: undefined });
    });
    // Exactly ONE alt-exit despite BOTH the net AND the finally calling restore() (the controller latch).
    expect(h.writes.filter((w) => w === EXIT_SEQ)).toHaveLength(1);
    expect(h.writes[0]).toBe(ENTER_SEQ);
  });

  it('a SIGTERM/SIGHUP handler restores the FULL terminal state (buffer + paste + raw mode) then exits (128+signo)', async () => {
    const h = harness();
    await withHoistedAltScreen(opts(h, true), () => {
      h.fireSignal(15); // SIGTERM
      return Promise.resolve({ summaryText: undefined });
    });
    // The signal handler owns the whole restore since it suppresses ink's now-inert signal-exit.
    expect(h.writes).toContain(EXIT_SEQ); // alt buffer + cursor
    expect(h.writes).toContain(DISABLE_BRACKETED_PASTE); // bracketed paste off
    expect(h.setRawMode).toHaveBeenCalledWith(false); // raw mode restored
    expect(h.exit).toHaveBeenCalledWith(143); // 128 + 15 (SIGTERM)
  });

  it('a SIGHUP is 128+1 = 129, a SIGQUIT is 128+3 = 131 (the external kills that skip Node’s exit event)', async () => {
    const hup = harness();
    await withHoistedAltScreen(opts(hup, true), () => {
      hup.fireSignal(1); // SIGHUP
      return Promise.resolve({});
    });
    expect(hup.exit).toHaveBeenCalledWith(129);
    expect(hup.writes).toContain(EXIT_SEQ); // buffer exited (not stranded)

    const quit = harness();
    await withHoistedAltScreen(opts(quit, true), () => {
      quit.fireSignal(3); // SIGQUIT — was stranding the terminal before Step-4b-3 Opus fold
      return Promise.resolve({});
    });
    expect(quit.exit).toHaveBeenCalledWith(131);
    expect(quit.writes).toContain(EXIT_SEQ);
  });

  it('a rebuild-failure errorText is emitted via writeErr AFTER the alt-exit — on the PRIMARY buffer (Step-4b-3 fix)', async () => {
    const h = harness();
    const msg = 'could not start a new session … resume with `relavium chat-resume abc123`.\n';
    await withHoistedAltScreen(opts(h, true), () => Promise.resolve({ errorText: msg }));
    expect(h.errs).toEqual([msg]); // the actionable resume hint is emitted, not discarded in the alt buffer
    // …and AFTER the alt-exit: EXIT_ALT_SCREEN precedes the error in the combined event log, so it lands on primary.
    const exitIdx = h.events.indexOf(`write:${EXIT_SEQ}`);
    const errIdx = h.events.indexOf(`err:${msg}`);
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(errIdx).toBeGreaterThan(exitIdx); // written after DECRST-1049 → survives on the primary buffer
  });

  it('defaultReplLifecycle registers + cleanly removes SIGTERM/SIGHUP/SIGQUIT on process', () => {
    const before = {
      term: process.listenerCount('SIGTERM'),
      hup: process.listenerCount('SIGHUP'),
      quit: process.listenerCount('SIGQUIT'),
    };
    const remove = defaultReplLifecycle.onTerminationSignal(() => {});
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    expect(process.listenerCount('SIGHUP')).toBe(before.hup + 1);
    expect(process.listenerCount('SIGQUIT')).toBe(before.quit + 1);
    remove();
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(process.listenerCount('SIGHUP')).toBe(before.hup);
    expect(process.listenerCount('SIGQUIT')).toBe(before.quit);
  });

  it('inactive (inline / non-TTY / --json / CI): writes NOTHING, registers NO nets — but still prints the summary', async () => {
    const h = harness();
    await withHoistedAltScreen(opts(h, false), (alt) => {
      alt.clearBetween();
      return Promise.resolve({ summaryText: 'inline summary' });
    });
    expect(h.writes).toEqual([]); // no DECSET bytes at all — byte-identical opt-out (ADR-0068 §e)
    expect(h.onProcessExit).not.toHaveBeenCalled(); // no exit net registered when inactive
    expect(h.onTerminationSignal).not.toHaveBeenCalled();
    expect(h.outs).toEqual(['inline summary\n']); // the summary still prints (inline path is unchanged)
  });

  it('a THROW in the loop still exits the alt buffer (the finally), removes the nets, and propagates — no summary', async () => {
    const h = harness();
    const boom = new Error('loop exploded');
    await expect(withHoistedAltScreen(opts(h, true), () => Promise.reject(boom))).rejects.toBe(
      boom,
    );
    expect(h.writes).toEqual([ENTER_SEQ, EXIT_SEQ]); // restored on throw
    expect(h.outs).toEqual([]); // no summary (the loop never returned one)
    expect(h.removeExit).toHaveBeenCalledTimes(1);
    expect(h.removeSignal).toHaveBeenCalledTimes(1);
  });

  /**
   * THE REBUILD WINDOW (2.6.F Step 6g, whole-phase Opus review). SIGINT belongs to ink: while a tree is mounted,
   * `driveInk`'s `onSigintGated` runs the cooperative `/cancel`, and during a `/scrollback` or `/edit` hatch it
   * DROPS the signal so the suspension can reclaim the terminal. But a `/clear` or `/models` rebuild unmounts ink
   * and mounts a fresh tree, and in that window nothing listens for SIGINT — Node's default action kills the process
   * WITHOUT firing `'exit'`, so the `onProcessExit` net never runs and the alt buffer, mouse reporting and the hidden
   * cursor are stranded on the user's shell.
   */
  it('a THROWING alt.enter() still runs the finally — the nets are removed and the summary is not lost', async () => {
    // `enter()`'s write can throw on a dead TTY. It used to run BEFORE the try, so the `finally` never ran, and the
    // nets (had any been registered) would have outlived the loop. Flagged by the PR bot once 6h-1 made `enter` throw.
    const h = harness();
    const throwing = {
      ...opts(h, true),
      write: (s_: string) => {
        if (s_.includes(ENTER_ALT_SCREEN)) throw new Error('EIO');
        h.writes.push(s_);
      },
    };
    await expect(
      withHoistedAltScreen(throwing, () => Promise.resolve({ summaryText: 'never runs' })),
    ).rejects.toThrow('EIO');
    expect(h.writes).toEqual([]); // nothing entered ⇒ nothing exited
    expect(h.outs).toEqual([]); // the loop never ran, so there is no summary
  });

  describe('the SIGINT net covers the window where no ink tree is mounted', () => {
    /** A port that reports whether an ink tree is attached — exactly what `createSuspendPort().current()` does. */
    const portWith = (attached: boolean): SuspendPort => {
      const port = createSuspendPort();
      if (attached) port.attach((cb) => cb());
      return port;
    };

    it('restores the terminal and exits 130 when NO ink tree is attached', async () => {
      const h = harness();
      await withHoistedAltScreen(
        {
          active: true,
          write: (s_) => h.writes.push(s_),
          lifecycle: h.lifecycle,
          writeOut: () => undefined,
          writeErr: () => undefined,
          suspendPort: portWith(false),
        },
        () => {
          h.fireInterrupt();
          return Promise.resolve({});
        },
      );
      expect(h.exit).toHaveBeenCalledWith(130);
      expect(h.writes.join('')).toContain(DISABLE_MOUSE);
      expect(h.writes.join('')).toContain(EXIT_ALT_SCREEN);
      expect(h.setRawMode).toHaveBeenCalledWith(false);
    });

    it('DEFERS to ink when a tree IS attached — Ctrl-C there is the cooperative /cancel, not a kill', async () => {
      const h = harness();
      await withHoistedAltScreen(
        {
          active: true,
          write: (s_) => h.writes.push(s_),
          lifecycle: h.lifecycle,
          writeOut: () => undefined,
          writeErr: () => undefined,
          suspendPort: portWith(true),
        },
        () => {
          h.fireInterrupt();
          return Promise.resolve({});
        },
      );
      expect(h.exit).not.toHaveBeenCalled();
    });

    it('registers no SIGINT net when the alt screen is inactive (inline / --json)', async () => {
      const h = harness();
      await withHoistedAltScreen(
        {
          active: false,
          write: (s_) => h.writes.push(s_),
          lifecycle: h.lifecycle,
          writeOut: () => undefined,
          writeErr: () => undefined,
          suspendPort: portWith(false),
        },
        () => Promise.resolve({}),
      );
      expect(h.onInterrupt).not.toHaveBeenCalled();
    });

    it('removes the SIGINT net when the loop ends — it must not outlive the hoist', async () => {
      const h = harness();
      await withHoistedAltScreen(
        {
          active: true,
          write: (s_) => h.writes.push(s_),
          lifecycle: h.lifecycle,
          writeOut: () => undefined,
          writeErr: () => undefined,
          suspendPort: portWith(false),
        },
        () => Promise.resolve({}),
      );
      expect(h.removeInterrupt).toHaveBeenCalledTimes(1);
    });

    it('the PRODUCTION lifecycle registers SIGINT separately from the termination signals', () => {
      const before = process.listenerCount('SIGINT');
      const off = defaultReplLifecycle.onInterrupt(() => undefined);
      expect(process.listenerCount('SIGINT')).toBe(before + 1);
      off();
      expect(process.listenerCount('SIGINT')).toBe(before);
    });
  });
});
