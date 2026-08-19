/**
 * The per-attempt deadline
 * ([ADR-0082](../../../docs/decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md)
 * §5-§7).
 *
 * **An `AbortSignal` is a request, not a guarantee.** A provider that ignores it —
 *
 * ```ts
 * generate(): Promise<LlmResult> { return new Promise(() => {}); }
 * ```
 *
 * — or whose iterator's `next()` never settles leaves the chain waiting forever, which is exactly the hang
 * this exists to remove. So the cooperative abort is raised AND the awaited promise is hard-raced against a
 * timer. The repo already works this way where it bounds outbound work: `safe-egress.ts` and the CLI's key
 * validation both race rather than trusting the signal alone.
 *
 * **The guarantee is CALLER liveness, not resource termination.** An uncooperative provider's work may
 * continue in the background; what is bounded is how long Relavium waits. Promising otherwise would be a
 * promise this design cannot keep, and §5 says so in those words.
 */

import type { AbortSignalLike } from '@relavium/shared';

/** A controller the host supplies — the seam is platform-free, so there is no ambient `AbortController`. */
export interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort: (reason?: unknown) => void;
}

/** A one-shot timer the host supplies; calling the returned function disarms it. */
export type SetAttemptTimer = (ms: number, fire: () => void) => () => void;

/**
 * The default per-attempt deadline, in milliseconds.
 *
 * Stated here rather than only in prose because a default is part of the decision, and an append-only ADR
 * should not defer its own substance to a mutable document. Generous on purpose: a reasoning model's first
 * token can legitimately be a long way off, and a too-tight default turns a working model into an
 * unexplained failure — a worse outcome than the unbounded wait it replaces.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 120_000;

/** Why a deadline-scoped run ended. `caller` wins a same-tick tie — see {@link raceDeadline}. */
export type DeadlineOutcome = 'settled' | 'deadline' | 'caller';

export interface DeadlineScope {
  /** The signal to hand the provider: aborts on EITHER the caller's abort or the deadline. */
  readonly signal: AbortSignalLike;
  /**
   * Race one awaited step against the ABSOLUTE deadline. Used per `next()` on a stream, deliberately: a
   * per-chunk reset would let a provider dribble one token per interval forever.
   */
  race: <T>(step: Promise<T>) => Promise<{ outcome: 'settled'; value: T } | { outcome: 'deadline' }>;
  /** Which side ended it, resolved at CLASSIFICATION time so the answer is a contract, not a race. */
  classify: () => DeadlineOutcome;
  /** Disarm the timer and detach the caller listener. Idempotent; safe on every exit path. */
  dispose: () => void;
}

/**
 * Open a deadline scope for one provider attempt.
 *
 * **Precedence is decided at classification time, not by listener order.** If the caller's signal is aborted
 * when the failure is classified, the outcome is `caller` even if the deadline has also elapsed — the same
 * cancel-wins rule ADR-0036 uses for the run. Without a stated rule the answer would depend on which
 * listener the runtime happened to invoke first, and a test would be pinning a scheduler detail.
 */
export function openDeadline(
  timeoutMs: number,
  newController: () => AbortControllerLike,
  setTimer: SetAttemptTimer,
  callerSignal?: AbortSignalLike,
): DeadlineScope {
  const controller = newController();
  let expired = false;
  let disposed = false;
  const waiters = new Set<() => void>();

  const trip = (): void => {
    expired = true;
    for (const wake of waiters) wake();
    controller.abort();
  };
  const disarm = setTimer(timeoutMs, trip);

  const onCallerAbort = (): void => {
    for (const wake of waiters) wake();
    controller.abort();
  };
  // A caller that has ALREADY aborted never fires a listener (matching a native signal), so check first.
  if (callerSignal?.aborted === true) {
    controller.abort();
  } else {
    callerSignal?.addEventListener('abort', onCallerAbort);
  }

  return {
    signal: controller.signal,
    race: async <T,>(step: Promise<T>) => {
      if (expired) {
        // **Discarded, but discarded HANDLED.** `step` is `iterator.next()`, already invoked by the caller —
        // argument evaluation happens before the call — so returning without attaching a handler leaves a
        // live promise nobody owns. The likeliest way to reach here is the well-behaved case: the deadline
        // trips while the chain is suspended handing a chunk to a slower consumer, the provider honours the
        // merged abort and REJECTS its in-flight `next()`, and the next pull finds `expired` already true.
        // Node's default is `--unhandled-rejections=throw`, so that killed the process mid-turn with a stack
        // trace instead of surfacing the `timeout` error the caller had just computed. A review reproduced
        // it: `unhandled= 1`.
        void step.catch(() => undefined);
        return { outcome: 'deadline' };
      }
      // The wake-up promise is settled by `trip`/`onCallerAbort` and by `dispose`, so it never outlives the
      // scope — a `race` against a permanently pending promise would itself be the leak this file is about.
      let wake: () => void = () => undefined;
      const tripped = new Promise<'tripped'>((resolve) => {
        wake = () => {
          resolve('tripped');
        };
        waiters.add(wake);
      });
      try {
        const settled = await Promise.race([step.then((value) => ({ value })), tripped]);
        // `expired` rather than "which promise won": the caller-abort path also wakes the race, and its
        // classification belongs to `classify`, not here.
        if (settled === 'tripped') return { outcome: 'deadline' };
        return { outcome: 'settled', value: settled.value };
      } finally {
        waiters.delete(wake);
      }
    },
    classify: () => {
      if (callerSignal?.aborted === true) return 'caller'; // cancel wins a same-tick tie
      return expired ? 'deadline' : 'settled';
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      disarm();
      callerSignal?.removeEventListener('abort', onCallerAbort);
      // Wake anything still racing so no promise is left pending on a disposed scope.
      for (const wake of waiters) wake();
      waiters.clear();
    },
  };
}
