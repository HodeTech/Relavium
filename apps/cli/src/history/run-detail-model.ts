import type { RunDetailRecord, StepSummaryRecord } from '@relavium/db';
import {
  isCorruptRunEventError,
  UsageCoverageFold,
  type CostAttemptSettledEvent,
  type NodeCompletedEvent,
  type NodeFailedEvent,
  type NodeSkippedEvent,
  type NodeSkippedReason,
  type RunEvent,
  type RunStatus,
  type ToolActivityEntry,
  type UsageCoverage,
} from '@relavium/shared';

import { sanitizeInline, sanitizeUntrustedInline } from '../render/sanitize.js';
import {
  formatCostShort,
  formatDuration,
  formatReportedCost,
  formatTokens,
} from '../render/tui/format.js';
import { UNVERIFIED_USAGE } from './usage-coverage.js';

/**
 * The pure view model of ONE run's detail page — the header and the node table of ADR-0140 §2 (MVP-8 step 1).
 * No I/O, no clock, no ink: the caller reads the run (`loadRunDetail`), its attempt rows (`listStepSummaries`)
 * and its event log, builds this once when the page opens, and a thin view paints it. Every free-form string a
 * row carries (a node id, a model, a tool id, an error) has passed the sanitize floor; the raw `nodeId` is kept
 * beside its `label` only as the identity a drill-down looks up with, and is never what a view draws.
 *
 * **Cost is never a bare zero.** A node's money is read in this order and the row says which it used:
 * (1) the sum of the node's `cost:attempt_settled` rows (exact, ADR-0076); (2) failing that, the node's boundary
 * cost from `step_executions.cost_microcents`, marked approximate (`~`) because under a fan-out it is a delta of
 * the run-wide counter; (3) failing both, the row's absence sentence (below). The column defaults to `0`, so a `0`
 * there is indistinguishable from "never written" and is treated as absent, never shown as a price.
 *
 * **Tokens follow the cost, never a bare zero either.** A node's tokens are read in this order and the row says
 * which it used: (1) the sum of the `inputTokens` and `outputTokens` of the node's `cost:attempt_settled` rows,
 * the very attempts that give its cost, so a node that failed after a billed call and a node that succeeded on its
 * second attempt both show every attempt's tokens beside a cost that covers every attempt; (2) failing that, the
 * step row's tokens, for a COMPLETED node only (the step row of a failed attempt carries no tokens, so its `0` is
 * "never written", not a count); (3) failing both, the row's absence sentence. The run header's total is the same sum
 * over the whole log when the log holds any `cost:attempt_settled` row, and the run row's own totals otherwise. When
 * those are both `0` too, the header says why there is no figure by the run's own state, as a row does: `in progress`
 * for a run that has not finished (pending, running or paused: nothing has settled yet) and `not recorded` for one
 * that has (completed, failed or cancelled: the totals were never written).
 *
 * **An absent figure says why it is absent** ({@link absenceText}). A skipped row says `did not run` for its tokens,
 * cost and tool trace; a row left `stopped` (its last attempt has no terminal event and the run has finished) says
 * `did not finish`; a row still running in a run that has not finished says `in progress`. Only a completed or
 * failed row whose data is genuinely absent (an older log, or no settled row and no step figure) says
 * `not recorded` — anywhere else that sentence would read as data that was lost.
 *
 * **Attempt grouping (the load-bearing rule).** `cost:attempt_settled.attemptNumber` counts WITHIN a fallback
 * chain and resets to 1 on every node retry, so it does NOT join `node:started.attemptNumber`, which is the
 * node-retry dispatch index. A node's settled rows are therefore partitioned by the node's own `node:started`
 * events in `sequenceNumber` order: a row belongs to the nearest `node:started` of the same node that precedes
 * it. A row with no earlier `node:started` (a log cut short) stays in {@link NodeEventLog.settledBeforeStart}:
 * it still counts toward the node's total and belongs to no attempt.
 */

/**
 * What a completed or failed row says when a figure (tokens, cost, tool trace) is genuinely absent from what was
 * read — an older log, or no settled row and no step figure. Never `0`, never empty. A row that did not run, did
 * not finish or is still running says that instead ({@link absenceText}): `not recorded` there reads as lost data.
 */
export const NOT_RECORDED = 'not recorded';

/** What a skipped row says for tokens, cost and tool trace: the node never ran, so there is nothing to record. */
export const DID_NOT_RUN = 'did not run';

/** What a row says when its last attempt has no terminal event and the run has finished (status `stopped`). */
export const DID_NOT_FINISH = 'did not finish';

/** What a row says while it is still running in a run that has not finished. */
export const IN_PROGRESS = 'in progress';

/** Every sentence a row's figure can carry when it has nothing to show; see {@link absenceText}. */
export type AbsenceText =
  | typeof NOT_RECORDED
  | typeof DID_NOT_RUN
  | typeof DID_NOT_FINISH
  | typeof IN_PROGRESS;

/**
 * What a node's tool trace says when its terminal event carries no `toolActivity` field at all. Every node
 * terminal written since the field landed carries it (an empty array for a node that made no call), so absence
 * means the log was written by an older binary — never "no tool calls".
 */
export const NOT_RECORDED_OLDER_LOG = 'not recorded (older log)';

/**
 * What a tool-trace entry says when its call has no recorded result (`resultRecorded: false`). It states the fact and
 * no cause: a node that ended before the call was answered and a tool that threw (a fatal failure ends the node
 * with no `agent:tool_result`) look the same in the log, and the node's own error says why it failed. Only that
 * entry says it: a refusal is a recorded result.
 */
export const NO_RESULT_RECORDED = 'no result recorded';

/** What a node page's tool trace says for an attempt other than the one its terminal event closed. */
export const NOT_RECORDED_FOR_ATTEMPT = 'not recorded for this attempt';

/** A node's status as the table shows it. `stopped` is a step row left `running` under a finished run. */
export type NodeRowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'stopped';

/** The glyph of each node status; the word is the status itself (colour is never the only signal). */
export const NODE_ROW_GLYPH: Readonly<Record<NodeRowStatus, string>> = {
  pending: '○',
  running: '◐',
  completed: '✓',
  failed: '✗',
  skipped: '⊘',
  stopped: '■',
};

const FINISHED_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'failed',
  'cancelled',
]);

/** Whether a run has its durable terminal (so a step row still `running` under it never finished). */
export function isFinishedRun(status: RunStatus): boolean {
  return FINISHED_RUN_STATUSES.has(status);
}

/**
 * What a figure of a row (its tokens, its cost, its tool trace) says when it has nothing to show, by the row's own
 * state: a skipped row `did not run`; a row `stopped` (its last attempt has no terminal event and the run has
 * finished) `did not finish`; a row still `running` in a run that has not finished `in progress`; and only a
 * completed or failed row, whose data is genuinely absent (an older log, or no settled row and no step figure),
 * says `not recorded`. A `pending` row has not started: `did not run` once the run has finished, `in progress`
 * (the run is) before. This never invents a figure; it only says why there is none.
 */
export function absenceText(status: NodeRowStatus, runFinished: boolean): AbsenceText {
  switch (status) {
    case 'skipped':
      return DID_NOT_RUN;
    case 'pending':
      return runFinished ? DID_NOT_RUN : IN_PROGRESS;
    case 'stopped':
      return DID_NOT_FINISH;
    case 'running':
      return IN_PROGRESS;
    case 'completed':
    case 'failed':
      return NOT_RECORDED;
  }
}

/** The most code points of a stored error message a page shows. */
export const MAX_ERROR_MESSAGE_CHARS = 300;
/**
 * The ONE bound on the length of a stored text a page handles whole, in two places. {@link scrubbedBounded} (text that
 * could carry a secret) takes a value of at most this many code units and scrubs ALL of it; a longer value is not cut
 * and not scrubbed, it is not shown at all (a fixed sentence says only its size). {@link boundedIdentifier} (text this
 * codebase or the workflow authored, which is never scrubbed) cuts to this many code points before its non-scrubbing
 * filter runs, so a pathological row costs a bound. It is far above any window a view shows (the largest is 4096
 * code points), and it is the fixed bound on the scrub's work.
 */
export const SCRUB_INPUT_CHARS = 65_536;
/** The most code points of one stored identifier (an error code, a node id, a model name) a page shows. */
export const MAX_IDENTIFIER_CHARS = 128;
/**
 * The most code points of one stored project root (a path) a row shows. A path is longer than an identifier and is
 * read from its tail, so it gets the largest path an operating system accepts (`PATH_MAX`, 4096) rather than 128.
 */
export const MAX_PROJECT_ROOT_CHARS = 4096;

/**
 * The first characters of a run id, for a row: cut first (so a forged id costs a bound), then through the
 * one-line floor — a run id is read back from `history.db`, which accepts any text in that column.
 */
export function shortRunId(id: string): string {
  return sanitizeInline(id.slice(0, 8));
}

// ---------------------------------------------------------------------------------------------------------
// One pass over the events, grouped per node.
// ---------------------------------------------------------------------------------------------------------

/** One `node:started` and the settled model calls that followed it (until the node's next `node:started`). */
export interface AttemptGroup {
  /** `node:started.attemptNumber`, absent meaning 1 — the NODE-RETRY dispatch index, not the within-chain one. */
  readonly attemptNumber: number;
  readonly settled: readonly CostAttemptSettledEvent[];
}

/** What the log says about one node, built by {@link indexNodeEvents}. */
export interface NodeEventLog {
  /** The lowest `sequenceNumber` of any event the node produced — its place in execution order. */
  readonly firstSeq: number;
  /** One group per `node:started`, in sequence order. Its length is the node's attempt count. */
  readonly groups: readonly AttemptGroup[];
  /** Settled rows that precede every `node:started` of the node (a truncated log). */
  readonly settledBeforeStart: readonly CostAttemptSettledEvent[];
  /** The `node:completed` / `node:failed` with the highest `sequenceNumber`. */
  readonly lastTerminal?: NodeCompletedEvent | NodeFailedEvent;
  readonly skipped?: NodeSkippedEvent;
  /** A `human_gate:resumed` was recorded for this node. */
  readonly gateDecided: boolean;
}

interface MutableNodeEventLog {
  firstSeq: number;
  readonly groups: { attemptNumber: number; settled: CostAttemptSettledEvent[] }[];
  readonly settledBeforeStart: CostAttemptSettledEvent[];
  lastTerminal?: NodeCompletedEvent | NodeFailedEvent;
  skipped?: NodeSkippedEvent;
  gateDecided: boolean;
}

/** Every settled row of a node, attempts and strays together. */
export function allSettled(log: NodeEventLog | undefined): readonly CostAttemptSettledEvent[] {
  if (log === undefined) return [];
  return [...log.settledBeforeStart, ...log.groups.flatMap((group) => group.settled)];
}

/**
 * Group a run's events per node, in `sequenceNumber` order (the input need not be sorted). Only the events the
 * detail pages read are kept: the node boundaries, the settled model calls, a skip and a decided gate.
 */
export function indexNodeEvents(events: readonly RunEvent[]): ReadonlyMap<string, NodeEventLog> {
  const logs = new Map<string, MutableNodeEventLog>();
  const logFor = (nodeId: string, sequenceNumber: number): MutableNodeEventLog => {
    let log = logs.get(nodeId);
    if (log === undefined) {
      log = { firstSeq: sequenceNumber, groups: [], settledBeforeStart: [], gateDecided: false };
      logs.set(nodeId, log);
    }
    log.firstSeq = Math.min(log.firstSeq, sequenceNumber);
    return log;
  };
  const ordered = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  for (const event of ordered) {
    switch (event.type) {
      case 'node:started': {
        logFor(event.nodeId, event.sequenceNumber).groups.push({
          attemptNumber: event.attemptNumber ?? 1,
          settled: [],
        });
        break;
      }
      case 'cost:attempt_settled': {
        // The partition: the row goes to the nearest EARLIER `node:started` of this node. It is never keyed by
        // `event.attemptNumber`, which counts within a fallback chain and resets for each node retry.
        const log = logFor(event.nodeId, event.sequenceNumber);
        const group = log.groups.at(-1);
        (group === undefined ? log.settledBeforeStart : group.settled).push(event);
        break;
      }
      case 'node:completed':
      case 'node:failed': {
        logFor(event.nodeId, event.sequenceNumber).lastTerminal = event;
        break;
      }
      case 'node:skipped': {
        logFor(event.nodeId, event.sequenceNumber).skipped = event;
        break;
      }
      case 'human_gate:resumed': {
        logFor(event.nodeId, event.sequenceNumber).gateDecided = true;
        break;
      }
      default:
        break;
    }
  }
  return logs;
}

// ---------------------------------------------------------------------------------------------------------
// Usage coverage — the qualification every cost figure carries.
// ---------------------------------------------------------------------------------------------------------

/** The accounting facts a cost figure is qualified with (ADR-0104). */
export interface UsageFacts {
  readonly run: UsageCoverage;
  readonly nodes: ReadonlyMap<string, UsageCoverage>;
  /** Calls whose price was unknown, as the run-level counter and the ledger rows agree on. */
  readonly unpricedCalls: number;
}

/**
 * Fold a run's events into its usage coverage, the way the Home and `status` do (`readRunUsageCoverage`), but
 * over an in-memory log. A log with no `cost:coverage_started` stays `unverified` — an old or foreign history
 * never gains a basis by being read. A log whose accounting events contradict each other (the fold's invariant
 * error, surfaced as a corrupt-event error) degrades to `unverified` rather than throwing out of a display
 * model: the figures then say `usage unverified`. Any other error is rethrown.
 */
export function foldUsageFacts(events: readonly RunEvent[]): UsageFacts {
  const ordered = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const fold = new UsageCoverageFold();
  const nodes = new Map<string, UsageCoverageFold>();
  let ledgerUnpriced = 0;
  let snapshotUnpriced = 0;
  try {
    for (const event of ordered) {
      fold.apply(event);
      if (
        'nodeId' in event &&
        (event.type === 'node:started' ||
          event.type === 'cost:usage_pending' ||
          event.type === 'cost:usage_disposition' ||
          event.type === 'cost:attempt_settled')
      ) {
        let node = nodes.get(event.nodeId);
        if (node === undefined) {
          node = new UsageCoverageFold();
          node.start(fold.snapshot().coverage.unverified ? 'legacy_unverified' : 'complete');
          nodes.set(event.nodeId, node);
        }
        node.apply(event);
      }
      if (event.type === 'cost:attempt_settled' && event.priced === false) ledgerUnpriced++;
      snapshotUnpriced = Math.max(snapshotUnpriced, event.cumulativeUnpricedCalls ?? 0);
    }
  } catch (cause) {
    if (isCorruptRunEventError(cause)) {
      return { run: UNVERIFIED_USAGE, nodes: new Map(), unpricedCalls: 0 };
    }
    throw cause;
  }
  return {
    run: fold.snapshot().coverage,
    nodes: new Map([...nodes].map(([id, node]) => [id, node.snapshot().coverage])),
    // A queued boundary may already carry a later counter: never add ledger rows to that snapshot.
    unpricedCalls: Math.max(ledgerUnpriced, snapshotUnpriced),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Node cost.
// ---------------------------------------------------------------------------------------------------------

/** A node's (or an attempt's) money, with the source it was read from. */
export type NodeCost =
  | {
      /** The sum of `cost:attempt_settled` rows — exact. */
      readonly source: 'attempts';
      readonly microcents: number;
      readonly approximate: false;
      readonly unpricedCalls: number;
      readonly text: string;
    }
  | {
      /** The step row's boundary cost — a delta of the run-wide counter, so approximate (`~`). */
      readonly source: 'boundary';
      readonly microcents: number;
      readonly approximate: true;
      readonly unpricedCalls: 0;
      readonly text: string;
    }
  | {
      /** Neither exists. The text says why ({@link absenceText}): `not recorded` for a row that finished, never a zero amount. */
      readonly source: 'none';
      readonly approximate: false;
      readonly unpricedCalls: 0;
      readonly text: AbsenceText;
    };

/**
 * A node's cost from its settled rows, else its boundary cost, else nothing. `boundaryMicrocents` is the node's
 * `step_executions.cost_microcents`; a value of `0` is "absent" (the column defaults to it), so it never reaches
 * the screen as a price. `absence` is what the row says when it has neither ({@link absenceText}); it defaults to
 * `not recorded`.
 */
export function buildNodeCost(input: {
  readonly settled: readonly CostAttemptSettledEvent[];
  readonly boundaryMicrocents: number;
  readonly coverage: UsageCoverage | undefined;
  readonly absence?: AbsenceText;
}): NodeCost {
  const { settled, boundaryMicrocents, coverage, absence = NOT_RECORDED } = input;
  if (settled.length > 0) {
    let microcents = 0;
    let unpricedCalls = 0;
    for (const row of settled) {
      microcents += row.costMicrocents;
      if (!row.priced) unpricedCalls++;
    }
    return {
      source: 'attempts',
      microcents,
      approximate: false,
      unpricedCalls,
      text: formatCostShort(microcents, coverage, unpricedCalls),
    };
  }
  if (boundaryMicrocents > 0) {
    return {
      source: 'boundary',
      microcents: boundaryMicrocents,
      approximate: true,
      unpricedCalls: 0,
      text: `~${formatReportedCost(boundaryMicrocents, coverage, 0)}`,
    };
  }
  return { source: 'none', approximate: false, unpricedCalls: 0, text: absence };
}

/** A node's (or an attempt's) tokens, with the source they were read from. There is no cached count: the column is never written. */
export type NodeTokens =
  | {
      /** The sum of `cost:attempt_settled` rows — the same attempts that give the cost. */
      readonly source: 'attempts';
      readonly input: number;
      readonly output: number;
      readonly text: string;
    }
  | {
      /** The step row's own figures, read for a COMPLETED node only. */
      readonly source: 'step';
      readonly input: number;
      readonly output: number;
      readonly text: string;
    }
  | {
      /** Neither exists. The text says why ({@link absenceText}): `not recorded` for a row that finished, never `↑0 ↓0`. */
      readonly source: 'none';
      readonly text: AbsenceText;
    };

/** The `inputTokens` and `outputTokens` of `rows`, summed. */
function sumSettledTokens(rows: readonly CostAttemptSettledEvent[]): {
  readonly input: number;
  readonly output: number;
} {
  let input = 0;
  let output = 0;
  for (const row of rows) {
    input += row.inputTokens;
    output += row.outputTokens;
  }
  return { input, output };
}

/**
 * The figures of a node's step rows, summed, when the node COMPLETED and at least one row was read; absent
 * otherwise. A failed attempt's step row carries no tokens (the writer records none), so for any other node its
 * `0` would be a missing figure shown as a count.
 */
export function completedStepTokens(
  rows: readonly StepSummaryRecord[],
  status: NodeRowStatus,
): { readonly input: number; readonly output: number } | undefined {
  if (status !== 'completed' || rows.length === 0) return undefined;
  let input = 0;
  let output = 0;
  for (const row of rows) {
    input += row.inputTokens;
    output += row.outputTokens;
  }
  return { input, output };
}

/**
 * A node's (or an attempt's) tokens, by the rule of the module note: the sum of its `cost:attempt_settled` rows
 * when it has any (the same rows {@link buildNodeCost} sums), else the step row's figures when
 * `completedStep` is given (the caller gives it for a completed node only, see {@link completedStepTokens}), else
 * what `absence` says ({@link absenceText}; `not recorded` by default).
 */
export function buildNodeTokens(input: {
  readonly settled: readonly CostAttemptSettledEvent[];
  readonly completedStep: { readonly input: number; readonly output: number } | undefined;
  readonly absence?: AbsenceText;
}): NodeTokens {
  const { settled, completedStep, absence = NOT_RECORDED } = input;
  if (settled.length > 0) {
    const sum = sumSettledTokens(settled);
    return { source: 'attempts', ...sum, text: formatTokens(sum) };
  }
  if (completedStep !== undefined) {
    return { source: 'step', ...completedStep, text: formatTokens(completedStep) };
  }
  return { source: 'none', text: absence };
}

// ---------------------------------------------------------------------------------------------------------
// Tool activity and stored errors.
// ---------------------------------------------------------------------------------------------------------

/** One call of a node's tool trace, content-free (ADR-0140 §4). */
export interface ToolActivityRowView {
  /** Scrubbed, one line and cut to {@link MAX_IDENTIFIER_CHARS} code points: it is read back from the history file. */
  readonly toolId: string;
  readonly ok: boolean;
  /** A result paired with the call. `false` only for a call the node ended before it was answered. */
  readonly resultRecorded: boolean;
  /** Measured by the engine; present only when it was (a refusal and an unpaired call have none). */
  readonly durationMs?: number;
  /**
   * The three outcomes of the sse-event-schema trace table, and the success: `refused` is a recorded result with no
   * duration (the tool never ran); `failed` is a recorded failure that ran; `unpaired` is no result at all.
   */
  readonly outcome: 'ok' | 'failed' | 'refused' | 'unpaired';
  /** What the row says, one line: `ok`, `ok in 12ms`, `refused`, `failed after 340ms`, or {@link NO_RESULT_RECORDED}. */
  readonly text: string;
}

/**
 * A node's tool trace. `recorded: false` is one of a few statements, and the text says which: the node has no
 * terminal event, and the text says why by the row's state ({@link absenceText}) — `did not run` (skipped),
 * `did not finish` (stopped under a finished run), `in progress`, or, for a completed or failed row whose terminal
 * was not read (the log was cut), `not recorded`; or its terminal carries no `toolActivity` field, which only a
 * log written before the field existed lacks — `not recorded (older log)`; or the terminal closed a different
 * attempt than the one the page shows — `not recorded for this attempt`. `recorded: true` with no entries is a
 * node that made no tool call (`no tool calls`), a different statement from all of them.
 */
export type ToolActivityView =
  | {
      readonly recorded: false;
      readonly text: AbsenceText | typeof NOT_RECORDED_OLDER_LOG | typeof NOT_RECORDED_FOR_ATTEMPT;
    }
  | {
      readonly recorded: true;
      readonly entries: readonly ToolActivityRowView[];
      /** Calls beyond the stored entries (`toolActivityTruncated`). */
      readonly truncated: number;
      readonly text: string;
    };

/**
 * One stored entry as a row. `resultRecorded` alone says whether the call was answered: a refusal is `ok: false`
 * with no duration exactly as an unpaired call is, and must never be described as one.
 */
function toolActivityRow(entry: ToolActivityEntry): ToolActivityRowView {
  const toolId = scrubbedBounded(entry.toolId);
  const duration = entry.durationMs === undefined ? {} : { durationMs: entry.durationMs };
  if (!entry.resultRecorded) {
    return {
      toolId,
      ok: false,
      resultRecorded: false,
      outcome: 'unpaired',
      text: NO_RESULT_RECORDED,
    };
  }
  if (entry.ok) {
    const text =
      entry.durationMs === undefined ? 'ok' : `ok in ${formatDuration(entry.durationMs)}`;
    return { toolId, ok: true, resultRecorded: true, ...duration, outcome: 'ok', text };
  }
  if (entry.durationMs === undefined) {
    return { toolId, ok: false, resultRecorded: true, outcome: 'refused', text: 'refused' };
  }
  return {
    toolId,
    ok: false,
    resultRecorded: true,
    ...duration,
    outcome: 'failed',
    text: `failed after ${formatDuration(entry.durationMs)}`,
  };
}

/**
 * The tool trace of a node's last terminal event. `absence` is what the row says when it has no terminal
 * ({@link absenceText}); it defaults to `not recorded`.
 */
export function buildToolActivity(
  terminal: NodeCompletedEvent | NodeFailedEvent | undefined,
  absence: AbsenceText = NOT_RECORDED,
): ToolActivityView {
  if (terminal === undefined) return { recorded: false, text: absence };
  const stored = terminal.toolActivity;
  if (stored === undefined) return { recorded: false, text: NOT_RECORDED_OLDER_LOG };
  const entries = stored.map(toolActivityRow);
  const truncated = terminal.toolActivityTruncated ?? 0;
  const total = entries.length + truncated;
  return {
    recorded: true,
    entries,
    truncated,
    text: total === 0 ? 'no tool calls' : `${total} tool ${total === 1 ? 'call' : 'calls'}`,
  };
}

/**
 * The tool trace of the node's terminal event, for the attempt a page shows. A terminal records the one attempt
 * that produced it (`attemptNumber`, absent meaning 1), so another attempt's page must not borrow it: its trace is
 * `not recorded for this attempt`. With no terminal at all it says `absence` ({@link buildToolActivity}).
 */
export function buildToolActivityForAttempt(
  terminal: NodeCompletedEvent | NodeFailedEvent | undefined,
  attemptNumber: number,
  absence: AbsenceText = NOT_RECORDED,
): ToolActivityView {
  if (terminal !== undefined && (terminal.attemptNumber ?? 1) !== attemptNumber) {
    return { recorded: false, text: NOT_RECORDED_FOR_ATTEMPT };
  }
  return buildToolActivity(terminal, absence);
}

/** A stored error, sanitized and bounded. */
export interface StoredErrorView {
  readonly code?: string;
  readonly message?: string;
  readonly nodeId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first `max` code points of `text`, and whether anything was cut. Never splits a code point. */
export function clipCodePoints(
  text: string,
  max: number,
): { readonly text: string; readonly truncated: boolean } {
  let end = 0;
  let count = 0;
  for (const point of text) {
    if (count === max) return { text: text.slice(0, end), truncated: true };
    end += point.length;
    count++;
  }
  return { text, truncated: false };
}

/**
 * One stored identifier for a row: cut to a bound before the filter reads it, filtered to one line (by default
 * the one-line floor), then cut to {@link MAX_IDENTIFIER_CHARS} code points, with `…` marking a cut. It is for text
 * this codebase or the workflow authored (a node id, a model name). A SCRUBBING filter does not belong here: the
 * first cut can split a secret, and its remaining prefix is no longer a shape the scrubber recognizes. Text that
 * could carry a secret goes through {@link scrubbedBounded}, which scrubs it whole first.
 */
export function boundedIdentifier(
  text: string,
  filter: (text: string) => string = sanitizeInline,
): string {
  const clipped = clipCodePoints(
    filter(clipCodePoints(text, SCRUB_INPUT_CHARS).text),
    MAX_IDENTIFIER_CHARS,
  );
  return clipped.truncated ? `${clipped.text}…` : clipped.text;
}

/**
 * Text read back from the history file that could carry a secret (an error's message or code, an event's reason),
 * for one row: scrubbed WHOLE and filtered to one line ({@link sanitizeUntrustedInline}), and only then cut to
 * `max` code points (default {@link MAX_IDENTIFIER_CHARS}), with `…` marking a cut. The order is the point: a cut
 * made first can leave the first characters of a secret that the scrubber no longer recognizes, and a mask made
 * first can never be clipped away from its context.
 *
 * The scrub's work is bounded by refusing, never by cutting: a value of more than {@link SCRUB_INPUT_CHARS} code units
 * is neither scrubbed nor shown in part (any cut made before the scrub can leave the recognizable prefix of a secret
 * in the window); the whole of it is replaced by a fixed sentence that says only its size in UTF-8 bytes. A value of
 * exactly the bound is scrubbed whole.
 */
export function scrubbedBounded(text: string, max: number = MAX_IDENTIFIER_CHARS): string {
  if (text.length > SCRUB_INPUT_CHARS) {
    return `text too large to show (${Buffer.byteLength(text, 'utf8')} bytes)`;
  }
  const clipped = clipCodePoints(sanitizeUntrustedInline(text), max);
  return clipped.truncated ? `${clipped.text}…` : clipped.text;
}

/** The largest stored `error_json` a page reads: 1 MiB, the output preview's bound ({@link MAX_STORED_OUTPUT_BYTES}'s twin). */
export const MAX_STORED_ERROR_BYTES = 1_048_576;

/** The fixed sentence for a stored error above {@link MAX_STORED_ERROR_BYTES}: it is never read, only its size is said. */
function oversizedError(bytes: number): StoredErrorView {
  return { message: `error record too large to show (${bytes} bytes)` };
}

/**
 * Read a stored `error_json` (`{ code, message, nodeId? }`) for display. The text is data from the history file.
 * The detail reads size-gate the document in SQL (`MAX_RUN_DETAIL_DOCUMENT_BYTES`): an over-bound document arrives as
 * `null` text with its `byteLength`, and is refused here with the fixed sentence without ever being read; `null` text
 * with no byte length is no error at all. A text above {@link MAX_STORED_ERROR_BYTES} is refused the same way before
 * it is parsed, so what is scrubbed below is bounded. The message and the code are then each scrubbed whole, passed
 * through the one-line floor, and only then cut ({@link scrubbedBounded}) to {@link MAX_ERROR_MESSAGE_CHARS} and
 * {@link MAX_IDENTIFIER_CHARS}; the node id passes the floor and the same cut. An unreadable document yields a
 * fixed sentence, never a throw.
 */
export function readStoredError(
  json: string | null | undefined,
  byteLength?: number | null,
): StoredErrorView | undefined {
  if (json === undefined || json === null) {
    return typeof byteLength === 'number' ? oversizedError(byteLength) : undefined;
  }
  const size = Buffer.byteLength(json, 'utf8');
  if (size > MAX_STORED_ERROR_BYTES) return oversizedError(size);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { message: 'the error record could not be read' };
  }
  if (!isRecord(parsed)) return { message: 'the error record could not be read' };
  const code = parsed['code'];
  const message = parsed['message'];
  const nodeId = parsed['nodeId'];
  return {
    ...(typeof code === 'string' ? { code: scrubbedBounded(code) } : {}),
    ...(typeof message === 'string'
      ? { message: scrubbedBounded(message, MAX_ERROR_MESSAGE_CHARS) }
      : {}),
    ...(typeof nodeId === 'string' ? { nodeId: boundedIdentifier(nodeId) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------
// The run detail.
// ---------------------------------------------------------------------------------------------------------

export interface RunDetailInput {
  readonly run: RunDetailRecord;
  /** The run's attempt rows in execution order (`listStepSummaries`): one per node attempt. */
  readonly steps: readonly StepSummaryRecord[];
  /** The run's event log. Not required to be sorted. Pass the whole log: costs and coverage fold over it. */
  readonly events: readonly RunEvent[];
  /**
   * The workflow's authored node order, when the caller read it from the frozen snapshot. It only orders nodes
   * that have no event position (a log that was not read); it never adds a row for a node with no record.
   */
  readonly workflowNodeOrder?: readonly string[];
  /** The workflow's slug when the caller resolved it; the header shows the workflow id otherwise. */
  readonly workflowSlug?: string;
  /** Node id → engine node type from the frozen snapshot, for a skipped node (it has no step row). */
  readonly nodeTypes?: ReadonlyMap<string, string>;
}

export interface NodeRow {
  /** The raw identity a drill-down looks the node up with. Never draw it; draw {@link label}. */
  readonly nodeId: string;
  readonly label: string;
  readonly nodeType?: string;
  readonly status: NodeRowStatus;
  readonly glyph: string;
  /** The number of `node:started` events (the step-row count when the log has none). */
  readonly attemptCount: number;
  /** The last attempt's duration. */
  readonly durationMs?: number;
  /**
   * The node's tokens, by the rule of the module note: its settled rows, else a completed step row, else the row's
   * absence sentence ({@link absenceText}: `did not run`, `did not finish`, `in progress` or `not recorded`).
   */
  readonly tokens: NodeTokens;
  readonly cost: NodeCost;
  /** Why the node was skipped, as words; present for a `skipped` row with a recorded reason. */
  readonly skippedReason?: string;
  readonly toolActivity: ToolActivityView;
}

export interface RunDetailHeader {
  readonly runId: string;
  readonly shortId: string;
  readonly status: RunStatus;
  readonly workflow: string;
  readonly startedAt?: string;
  readonly durationMs?: number;
  /**
   * The run's tokens. The sum of the `cost:attempt_settled` rows of the whole log when the log holds any (the same
   * rows that give the cost beside it), else the run row's own totals.
   */
  readonly tokens: { readonly input: number; readonly output: number };
  /**
   * {@link tokens} as text; when there is no settled row and the run row's totals are both `0`, the absence sentence
   * of the run's state instead: `in progress` for a run that has not finished, `not recorded` for one that has.
   */
  readonly tokensText: string;
  readonly totalCostMicrocents: number;
  /** The run total, qualified by the coverage the log establishes — never a bare number. */
  readonly costText: string;
  readonly error?: StoredErrorView;
}

export interface RunDetailModel {
  readonly header: RunDetailHeader;
  readonly rows: readonly NodeRow[];
  /** The run's total minus every node cost that has a source, clamped at zero. */
  readonly unattributedMicrocents: number;
  /** Present when {@link unattributedMicrocents} is non-zero: the `unattributed` row. */
  readonly unattributedRow?: { readonly label: 'unattributed'; readonly text: string };
  /** The first node (execution order) whose LAST attempt failed; a retried-then-successful node never matches. */
  readonly firstFailedNodeId?: string;
}

const SKIP_REASON_TEXT: Readonly<Record<NodeSkippedReason, string>> = {
  branch_not_taken: 'branch not taken',
  upstream_unreachable: 'upstream unreachable',
};

/**
 * One step row per `attemptNumber`, in the order each number first appeared, keeping the LAST row of a number. A node
 * that is dispatched again under the number it already ran under (a budget-approved redispatch, a resume of a node left
 * running) can have two rows with one number; the later row is the dispatch that settled last, so it is the one that
 * says where the attempt stands. Without this, the attempts list would show one attempt twice, and the step-row
 * fallback ({@link completedStepTokens}) would add one attempt's tokens to themselves. Apply it before any per-attempt
 * or fallback use of a node's rows.
 */
export function collapseAttemptRows(rows: readonly StepSummaryRecord[]): StepSummaryRecord[] {
  const byAttempt = new Map<number, StepSummaryRecord>();
  for (const row of rows) byAttempt.set(row.attemptNumber, row);
  return [...byAttempt.values()];
}

/** The attempt row with the highest `attemptNumber`; on a tie, the later one in execution order. */
export function lastAttemptRow(rows: readonly StepSummaryRecord[]): StepSummaryRecord | undefined {
  let last: StepSummaryRecord | undefined;
  for (const row of rows) {
    if (last === undefined || row.attemptNumber >= last.attemptNumber) last = row;
  }
  return last;
}

/**
 * The table status of a node. A step row `running` under a finished run is `stopped` (a decided gate, a node a
 * failure killed, a parked media node), as `relavium status` says; a `human_in_the_loop` step whose gate was
 * decided is `completed`, because no `node:completed` closes that row.
 */
export function resolveNodeStatus(input: {
  readonly step: StepSummaryRecord | undefined;
  readonly log: NodeEventLog | undefined;
  readonly runFinished: boolean;
}): NodeRowStatus {
  const { step, log, runFinished } = input;
  if (step !== undefined) {
    if (step.status !== 'running') return step.status;
    if (step.nodeType === 'human_in_the_loop' && log?.gateDecided === true) return 'completed';
    return runFinished ? 'stopped' : 'running';
  }
  if (log?.skipped !== undefined) return 'skipped';
  if (log?.lastTerminal !== undefined) {
    return log.lastTerminal.type === 'node:failed' ? 'failed' : 'completed';
  }
  if (log !== undefined && log.groups.length > 0) return runFinished ? 'stopped' : 'running';
  return 'pending';
}

function groupSteps(steps: readonly StepSummaryRecord[]): Map<string, StepSummaryRecord[]> {
  const byNode = new Map<string, StepSummaryRecord[]>();
  for (const step of steps) {
    const rows = byNode.get(step.nodeId);
    if (rows === undefined) byNode.set(step.nodeId, [step]);
    else rows.push(step);
  }
  return byNode;
}

/**
 * Node ids in execution order: by the first event each produced; a node with no event (its log was not read) is
 * placed after them by its authored position, then by its step-row position.
 */
function executionOrder(input: {
  readonly stepsByNode: ReadonlyMap<string, readonly StepSummaryRecord[]>;
  readonly logs: ReadonlyMap<string, NodeEventLog>;
  readonly authored: readonly string[] | undefined;
}): string[] {
  const { stepsByNode, logs, authored } = input;
  const stepPosition = new Map<string, number>();
  for (const nodeId of stepsByNode.keys()) stepPosition.set(nodeId, stepPosition.size);
  const ids = new Set<string>([...stepsByNode.keys(), ...logs.keys()]);
  const authoredPosition = (nodeId: string): number => {
    const index = authored?.indexOf(nodeId) ?? -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const rank = (nodeId: string): readonly [number, number, number] => {
    const log = logs.get(nodeId);
    if (log !== undefined) return [0, log.firstSeq, 0];
    return [1, authoredPosition(nodeId), stepPosition.get(nodeId) ?? 0];
  };
  return [...ids].sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  });
}

/** Wall-clock span between two ISO timestamps; absent when either is missing or unparseable. */
export function spanMs(
  startedAt: string | undefined,
  completedAt: string | undefined,
): number | undefined {
  if (startedAt === undefined || completedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

/**
 * The run header's tokens: the sum over the whole log's `cost:attempt_settled` rows when it holds any, so the figure
 * covers the same attempts the run's cost does (the run row keeps no tokens for a node that failed after a billed
 * call); the run row's own totals when the log holds none (an older log, or one that was not read). With no settled
 * row AND both totals `0` the figure is never a bare `↑0 ↓0`: the column defaults to `0`, so that zero is "never
 * written", not a count. It says why there is none by the run's state ({@link isFinishedRun}), as a node row does:
 * `in progress` for a run that has not finished (pending, running or paused: nothing has settled yet, and the run
 * row's totals are still the default `0`), and `not recorded` for one that has (an empty run, or a failed run with no
 * billed attempt). A settled row, however small, is a recorded figure, as are non-zero totals.
 */
function runTokens(
  run: RunDetailRecord,
  events: readonly RunEvent[],
): { readonly input: number; readonly output: number; readonly text: string } {
  const settledRows = events.filter(
    (event): event is CostAttemptSettledEvent => event.type === 'cost:attempt_settled',
  );
  if (settledRows.length > 0) {
    const sum = sumSettledTokens(settledRows);
    return { ...sum, text: formatTokens(sum) };
  }
  const totals = { input: run.totalInputTokens, output: run.totalOutputTokens };
  const unrecorded = totals.input === 0 && totals.output === 0;
  if (!unrecorded) return { ...totals, text: formatTokens(totals) };
  return { ...totals, text: isFinishedRun(run.status) ? NOT_RECORDED : IN_PROGRESS };
}

/** Build the run detail page's model. See the module note for the cost and attempt rules. */
export function buildRunDetailModel(input: RunDetailInput): RunDetailModel {
  const { run, steps, events } = input;
  const runFinished = isFinishedRun(run.status);
  const logs = indexNodeEvents(events);
  const facts = foldUsageFacts(events);
  const stepsByNode = groupSteps(steps);

  const rows = executionOrder({ stepsByNode, logs, authored: input.workflowNodeOrder }).map(
    (nodeId): NodeRow => {
      const storedSteps = stepsByNode.get(nodeId) ?? [];
      // One row per attempt number before any per-attempt or fallback use: a re-dispatched node can hold two rows
      // under one number, and the tokens fallback would add one attempt's tokens to themselves.
      const nodeSteps = collapseAttemptRows(storedSteps);
      const log = logs.get(nodeId);
      const last = lastAttemptRow(nodeSteps);
      const status = resolveNodeStatus({ step: last, log, runFinished });
      const nodeType = last?.nodeType ?? input.nodeTypes?.get(nodeId);
      // Every non-zero boundary figure on a node's rows is the node-wide cost at that boundary (the writer stores
      // `nodeSettledCost`, not a per-attempt delta), so the rows are never summed: the largest one is the node's. It
      // is read over every stored row, a collapsed duplicate included: a maximum is not a per-attempt figure.
      const boundaryMicrocents = storedSteps.reduce(
        (max, step) => Math.max(max, step.costMicrocents),
        0,
      );
      const skipped = log?.skipped;
      const absence = absenceText(status, runFinished);
      return {
        nodeId,
        label: scrubbedBounded(nodeId),
        ...(nodeType === undefined ? {} : { nodeType: scrubbedBounded(nodeType) }),
        status,
        glyph: NODE_ROW_GLYPH[status],
        attemptCount:
          log !== undefined && log.groups.length > 0 ? log.groups.length : nodeSteps.length,
        ...(last?.durationMs === undefined ? {} : { durationMs: last.durationMs }),
        tokens: buildNodeTokens({
          settled: allSettled(log),
          completedStep: completedStepTokens(nodeSteps, status),
          absence,
        }),
        cost: buildNodeCost({
          settled: allSettled(log),
          boundaryMicrocents,
          coverage: facts.nodes.get(nodeId) ?? facts.run,
          absence,
        }),
        ...(status === 'skipped' && skipped !== undefined
          ? { skippedReason: SKIP_REASON_TEXT[skipped.reason] }
          : {}),
        toolActivity: buildToolActivity(log?.lastTerminal, absence),
      };
    },
  );

  let attributed = 0;
  for (const row of rows) if (row.cost.source !== 'none') attributed += row.cost.microcents;
  const unattributedMicrocents = Math.max(0, run.totalCostMicrocents - attributed);
  const firstFailed = rows.find((row) => row.status === 'failed');
  const durationMs = spanMs(run.startedAt, run.completedAt);
  const error = readStoredError(run.errorJson, run.errorByteLength);
  const { text: tokensText, ...tokens } = runTokens(run, events);

  return {
    header: {
      runId: run.id,
      shortId: shortRunId(run.id),
      status: run.status,
      workflow: scrubbedBounded(input.workflowSlug ?? run.workflowId),
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
      tokens,
      tokensText,
      totalCostMicrocents: run.totalCostMicrocents,
      costText: formatCostShort(run.totalCostMicrocents, facts.run, facts.unpricedCalls),
      ...(error === undefined ? {} : { error }),
    },
    rows,
    unattributedMicrocents,
    ...(unattributedMicrocents > 0
      ? {
          unattributedRow: {
            label: 'unattributed' as const,
            // The header's own formatter and facts: the residual of a run total carries the run total's qualification.
            text: formatCostShort(unattributedMicrocents, facts.run, facts.unpricedCalls),
          },
        }
      : {}),
    ...(firstFailed === undefined ? {} : { firstFailedNodeId: firstFailed.nodeId }),
  };
}
