/**
 * The durable-truth oracle (`CR-91`) — does a run's LIVE answer survive a restart?
 *
 * The e2e harness could already prove that a run streamed a terminal and that the terminal said what the test
 * expected. That is one view, taken in-process, while the engine that produced it is still alive. It cannot
 * catch the failure class phase 2.6.5 exists for: a caller receives `run:completed` with outputs while the
 * durable log says the run failed, or a restart reconciles the same run to a DIFFERENT terminal, or a resume
 * re-runs work the log already records as done. Every one of those is invisible to a live assertion.
 *
 * So this compares FOUR independent views of the same run and reports where they disagree:
 *
 * 1. **live** — the terminal the caller drained from `RunHandle.events`.
 * 2. **history** — the terminal as it exists in the store, read back.
 * 3. **after reconcile** — the history a *fresh* engine leaves behind after `reconcile()` on restart. It must
 *    be the SAME terminal: reconciliation repairs a run that died without one, and must never overwrite or
 *    duplicate one that already landed.
 * 4. **checkpoint** — the status `reconstructCheckpointState` derives from the durable log alone. A resume
 *    seeds itself from this, so if it disagrees with the terminal, a resumed run does the wrong work.
 *
 * **It returns a verdict rather than throwing.** A thrower is hard to test and forces every caller into the
 * same message; a structured verdict lets the callers that need one assert on the specific disagreement, and
 * lets this module have its own tests. {@link formatDurableTruth} renders it when a caller just wants to fail
 * with a readable diff.
 *
 * This is the instrument `CR-10`, `CR-11`, `CR-12` and `CR-92` are proven with, which is why it lands before
 * them — a spine asserted with a harness that only reads the live stream is not asserted.
 */

import type { RunEvent, RunStatus } from '@relavium/shared';

import { reconstructCheckpointState } from './checkpoint.js';

/** The run terminals. Exactly one closes a run (ADR-0036); the oracle's whole job is to check they agree. */
const TERMINALS = new Set<RunEvent['type']>(['run:completed', 'run:failed', 'run:cancelled']);

/** The run status each terminal implies — the checkpoint fold must arrive at the same one. */
const STATUS_FOR: Partial<Record<RunEvent['type'], RunStatus>> = {
  'run:completed': 'completed',
  'run:failed': 'failed',
  'run:cancelled': 'cancelled',
};

/**
 * A terminal reduced to what must agree across views: its type, and the payload a consumer acts on.
 *
 * Deliberately NOT the whole event. `timestamp` and `sequenceNumber` are envelope fields the bus stamps, and
 * comparing them would make every restart look like a disagreement while catching nothing — the failure this
 * oracle is for is a terminal whose TYPE or OUTPUT changed, not one whose clock moved.
 */
export interface TerminalView {
  readonly type: RunEvent['type'];
  /** `run:completed.outputs` / `run:failed.partialOutputs`, JSON-normalized. Absent for `run:cancelled`. */
  readonly outputs?: string;
  /** `run:failed.error.code`, when the terminal carries one. */
  readonly errorCode?: string;
  /** The run-wide realized total the terminal reports, when it carries one. */
  readonly costMicrocents?: number;
}

export interface DurableTruthVerdict {
  readonly agrees: boolean;
  readonly runId: string;
  readonly live: TerminalView | undefined;
  readonly history: TerminalView | undefined;
  readonly afterReconcile: TerminalView | undefined;
  readonly checkpointStatus: RunStatus | undefined;
  /** How many terminals the durable log holds. Anything but 1 breaks exactly-one-terminal (ADR-0036). */
  readonly durableTerminalCount: number;
  /** Events `reconcile()` produced. Non-empty for a run that already had a durable terminal is a defect. */
  readonly reconciledCount: number;
  /** One sentence per disagreement, in the order checked. Empty iff `agrees`. */
  readonly disagreements: readonly string[];
}

function viewOf(event: RunEvent | undefined): TerminalView | undefined {
  if (event === undefined) return undefined;
  switch (event.type) {
    case 'run:completed':
      return {
        type: event.type,
        outputs: JSON.stringify(event.outputs),
        costMicrocents: event.totalCostMicrocents,
      };
    case 'run:failed':
      return {
        type: event.type,
        outputs: JSON.stringify(event.partialOutputs),
        errorCode: event.error.code,
        ...(event.cumulativeCostMicrocents === undefined
          ? {}
          : { costMicrocents: event.cumulativeCostMicrocents }),
      };
    case 'run:cancelled':
      return {
        type: event.type,
        ...(event.cumulativeCostMicrocents === undefined
          ? {}
          : { costMicrocents: event.cumulativeCostMicrocents }),
      };
    default:
      return undefined;
  }
}

function terminalIn(events: readonly RunEvent[]): RunEvent | undefined {
  return events.find((event) => TERMINALS.has(event.type));
}

function describe(view: TerminalView | undefined): string {
  if (view === undefined) return 'none';
  const parts: string[] = [view.type];
  if (view.errorCode !== undefined) parts.push(`code=${view.errorCode}`);
  if (view.costMicrocents !== undefined) parts.push(`cost=${view.costMicrocents}`);
  if (view.outputs !== undefined) parts.push(`outputs=${view.outputs}`);
  return parts.join(' ');
}

function sameView(a: TerminalView | undefined, b: TerminalView | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.type === b.type &&
    a.outputs === b.outputs &&
    a.errorCode === b.errorCode &&
    a.costMicrocents === b.costMicrocents
  );
}

export interface DurableTruthInput {
  readonly runId: string;
  /** The terminal the caller drained from the live stream, or `undefined` if the stream produced none. */
  readonly live: RunEvent | undefined;
  /** Read the run's persisted events — the same store the run was executed against. */
  readonly eventsFor: (runId: string) => readonly RunEvent[] | Promise<readonly RunEvent[]>;
  /**
   * Run `reconcile()` as a FRESH engine over that same store, exactly as a restarted process would. Omit only
   * when the caller has already restarted for its own reasons; then view 3 is skipped and the verdict says so.
   */
  readonly reconcile?: () => Promise<readonly RunEvent[]>;
}

/**
 * Compare the four views. Cheap enough to call at the end of every e2e run; it reads the log twice and runs
 * one reconcile.
 */
export async function checkDurableTruth(input: DurableTruthInput): Promise<DurableTruthVerdict> {
  const disagreements: string[] = [];

  const before = [...(await input.eventsFor(input.runId))];
  const live = viewOf(input.live);
  const history = viewOf(terminalIn(before));

  if (!sameView(live, history)) {
    disagreements.push(
      `live and durable history disagree: live=${describe(live)} history=${describe(history)}`,
    );
  }

  let reconciledCount = 0;
  let afterReconcile = history;
  if (input.reconcile !== undefined) {
    const reconciled = await input.reconcile();
    reconciledCount = reconciled.length;
    const after = [...(await input.eventsFor(input.runId))];
    afterReconcile = viewOf(terminalIn(after));
    if (!sameView(history, afterReconcile)) {
      disagreements.push(
        `a restart CHANGED the terminal: before=${describe(history)} after=${describe(afterReconcile)}`,
      );
    }
    if (history !== undefined && reconciledCount > 0) {
      disagreements.push(
        `reconcile() produced ${reconciledCount} event(s) for a run that already had a durable terminal ` +
          `(${describe(history)}) — reconciliation repairs a run that died WITHOUT one, it must not add a second`,
      );
    }
  }

  const finalEvents = [...(await input.eventsFor(input.runId))];
  const terminalCount = finalEvents.filter((event) => TERMINALS.has(event.type)).length;
  if (terminalCount !== 1) {
    disagreements.push(
      `the durable log holds ${terminalCount} terminal(s); exactly one closes a run (ADR-0036)`,
    );
  }

  const checkpointStatus = reconstructCheckpointState(finalEvents)?.runStatus;
  const expectedStatus = afterReconcile === undefined ? undefined : STATUS_FOR[afterReconcile.type];
  if (expectedStatus !== undefined && checkpointStatus !== expectedStatus) {
    disagreements.push(
      `the checkpoint fold says '${String(checkpointStatus)}' while the durable terminal says ` +
        `'${expectedStatus}' — a resume seeds itself from the fold, so it would do the wrong work`,
    );
  }

  return {
    agrees: disagreements.length === 0,
    runId: input.runId,
    live,
    history,
    afterReconcile,
    checkpointStatus,
    durableTerminalCount: terminalCount,
    reconciledCount,
    disagreements,
  };
}

/** Render a verdict for an assertion message — every view on its own line, so the diff reads at a glance. */
export function formatDurableTruth(verdict: DurableTruthVerdict): string {
  return [
    `durable truth for run ${verdict.runId}: ${verdict.agrees ? 'AGREES' : 'DISAGREES'}`,
    `  live            : ${describe(verdict.live)}`,
    `  history         : ${describe(verdict.history)}`,
    `  after reconcile : ${describe(verdict.afterReconcile)}`,
    `  checkpoint      : ${String(verdict.checkpointStatus)}`,
    `  terminals in log: ${verdict.durableTerminalCount}`,
    ...verdict.disagreements.map((d) => `  ✖ ${d}`),
  ].join('\n');
}
