import { collectDurableMediaHandles, type RunEvent } from '@relavium/shared';

import type { CliIo } from '../process/io.js';
import { formatProducedMedia } from './tui/format.js';
import { sanitizeInline, stringifyJsonLine } from './sanitize.js';

/**
 * A renderer consumes the run's canonical {@link RunEvent} stream. The renderers below sit behind this one
 * seam, so the run core never forks per output mode — the rich `ink` TUI (2.E, `render/tui/`) is a third
 * implementation of the SAME seam. This is the "renderer, not a fork" guarantee 2.K relies on.
 */
export interface RunRenderer {
  onEvent: (event: RunEvent) => void;
  /**
   * Optional pause of the live view so an interactive `@clack/prompts` gate card (2.G) can own the terminal
   * mid-run: the `ink` TUI unmounts (releasing the terminal) WITHOUT writing its final summary; `resume`
   * re-mounts from the same retained store so the live view continues seamlessly. The line / NDJSON renderers
   * have no live view and omit both — the run core calls them only in the interactive TUI path.
   */
  suspend?: () => Promise<void> | void;
  /** Re-mount the live view after a {@link suspend} (no-op once {@link finalize} has run). See `suspend`. */
  resume?: () => Promise<void> | void;
  /**
   * Optional teardown, awaited by the run core after the event loop ends (even on a throw). The `ink` TUI
   * (2.E) uses it to unmount the live view — restoring the terminal — and write its persistent final
   * summary; the line and NDJSON renderers need no teardown and omit it. Shared by 2.G / 2.M.
   */
  finalize?: () => Promise<void> | void;
}

/**
 * The `--json` NDJSON renderer (2.F, [ADR-0049](../../../../docs/decisions/0049-cli-machine-output-contract.md)):
 * one canonical {@link RunEvent} serialized verbatim per **stdout** line, preserving the envelope
 * (`type`/`runId`/`timestamp`/`sequenceNumber`) exactly per
 * [sse-event-schema.md](../../../../docs/reference/contracts/sse-event-schema.md). No wrapper, no stream
 * header — the per-line RunEvent IS the stable envelope, and the terminal `run:completed` event is
 * itself the final result line (it carries `outputs` + totals). Secret-typed values are already masked
 * by the engine (`MaskedSecret`); the serializer emits that masked shape verbatim and never unwraps
 * it. Only stdout is touched here — all diagnostics (incl. the CLI-fault envelope) go to stderr.
 *
 * {@link stringifyJsonLine} rather than bare `JSON.stringify` — the same reason `records.ts` uses it. A
 * `--json` stream is read on a terminal as often as it is piped, and `JSON.stringify` escapes `ESC` but leaves
 * DEL, the C1 controls (incl. the 8-bit CSI) and the Trojan-Source bidi family raw. The escape is lossless, so
 * the "serialized verbatim" contract above still holds for any JSON parser.
 */
export function createJsonRenderer(io: CliIo): RunRenderer {
  return {
    onEvent: (event) => {
      io.writeOut(`${stringifyJsonLine(event)}\n`);
    },
  };
}

/**
 * Minimal human renderer — a terse line per lifecycle event; the no-TTY / CI fallback beside the ink TUI (2.E).
 *
 * Sanitized at the SINGLE write, not per field (G34/#57's class). Lane (c) hardened the TUI leaf and four
 * specific call sites; this is the third leaf of the same "one seam, three renderers" split, and putting the
 * guard at the boundary rather than on today's fields means an arm added later cannot reopen the hole by
 * forgetting it. The fields that matter today are authored `nodeId`s and a provider-declared media `mimeType`
 * (never verified against the bytes — finding #107), so the exposure is narrower than the human-gate message
 * that `status.ts`/`gate-list.ts` printed, but it is the same class and the same fix.
 *
 * `sanitizeInline` rather than `stripTerminalControls`: a lifecycle line is one row, so an embedded newline
 * would forge extra rows in a CI log just as it would on a terminal.
 */
export function createPlainRenderer(io: CliIo): RunRenderer {
  return {
    onEvent: (event) => {
      const line = describe(event);
      if (line !== undefined) {
        // `describe()` sanitizes each untrusted FIELD as it interpolates it (the `final-summary.ts` pattern), so
        // every `\n` still in `line` is one this file put there — a legitimate row break for `node:completed`'s
        // media handles. Sanitizing the ASSEMBLED line and splitting on newlines was the wrong order: the split
        // ran on raw text first, so an embedded newline in a `nodeId` or an error code forged a whole extra row
        // and each forged row was then neutralized individually, which made the forgery look intentional.
        io.writeOut(`${line}\n`);
      }
    },
  };
}

function describe(event: RunEvent): string | undefined {
  switch (event.type) {
    case 'run:started':
      return `> run ${sanitizeInline(event.runId)} started`;
    case 'node:started':
      return `  - ${sanitizeInline(event.nodeId)} ...`;
    case 'node:completed': {
      // Surface each produced media handle (never bytes) on its own indented line — the plain/CI leaf of the
      // cross-surface "render a produced media handle" acceptance. A text-only node yields no extra lines.
      const ok = `  ok ${sanitizeInline(event.nodeId)}`;
      const mediaLines = collectDurableMediaHandles(event.output).map(
        // The handle is provider/model-derived, so it is untrusted like every other field here.
        (m) => `    ${sanitizeInline(formatProducedMedia(m))}`,
      );
      return [ok, ...mediaLines].join('\n');
    }
    case 'node:failed':
      return `  FAIL ${sanitizeInline(event.nodeId)}: ${sanitizeInline(event.error.code)}`;
    case 'human_gate:paused':
      return `  paused at gate ${sanitizeInline(event.gateId)} (${sanitizeInline(event.gateType)})`;
    case 'run:completed':
      return `done: run completed`;
    case 'run:failed':
      return `done: run failed (${sanitizeInline(event.error.code)})`;
    case 'run:cancelled':
      return `done: run cancelled`;
    default:
      return undefined; // tokens / cost / per-node detail — quiet in the minimal renderer
  }
}
