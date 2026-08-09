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
