import { sanitizeInline, stripTerminalControls } from '../render/sanitize.js';
import { EXIT_CODES } from './exit-codes.js';
import type { CliIo } from './io.js';

/**
 * The process-level last-resort net for an unhandled promise rejection (#228).
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
 *
 * Lives in its own module, rather than inline in the `bin` entry, so it is unit-testable — `index.ts` has a
 * top-level `await run(...)` and importing it from a test would run the whole CLI.
 */
export interface BackgroundFailureNet {
  /** Whether a background failure was reported during this process's lifetime. */
  readonly occurred: () => boolean;
  /** Detach the listener (tests; the real process never needs it). */
  readonly dispose: () => void;
}

/** How many distinct rejections are reported in full before the net starts counting instead of printing. */
const MAX_REPORTED = 5;

export function installBackgroundFailureNet(io: CliIo): BackgroundFailureNet {
  let count = 0;
  // With `RELAVIUM_DEBUG` set the bound is lifted entirely — otherwise the suppression line below would be
  // making a promise ("set RELAVIUM_DEBUG to see them") the code does not keep, and a diagnostic flag that
  // does not actually reveal the diagnostics is worse than no flag.
  const verbose = io.env['RELAVIUM_DEBUG'] !== undefined;
  const onRejection = (reason: unknown): void => {
    count += 1;
    if (verbose || count <= MAX_REPORTED) {
      // Sanitized like every other terminal boundary (`process/render-error.ts`): a rejection reason is
      // arbitrary `unknown` — realistically an MCP server's error text, a provider response body, or a tool
      // result — i.e. exactly the untrusted sources the ANSI/OSC/Trojan-Source guard exists for.
      io.writeErr(
        `relavium: a background operation failed: ${sanitizeInline(describeReason(reason))}\n`,
      );
      if (verbose && reason instanceof Error && reason.stack !== undefined) {
        io.writeErr(`${stripTerminalControls(reason.stack)}\n`);
      }
    } else if (count === MAX_REPORTED + 1) {
      // Bounded: a repeating fault in a long interactive session must not scroll the transcript away.
      io.writeErr(
        'relavium: further background failures suppressed (set RELAVIUM_DEBUG to see them).\n',
      );
    }
    // Fires after `run()` already set the code: only ever upgrade a clean `0`, never overwrite a more
    // specific outcome (a `chatEnded` 4 or a `gatePaused` 3 still means exactly what it says).
    escalateExitCode();
  };
  process.on('unhandledRejection', onRejection);
  return {
    occurred: () => count > 0,
    dispose: () => {
      process.off('unhandledRejection', onRejection);
    },
  };
}

/**
 * Upgrade a clean success to a failure, and nothing else. A run that lost a durable write must not report
 * `0` — but a `chatEnded` (4), `gatePaused` (3) or `invalidInvocation` (2) already carries a more specific
 * truth that CI and scripts key on, so those survive untouched.
 */
export function escalateExitCode(): void {
  if (process.exitCode === undefined || process.exitCode === EXIT_CODES.success) {
    process.exitCode = EXIT_CODES.workflowFailed;
  }
}

/** A one-line, user-safe description of a rejection reason — never a stack as primary output. */
export function describeReason(reason: unknown): string {
  if (reason instanceof AggregateError) {
    return `${reason.errors.length} background errors: ${reason.errors
      .slice(0, 3)
      .map((e: unknown) => describeReason(e))
      .join('; ')}`;
  }
  if (reason instanceof Error) {
    // Include the discriminant when there is one — a bare message often cannot identify the wiring gap.
    const code = 'code' in reason && typeof reason.code === 'string' ? ` [${reason.code}]` : '';
    return `${reason.message}${code}`;
  }
  if (typeof reason === 'string') {
    return reason;
  }
  // A driver-shaped plain object (`{ code, message }`) is the realistic non-Error case on this path.
  if (typeof reason === 'object' && reason !== null && 'message' in reason) {
    const message: unknown = reason.message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return 'unknown reason';
}
