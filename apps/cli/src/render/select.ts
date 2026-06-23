import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { detectOutputMode, isCiEnv } from '../process/output-mode.js';
import { createInkRenderer } from './tui/ink-renderer.js';
import { createJsonRenderer, createPlainRenderer, type RunRenderer } from './renderer.js';

/**
 * Pick the {@link RunRenderer} for a `relavium run` from the resolved output mode (the "Output modes" table
 * in [commands.md](../../../../docs/reference/cli/commands.md)): the `ink` TUI when an interactive TTY is
 * attached, the NDJSON renderer under `--json`, and the plain line renderer otherwise (no-TTY / `CI=true`).
 * All three are the same `onEvent` seam over one bus — "renderer, not a fork" (2.F / 2.K).
 */
export function selectRenderer(io: CliIo, global: GlobalOptions): RunRenderer {
  const mode = detectOutputMode({
    stdoutIsTty: io.stdoutIsTty,
    json: global.json,
    ci: isCiEnv(io.env),
  });
  if (mode === 'tui') {
    // The ink renderer takes the real stdout stream directly (not the CliIo text seam): ink needs a
    // NodeJS.WriteStream for cursor control / raw mode / terminal dimensions, which `writeOut(text)` cannot
    // represent. This path is only reached on an interactive TTY (never in tests — captureIo is not a TTY).
    return createInkRenderer({ color: global.color });
  }
  // 'plain' covers --json (NDJSON), CI, and no-TTY: NDJSON only under the explicit --json opt-in (ADR-0049).
  return global.json ? createJsonRenderer(io) : createPlainRenderer(io);
}
