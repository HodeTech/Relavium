import { defaultSubscribeSignals } from '../home/drive-home.js';

/**
 * Reap spawned MCP children when a one-shot command is signalled
 * ([ADR-0088](../../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §1.3, `#21`).
 *
 * **The gap this closes was measured, not inferred.** `run` and `agent run` both tear their MCP client down in
 * a `finally`, which is correct for every path Node unwinds — and a signal is not one of them. With no
 * listener, Node's default SIGINT/SIGTERM handling terminates the process *without* running `finally`.
 * Reproduced: a host that spawned a child exactly the way the MCP SDK does, sent `SIGTERM`, printed no
 * `FINALLY_RAN`, and left the child alive with **`ppid 1`**.
 *
 * A terminal `Ctrl-C` often hides this, because the TTY signals the whole foreground process group and the
 * child usually dies with the parent. That is a coincidence of delivery, not a guarantee: `kill -TERM <pid>`,
 * a supervisor, an IDE stop button, and a child that ignores `SIGINT` (many servers do) all reproduce the
 * orphan. The interactive Home has had a cooperative teardown since 2.6.F; the one-shot commands never did.
 *
 * Deliberately narrow: this owns **only** the MCP teardown and the exit code. It does not restore the
 * terminal (the one-shot commands never take custody of it) and it does not try to cancel the run — a
 * signalled one-shot invocation is ending, and the obligation is to leave nothing behind.
 */

/** The conventional `128 + signo` exit code, so a shell pipeline still reads the signal correctly. */
const signalExitCode = (signo: number): number => 128 + signo;

/**
 * How long the teardown may take before the process exits anyway.
 *
 * A bound, because the whole point is that a signalled process ends. The SDK's own stdio close is already
 * bounded (SIGTERM → 2 s → SIGKILL), so this sits just above it: long enough for the ordinary case to finish
 * cleanly, short enough that a wedged transport cannot convert "the user pressed Ctrl-C" into "the shell
 * hangs". Exiting on the timer is strictly better than not exiting — a child the OS re-parents to `init` is
 * the same outcome as today's bug, whereas a stuck foreground process is worse than it.
 */
export const MCP_TEARDOWN_GRACE_MS = 3_000;

export interface McpTeardownGuardDeps {
  /** Signal source — defaults to the four-signal subscription the Home already uses (never a second one). */
  readonly subscribeSignals?: (onSignal: (signo: number) => void) => () => void;
  /** Exit the process (tests inject a capture; production `process.exit`). */
  readonly exit?: (code: number) => void;
  /** Injectable delay so the grace path is testable without waiting for it. */
  readonly delay?: (ms: number) => Promise<void>;
}

/**
 * Register the signal guard around `close`, returning an unsubscribe the caller MUST call on the normal path
 * (its own `finally` already owns the teardown there — running both would close twice).
 *
 * `close` is expected to be idempotent: `McpClient.close()` is, and the guard also latches so a second signal
 * during teardown does not start a second one. A close fault is swallowed rather than surfaced — the process
 * is ending on a signal, and a teardown error has no reader.
 */
export function guardMcpTeardown(
  close: () => Promise<void>,
  deps: McpTeardownGuardDeps = {},
): () => void {
  const subscribe = deps.subscribeSignals ?? defaultSubscribeSignals;
  const exit = deps.exit ?? ((code: number): void => process.exit(code));
  const delay =
    deps.delay ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms).unref?.();
      }));

  let tearingDown = false;
  const unsubscribe = subscribe((signo) => {
    // Latched: a user who presses Ctrl-C twice must not start a second teardown racing the first. The second
    // signal is dropped rather than escalated — the grace timer below is what guarantees the exit anyway.
    if (tearingDown) return;
    tearingDown = true;
    void Promise.race([close().catch(() => undefined), delay(MCP_TEARDOWN_GRACE_MS)]).then(() => {
      unsubscribe();
      exit(signalExitCode(signo));
    });
  });
  return unsubscribe;
}
