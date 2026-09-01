/**
 * The CLI's ONE external-signal subscription — SIGINT(2), SIGTERM(15), SIGHUP(1), SIGQUIT(3).
 *
 * **It lives here, not beside its first caller, because its second caller must not pay for the first.** It was
 * written for the full-screen Home (2.6.F Step 6f) and lived in `home/drive-home.tsx`; when the one-shot MCP
 * teardown guard reused it (ADR-0088 §1.3), `relavium run` and `relavium agent run` began value-importing the
 * entire Ink/React Home module graph for four `process.on` calls. Reusing the one subscription is right — a
 * second one is how two surfaces start disagreeing about which signals they cover — so the subscription moved
 * rather than the caller.
 *
 * All four, not just SIGINT: SIGHUP is what a user gets by closing the terminal window and SIGQUIT is
 * catchable, and both terminate WITHOUT firing Node's `'exit'` event. Their absence is what once left DECSET
 * 1002+1006 enabled on the primary buffer after a closed window.
 */

/**
 * Subscribe to the four termination signals; returns an unsubscribe.
 *
 * Registered with `on`, **not** `once`: an interactive surface mounts ink, which registers a `signal-exit`
 * SIGINT listener that re-raises SIGINT (→ exit 130) **only when it is the sole remaining SIGINT listener**. A
 * `once` handler removes itself the instant it fires, so signal-exit then sees only itself and re-raises —
 * killing a cooperative teardown before it completes. Staying registered is what prevents that.
 */
export function defaultSubscribeSignals(onSignal: (signo: number) => void): () => void {
  const onSigint = (): void => onSignal(2);
  const onSigterm = (): void => onSignal(15);
  const onSighup = (): void => onSignal(1);
  const onSigquit = (): void => onSignal(3);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('SIGHUP', onSighup);
  process.on('SIGQUIT', onSigquit);
  return () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGHUP', onSighup);
    process.removeListener('SIGQUIT', onSigquit);
  };
}
