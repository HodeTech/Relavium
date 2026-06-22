import type { RunEvent } from '@relavium/shared';

import type { CliIo } from '../process/io.js';

/**
 * A renderer consumes the run's canonical {@link RunEvent} stream. 2.D ships minimal implementations
 * behind this seam; the rich `ink` TUI (**2.E**) and the full `--json` NDJSON contract (**2.F**)
 * provide richer implementations of the SAME seam, so the run core never forks per output mode.
 */
export interface RunRenderer {
  onEvent: (event: RunEvent) => void;
}

/** Minimal NDJSON renderer — one canonical RunEvent per stdout line. 2.F formalizes the envelope. */
export function createJsonRenderer(io: CliIo): RunRenderer {
  return {
    onEvent: (event) => {
      io.writeOut(`${JSON.stringify(event)}\n`);
    },
  };
}

/** Minimal human renderer — a terse line per lifecycle event. 2.E replaces this with the ink TUI. */
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
