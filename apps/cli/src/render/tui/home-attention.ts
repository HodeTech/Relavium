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
 * - **What the row says is what the person needs to pick a run.** Its workflow's slug and the earliest deadline of its open gates, beside the
 *   run id, the kind of gate and the key. When the terminal cannot hold all of it, the id gives way first (to its first columns), then the
 *   workflow, then the deadline; the kind and the key never do ({@link parkedRunLabel}).
 */

import type { RunHistoryReader } from '@relavium/db';

import type { HostedRunDisposition } from '../../home/hosted-run-terminal.js';
import {
  isMediaOnlyPark,
  readProjectRunGates,
  type ProjectRunGates,
  type RunGatesReader,
} from '../../home/run-gates.js';
import { shortId } from '../notation.js';
import { flowLine } from './flow-text.js';
import { glyph } from './glyphs.js';
import { expiryLabel } from './home-projection.js';
import { keyLabel, type LegendKey } from './legend.js';
import { clipLine } from './sheet-frame.js';
import { displayWidth, sliceDisplayColumns } from './viewport.js';

/** The most parked runs the Home keeps rows for. */
export const PARKED_RUNS_MAX = 8;

/**
 * What a parked run waits on: one gate's type, a budget gate, several gates, media jobs and nothing else (`Enter` asks whether to continue
 * it here), or nothing a card can show or a continue can answer (`none`: the log names no gate and no job in flight).
 */
export type ParkedRunKind =
  | 'approval'
  | 'input'
  | 'review'
  | 'budget'
  | 'several'
  | 'media'
  | 'none';

export interface ParkedRunRow {
  readonly runId: string;
  readonly kind: ParkedRunKind;
  /** How many gates (human and budget) the run has open. */
  readonly gates: number;
  /** The run's workflow, by its slug: what a person knows a run by. Absent when the read could not name it. */
  readonly workflow?: string | undefined;
  /** The earliest deadline among the run's open gates (an ISO timestamp), when any gate has one. */
  readonly expiresAt?: string | undefined;
}

function kindOf(run: ProjectRunGates['runs'][number]): ParkedRunKind {
  const open = run.gates.length + run.budgetGates.length;
  if (open === 0) return isMediaOnlyPark(run) ? 'media' : 'none';
  if (open > 1) return 'several';
  return run.gates[0]?.gateType ?? 'budget';
}

/** The earliest deadline among a run's open gates, as it was recorded; a deadline that does not parse is no deadline. */
function earliestDeadline(run: ProjectRunGates['runs'][number]): string | undefined {
  let earliest: { readonly at: number; readonly iso: string } | undefined;
  for (const gate of [...run.gates, ...run.budgetGates]) {
    if (gate.expiresAt === undefined) continue;
    const at = Date.parse(gate.expiresAt);
    if (Number.isFinite(at) && (earliest === undefined || at < earliest.at))
      earliest = { at, iso: gate.expiresAt };
  }
  return earliest?.iso;
}

/**
 * One row per readable parked run of `project`, in the order the read returned them (newest run first), at most {@link PARKED_RUNS_MAX}.
 * `slugs` names the workflows by their ids (a run record carries only the id); a run with no slug there has no workflow word.
 */
export function parkedRunRows(
  project: ProjectRunGates,
  slugs: ReadonlyMap<string, string> = new Map(),
): readonly ParkedRunRow[] {
  return project.runs
    .filter((run) => !run.degraded)
    .slice(0, PARKED_RUNS_MAX)
    .map((run): ParkedRunRow => {
      const workflow = slugs.get(run.workflowId);
      const expiresAt = earliestDeadline(run);
      return {
        runId: run.runId,
        kind: kindOf(run),
        gates: run.gates.length + run.budgetGates.length,
        ...(workflow === undefined ? {} : { workflow }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
    });
}

/** The reads the Attention rows make: the gate read's own, and (when the reader has it) the slugs of the workflows the runs belong to. */
export type ParkedRunsReader = RunGatesReader &
  Partial<Pick<RunHistoryReader, 'loadWorkflowSlugs'>>;

/** The rows for the runs parked in `projectRoot`: the read and the projection together. */
export function readParkedRuns(
  reader: ParkedRunsReader,
  projectRoot: string,
): readonly ParkedRunRow[] {
  const project = readProjectRunGates(reader, projectRoot, { maxRuns: PARKED_RUNS_MAX });
  const ids = [...new Set(project.runs.map((run) => run.workflowId))];
  return parkedRunRows(project, reader.loadWorkflowSlugs?.(ids));
}

/**
 * What `Enter` does on the focused row of each kind, in the row's own words: a gate or a budget gate opens its card, a media park asks
 * whether to continue the run here (nothing is continued without a Yes), and a run with nothing to answer says why. An input gate's card
 * cannot take its value, so its key says what the card does: it shows how to answer. Each is a legend item (ADR-0145 §3), so the key is
 * written by the bracket rule and the verb is the imperative of the action the key performs.
 */
const FOCUSED_CUE: Readonly<Record<ParkedRunKind, LegendKey>> = {
  approval: { keys: 'Enter', verb: 'open' },
  // The card of an input gate takes no typed value: it shows the shell command that does, and offers a rejection. `Enter` shows how.
  input: { keys: 'Enter', verb: 'show how to answer' },
  review: { keys: 'Enter', verb: 'open' },
  budget: { keys: 'Enter', verb: 'open' },
  several: { keys: 'Enter', verb: 'open' },
  media: { keys: 'Enter', verb: 'ask to continue' },
  none: { keys: 'Enter', verb: 'say why' },
};

/**
 * What an unfocused row names instead: the arrows move onto it, and only the focused row can be opened. Both arrows: the row is on the work
 * page (MVP-11 unit 7), where `↑` reaches the list from the docked prompt under it and the arrows walk it from a row either side.
 */
const UNFOCUSED_CUE: LegendKey = { keys: '↑/↓', verb: 'select' };

/** One legend item as the row writes it: its key by the bracket rule, then its verb. */
function cueText(item: LegendKey): string {
  return `${keyLabel(item.keys)} ${item.verb}`;
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
    case 'media':
      return 'waiting for media';
    case 'none':
      return 'parked, no gate to decide';
  }
}

/**
 * The columns the Attention list spends before a row's own label: the list's two-column margin and the two-column focus marker
 * (`> `). The view hands {@link parkedRunLabel} what is left of the terminal after them.
 */
export const PARKED_ROW_INDENT_COLUMNS = 4;

/** The ellipsis a run id ends with when the row had to give it up some columns. */
const ID_ELLIPSIS = '…';
/** The columns of a run id kept when the row needs the room for the workflow and the deadline: the first eight, as the short id is elsewhere. */
const SHORT_ID_COLUMNS = 8;
/** The most columns a workflow's slug takes in a row, the cut shown by an ellipsis. */
const WORKFLOW_COLUMNS = 24;
const ROW_SEPARATOR = '  ·  ';

/** Whether the run's earliest deadline has passed at `nowMs`: the row says `expired`, and the view draws it in red, as the strip's own gate rows are. */
export function parkedRunOverdue(row: ParkedRunRow, nowMs: number): boolean {
  return expiryLabel(row.expiresAt, nowMs) === 'expired';
}

/** `id` kept to its first `columns` columns and ended with an ellipsis, or whole when it is no longer than that. */
function idWithin(id: string, columns: number): string {
  if (displayWidth(id) <= columns) return id;
  // Never an id of nothing: a row that cannot fit even one column of it still names the run by where it starts.
  return `${sliceDisplayColumns(id, 0, Math.max(1, columns - displayWidth(ID_ELLIPSIS)))}${ID_ELLIPSIS}`;
}

/**
 * The strip line of a parked run: a glyph, the run id, its workflow, the kind of gate, its deadline and the key that opens its card.
 * `focused` is the row the person has moved onto (`↓`): only that row can be opened, so only it names `Enter`; the others say how to reach
 * them. `nowMs` is the clock the deadline is worded against (`expires in 5m`, `expired`); without it the row has no deadline words.
 *
 * `maxColumns` is the room the row has (the terminal's width less its indent). The kind and the key are what the row is FOR, and they are
 * never the part that is cut. What the rest gives up, in order: the id keeps its first eight columns and ends with an ellipsis (the run view
 * and the card name it in full), then the workflow goes, then the deadline; and a row that still would not fit shortens the id further, as
 * a row with neither always did.
 */
export function parkedRunLabel(
  row: ParkedRunRow,
  focused: boolean,
  maxColumns = Number.POSITIVE_INFINITY,
  nowMs?: number,
): string {
  const key = cueText(focused ? FOCUSED_CUE[row.kind] : UNFOCUSED_CUE);
  // Stored text, through the Home's full row scrub (MVP-11 unit 7, round 1): the label's own separators are then the only ones on the row.
  const id = flowLine(row.runId);
  const workflow =
    row.workflow === undefined || row.workflow === ''
      ? undefined
      : clipLine(flowLine(row.workflow), WORKFLOW_COLUMNS);
  const due = nowMs === undefined ? undefined : expiryLabel(row.expiresAt, nowMs);
  const line = (shownId: string, withWorkflow: boolean, withDue: boolean): string =>
    [
      `${glyph('paused')} ${shownId}`,
      ...(withWorkflow && workflow !== undefined ? [workflow] : []),
      wordsFor(row),
      ...(withDue && due !== undefined ? [due] : []),
      key,
    ].join(ROW_SEPARATOR);
  const short = idWithin(id, SHORT_ID_COLUMNS);
  // Each plan gives up one more thing than the one before it; the first that fits is the row. A plan is tried only if it says something
  // beyond the row's own words (a run with no workflow and no deadline keeps as much of its id as the room allows, below).
  const plans: readonly (readonly [string, boolean, boolean])[] = [
    [id, true, true],
    [short, true, true],
    [short, false, true],
  ];
  for (const [shownId, withWorkflow, withDue] of plans) {
    const extra = (withWorkflow && workflow !== undefined) || (withDue && due !== undefined);
    const full = extra ? line(shownId, withWorkflow, withDue) : undefined;
    if (full !== undefined && displayWidth(full) <= maxColumns) return full;
  }
  const bare = line('', false, false);
  return line(idWithin(id, Math.max(1, maxColumns - displayWidth(bare))), false, false);
}

/**
 * The line a chat's transcript gets when a hosted leg ends while that chat is in front ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md)
 * §3: a run that parks, finishes or fails behind a chat would otherwise tell nobody; no card ever takes the keyboard from another screen),
 * or `undefined` for an end that needs no word here (a cancel the person asked for, a run another process settled, a record the exit line
 * reports). Each is a glyph and a word from a closed vocabulary and the run's name: its workflow's slug when `parked` is the run's own
 * Attention row and has one, else `run` and the first eight characters of its id, scrubbed like every other label. The remedy is the same
 * for all of them: the landing is where the run is shown, and a chat holds the keyboard until it is left.
 */
export function hostedEndNotice(
  end: { readonly runId: string; readonly disposition: HostedRunDisposition },
  parked: ParkedRunRow | undefined,
): string | undefined {
  const slug = parked?.workflow === undefined ? '' : flowLine(parked.workflow).trim();
  const name = slug === '' ? `run ${shortId(flowLine(end.runId))}` : slug;
  switch (end.disposition) {
    case 'paused':
      return `${glyph('paused')} ${name} ${pausedWords(parked?.kind)} on the Home.`;
    case 'completed':
      return `${glyph('completed')} ${name} completed. Leave this chat to see it on the Home.`;
    case 'failed':
      return `${glyph('failed')} ${name} failed. Leave this chat to see it on the Home.`;
    default:
      return undefined;
  }
}

/** What a parked run waits on and what to do about it, in the words of {@link hostedEndNotice}; the row may not be read yet (`undefined`). */
function pausedWords(kind: ParkedRunKind | undefined): string {
  switch (kind) {
    case 'media':
      return 'is waiting for media jobs. Leave this chat to continue it';
    case 'none':
      return 'paused. Leave this chat to see it';
    default:
      return 'is waiting at a gate. Leave this chat to answer it';
  }
}
