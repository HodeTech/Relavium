import { describe, expect, it, vi } from 'vitest';

import { guardMcpTeardown, MCP_TEARDOWN_GRACE_MS } from './mcp-signal-teardown.js';

/**
 * `#21` / [ADR-0088](../../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §1.3 — a signalled
 * one-shot command must not orphan the MCP children it spawned.
 *
 * **The bug was measured before this was written**, with a host that spawned a child exactly the way the MCP
 * SDK does (no `detached`, piped stdio): sending `SIGTERM` printed no teardown line and left the child alive
 * with **`ppid 1`**. `run` and `agent run` both tear down in a `finally`, and Node's default signal handling
 * terminates without unwinding one — so the teardown they rely on never ran.
 *
 * A terminal `Ctrl-C` frequently hides this, because the TTY signals the whole foreground group. That is a
 * property of how the signal was delivered, not of the code, which is why these tests drive the handler
 * directly rather than through a TTY.
 */

/** A signal source under the test's control, plus a way to fire one. */
function fakeSignals(): {
  subscribe: (onSignal: (signo: number) => void) => () => void;
  fire: (signo: number) => void;
  subscribed: () => boolean;
} {
  let handler: ((signo: number) => void) | undefined;
  return {
    subscribe: (onSignal) => {
      handler = onSignal;
      return () => {
        handler = undefined;
      };
    },
    fire: (signo) => handler?.(signo),
    subscribed: () => handler !== undefined,
  };
}

const never = (): Promise<void> => new Promise<void>(() => undefined);

describe('guardMcpTeardown', () => {
  it('closes the MCP client on a signal and exits 128+signo', async () => {
    // The whole point: without the guard, neither of these happens — the process dies and the children are
    // re-parented to `init`.
    const signals = fakeSignals();
    const close = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    guardMcpTeardown(close, { subscribeSignals: signals.subscribe, exit, delay: never });

    signals.fire(2); // SIGINT
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130); // 128 + 2 — a shell pipeline still reads the signal
  });

  it.each([
    ['SIGHUP', 1, 129],
    ['SIGINT', 2, 130],
    ['SIGQUIT', 3, 131],
    ['SIGTERM', 15, 143],
  ])('reaps on %s and exits %i+128 = %i', async (_name, signo, code) => {
    // All four, not just SIGINT: SIGHUP is what a user gets by closing the terminal window, and SIGTERM is
    // what a supervisor or an IDE stop button sends — the two deliveries where the process group does NOT
    // save us, which is exactly how the orphan was reproduced.
    const signals = fakeSignals();
    const close = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    guardMcpTeardown(close, { subscribeSignals: signals.subscribe, exit, delay: never });

    signals.fire(signo);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(code));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('exits anyway when the teardown wedges, rather than hanging the shell', async () => {
    // A bound, because the whole point is that a signalled process ends. A child the OS re-parents is the
    // same outcome as the bug; a stuck foreground process is WORSE than it, so the timer wins.
    const signals = fakeSignals();
    const exit = vi.fn();
    // A recorder rather than a mock: the assertion is on the VALUE the guard asked to wait for, and reading
    // it back from a list keeps the injected function a plain `(ms) => Promise<void>` the seam actually takes.
    const waited: number[] = [];
    const delay = (ms: number): Promise<void> => {
      waited.push(ms);
      return Promise.resolve();
    };
    guardMcpTeardown(never, { subscribeSignals: signals.subscribe, exit, delay });

    signals.fire(15);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    expect(waited).toContain(MCP_TEARDOWN_GRACE_MS);
  });

  it('does not let a teardown fault stop the exit', async () => {
    // The process is ending on a signal; a close error has no reader and must not become a hang.
    const signals = fakeSignals();
    const exit = vi.fn();
    guardMcpTeardown(() => Promise.reject(new Error('transport already gone')), {
      subscribeSignals: signals.subscribe,
      exit,
      delay: never,
    });

    signals.fire(2);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
  });

  it('latches, so a second Ctrl-C does not start a second teardown', async () => {
    // A user who does not see an immediate exit presses again. Two concurrent teardowns racing over the same
    // connections is how an idempotent close stops being idempotent in practice.
    const signals = fakeSignals();
    const close = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    guardMcpTeardown(close, { subscribeSignals: signals.subscribe, exit, delay: never });

    signals.fire(2);
    signals.fire(2);
    signals.fire(15);
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes when the caller finishes normally — the finally owns the teardown there', () => {
    // Leaving the listener registered would close a second time and hold a handle on a process exiting
    // cleanly. The returned unsubscribe is what `run.ts` / `agent-run.ts` call in their own `finally`.
    const signals = fakeSignals();
    const close = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const unguard = guardMcpTeardown(close, {
      subscribeSignals: signals.subscribe,
      exit,
      delay: never,
    });

    expect(signals.subscribed()).toBe(true);
    unguard();
    expect(signals.subscribed()).toBe(false);
    signals.fire(2); // nothing is listening any more
    expect(close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
