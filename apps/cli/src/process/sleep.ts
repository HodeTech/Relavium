import type { AbortSignalLike } from '@relavium/shared';

/**
 * The host timer behind the engine's `sleep` seam — the `setTimeout` the platform-free packages cannot reach.
 *
 * **Abort-aware, and it clears the timer** (#W15-14). The chain honours a provider's `Retry-After` up to a
 * 60 s ceiling, so a cancel arriving mid-wait has to be honoured: both surfaces previously passed a bare
 * `setTimeout` promise that nothing could interrupt, and a `Ctrl-C` during that window did nothing visible
 * until the timer fired. Clearing (rather than merely racing) also stops the pending timer from holding the
 * event loop open after the run has already given up on it.
 *
 * Resolves — never rejects — on abort: the delay's contract is "the wait is over", and the caller decides what
 * a cancelled state means. The chain's next loop iteration observes `signal.aborted` and emits the
 * cancellation itself.
 *
 * One home for both hosts (`build-engine.ts` and `session-host.ts`) so the two cannot drift.
 */
export function hostSleep(ms: number, signal?: AbortSignalLike): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.resolve(); // never start a timer we would immediately clear
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      // `AbortSignalLike` is the seam's structural two-argument shape, so there is no `{ once: true }` to
      // lean on — both paths detach explicitly and the listener never outlives its timer.
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * The one-shot timer behind the engine's per-attempt DEADLINE seam
 * ([ADR-0082](../../../../docs/decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) §6).
 *
 * Distinct from {@link hostSleep} on purpose. That one is a *delay* the caller awaits; this one is a *timer*
 * the caller arms and disarms, and the difference matters — a deadline has to be cancellable from the
 * success path, where nothing is awaiting it.
 *
 * **Deliberately NOT `unref`'d.** By the rule this CLI already states in `engine/host.ts` — *"a liveness
 * timer is `unref`'d; a work timer is not"* — an attempt deadline is a WORK timer: the run is parked on it,
 * and it is the only thing that will unblock the run. A first version did `unref` it, and a review measured
 * the consequence against ADR-0082's own motivating provider (`new Promise(() => {})`): the event loop
 * drained, the process exited with a bare code, and the deadline never fired — no `timeout` error, no
 * `run:failed`, no conservative settlement, and a run row left non-terminal for the lease to age out.
 *
 * The leak this would guard against is already impossible: the chain disposes the scope in a `finally` on
 * every exit, including success.
 */
export function hostAttemptTimer(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  return () => {
    clearTimeout(timer);
  };
}

/**
 * A real `AbortController` for the engine's deadline scope — the seam is platform-free and names no
 * DOM/Node type, so the host supplies one whose signal a `fetch` in an adapter can also observe.
 */
export function hostAbortController(): { signal: AbortSignalLike; abort: (reason?: unknown) => void } {
  const controller = new AbortController();
  return { signal: controller.signal, abort: (reason?: unknown) => controller.abort(reason) };
}

