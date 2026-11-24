/**
 * The strip's retry backoff ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §6): when a read of the strip fails (a locked or unreadable database, a parked-rows read that threw), the next attempt waits twice as
 * long as the one before, up to {@link STRIP_BACKOFF_MAX_MS}, instead of asking the same store again every tick. It is the strip's own
 * schedule function, wrapped around the Home's one timer, so the Active tab's poll (which shares `createActivePoll`) keeps its schedule.
 *
 * - **The delay after `n` consecutive failures is the base doubled `n` times**, at most 60 s: with a 5 s base the waits before successive
 *   attempts are 5, 10, 20, 40, 60, 60 … seconds.
 * - **A failure moves the pending timer.** The poll arms its next timer before it reads, so the wrapper re-arms the pending one from the
 *   moment the failure is known; the wait is counted from the failed read, never from the tick before it.
 * - **The delay resets when the news is good, or when there is news.** A read that was applied, or a change token that moved since the last
 *   one asked, sets the count back to zero (a moved token means something wrote: whatever failed may have healed, so the next attempt is
 *   not penalised for the history of the last one).
 * - **Nothing here reads, ticks or keeps a timer of its own.** It holds the count and a handle to the one pending timer, and the Home's own
 *   cancel (which `createActivePoll` calls) clears it, so a Home that ends leaves nothing scheduled.
 */

import { tokensEqual, type ChangeToken } from '../../history/change-probe.js';

/** The longest the strip waits between two attempts while its reads keep failing. */
export const STRIP_BACKOFF_MAX_MS = 60_000;

/**
 * The delay before the next attempt after `failures` consecutive failed reads: `baseMs` with none, then doubled for each, at most
 * {@link STRIP_BACKOFF_MAX_MS}. The exponent is bounded first so a store that fails for days never reaches an infinite product.
 */
export function stripRetryDelay(baseMs: number, failures: number): number {
  if (failures <= 0) return baseMs;
  return Math.min(STRIP_BACKOFF_MAX_MS, baseMs * 2 ** Math.min(failures, 20));
}

export interface StripBackoff {
  /** The strip's schedule: the Home's timer, started with the delay the failures so far call for (the `delayMs` it is given is the base). */
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  /** A read of the strip failed: the next attempt waits twice as long, counted from now. */
  readonly failed: () => void;
  /** A read of the strip was applied: the next attempt is one base interval away again. */
  readonly succeeded: () => void;
  /** The change token as the tick just took it: one that differs from the one before it resets the delay. Returns `token` unchanged. */
  readonly observe: (token: ChangeToken) => ChangeToken;
}

/** One logical timer: it may be restarted (with another delay) any number of times before it fires or is cancelled. */
interface Logical {
  readonly callback: () => void;
  readonly baseMs: number;
  live: boolean;
  cancelInner: (() => void) | undefined;
}

/**
 * The backoff over `inner`, the Home's one timer (call `callback` once after `delayMs` and return the function that cancels it).
 * `seed` is the token the strip was first read under, so the first tick compares with it.
 */
export function createStripBackoff(
  inner: (callback: () => void, delayMs: number) => () => void,
  seed?: ChangeToken,
): StripBackoff {
  let failures = 0;
  let current: Logical | undefined;
  let lastToken: ChangeToken | undefined = seed;

  const start = (logical: Logical): void => {
    logical.cancelInner = inner(
      () => {
        if (!logical.live) return;
        logical.live = false;
        if (current === logical) current = undefined;
        logical.callback();
      },
      stripRetryDelay(logical.baseMs, failures),
    );
  };
  /** Start the pending timer again from now, with the delay the count calls for; a no-op with nothing pending. */
  const rearm = (): void => {
    const pending = current;
    if (!pending?.live) return;
    pending.cancelInner?.();
    start(pending);
  };
  const reset = (): void => {
    if (failures === 0) return;
    failures = 0;
    rearm();
  };

  return {
    schedule: (callback, baseMs) => {
      const logical: Logical = { callback, baseMs, live: true, cancelInner: undefined };
      current = logical;
      start(logical);
      return () => {
        logical.live = false;
        logical.cancelInner?.();
        logical.cancelInner = undefined;
        if (current === logical) current = undefined;
      };
    },
    failed: () => {
      failures += 1;
      rearm();
    },
    succeeded: reset,
    observe: (token) => {
      if (lastToken !== undefined && !tokensEqual(lastToken, token)) reset();
      lastToken = token;
      return token;
    },
  };
}
