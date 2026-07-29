import { EXIT_CODES } from './process/exit-codes.js';
import { processIo } from './process/io.js';
import { run } from './run.js';

// The `bin` entry: wire the real-process IO seam, run, and set the deterministic exit code.
const io = processIo();

/**
 * Whether a background (out-of-band) failure was reported during this process's lifetime. Kept so a run that
 * otherwise succeeded cannot exit `0` and claim everything landed — see the escalation after `run()`.
 */
let backgroundFailure = false;

/**
 * Last-resort net for an unhandled promise rejection (#228).
 *
 * Node's default for one is to **kill the process**. That default is load-bearing in the wrong direction here:
 * the engine's `RunEventBus` deliberately re-throws a passive subscriber's fault out-of-band, on a microtask,
 * when no `onListenerError` sink is wired — precisely so it is never silently swallowed. The consequence was
 * that a transient `history.db` write failure inside the chat persister took the whole CLI down
 * **asynchronously, after the user had already seen the reply**, losing a turn they had been billed for.
 *
 * So: report it loudly and keep the process alive. This is a BACKSTOP, not a replacement for the sinks
 * upstream of it — the store's bounded retry absorbs the transient case and the bus's `onListenerError` sink
 * reports the genuine one; anything reaching here is a wiring gap worth seeing. Deliberately scoped to
 * rejections: an `uncaughtException` is a different class of fault and continuing past one would be unsafe.
 */
process.on('unhandledRejection', (reason: unknown) => {
  backgroundFailure = true;
  io.writeErr(`relavium: a background operation failed: ${describeReason(reason)}\n`);
  if (
    io.env['RELAVIUM_DEBUG'] !== undefined &&
    reason instanceof Error &&
    reason.stack !== undefined
  ) {
    io.writeErr(`${reason.stack}\n`);
  }
  // Fires after `run()` already set the code: only ever upgrade a clean `0`, never overwrite a more specific
  // outcome (a `chatEnded` 4 or a `gatePaused` 3 still means exactly what it says).
  if (process.exitCode === undefined || process.exitCode === EXIT_CODES.success) {
    process.exitCode = EXIT_CODES.workflowFailed;
  }
});

try {
  process.exitCode = await run(process.argv, io);
} catch (err) {
  // `run()` is designed never to reject; this is a last-resort guard that fails loudly
  // without leaking a stack as primary output. Set `RELAVIUM_DEBUG` to see the stack.
  io.writeErr('relavium: a fatal internal error occurred.\n');
  if (io.env['RELAVIUM_DEBUG'] !== undefined && err instanceof Error && err.stack !== undefined) {
    io.writeErr(`${err.stack}\n`);
  }
  process.exitCode = EXIT_CODES.workflowFailed;
}

// The mirror of the in-handler upgrade above, for a rejection that fired BEFORE `run()` assigned the code and
// would otherwise have been overwritten by it. Same rule: only a clean `0` is escalated.
if (backgroundFailure && process.exitCode === EXIT_CODES.success) {
  process.exitCode = EXIT_CODES.workflowFailed;
}

/** A one-line, user-safe description of a rejection reason — never a stack as primary output. */
function describeReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return typeof reason === 'string' ? reason : 'unknown reason';
}
