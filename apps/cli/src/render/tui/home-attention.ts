/**
 * The Home's Attention rows for parked runs
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §4, §7): one line per run of THIS project
 * that is paused, with the kind of gate it waits on and the key that opens its card. Pure: the read is over the injected reader and the
 * label over a row, so what the strip says and what the keys do come from one place.
 *
 * - **This project's runs only.** The rows come from `readProjectRunGates`, which asks the reader for the project's paused runs and checks
 *   each row against the project root again, so a run of another directory never gets a row: a run is actionable only in its own workspace.
 * - **One row per run, not per gate.** A run with several open gates is one row (`3 open gates`); its card lists them.
 * - **A run whose log cannot be read gets no row here.** Its gates are unknown, so there is no kind to name and no card to open; the strip's
 *   own unreadable-run line already says so.
 * - **Bounded.** At most {@link PARKED_RUNS_MAX} runs are read and shown, newest first, as the other strip lists are.
 */

import {
  readProjectRunGates,
  type ProjectRunGates,
  type RunGatesReader,
} from '../../home/run-gates.js';
import { sanitizeInline } from '../sanitize.js';

/** The most parked runs the Home keeps rows for. */
export const PARKED_RUNS_MAX = 8;

/** What a parked run waits on: one gate's type, a budget gate, several gates, or nothing a card can show (a media park). */
export type ParkedRunKind = 'approval' | 'input' | 'review' | 'budget' | 'several' | 'none';

export interface ParkedRunRow {
  readonly runId: string;
  readonly kind: ParkedRunKind;
  /** How many gates (human and budget) the run has open. */
  readonly gates: number;
}

function kindOf(run: ProjectRunGates['runs'][number]): ParkedRunKind {
  const open = run.gates.length + run.budgetGates.length;
  if (open === 0) return 'none';
  if (open > 1) return 'several';
  return run.gates[0]?.gateType ?? 'budget';
}

/** One row per readable parked run of `project`, in the order the read returned them (newest run first), at most {@link PARKED_RUNS_MAX}. */
export function parkedRunRows(project: ProjectRunGates): readonly ParkedRunRow[] {
  return project.runs
    .filter((run) => !run.degraded)
    .slice(0, PARKED_RUNS_MAX)
    .map(
      (run): ParkedRunRow => ({
        runId: run.runId,
        kind: kindOf(run),
        gates: run.gates.length + run.budgetGates.length,
      }),
    );
}

/** The rows for the runs parked in `projectRoot`: the read and the projection together. */
export function readParkedRuns(
  reader: RunGatesReader,
  projectRoot: string,
): readonly ParkedRunRow[] {
  return parkedRunRows(readProjectRunGates(reader, projectRoot, { maxRuns: PARKED_RUNS_MAX }));
}

function wordsFor(row: ParkedRunRow): string {
  switch (row.kind) {
    case 'approval':
    case 'input':
    case 'review':
    case 'budget':
      return `${row.kind} gate`;
    case 'several':
      return `${String(row.gates)} open gates`;
    case 'none':
      return 'parked, no gate to decide';
  }
}

/**
 * The strip line of a parked run: a glyph, the run id, the kind of gate and the key that opens its card. `focused` is the row the
 * person has moved onto (`↓`): only that row can be opened, so only it names `Enter`; the others say how to reach them.
 */
export function parkedRunLabel(row: ParkedRunRow, focused: boolean): string {
  const key = focused ? (row.kind === 'none' ? 'Enter says why' : 'Enter opens') : '↓ selects';
  return `‖ ${sanitizeInline(row.runId)}  ·  ${wordsFor(row)}  ·  ${key}`;
}
