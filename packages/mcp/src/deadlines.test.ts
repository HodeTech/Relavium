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
 *    request timeout never applied to it.
 *
 * Measurement 2 — an aborted `tools/call` still pending 500 ms later — is **not** asserted here, and an
 * earlier version of this docstring said it was. There is no `tools/call` in this file; the closest is a
 * `raceDeadline(…, 'call', …)` over a synthetic promise, which is neither a call nor an SDK request. It is
 * asserted where it can actually be: `network-adapters.test.ts`, against a real `McpServer` whose handler
 * observes its own cancellation.
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
function fakeSignal(): {
  signal: AbortSignalLike;
  abort: () => void;
  listenerCount: () => number;
} {
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
    // Exposed so the bridge's listener lifetime is ASSERTABLE rather than argued about — the review that
    // caught the leak had to read the code to find it.
    listenerCount: () => listeners.size,
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

  it('refuses a PRE-ABORTED signal without starting the work at all', async () => {
    // `Promise.race` evaluates its array before racing, so an `operation()` in it runs even when the guard
    // has already rejected. Measured on the real thing: a pre-aborted connect still SPAWNED the child, and a
    // pre-aborted request still put bytes on the wire — the "the remote or child effect keeps running" harm
    // ADR-0088's own Context names. The refusal now happens before the array exists.
    const { signal, abort } = fakeSignal();
    abort();
    const operation = vi.fn(() => Promise.resolve('never'));
    await expect(
      raceDeadline('s', 'connect', openWindow(1_000), operation, signal),
    ).rejects.toBeInstanceOf(McpAbortedError);
    expect(operation).not.toHaveBeenCalled();
  });

  it('reports a CANCELLATION when the timer won the race but the caller had cancelled', async () => {
    // **The test the previous version could not be.** It passed a PRE-aborted signal, which takes the early
    // refusal above and never reaches the timer — so reordering the guard's branches left it green and it
    // pinned nothing.
    //
    // This signal never FIRES an abort event, so the guard's abort branch cannot win: the timer necessarily
    // does. But `aborted` flips to true as the window elapses, so at classification time the caller has
    // cancelled. That is the whole property — precedence decided when the failure is classified, not by which
    // listener the runtime happened to invoke first — and it is deterministic rather than a scheduler race.
    // The realistic delivery it models: our `setTimeout` fires in the timers phase while the user's Esc
    // arrives in the poll phase of the same iteration. ADR-0082 §5: a user who pressed Esc must not be told
    // the server was slow.
    const startedAt = Date.now();
    const silentlyCancelled: AbortSignalLike = {
      get aborted() {
        return Date.now() - startedAt >= 10;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    await expect(
      raceDeadline(
        's',
        'call',
        openWindow(10),
        () =>
          new Promise<never>(() => {
            // never settles — the timer is what ends this
          }),
        silentlyCancelled,
      ),
    ).rejects.toBeInstanceOf(McpAbortedError);
  });

  it('does NOT relabel an error the operation itself produced, even mid-cancel', async () => {
    // Only our own verdict is reclassified. A server that answered with an error while the user happened to
    // cancel must still report what the server said — laundering it into "cancelled" would hide a real fault.
    //
    // **This test built a signal and then never passed it.** It aborted a `fakeSignal`, handed `raceDeadline`
    // nothing, and asserted the signal it had aborted was aborted — so `cancelled()` was constant `false` and
    // the "while the user happened to cancel" half, the entire point, was never exercised. It was a duplicate
    // of the test below it. A pre-aborted signal cannot be used here either: the pre-abort refusal returns
    // before the operation runs. It needs one that goes live→aborted around the operation, which is the
    // `silentlyCancelled` shape above.
    const startedAt = Date.now();
    const cancelsDuringTheCall: AbortSignalLike = {
      get aborted() {
        return Date.now() - startedAt >= 5;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    await expect(
      raceDeadline(
        's',
        'call',
        openWindow(1_000),
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 15)); // the cancel lands in here
          throw new Error('server said no');
        },
        cancelsDuringTheCall,
      ),
    ).rejects.toThrow('server said no');
    expect(cancelsDuringTheCall.aborted).toBe(true); // …and it really was cancelled by then
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
    expect(toAbortSignal(undefined).signal).toBeUndefined();
  });

  it('bridges a real AbortSignal too, rather than forwarding it — and forwards its reason', () => {
    // **The forward was the leak.** `Protocol.request` does `options.signal.addEventListener('abort', …)`
    // with no removal and no detach on settle, so handing it the run-lifetime signal left one listener per
    // `tools/call` and per discovery page for the rest of the run. Giving the SDK a controller WE own moves
    // that retention to something with a lifetime we control. The `reason` — the only thing forwarding
    // bought — is carried across explicitly.
    const controller = new AbortController();
    const bridged = toAbortSignal(controller.signal);
    expect(bridged.signal).not.toBe(controller.signal);
    controller.abort(new Error('user pressed Esc'));
    expect(bridged.signal?.aborted).toBe(true);
    expect((bridged.signal?.reason as Error).message).toBe('user pressed Esc');
  });

  it('releases its listener on a real AbortSignal as well', () => {
    // The leak this replaces was on exactly this path, so the disposer has to work here or nothing changed.
    const controller = new AbortController();
    const bridged = toAbortSignal(controller.signal);
    bridged.dispose();
    controller.abort();
    expect(bridged.signal?.aborted).toBe(false); // detached before the abort — no propagation
  });

  it('bridges an ALREADY-aborted engine signal to an aborted AbortSignal', () => {
    const { signal, abort } = fakeSignal();
    abort();
    expect(toAbortSignal(signal).signal?.aborted).toBe(true);
  });

  it('bridges a LATER abort', () => {
    const { signal, abort } = fakeSignal();
    const bridged = toAbortSignal(signal);
    expect(bridged.signal?.aborted).toBe(false);
    abort();
    expect(bridged.signal?.aborted).toBe(true);
  });

  it('RELEASES its listener on the source signal when disposed', () => {
    // **The leak a review caught, inverted into an assertion.** A first version never removed the listener and
    // its comment claimed the bridge "lives exactly as long as the request" — but the retainer is the SOURCE
    // signal, which is the engine's run/turn signal, alive for the whole run. One bridge is built per request,
    // and a discovery walk builds one per page, so a long agentic loop accumulated hundreds.
    const { signal, listenerCount } = fakeSignal();
    const bridged = toAbortSignal(signal);
    expect(listenerCount()).toBe(1);
    bridged.dispose();
    expect(listenerCount()).toBe(0);
  });

  it('has a no-op dispose where it subscribed to nothing', () => {
    // An absent signal, a real `AbortSignal`, and an already-aborted one all skip the subscription — calling
    // dispose on them must be safe rather than merely unnecessary.
    const controller = new AbortController();
    const { signal, abort } = fakeSignal();
    abort();
    expect(() => {
      toAbortSignal(undefined).dispose();
      toAbortSignal(controller.signal).dispose();
      toAbortSignal(signal).dispose();
    }).not.toThrow();
  });
});

describe('MCP_DEADLINES', () => {
  it('gives stdio the longest window and the network the shortest — the whole ordering, not half of it', () => {
    // Not a tautology: the ordering IS the decision (ADR-0088 §1). A cold `npx` needs room; a remote endpoint
    // past thirty seconds is hung rather than starting.
    //
    // **An earlier version asserted only half its own title**, and a review proved it: raising
    // `networkConnectMs` to 90 s — longer than discovery AND call, and 3× the stated rationale — left it
    // green. Both halves are checked against every member now.
    const all = Object.values(MCP_DEADLINES);
    expect(MCP_DEADLINES.stdioConnectMs).toBe(Math.max(...all));
    expect(MCP_DEADLINES.networkConnectMs).toBe(Math.min(...all));
    expect(MCP_DEADLINES.stdioConnectMs).toBeGreaterThan(60_000); // above the SDK's own default
  });
});

describe('raceDeadline — cleanup', () => {
  it('clears its timer and RELEASES its abort listener on the happy path', async () => {
    // **A review deleted the whole `finally` and every test stayed green.** That is not cosmetic: this runs on
    // every `tools/list` page and every `tools/call` against the run's long-lived signal, so a session making
    // N MCP calls would retain N listeners and N timers. The file reasons carefully about listener lifetime in
    // `toAbortSignal` while the same decision here went unasserted.
    vi.useFakeTimers();
    const { signal, listenerCount } = fakeSignal();
    const before = vi.getTimerCount();
    await expect(
      raceDeadline('s', 'call', openWindow(5_000), () => Promise.resolve('ok'), signal),
    ).resolves.toBe('ok');
    expect(listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(before);
  });

  it('clears them on the FAILURE path too', async () => {
    vi.useFakeTimers();
    const { signal, listenerCount } = fakeSignal();
    const before = vi.getTimerCount();
    await expect(
      raceDeadline('s', 'call', openWindow(5_000), () => Promise.reject(new Error('nope')), signal),
    ).rejects.toThrow('nope');
    expect(listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(before);
  });
});
