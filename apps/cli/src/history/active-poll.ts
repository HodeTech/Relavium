import { RUN_LEASE_TTL_MS } from '@relavium/shared';

import { tokensEqual, type ChangeToken } from './change-probe.js';

/**
 * The poll behind the Home's Active tab ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2): a timer, a change token and one read at a time, with every effect (the clock, the timer, the read, the paint) injected so a test
 * moves time by hand. It is read-only by construction: it holds no store, only the functions it is given.
 *
 * - **A tick reads only when something moved.** The token (`PRAGMA data_version` plus the in-process generation, `change-probe.ts`) is
 *   compared with the one the last applied read was made under; an equal token reads nothing. One bound is added to that: a read older
 *   than {@link ACTIVE_MAX_AGE_MS} is repeated whatever the token says, because what the tab shows depends on the clock as well as on the
 *   log (a run turns `stalled` when its lease has been gone for a TTL, and nothing is written when that happens).
 * - **One read at a time.** A tick that finds a read in flight does nothing (coalesced), and the timer is re-armed from the tick, so ticks
 *   never queue up behind a slow read.
 * - **A late result is dropped.** Every read takes the next sequence number, and a result is applied only if its number is still the
 *   latest: {@link ActivePoll.refresh} (a read that supersedes the one in flight) and {@link ActivePoll.cancel} both move the number on, so
 *   an older read that resolves afterwards can never replace a newer result or paint a screen that has closed.
 * - **Paused is not reading.** While `paused()` says so (a card is open, or the terminal is below the floor) nothing is probed or read;
 *   the timer keeps running and the first tick after the pause reads.
 * - **Closed is not reading.** `isClosed()` is asked before EVERY read, and a closed database stops the poll for good.
 * - **Cancelled means no timer.** {@link ActivePoll.cancel} clears the pending timer, so a closed screen or a torn-down Home leaves nothing
 *   scheduled.
 */

/** How often a tick looks at the token while the tab is in front. */
export const ACTIVE_POLL_MS = 1500;
/** The longest an applied read is trusted when the token has not moved: one lease TTL, the unit of the `stalled` rule. */
export const ACTIVE_MAX_AGE_MS = RUN_LEASE_TTL_MS;

export interface ActivePollDeps<T> {
  /** Call `callback` once after `delayMs` and return the function that cancels it (the Home's one timer). */
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  /** A monotonic clock in milliseconds; it ages an applied read, and nothing else. */
  readonly now: () => number;
  /** The change token as it is now. May throw (a closed database): that is reported to {@link ActivePollDeps.onError}. */
  readonly token: () => ChangeToken;
  /** One read of what the tab shows. It runs only when the token moved, and never while another read of this poll is in flight. */
  readonly read: () => Promise<T>;
  /** The result of the newest read, applied once. Never called for a late, superseded or cancelled read. */
  readonly apply: (value: T) => void;
  /** Nothing is read while this says `true` (a card is open on a row, the terminal is too small). */
  readonly paused: () => boolean;
  /** The database is closed: nothing is read, and the poll stops. Asked before every read. */
  readonly isClosed: () => boolean;
  /** A read, or the token, failed; the next tick tries again. */
  readonly onError?: ((cause: unknown) => void) | undefined;
  readonly intervalMs?: number | undefined;
  readonly maxAgeMs?: number | undefined;
  /**
   * For a caller that already holds what a read would give: the token as it was taken BEFORE that read. {@link ActivePoll.start} then reads
   * nothing and records this token as the one the held read was made under, so the first tick reads when the token has moved since (a
   * commit between the caller's read and the start is picked up there, never lost). Absent, `start` reads now.
   */
  readonly after?: ChangeToken | undefined;
}

export interface ActivePoll {
  /** Arm the timer and read now. Idempotent while running. */
  readonly start: () => void;
  /** Read now, whatever the token says, superseding a read in flight (the tab was entered, or came back). A no-op unless running. */
  readonly refresh: () => void;
  /** Stop for good: clear the timer and drop any read in flight, so its result is never applied. */
  readonly cancel: () => void;
}

export function createActivePoll<T>(deps: ActivePollDeps<T>): ActivePoll {
  const intervalMs = deps.intervalMs ?? ACTIVE_POLL_MS;
  const maxAgeMs = deps.maxAgeMs ?? ACTIVE_MAX_AGE_MS;
  let clearTimer: (() => void) | undefined;
  let running = false;
  let sequence = 0;
  let inFlight = false;
  let applied: { readonly token: ChangeToken; readonly at: number } | undefined;

  const arm = (): void => {
    clearTimer = deps.schedule(tick, intervalMs);
  };

  const cancel = (): void => {
    running = false;
    clearTimer?.();
    clearTimer = undefined;
    sequence += 1; // a read still in flight is now late
    inFlight = false;
    applied = undefined;
  };

  const fail = (cause: unknown): void => {
    applied = undefined; // the failed read was not applied: the next tick reads again, token or not
    deps.onError?.(cause);
  };

  const begin = (token: ChangeToken): void => {
    sequence += 1;
    const mine = sequence;
    inFlight = true;
    /** Whether this read is still the newest: a newer read or a cancel has moved the number on for a late one. */
    const current = (): boolean => mine === sequence;
    const onResult = (value: T): void => {
      if (!current()) return;
      inFlight = false;
      applied = { token, at: deps.now() };
      try {
        deps.apply(value);
      } catch (cause) {
        fail(cause);
      }
    };
    const onFailure = (cause: unknown): void => {
      if (!current()) return;
      inFlight = false;
      fail(cause);
    };
    let pending: Promise<T>;
    try {
      pending = deps.read();
    } catch (cause) {
      onFailure(cause);
      return;
    }
    void pending.then(onResult, onFailure);
  };

  const attempt = (force: boolean): void => {
    if (deps.isClosed()) {
      cancel();
      return;
    }
    if (deps.paused()) return;
    if (inFlight && !force) return; // coalesced
    let token: ChangeToken;
    try {
      token = deps.token();
    } catch (cause) {
      fail(cause);
      return;
    }
    const unchanged =
      applied !== undefined &&
      tokensEqual(applied.token, token) &&
      deps.now() - applied.at < maxAgeMs;
    if (unchanged && !force) return;
    begin(token);
  };

  function tick(): void {
    clearTimer = undefined;
    if (!running) return;
    arm();
    attempt(false);
  }

  return {
    start: () => {
      if (running) return;
      running = true;
      arm();
      const held = deps.after;
      if (held === undefined) attempt(true);
      else if (deps.isClosed()) cancel();
      else applied = { token: held, at: deps.now() };
    },
    refresh: () => {
      if (running) attempt(true);
    },
    cancel,
  };
}
