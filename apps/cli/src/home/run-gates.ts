import { decisionsForGateType } from '@relavium/core';
import type { RunHistoryReader } from '@relavium/db';
import type { GateDecision, HumanGatePausedEvent, RunEvent } from '@relavium/shared';

import type { BudgetPromptContext } from '../gate/budget.js';
import { pendingParkDisplays, type PendingBudgetGate } from '../gate/pending.js';
import { keysetCursorOf, type KeysetCursor } from '../history/keyset-cursor.js';
import { readPerRunOrDegrade } from '../history/per-run-read.js';

/**
 * The open gates of the runs parked in THIS project
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §4, §7): what the Home's gate card
 * and, later, its Active tab and strip read. A read, never a decision: it grants nothing and resumes nothing.
 *
 * - **Only this project's runs.** The page is asked for the project's paused runs, and every row it returns is checked against the
 *   project root once more here, so a reader that over-returns can never hand another directory's run to a card (a run is
 *   actionable only in its own workspace, ADR-0139 §7).
 * - **Chunks of at most {@link RUN_GATES_CHUNK} runs.** The reader pages by keyset, one page of that many ids at a time (the largest
 *   page the summary read accepts, and the largest id list `loadRunLeases` takes), and stops at {@link RUN_GATES_MAX_RUNS}: a project
 *   that parks without ever answering costs one bounded read per call, never an unbounded one. A caller that keeps fewer (`maxRuns`) asks
 *   for `maxRuns + 1` rows at most: one more than it keeps is enough to say the project parks more.
 * - **Per-run isolation.** Each run's log is read inside `readPerRunOrDegrade`: one damaged log degrades that run (it is named in
 *   `degradedRunIds` and carries no gate), and the others are read. Any other fault is not a per-run condition and propagates.
 * - **Text is the card's to clean.** `message` is the workflow author's text (it can interpolate model output) and is returned as
 *   stored; the card's projection sanitizes it, as it does every string it draws.
 */

/** The most runs one page of the read asks for, and the most ids a lease read takes. */
export const RUN_GATES_CHUNK = 200;
/** The most parked runs one call reads; a project with more reports `truncated`. */
export const RUN_GATES_MAX_RUNS = 1000;

export type RunGateType = HumanGatePausedEvent['gateType'];
export type RunGateTimeoutAction = NonNullable<HumanGatePausedEvent['timeoutAction']>;

/** One open human gate of a parked run: what to show, and which decisions the gate accepts. */
export interface RunGate {
  readonly runId: string;
  readonly gateId: string;
  readonly nodeId: string;
  readonly gateType: RunGateType;
  /** The author's message, as stored. */
  readonly message: string;
  /** The gate's absolute deadline, when one was authored. */
  readonly expiresAt?: string;
  /** What the engine does at the deadline (approve, or fail the run with `run_timeout`), when one was authored. */
  readonly timeoutAction?: RunGateTimeoutAction;
  /** The decision kinds this gate's type accepts (`decisionsForGateType`): nothing else is ever offered. */
  readonly accepts: readonly GateDecision['decision'][];
}

/**
 * One open budget gate of a parked run, as the Home's card holds it ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4).
 * The allowance is the log's own structured projection (`budgetPromptContext` of the frozen quote), never parsed from text, and the
 * decisions it accepts follow from it: only a priced, representable allowance can be approved, and then only for exactly that amount.
 */
export interface RunBudgetGate {
  readonly runId: string;
  readonly gateId: string;
  readonly nodeId: string;
  /** What the log froze: an exact amount, a quote that can only be rejected, or a legacy gate with none. */
  readonly allowance: BudgetPromptContext;
  readonly expiresAt?: string;
  /** `approved` is offered only for an `amount` allowance; every other allowance accepts a rejection (an abort) only. */
  readonly accepts: readonly GateDecision['decision'][];
}

/** Any gate the Home's card can hold: a human gate or a budget gate. */
export type RunCardGate = RunGate | RunBudgetGate;

export function isBudgetGate(gate: RunCardGate): gate is RunBudgetGate {
  return 'allowance' in gate;
}

/** The budget gates of `run` as the card holds them, in the order the log raised them. */
export function budgetCardGates(run: RunGates): readonly RunBudgetGate[] {
  return run.budgetGates.map(
    (gate): RunBudgetGate => ({
      runId: run.runId,
      gateId: gate.gateId,
      nodeId: gate.nodeId,
      allowance: gate.allowance,
      ...(gate.expiresAt === undefined ? {} : { expiresAt: gate.expiresAt }),
      accepts: gate.allowance.kind === 'amount' ? ['approved', 'rejected'] : ['rejected'],
    }),
  );
}

/** Every gate the card holds for `run`: its human gates, then its budget gates. */
export function cardGatesOf(run: RunGates): readonly RunCardGate[] {
  return [...run.gates, ...budgetCardGates(run)];
}

/** One parked run of this project and what it is waiting on. */
export interface RunGates {
  readonly runId: string;
  readonly workflowId: string;
  /** Its open human gates, in the order the log raised them; empty for a media park or a budget-only park. */
  readonly gates: readonly RunGate[];
  /** Its open budget gates (the budget card's, not the human gate card's). */
  readonly budgetGates: readonly PendingBudgetGate[];
  /**
   * The nodes whose async media jobs are still in flight, from the same fold of the log. A run with this and no gate is the media-only park:
   * the Home continues it with no decision ({@link isMediaOnlyPark}). Absent reads as none (a stand-in for a read that was not made).
   */
  readonly pendingMediaJobNodeIds?: readonly string[];
  /** The run's event log could not be read: `gates` is a stand-in, not an answer. */
  readonly degraded: boolean;
}

/**
 * Whether `run` waits on media jobs and on nothing a person can decide: a readable log, no human gate, no budget gate and at least one job
 * in flight. The one test of "the media-only park" for the Home's rows, its question and the Active tab, so they cannot disagree on it
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3).
 */
export function isMediaOnlyPark(
  run: Pick<RunGates, 'gates' | 'budgetGates' | 'pendingMediaJobNodeIds' | 'degraded'>,
): boolean {
  return (
    !run.degraded &&
    run.gates.length === 0 &&
    run.budgetGates.length === 0 &&
    (run.pendingMediaJobNodeIds?.length ?? 0) > 0
  );
}

export interface ProjectRunGates {
  readonly runs: readonly RunGates[];
  /** The ids of the runs whose log could not be read. */
  readonly degradedRunIds: readonly string[];
  /** The project parks more runs than one call reads. */
  readonly truncated: boolean;
}

/** The reads this module needs: a keyset page of summaries, one run's detail and a run's state events. */
export type RunGatesReader = Pick<
  RunHistoryReader,
  'listRunSummaries' | 'loadRunDetail' | 'loadRunStateEvents'
>;

/** The timeout policy each `human_gate:paused` event carried, by gate id (the display projection leaves it out). */
function timeoutActions(events: readonly RunEvent[]): ReadonlyMap<string, RunGateTimeoutAction> {
  const byGate = new Map<string, RunGateTimeoutAction>();
  for (const event of events) {
    if (event.type === 'human_gate:paused' && event.timeoutAction !== undefined)
      byGate.set(event.gateId, event.timeoutAction);
  }
  return byGate;
}

/** One parked run's gates, read from its own log in one isolated read (a damaged log degrades this run only). */
export function gatesOfRun(
  reader: Pick<RunGatesReader, 'loadRunStateEvents'>,
  run: { readonly id: string; readonly workflowId: string },
): RunGates {
  const read = readPerRunOrDegrade<Omit<RunGates, 'degraded'>>(
    {
      runId: run.id,
      workflowId: run.workflowId,
      gates: [],
      budgetGates: [],
      pendingMediaJobNodeIds: [],
    },
    () => {
      const events = reader.loadRunStateEvents(run.id);
      const pending = pendingParkDisplays(events);
      const actions = timeoutActions(events);
      return {
        runId: run.id,
        workflowId: run.workflowId,
        gates: pending.pendingGates.map((gate): RunGate => {
          const action = actions.get(gate.gateId);
          return {
            runId: run.id,
            gateId: gate.gateId,
            nodeId: gate.nodeId,
            gateType: gate.gateType,
            message: gate.message,
            ...(gate.expiresAt === undefined ? {} : { expiresAt: gate.expiresAt }),
            ...(action === undefined ? {} : { timeoutAction: action }),
            accepts: decisionsForGateType(gate.gateType),
          };
        }),
        budgetGates: pending.pendingBudgetGates,
        pendingMediaJobNodeIds: pending.pendingMediaJobNodeIds,
      };
    },
  );
  return { ...read.value, degraded: read.degraded };
}

/** What one scan of the parked runs has gathered so far. */
interface GatesScan {
  readonly runs: RunGates[];
  readonly degradedRunIds: string[];
  truncated: boolean;
}

/**
 * Fold one page of run summaries into the scan: a run of another directory is skipped whatever the reader handed back, a run past
 * `maxRuns` marks the scan truncated and ends the page, and a run whose log is damaged is kept degraded and named.
 */
function foldPage(
  scan: GatesScan,
  reader: RunGatesReader,
  page: ReturnType<RunGatesReader['listRunSummaries']>,
  projectRoot: string,
  maxRuns: number,
): void {
  for (const run of page) {
    if (run.projectRoot !== projectRoot) continue;
    if (scan.runs.length >= maxRuns) {
      scan.truncated = true;
      return;
    }
    const read = gatesOfRun(reader, run);
    scan.runs.push(read);
    if (read.degraded) scan.degradedRunIds.push(run.id);
  }
}

/**
 * Every parked run of `projectRoot` with the gates it is waiting on, newest run first. A run of another directory is never
 * returned, whatever the reader hands back.
 */
export function readProjectRunGates(
  reader: RunGatesReader,
  projectRoot: string,
  options?: { readonly maxRuns?: number },
): ProjectRunGates {
  const maxRuns = Math.min(Math.max(1, options?.maxRuns ?? RUN_GATES_MAX_RUNS), RUN_GATES_MAX_RUNS);
  const scan: GatesScan = { runs: [], degradedRunIds: [], truncated: false };
  let before: KeysetCursor | undefined;
  // One row more than the call may keep is enough to know it was truncated: a Home that shows eight parked runs reads nine summaries, not a chunk.
  const limit = Math.min(RUN_GATES_CHUNK, maxRuns + 1);
  for (;;) {
    const page = reader.listRunSummaries({
      limit,
      status: 'paused',
      projectRoot,
      ...(before === undefined ? {} : { before }),
    });
    foldPage(scan, reader, page, projectRoot, maxRuns);
    if (scan.truncated || page.length < limit) break;
    // The one derivation the browsers share: a last row whose time does not parse has no keyset position, and the store refuses such a
    // cursor with `invalid_cursor`, which would take the whole Attention list down for one damaged row. A FULL page that cannot be
    // continued from may have runs after it, so the read ends and says it was cut, never that it saw every parked run.
    before = keysetCursorOf(page.at(-1));
    if (before === undefined) {
      scan.truncated = true;
      break;
    }
  }
  return { runs: scan.runs, degradedRunIds: scan.degradedRunIds, truncated: scan.truncated };
}

/**
 * One run's gates, when the run is parked in `projectRoot`: `undefined` for a run that does not exist, is not paused or belongs to
 * another directory. The run view re-reads with this after an answer, so the card shows what the log now says.
 */
export function readRunGates(
  reader: Pick<RunGatesReader, 'loadRunDetail' | 'loadRunStateEvents'>,
  projectRoot: string,
  runId: string,
): RunGates | undefined {
  const run = reader.loadRunDetail(runId);
  if (run === undefined || run.status !== 'paused' || run.projectRoot !== projectRoot)
    return undefined;
  return gatesOfRun(reader, run);
}
