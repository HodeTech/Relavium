import { describe, expect, it, vi } from 'vitest';

import {
  guardMcpTeardown,
  MCP_TEARDOWN_GRACE_MS,
  type McpTeardownGuardOptions,
} from './mcp-signal-teardown.js';

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
 *
 * The suite covers BOTH halves. The cooperative half awaits `close()`; the synchronous `process.on('exit')`
 * half exists because the cooperative one cannot cover an exit nobody awaits — and `driveRun`'s own
 * second-Ctrl-C force-quit is exactly such an exit, which a first version of this guard left re-orphaning the
 * children it was mid-way through reaping.
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

/** A `process.on('exit')` stand-in the test can fire deliberately. */
function fakeExitNet(): {
  subscribe: (onExit: () => void) => () => void;
  fire: () => void;
  subscribed: () => boolean;
} {
  let handler: (() => void) | undefined;
  return {
    subscribe: (onExit) => {
      handler = onExit;
      return () => {
        handler = undefined;
      };
    },
    fire: () => handler?.(),
    subscribed: () => handler !== undefined,
  };
}

const never = (): Promise<void> => new Promise<void>(() => undefined);
const none = (): readonly number[] => [];

/** The common wiring: a controllable signal source, exit net, kill capture and exit capture. */
function harness(overrides: Partial<McpTeardownGuardOptions> = {}): {
  signals: ReturnType<typeof fakeSignals>;
  exitNet: ReturnType<typeof fakeExitNet>;
  killed: number[];
  exit: ReturnType<typeof vi.fn>;
  options: McpTeardownGuardOptions;
} {
  const signals = fakeSignals();
  const exitNet = fakeExitNet();
  const killed: number[] = [];
  const exit = vi.fn();
  return {
    signals,
    exitNet,
    killed,
    exit,
    options: {
      subscribeSignals: signals.subscribe,
      subscribeProcessExit: exitNet.subscribe,
      killPid: (pid: number) => {
        killed.push(pid);
      },
      exit,
      delay: never,
      ...overrides,
    },
  };
}

describe('guardMcpTeardown — the cooperative half', () => {
  it('closes the MCP client on a signal and exits 128+signo', async () => {
    const h = harness();
    const close = vi.fn(() => Promise.resolve());
    guardMcpTeardown(close, none, h.options);

    h.signals.fire(2); // SIGINT
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
      expect(h.exit).toHaveBeenCalledWith(130); // 128 + 2 — a shell pipeline still reads the signal
    });
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
    const h = harness();
    const close = vi.fn(() => Promise.resolve());
    guardMcpTeardown(close, none, h.options);

    h.signals.fire(signo);
    await vi.waitFor(() => {
      expect(h.exit).toHaveBeenCalledWith(code);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it('exits anyway when the teardown wedges, rather than hanging the shell', async () => {
    // A bound, because the whole point is that a signalled process ends. Exiting on the timer is safe
    // precisely BECAUSE the synchronous exit net below still reaps — otherwise this would be the bug again.
    const waited: number[] = [];
    const h = harness({
      delay: (ms: number) => {
        waited.push(ms);
        return Promise.resolve();
      },
    });
    guardMcpTeardown(never, none, h.options);

    h.signals.fire(15);
    await vi.waitFor(() => {
      expect(h.exit).toHaveBeenCalledWith(143);
      expect(waited).toContain(MCP_TEARDOWN_GRACE_MS);
    });
  });

  it('does not let a teardown fault stop the exit', async () => {
    const h = harness();
    guardMcpTeardown(() => Promise.reject(new Error('transport already gone')), none, h.options);

    h.signals.fire(2);
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(130));
  });

  it('latches, so a second Ctrl-C does not start a second teardown', async () => {
    const h = harness();
    const close = vi.fn(() => Promise.resolve());
    guardMcpTeardown(close, none, h.options);

    h.signals.fire(2);
    h.signals.fire(2);
    h.signals.fire(15);
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
      expect(h.exit).toHaveBeenCalledTimes(1);
    });
  });
});

describe('guardMcpTeardown — reapOnly, for a surface that owns its own exit contract', () => {
  it('reaps but does NOT exit, leaving the documented run:cancelled + exit 1 to driveRun', async () => {
    // **The blocker a review caught.** A first version exited `128+signo` unconditionally. On `relavium run`
    // that raced `driveRun`'s cooperative cancel and won whenever MCP was in play — replacing the documented
    // exit `1` with a code absent from the CLI's closed 0–7 table, and leaving the run with NO terminal in the
    // durable log, so `relavium status` would list it as active forever.
    const h = harness({ reapOnly: true });
    const close = vi.fn(() => Promise.resolve());
    guardMcpTeardown(close, none, h.options);

    h.signals.fire(2);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(h.exit).not.toHaveBeenCalled();
  });
});

describe('guardMcpTeardown — the synchronous exit net', () => {
  it('SIGKILLs every live child on process exit, covering the paths nobody awaits', () => {
    // `driveRun`'s second-Ctrl-C force-quit calls `process.exit` synchronously, abandoning any in-flight
    // async teardown. The cooperative half cannot cover that; this half is why the children still die.
    const h = harness();
    guardMcpTeardown(never, () => [4242, 4243], h.options);

    h.exitNet.fire();
    expect(h.killed).toEqual([4242, 4243]);
  });

  it('reads the pids LAZILY, so a guard armed before the connect still reaps what it spawns', () => {
    // The guard is armed BEFORE `connectWorkflowMcp` — the window where a cold `npx` runs for up to 120 s
    // with the terminal silent — so at arming time there are no children yet. A snapshot taken then would
    // reap nothing, which is the highest-probability window for the bug.
    let pids: readonly number[] = [];
    const h = harness();
    guardMcpTeardown(never, () => pids, h.options);

    h.exitNet.fire();
    expect(h.killed).toEqual([]); // nothing spawned yet
    pids = [777];
    h.exitNet.fire();
    expect(h.killed).toEqual([777]);
  });

  it('is registered even in reapOnly mode — the exit is the caller’s, the children are not', () => {
    const h = harness({ reapOnly: true });
    guardMcpTeardown(never, () => [99], h.options);

    h.exitNet.fire();
    expect(h.killed).toEqual([99]);
  });

  it('survives a kill that throws, because at exit time there is nothing to report to', () => {
    // ESRCH (already reaped by the cooperative half — the ordinary case) and EPERM (a recycled pid) both
    // throw. Neither may stop the loop reaping the REMAINING children.
    const reached: number[] = [];
    const h = harness({
      killPid: (pid: number) => {
        reached.push(pid);
        if (pid === 1) throw new Error('ESRCH');
      },
    });
    guardMcpTeardown(never, () => [1, 2], h.options);

    expect(() => h.exitNet.fire()).not.toThrow();
    expect(reached).toEqual([1, 2]);
  });
});

describe('guardMcpTeardown — the production defaults', () => {
  it('registers on the REAL process signals and exit, and removes both', () => {
    // Every other test injects `subscribeSignals`, so the default — the four-signal subscription every
    // surface shares — was never taken. A review pointed out that with the surface binding also missing, the
    // real registration path had zero coverage from either end.
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      sighup: process.listenerCount('SIGHUP'),
      sigquit: process.listenerCount('SIGQUIT'),
      exit: process.listenerCount('exit'),
    };
    const unguard = guardMcpTeardown(() => Promise.resolve(), none);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
    expect(process.listenerCount('SIGHUP')).toBe(before.sighup + 1);
    expect(process.listenerCount('SIGQUIT')).toBe(before.sigquit + 1);
    expect(process.listenerCount('exit')).toBe(before.exit + 1);
    unguard();
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.listenerCount('SIGHUP')).toBe(before.sighup);
    expect(process.listenerCount('SIGQUIT')).toBe(before.sigquit);
    expect(process.listenerCount('exit')).toBe(before.exit);
  });

  it('keeps the grace short enough to serve its own stated purpose', () => {
    // The other grace test asserts the guard passes the exported constant — which a literal `delay(500)` would
    // redden, but which stays green if the constant itself becomes an hour. The bound's whole justification is
    // that a wedged transport must not turn Ctrl-C into a hung shell, so the VALUE needs an assertion too.
    expect(MCP_TEARDOWN_GRACE_MS).toBeLessThanOrEqual(5_000);
    expect(MCP_TEARDOWN_GRACE_MS).toBeGreaterThan(0);
  });
});

describe('guardMcpTeardown — unsubscribe', () => {
  it('removes BOTH subscriptions when the caller finishes normally', () => {
    // Leaving either registered would hold a handle on a process exiting cleanly — and the exit net would
    // SIGKILL pids the `finally` had already closed, which is harmless but is a listener nobody owns.
    const h = harness();
    const close = vi.fn(() => Promise.resolve());
    const unguard = guardMcpTeardown(close, () => [5], h.options);

    expect(h.signals.subscribed()).toBe(true);
    expect(h.exitNet.subscribed()).toBe(true);
    unguard();
    expect(h.signals.subscribed()).toBe(false);
    expect(h.exitNet.subscribed()).toBe(false);

    h.signals.fire(2);
    h.exitNet.fire();
    expect(close).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.killed).toEqual([]);
  });

  it('is idempotent, so a caller may unguard on more than one path', () => {
    const h = harness();
    const unguard = guardMcpTeardown(() => Promise.resolve(), none, h.options);
    expect(() => {
      unguard();
      unguard();
    }).not.toThrow();
  });
});
