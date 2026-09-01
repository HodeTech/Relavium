import { defaultSubscribeSignals } from '../process/signals.js';

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
 * **Two mechanisms, because one cannot cover every exit.** The cooperative half awaits `close()` and is what
 * runs on an ordinary signal. The `process.on('exit')` half is **synchronous** and covers the paths that
 * cannot await anything — a second Ctrl-C forcing `process.exit`, the outermost crash net, any `process.exit`
 * elsewhere in the tree. Without the second half, `driveRun`'s own force-quit re-orphans exactly the children
 * the first half was mid-way through reaping.
 */

/** The conventional `128 + signo` exit code, so a shell pipeline still reads the signal correctly. */
const signalExitCode = (signo: number): number => 128 + signo;

/**
 * How long the cooperative teardown may take before the process exits anyway.
 *
 * A bound, because the whole point is that a signalled process ends: a wedged transport must not convert "the
 * user pressed Ctrl-C" into "the shell hangs".
 *
 * **This deliberately does NOT wait for the SDK's own close ladder to finish, and an earlier comment here got
 * that ladder wrong.** Measured against `@modelcontextprotocol/sdk` 1.29.0 (`client/stdio.js`): `stdin.end()`
 * → race(exit, **2 s**) → `SIGTERM` → race(exit, **2 s**) → `SIGKILL`. So a child that ignores stdin EOF and
 * traps `SIGTERM` — the class this module's own header names — is not `SIGKILL`ed until ~4 s, and a 3 s grace
 * fires first. That is the right trade anyway, and only because the SECOND mechanism exists: the timer's exit
 * runs the synchronous `process.on('exit')` net, which `SIGKILL`s every live pid itself. Waiting the full 4 s
 * would buy a tidier teardown at the cost of a shell that sits there after a Ctrl-C, for a child this guard
 * kills either way.
 */
export const MCP_TEARDOWN_GRACE_MS = 3_000;

export interface McpTeardownGuardDeps {
  /** Signal source — defaults to the four-signal subscription every surface shares (never a second one). */
  readonly subscribeSignals?: (onSignal: (signo: number) => void) => () => void;
  /** Register a synchronous `process.on('exit')` net; returns a remover. */
  readonly subscribeProcessExit?: (onExit: () => void) => () => void;
  /** Synchronously SIGKILL a pid (tests inject a capture; production `process.kill`). */
  readonly killPid?: (pid: number) => void;
  /** Exit the process (tests inject a capture; production flushes stdout first — see `exitAfterFlush`). */
  readonly exit?: (code: number) => void;
  /** Injectable delay so the grace path is testable without waiting for it. */
  readonly delay?: (ms: number) => Promise<void>;
}

export interface McpTeardownGuardOptions extends McpTeardownGuardDeps {
  /**
   * Reap the children but do **not** exit — for a surface that already owns a documented signal contract.
   *
   * `relavium run` is that surface: `driveRun` registers its own SIGINT listener, and
   * [commands.md](../../../../docs/reference/cli/commands.md) promises `Ctrl-C` drains the run to
   * `run:cancelled` and exits `1`. A first version of this guard exited `128+signo` unconditionally, which
   * won that race whenever MCP was in play — replacing a documented exit code with one absent from the CLI's
   * closed `0`–`7` table, and leaving the run with **no terminal in the durable log**, so `relavium status`
   * would list it as active forever. Reaping is this guard's job; owning the exit code is not, wherever
   * something else already does.
   */
  readonly reapOnly?: boolean;
}

/**
 * The pids to reap synchronously if the process exits without awaiting the close. Read lazily, because a guard
 * armed BEFORE the connect — which is when the children are actually spawned — has none yet.
 */
export type LiveChildPids = () => readonly number[];

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
  livePids: LiveChildPids = () => [],
  options: McpTeardownGuardOptions = {},
): () => void {
  const subscribe = options.subscribeSignals ?? defaultSubscribeSignals;
  const subscribeExit = options.subscribeProcessExit ?? defaultSubscribeProcessExit;
  const kill = options.killPid ?? defaultKillPid;
  const exit = options.exit ?? exitAfterFlush;
  const delay = options.delay ?? defaultDelay;

  // The synchronous net. It runs on EVERY exit — normal or forced — and is a no-op once the cooperative
  // teardown has finished, because a reaped child's pid no longer exists.
  //
  // **Each kill is isolated, and its own test found why.** The guarantee is that EVERY live child is reaped,
  // so one throwing kill must not end the loop and strand the rest. The default kill already swallows its
  // ESRCH/EPERM, which is exactly what made the bare loop look correct — the isolation belongs to the loop,
  // which owns the guarantee, not to one implementation of the thing it calls.
  const unsubscribeExit = subscribeExit(() => {
    for (const pid of livePids()) {
      try {
        kill(pid);
      } catch {
        // Nothing to report to at exit time — and the next child still has to die.
      }
    }
  });

  let tearingDown = false;
  const unsubscribeSignals = subscribe((signo) => {
    // Latched: a user who presses Ctrl-C twice must not start a second teardown racing the first. The second
    // signal is dropped rather than escalated — the grace timer below, and the `exit` net above, are what
    // guarantee the process ends and the children die.
    if (tearingDown) return;
    tearingDown = true;
    void Promise.race([close().catch(() => undefined), delay(MCP_TEARDOWN_GRACE_MS)]).then(() => {
      if (options.reapOnly === true) return; // the caller owns the exit code — see `reapOnly`
      unsubscribeSignals();
      exit(signalExitCode(signo));
    });
  });

  return () => {
    unsubscribeSignals();
    unsubscribeExit();
  };
}

/** The default `process.on('exit')` net — synchronous by definition, which is why the reap it runs must be. */
function defaultSubscribeProcessExit(onExit: () => void): () => void {
  process.on('exit', onExit);
  return () => {
    process.removeListener('exit', onExit);
  };
}

/**
 * SIGKILL a pid, swallowing the throw.
 *
 * `SIGKILL` rather than `SIGTERM` because this runs on `process.on('exit')`: there is no event loop left to
 * wait for a graceful shutdown, so a signal the child may ignore is a signal that does nothing. The throw to
 * swallow is `ESRCH` — the ordinary case, where the cooperative teardown already reaped this child — and
 * `EPERM`, where the pid was recycled by a process we do not own. Neither is actionable at exit time.
 *
 * **The residual a pid-based reap cannot close, stated rather than implied.** If our child exits and the OS
 * recycles its pid to an unrelated process owned by the SAME user before this handler runs, the `SIGKILL`
 * lands on that process. Distinguishing them needs a mechanism this host does not have (a pid file descriptor,
 * or recording the child's start time), and the window is the milliseconds-to-3-seconds between the teardown
 * starting and the process exiting. Accepted rather than hidden: ADR-0088 §11's "asserted against the actual
 * child-process table" is a statement about what the TEST checks, and this is where the guarantee stops.
 */
function defaultKillPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone, or not ours. Both are fine; there is nothing left to report to.
  }
}

/**
 * Exit after stdout has drained.
 *
 * `process.exit()` terminates without flushing, and on a **pipe** — the machine-consumer case — stdout is
 * asynchronous and buffered. So `relavium run --json | jq` interrupted mid-stream could emit a **half-written
 * JSON line**, which breaks the consumer's parser rather than merely ending its stream early
 * ([ADR-0049](../../../../docs/decisions/0049-cli-machine-output-contract.md)). The CLI's own entry point sets
 * `process.exitCode` and lets Node exit naturally for that reason; a guard that must exit *now* asks for the
 * drain explicitly instead.
 *
 * The callback fires immediately when nothing is buffered, so the ordinary case costs one tick.
 */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  process.stdout.write('', () => process.exit(code));
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
