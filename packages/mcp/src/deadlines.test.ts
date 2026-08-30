import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AbortSignalLike } from '@relavium/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MCP_DEADLINES,
  McpAbortedError,
  McpDeadlineError,
  openWindow,
  raceDeadline,
  remainingMs,
  toAbortSignal,
} from './deadlines.js';
import { connectSdkTransport } from './sdk-stdio.js';

/**
 * `CR-40`'s deadline and cancellation guarantees
 * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §1), tested against the two
 * behaviours that were MEASURED broken before the ADR was written:
 *
 * 1. a transport whose `start()` never resolves hung `connectSdkTransport` **forever** — because
 *    `Client.connect` awaits `transport.start()` first and with no options at all, so the SDK's own 60 s
 *    request timeout never applied to it;
 * 2. an aborted `tools/call` was still pending 500 ms later, because the signal had nowhere to go.
 *
 * The suite deliberately asserts that the transport is CLOSED as well as that the promise rejected. Rejecting
 * without closing leaves the SDK transport running, which for `stdio` is a spawned child that outlives the
 * run — the orphan §1.3 forbids — and a test that only checked the promise would pass against exactly that
 * bug. That assertion binds `connectSdkTransport`'s `catch`; an earlier version ALSO threaded a `dispose`
 * into `raceDeadline`, and mutation testing showed the parameter had no owner (removing its call left every
 * test green), so it is gone rather than left as a second mechanism nobody exercises.
 */

/** A transport whose `start()` never settles — measurement 1's reproduction, as a fixture. */
function hungTransport(): { transport: Transport; closed: () => number } {
  let closes = 0;
  return {
    transport: {
      start: () => new Promise<void>(() => undefined),
      send: () => Promise.resolve(),
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    },
    closed: () => closes,
  };
}

/** A transport that connects but never answers — `start()` resolves, `send()` swallows every message. */
function muteTransport(): { transport: Transport; closed: () => number } {
  let closes = 0;
  return {
    transport: {
      start: () => Promise.resolve(),
      send: () => Promise.resolve(),
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    },
    closed: () => closes,
  };
}

/** A minimal `AbortSignalLike` that is NOT a real `AbortSignal` — the shape the engine actually passes. */
function fakeSignal(): { signal: AbortSignalLike; abort: () => void } {
  const listeners = new Set<() => void>();
  let aborted = false;
  return {
    signal: {
      get aborted() {
        return aborted;
      },
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
    },
    abort: () => {
      aborted = true;
      for (const l of [...listeners]) l();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('connectSdkTransport — the bound covers transport.start()', () => {
  it('refuses a transport whose start() never resolves, instead of hanging forever', async () => {
    // **Measurement 1, inverted into an assertion.** Before this change the same fixture hung indefinitely:
    // passing the SDK a `RequestOptions` would not have helped, because `Client.connect` awaits `start()`
    // BEFORE it issues the `initialize` request the options apply to.
    const { transport } = hungTransport();
    const promise = connectSdkTransport('hung', transport, { timeoutMs: 60 });
    await expect(promise).rejects.toBeInstanceOf(McpDeadlineError);
    await expect(promise).rejects.toMatchObject({ serverId: 'hung', phase: 'connect' });
  });

  it('CLOSES the transport when the deadline wins — the half that reaps a spawned child', async () => {
    // The assertion that separates "the promise rejected" from "no process was orphaned": for `stdio` this
    // close is what sends SIGTERM to the child. It binds `connectSdkTransport`'s own `catch`, which is the
    // ONE owner of teardown — an earlier version also passed a `dispose` into `raceDeadline`, and mutation
    // testing showed that parameter was ownerless: removing its call left this test green.
    const { transport, closed } = hungTransport();
    await expect(connectSdkTransport('hung', transport, { timeoutMs: 60 })).rejects.toBeInstanceOf(
      McpDeadlineError,
    );
    expect(closed()).toBeGreaterThan(0);
  });

  it('CLOSES the transport when the caller cancels, and reports a cancellation — not a timeout', async () => {
    const { transport, closed } = hungTransport();
    const { signal, abort } = fakeSignal();
    const promise = connectSdkTransport('hung', transport, { timeoutMs: 30_000, signal });
    abort();
    await expect(promise).rejects.toBeInstanceOf(McpAbortedError);
    expect(closed()).toBeGreaterThan(0);
  });

  it('honours an authored window LONGER than the SDK’s own 60 s default', async () => {
    // ADR-0088 §1.1's second half: the remaining window is passed into the SDK's `timeout`, so its internal
    // `DEFAULT_REQUEST_TIMEOUT_MSEC` cannot cut an authored 120 s connect short. Without that, this test fails
    // at 60 s — which is exactly `#205`'s npx cold-start complaint.
    vi.useFakeTimers();
    const { transport } = muteTransport();
    const promise = connectSdkTransport('slow', transport, { timeoutMs: 90_000 });
    const settled = vi.fn();
    void promise.catch(settled);

    await vi.advanceTimersByTimeAsync(61_000);
    expect(settled).not.toHaveBeenCalled(); // the SDK's 60 s did NOT fire — ours replaced it

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(promise).rejects.toBeInstanceOf(McpDeadlineError);
  });
});

describe('raceDeadline', () => {
  it('lets a fast operation through untouched', async () => {
    const window = openWindow(1_000);
    await expect(raceDeadline('s', 'call', window, () => Promise.resolve('ok'))).resolves.toBe(
      'ok',
    );
  });

  it('refuses BEFORE starting work when the window is already spent', async () => {
    // A window that expired while an earlier phase ran must not begin an operation that cannot finish inside
    // it — otherwise a paged discovery could start a page it has no time to complete.
    const spent = { startedAt: Date.now() - 5_000, timeoutMs: 1_000 };
    const operation = vi.fn(() => Promise.resolve('never'));
    await expect(raceDeadline('s', 'discovery', spent, operation)).rejects.toBeInstanceOf(
      McpDeadlineError,
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('gives the caller’s cancel precedence over a timer that fires in the same turn', async () => {
    // ADR-0082 §5's caller-cancel-wins, applied here: a user who pressed Esc must not be told the server was
    // slow. The signal is pre-aborted, so both branches are eligible at the first opportunity.
    const { signal } = fakeSignal();
    const preAborted: AbortSignalLike = { ...signal, aborted: true };
    await expect(
      raceDeadline(
        's',
        'call',
        { startedAt: Date.now(), timeoutMs: 1 },
        () => new Promise<never>(() => undefined),
        preAborted,
      ),
    ).rejects.toBeInstanceOf(McpAbortedError);
  });

  it('lets the operation’s OWN failure through unchanged, with its own type', async () => {
    // The race adds a verdict; it must not launder one. A server that answers with an error is not a timeout
    // and not a cancellation, and a caller distinguishing the three is what `#204` asks for.
    await expect(
      raceDeadline('s', 'call', openWindow(1_000), () =>
        Promise.reject(new Error('server said no')),
      ),
    ).rejects.toThrow('server said no');
  });
});

describe('remainingMs', () => {
  it('shrinks as the window is spent and floors at 1, never 0 or negative', () => {
    const window = { startedAt: 1_000, timeoutMs: 500 };
    expect(remainingMs(window, () => 1_000)).toBe(500);
    expect(remainingMs(window, () => 1_400)).toBe(100);
    // Floored at 1: the SDK reads `options.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC`, so a 0 or a negative
    // would either read as "absent" (restoring the 60 s default we just overrode) or be meaningless.
    expect(remainingMs(window, () => 9_999)).toBe(1);
  });
});

describe('toAbortSignal', () => {
  it('is undefined for an absent signal, so a caller can spread it', () => {
    expect(toAbortSignal(undefined)).toBeUndefined();
  });

  it('forwards a real AbortSignal rather than re-wrapping it', () => {
    // Re-wrapping would drop `signal.reason`, which the SDK maps into its own error.
    const controller = new AbortController();
    expect(toAbortSignal(controller.signal)).toBe(controller.signal);
  });

  it('bridges an ALREADY-aborted engine signal to an aborted AbortSignal', () => {
    const { signal, abort } = fakeSignal();
    abort();
    expect(toAbortSignal(signal)?.aborted).toBe(true);
  });

  it('bridges a LATER abort', () => {
    const { signal, abort } = fakeSignal();
    const bridged = toAbortSignal(signal);
    expect(bridged?.aborted).toBe(false);
    abort();
    expect(bridged?.aborted).toBe(true);
  });
});

describe('MCP_DEADLINES', () => {
  it('gives stdio the longest connect window, and the network the shortest', () => {
    // Not a tautology: the ordering IS the decision (ADR-0088 §1). A cold `npx` needs room; a remote endpoint
    // past thirty seconds is hung rather than starting. An edit that equalised them would silently reopen
    // `#205`, and this is the test that would go red.
    expect(MCP_DEADLINES.stdioConnectMs).toBeGreaterThan(MCP_DEADLINES.networkConnectMs);
    expect(MCP_DEADLINES.stdioConnectMs).toBeGreaterThan(60_000); // above the SDK's own default
  });
});
