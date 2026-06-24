import type { RunEvent } from '@relavium/shared';

import type { CliIo } from '../process/io.js';

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
 * by the engine (`MaskedSecret`); `JSON.stringify` emits that masked shape verbatim and never unwraps
 * it. Only stdout is touched here — all diagnostics (incl. the CLI-fault envelope) go to stderr.
 */
export function createJsonRenderer(io: CliIo): RunRenderer {
  return {
    onEvent: (event) => {
      io.writeOut(`${JSON.stringify(event)}\n`);
    },
  };
}

/** Minimal human renderer — a terse line per lifecycle event; the no-TTY / CI fallback beside the ink TUI (2.E). */
export function createPlainRenderer(io: CliIo): RunRenderer {
  return {
    onEvent: (event) => {
      const line = describe(event);
      if (line !== undefined) {
        io.writeOut(`${line}\n`);
      }
    },
  };
}

function describe(event: RunEvent): string | undefined {
  switch (event.type) {
    case 'run:started':
      return `> run ${event.runId} started`;
    case 'node:started':
      return `  - ${event.nodeId} ...`;
    case 'node:completed':
      return `  ok ${event.nodeId}`;
    case 'node:failed':
      return `  FAIL ${event.nodeId}: ${event.error.code}`;
    case 'human_gate:paused':
      return `  paused at gate ${event.gateId} (${event.gateType})`;
    case 'run:completed':
      return `done: run completed`;
    case 'run:failed':
      return `done: run failed (${event.error.code})`;
    case 'run:cancelled':
      return `done: run cancelled`;
    default:
      return undefined; // tokens / cost / per-node detail — quiet in the minimal renderer
  }
}
