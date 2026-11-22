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
  type UsageCoverage,
} from '@relavium/shared';

import { sanitizeInline, sanitizeUntrustedInline } from '../render/sanitize.js';
import {
  formatCostShort,
  formatCostUsd,
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
 * the run-wide counter; (3) failing both, `not recorded`. The column defaults to `0`, so a `0` there is
 * indistinguishable from "never written" and is treated as absent, never shown as a price.
 *
 * **Attempt grouping (the load-bearing rule).** `cost:attempt_settled.attemptNumber` counts WITHIN a fallback
 * chain and resets to 1 on every node retry, so it does NOT join `node:started.attemptNumber`, which is the
 * node-retry dispatch index. A node's settled rows are therefore partitioned by the node's own `node:started`
 * events in `sequenceNumber` order: a row belongs to the nearest `node:started` of the same node that precedes
 * it. A row with no earlier `node:started` (a log cut short) stays in {@link NodeEventLog.settledBeforeStart}:
 * it still counts toward the node's total and belongs to no attempt.
 */

/** What a node row says when no cost was recorded — never `0`, never empty. */
export const NOT_RECORDED = 'not recorded';

/** What a tool-trace entry says when its call has no recorded result. */
export const NO_RESULT_RECORDED = 'no result recorded';

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

/** The most code points of a stored error message a page shows. */
export const MAX_ERROR_MESSAGE_CHARS = 300;
/** A stored error is cut to this many code points BEFORE the scrubber runs, so a pathological row costs a bound. */
const MAX_ERROR_SCRUB_CHARS = 65_536;

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
      /** Neither exists. The text is {@link NOT_RECORDED}, never a zero amount. */
      readonly source: 'none';
      readonly approximate: false;
      readonly unpricedCalls: 0;
      readonly text: typeof NOT_RECORDED;
    };

/**
 * A node's cost from its settled rows, else its boundary cost, else nothing. `boundaryMicrocents` is the node's
 * `step_executions.cost_microcents`; a value of `0` is "absent" (the column defaults to it), so it never reaches
 * the screen as a price.
 */
export function buildNodeCost(input: {
  readonly settled: readonly CostAttemptSettledEvent[];
  readonly boundaryMicrocents: number;
  readonly coverage: UsageCoverage | undefined;
}): NodeCost {
  const { settled, boundaryMicrocents, coverage } = input;
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
  return { source: 'none', approximate: false, unpricedCalls: 0, text: NOT_RECORDED };
}

// ---------------------------------------------------------------------------------------------------------
// Tool activity and stored errors.
// ---------------------------------------------------------------------------------------------------------

/** One call of a node's tool trace, content-free (ADR-0140 §4). */
export interface ToolActivityRowView {
  /** Sanitized. */
  readonly toolId: string;
  readonly ok: boolean;
  readonly durationMs?: number;
  readonly outcome: 'ok' | 'failed' | typeof NO_RESULT_RECORDED;
}

/**
 * A node's tool trace. `recorded: false` means the terminal event carries no `toolActivity` (an older log, or no
 * terminal at all) — the page says `not recorded`. `recorded: true` with no entries is a node that made no tool
 * call, which is a different statement.
 */
export type ToolActivityView =
  | { readonly recorded: false; readonly text: typeof NOT_RECORDED }
  | {
      readonly recorded: true;
      readonly entries: readonly ToolActivityRowView[];
      /** Calls beyond the stored entries (`toolActivityTruncated`). */
      readonly truncated: number;
      readonly text: string;
    };

/** The tool trace of a node's last terminal event. */
export function buildToolActivity(
  terminal: NodeCompletedEvent | NodeFailedEvent | undefined,
): ToolActivityView {
  const stored = terminal?.toolActivity;
  if (stored === undefined) return { recorded: false, text: NOT_RECORDED };
  const entries = stored.map((entry): ToolActivityRowView => {
    const toolId = sanitizeInline(entry.toolId);
    // An unpaired call (the node ended before its result) is `ok: false` with no duration; a failed RESULT has one.
    if (!entry.ok && entry.durationMs === undefined) {
      return { toolId, ok: false, outcome: NO_RESULT_RECORDED };
    }
    return {
      toolId,
      ok: entry.ok,
      ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
      outcome: entry.ok ? 'ok' : 'failed',
    };
  });
  const truncated = terminal?.toolActivityTruncated ?? 0;
  const total = entries.length + truncated;
  return {
    recorded: true,
    entries,
    truncated,
    text: total === 0 ? 'no tool calls' : `${total} tool ${total === 1 ? 'call' : 'calls'}`,
  };
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
 * Read a stored `error_json` (`{ code, message, nodeId? }`) for display. The text is data from the history file:
 * the message passes the secret scrubber and the one-line floor, then is cut to
 * {@link MAX_ERROR_MESSAGE_CHARS}; the code and node id pass the one-line floor. An unreadable document yields a
 * fixed sentence, never a throw.
 */
export function readStoredError(json: string | undefined): StoredErrorView | undefined {
  if (json === undefined) return undefined;
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
  let shownMessage: string | undefined;
  if (typeof message === 'string') {
    const clipped = clipCodePoints(
      sanitizeUntrustedInline(clipCodePoints(message, MAX_ERROR_SCRUB_CHARS).text),
      MAX_ERROR_MESSAGE_CHARS,
    );
    shownMessage = clipped.truncated ? `${clipped.text}…` : clipped.text;
  }
  return {
    ...(typeof code === 'string' ? { code: sanitizeInline(code) } : {}),
    ...(shownMessage === undefined ? {} : { message: shownMessage }),
    ...(typeof nodeId === 'string' ? { nodeId: sanitizeInline(nodeId) } : {}),
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
  /** The node's tokens summed across its attempt rows, matching the cost, which is summed across attempts. */
  readonly tokens: { readonly input: number; readonly output: number };
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
  readonly tokens: { readonly input: number; readonly output: number };
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

/** Build the run detail page's model. See the module note for the cost and attempt rules. */
export function buildRunDetailModel(input: RunDetailInput): RunDetailModel {
  const { run, steps, events } = input;
  const runFinished = isFinishedRun(run.status);
  const logs = indexNodeEvents(events);
  const facts = foldUsageFacts(events);
  const stepsByNode = groupSteps(steps);

  const rows = executionOrder({ stepsByNode, logs, authored: input.workflowNodeOrder }).map(
    (nodeId): NodeRow => {
      const nodeSteps = stepsByNode.get(nodeId) ?? [];
      const log = logs.get(nodeId);
      const last = lastAttemptRow(nodeSteps);
      const status = resolveNodeStatus({ step: last, log, runFinished });
      const nodeType = last?.nodeType ?? input.nodeTypes?.get(nodeId);
      // Every non-zero boundary figure on a node's rows is the node-wide cost at that boundary (the writer stores
      // `nodeSettledCost`, not a per-attempt delta), so the rows are never summed: the largest one is the node's.
      const boundaryMicrocents = nodeSteps.reduce(
        (max, step) => Math.max(max, step.costMicrocents),
        0,
      );
      const skipped = log?.skipped;
      return {
        nodeId,
        label: sanitizeInline(nodeId),
        ...(nodeType === undefined ? {} : { nodeType: sanitizeInline(nodeType) }),
        status,
        glyph: NODE_ROW_GLYPH[status],
        attemptCount:
          log !== undefined && log.groups.length > 0 ? log.groups.length : nodeSteps.length,
        ...(last?.durationMs === undefined ? {} : { durationMs: last.durationMs }),
        tokens: {
          input: nodeSteps.reduce((sum, step) => sum + step.inputTokens, 0),
          output: nodeSteps.reduce((sum, step) => sum + step.outputTokens, 0),
        },
        cost: buildNodeCost({
          settled: allSettled(log),
          boundaryMicrocents,
          coverage: facts.nodes.get(nodeId) ?? facts.run,
        }),
        ...(status === 'skipped' && skipped !== undefined
          ? { skippedReason: SKIP_REASON_TEXT[skipped.reason] }
          : {}),
        toolActivity: buildToolActivity(log?.lastTerminal),
      };
    },
  );

  let attributed = 0;
  for (const row of rows) if (row.cost.source !== 'none') attributed += row.cost.microcents;
  const unattributedMicrocents = Math.max(0, run.totalCostMicrocents - attributed);
  const firstFailed = rows.find((row) => row.status === 'failed');
  const durationMs = spanMs(run.startedAt, run.completedAt);
  const error = readStoredError(run.errorJson);

  return {
    header: {
      runId: run.id,
      shortId: run.id.slice(0, 8),
      status: run.status,
      workflow: sanitizeInline(input.workflowSlug ?? run.workflowId),
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
      tokens: { input: run.totalInputTokens, output: run.totalOutputTokens },
      tokensText: formatTokens({ input: run.totalInputTokens, output: run.totalOutputTokens }),
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
            text: formatCostUsd(unattributedMicrocents),
          },
        }
      : {}),
    ...(firstFailed === undefined ? {} : { firstFailedNodeId: firstFailed.nodeId }),
  };
}
