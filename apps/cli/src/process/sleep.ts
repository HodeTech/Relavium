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
 * success path, where nothing is awaiting it. `unref()` so an armed deadline never by itself keeps the CLI
 * alive: the run decides when the process exits, not a timer nobody is waiting on.
 */
export function hostAttemptTimer(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  timer.unref?.();
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

