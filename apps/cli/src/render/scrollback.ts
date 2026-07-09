import type { Readable, Writable } from 'node:stream';

import { stripTerminalControls } from './tui/chat-projection.js';

/**
 * The `/scrollback` half of the ADR-0068 §e copy-and-search escape hatches (2.6.F Step 5d): print the transcript to
 * the **primary** buffer, so it lands in the terminal emulator's own scrollback where the user can scroll, search,
 * select, and copy it with every native tool they already have.
 *
 * This exists because the alternate screen structurally removes those affordances — it has no scrollback at all, and
 * mouse reporting (DECSET 1000) captures the click-drag the emulator would otherwise use for selection. The dump is
 * the escape hatch, not a workaround: it is the ONLY path that puts the whole conversation, not just the visible
 * rows, into the emulator's hands.
 *
 * It runs inside `suspendFullScreen`, which has already put the terminal back on the primary buffer with the mouse
 * off. After the user acknowledges, the caller's suspension restores the full-screen view — and the dumped text
 * stays in the scrollback above it, reachable for the rest of the terminal session.
 *
 * SANITIZATION is applied here, again. The lines a caller hands us were already sanitized by `entryLines` at the
 * projection boundary, and `stripTerminalControls` is idempotent — but this function writes raw bytes to a terminal,
 * so it sanitizes at its own boundary rather than trusting a caller to have done it. A model- or MCP-authored
 * escape sequence reaching the primary buffer could forge output, move the cursor, or (via bidi overrides) spoof the
 * reading order of the transcript the user opened this hatch to inspect.
 */

/** The banner printed above the dump, so a scrollback search lands on an unambiguous boundary. */
export const DUMP_HEADER = '───── relavium transcript ─────';
/** The banner printed below the dump. */
export const DUMP_FOOTER = '───── end of transcript ─────';
/** The acknowledgement line. The dump is useless if the full-screen view repaints over it before the user looks. */
export const DUMP_PROMPT = 'Press Enter to return to Relavium.';

export interface DumpToScrollbackDeps {
  /** Write to the PRIMARY buffer. MUST NOT throw and MUST NOT let the stream's async `'error'` event escape — see
   *  {@link nodeWriteOut}, the production adapter. */
  readonly writeOut: (text: string) => void;
  /** Resolve when the user acknowledges (production: one keypress/line on stdin). Injected: it is pure terminal I/O. */
  readonly waitForContinue: () => Promise<void>;
}

/**
 * Print `lines` between the banners, then wait for the user before returning (the caller then restores the
 * full-screen view). An empty transcript still prints the banners — a silent no-op would read as a broken command.
 */
export async function dumpToScrollback(
  deps: DumpToScrollbackDeps,
  lines: readonly string[],
): Promise<void> {
  const body = lines.map((line) => stripTerminalControls(line)).join('\n');
  // One write: a single syscall cannot be interleaved by another stdout writer mid-transcript.
  deps.writeOut(
    `${DUMP_HEADER}\n${body}${body.length > 0 ? '\n' : ''}${DUMP_FOOTER}\n${DUMP_PROMPT}\n`,
  );
  await deps.waitForContinue();
}

/**
 * The production {@link DumpToScrollbackDeps.writeOut}. `process.stdout` surfaces an OS write fault (EPIPE on a
 * closed pipe, EIO on a half-dead TTY) as an **asynchronous `'error'` event**, and Node throws an unhandled `'error'`
 * as an uncaught exception — which, mid-suspension, would kill the process with the terminal still handed away
 * (Step-5d-2 Sonnet review). The listener is attached for the write's lifetime and removed once it flushes, so we
 * neither crash nor permanently swallow errors on a stream other code shares.
 */
export const nodeWriteOut =
  (stdout: Writable) =>
  (text: string): void => {
    const swallow = (): void => undefined; // a dying TTY must not crash a suspension; there is nowhere to report to
    stdout.once('error', swallow);
    try {
      stdout.write(text, () => {
        stdout.removeListener('error', swallow);
      });
    } catch {
      stdout.removeListener('error', swallow); // a SYNCHRONOUS throw (an already-destroyed stream)
    }
  };

/**
 * The production {@link DumpToScrollbackDeps.waitForContinue}: one line (or any keypress) on stdin. It runs INSIDE the
 * suspension, where ink has already turned raw mode off and detached its own listeners — so we own stdin for the
 * duration and hand it back untouched. `ref()` keeps the event loop alive while we wait (ink's `pauseInput` `unref`s
 * it); the stream is re-paused on the way out so ink's `resumeInput` re-attaches to a quiet stream. An `end`/`error`
 * (a piped or closed stdin) resolves rather than hangs: the dump is already in the scrollback, which is the point.
 */
export const nodeWaitForContinue = (stdin: Readable & { ref?: () => void }) => (): Promise<void> =>
  new Promise<void>((resolve) => {
    const done = (): void => {
      stdin.removeListener('data', done);
      stdin.removeListener('end', done);
      stdin.removeListener('error', done);
      stdin.pause();
      resolve();
    };
    stdin.ref?.();
    stdin.resume();
    stdin.once('data', done);
    stdin.once('end', done);
    stdin.once('error', done);
  });
