import { describe, expect, it, vi } from 'vitest';

import {
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
  CLEAR_ALT_SCREEN,
} from '../render/alt-screen.js';
import { DISABLE_BRACKETED_PASTE } from '../render/tui/home-input.js';
import { withHoistedAltScreen, type ReplLifecycle } from './chat.js';

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
    readonly lifecycle: ReplLifecycle;
    readonly fireExit: () => void; // the captured process.on('exit') listener
    readonly fireSignal: (signo: number) => void; // the captured SIGTERM/SIGHUP listener
    readonly removeExit: ReturnType<typeof vi.fn>;
    readonly removeSignal: ReturnType<typeof vi.fn>;
    readonly setRawMode: ReturnType<typeof vi.fn>;
    readonly exit: ReturnType<typeof vi.fn>;
    readonly onProcessExit: ReturnType<typeof vi.fn>;
    readonly onTerminationSignal: ReturnType<typeof vi.fn>;
  }

  const harness = (): Harness => {
    const writes: string[] = [];
    const outs: string[] = [];
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
    return {
      writes,
      outs,
      lifecycle: { onProcessExit, onTerminationSignal, setRawMode, exit },
      fireExit: () => exitCb(),
      fireSignal: (signo) => signalCb(signo),
      removeExit,
      removeSignal,
      setRawMode,
      exit,
      onProcessExit,
      onTerminationSignal,
    };
  };

  const opts = (h: Harness, active: boolean) => ({
    active,
    write: (s: string) => h.writes.push(s),
    lifecycle: h.lifecycle,
    writeOut: (t: string) => h.outs.push(t),
  });

  it('active: enters once, runs the loop (which clears between swaps), exits once, prints the summary AFTER the exit', async () => {
    const h = harness();
    await withHoistedAltScreen(opts(h, true), (alt) => {
      alt.clearBetween(); // a /clear swap mid-loop
      return Promise.resolve({ summaryText: 'session over' });
    });
    // Enter → clear (swap) → exit, then the summary on the PRIMARY buffer (after the exit).
    expect(h.writes).toEqual([
      ENTER_ALT_SCREEN + HIDE_CURSOR,
      CLEAR_ALT_SCREEN,
      EXIT_ALT_SCREEN + SHOW_CURSOR,
    ]);
    expect(h.outs).toEqual(['session over\n']);
    // The last write (the alt-exit) precedes the summary print — the summary lands on the primary buffer.
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
    expect(h.writes.filter((w) => w === EXIT_ALT_SCREEN + SHOW_CURSOR)).toHaveLength(1);
    expect(h.writes[0]).toBe(ENTER_ALT_SCREEN + HIDE_CURSOR);
  });

  it('a SIGTERM/SIGHUP handler restores the FULL terminal state (buffer + paste + raw mode) then exits (128+signo)', async () => {
    const h = harness();
    await withHoistedAltScreen(opts(h, true), () => {
      h.fireSignal(15); // SIGTERM
      return Promise.resolve({ summaryText: undefined });
    });
    // The signal handler owns the whole restore since it suppresses ink's now-inert signal-exit.
    expect(h.writes).toContain(EXIT_ALT_SCREEN + SHOW_CURSOR); // alt buffer + cursor
    expect(h.writes).toContain(DISABLE_BRACKETED_PASTE); // bracketed paste off
    expect(h.setRawMode).toHaveBeenCalledWith(false); // raw mode restored
    expect(h.exit).toHaveBeenCalledWith(143); // 128 + 15 (SIGTERM)
  });

  it('a SIGHUP is 128+1 = 129', async () => {
    const h = harness();
    await withHoistedAltScreen(opts(h, true), () => {
      h.fireSignal(1); // SIGHUP
      return Promise.resolve({});
    });
    expect(h.exit).toHaveBeenCalledWith(129);
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
    expect(h.writes).toEqual([ENTER_ALT_SCREEN + HIDE_CURSOR, EXIT_ALT_SCREEN + SHOW_CURSOR]); // restored on throw
    expect(h.outs).toEqual([]); // no summary (the loop never returned one)
    expect(h.removeExit).toHaveBeenCalledTimes(1);
    expect(h.removeSignal).toHaveBeenCalledTimes(1);
  });
});
