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
  /** Write to the PRIMARY buffer (production: `process.stdout.write`). */
  readonly writeOut: (text: string) => void;
  /** Resolve when the user acknowledges (production: one line on stdin). Injected because it is pure terminal I/O. */
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
