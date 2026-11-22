import type { RunDetailRecord, StepSummaryRecord } from '@relavium/db';
import type { RunEvent, ToolActivityEntry } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  MAX_IDENTIFIER_CHARS,
  NOT_RECORDED,
  NOT_RECORDED_OLDER_LOG,
  NO_RESULT_RECORDED,
  boundedIdentifier,
  buildRunDetailModel,
  buildToolActivity,
  clipCodePoints,
  indexNodeEvents,
  readStoredError,
  shortRunId,
  type NodeRow,
} from './run-detail-model.js';

const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const T = '2026-11-22T10:00:00.000Z';
const base = (sequenceNumber: number) => ({ runId: RUN_ID, timestamp: T, sequenceNumber });

const coverageStarted = (sequenceNumber: number): RunEvent => ({
  type: 'cost:coverage_started',
  ...base(sequenceNumber),
  basis: 'complete',
});
const started = (sequenceNumber: number, nodeId: string, attemptNumber?: number): RunEvent => ({
  type: 'node:started',
  ...base(sequenceNumber),
  nodeId,
  nodeType: 'agent',
  ...(attemptNumber === undefined ? {} : { attemptNumber }),
});
const settled = (
  sequenceNumber: number,
  nodeId: string,
  costMicrocents: number,
  options: {
    readonly model?: string;
    readonly attemptNumber?: number;
    readonly priced?: boolean;
  } = {},
): RunEvent => ({
  type: 'cost:attempt_settled',
  ...base(sequenceNumber),
  nodeId,
  model: options.model ?? 'model-a',
  attemptNumber: options.attemptNumber ?? 1,
  inputTokens: 1,
  outputTokens: 1,
  costMicrocents,
  cumulativeCostMicrocents: costMicrocents,
  priced: options.priced ?? true,
});
const completed = (
  sequenceNumber: number,
  nodeId: string,
  extra: { toolActivity?: ToolActivityEntry[]; toolActivityTruncated?: number } = {},
): RunEvent => ({
  type: 'node:completed',
  ...base(sequenceNumber),
  nodeId,
  output: 'ok',
  tokensUsed: { input: 1, output: 1 },
  durationMs: 10,
  ...extra,
});
const failed = (
  sequenceNumber: number,
  nodeId: string,
  extra: { toolActivity?: ToolActivityEntry[] } = {},
): RunEvent => ({
  type: 'node:failed',
  ...base(sequenceNumber),
  nodeId,
  error: { code: 'tool_failed', message: 'boom', retryable: false },
  ...extra,
});
const retrying = (sequenceNumber: number, nodeId: string, attemptNumber: number): RunEvent => ({
  type: 'node:retrying',
  ...base(sequenceNumber),
  nodeId,
  attemptNumber,
  error: { code: 'tool_failed', message: 'boom', retryable: true },
  delayMs: 100,
});
const skipped = (
  sequenceNumber: number,
  nodeId: string,
  reason: 'branch_not_taken' | 'upstream_unreachable',
): RunEvent => ({ type: 'node:skipped', ...base(sequenceNumber), nodeId, reason });
const gateResumed = (sequenceNumber: number, nodeId: string): RunEvent => ({
  type: 'human_gate:resumed',
  ...base(sequenceNumber),
  nodeId,
  decision: 'approved',
  decidedBy: 'cli',
});

const OPEN_RUN_FIELDS = {
  id: RUN_ID,
  workflowId: 'workflow-uuid',
  status: 'completed',
  executionMode: 'local',
  triggerType: 'manual',
  startedAt: '2026-11-22T10:00:00.000Z',
  totalInputTokens: 10,
  totalOutputTokens: 5,
  totalCostMicrocents: 0,
  createdAt: '2026-11-22T10:00:00.000Z',
  updatedAt: '2026-11-22T10:01:30.000Z',
  inputJson: '{}',
} as const;

function runRecord(overrides: Partial<RunDetailRecord> = {}): RunDetailRecord {
  return { ...OPEN_RUN_FIELDS, completedAt: '2026-11-22T10:01:30.000Z', ...overrides };
}

/** A run with a start but no completion time. */
function openRunRecord(overrides: Partial<RunDetailRecord> = {}): RunDetailRecord {
  return { ...OPEN_RUN_FIELDS, ...overrides };
}

function stepRow(nodeId: string, overrides: Partial<StepSummaryRecord> = {}): StepSummaryRecord {
  return {
    nodeId,
    nodeType: 'agent',
    status: 'completed',
    attemptNumber: 1,
    costMicrocents: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

function rowOf(rows: readonly NodeRow[], nodeId: string): NodeRow {
  const row = rows.find((candidate) => candidate.nodeId === nodeId);
  if (row === undefined) throw new Error(`no row for ${nodeId}`);
  return row;
}

describe('node cost: the source rules', () => {
  it('sums a node`s cost:attempt_settled rows and says the source is the attempts (exact, not approximate)', () => {
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 7_500_000 }),
      steps: [stepRow('a')],
      events: [
        coverageStarted(0),
        started(1, 'a'),
        settled(2, 'a', 5_000_000),
        settled(3, 'a', 2_500_000),
        completed(4, 'a'),
      ],
    });
    const cost = rowOf(model.rows, 'a').cost;
    expect(cost).toMatchObject({ source: 'attempts', microcents: 7_500_000, approximate: false });
    expect(cost.text).toBe('$0.0750');
  });

  it('falls back to the step row`s boundary cost, marked approximate, when a node has no attempt rows', () => {
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 4_000_000 }),
      steps: [stepRow('media', { nodeType: 'tool', costMicrocents: 4_000_000 })],
      events: [coverageStarted(0), started(1, 'media'), completed(2, 'media')],
    });
    const cost = rowOf(model.rows, 'media').cost;
    expect(cost).toMatchObject({ source: 'boundary', microcents: 4_000_000, approximate: true });
    expect(cost.text).toBe('~$0.0400');
  });

  it('reads a node`s boundary cost as the largest row, never the sum (each row holds the node-wide figure)', () => {
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 4_000_000 }),
      steps: [
        stepRow('retried', { status: 'failed', attemptNumber: 1, costMicrocents: 0 }),
        stepRow('retried', { attemptNumber: 2, costMicrocents: 4_000_000 }),
        stepRow('twice', { attemptNumber: 1, costMicrocents: 4_000_000 }),
        stepRow('twice', { attemptNumber: 2, costMicrocents: 4_000_000 }),
      ],
      events: [coverageStarted(0)],
    });
    expect(rowOf(model.rows, 'retried').cost).toMatchObject({ microcents: 4_000_000 });
    expect(rowOf(model.rows, 'twice').cost).toMatchObject({ microcents: 4_000_000 });
  });

  it('gives settled rows precedence over a non-zero boundary cost: the settled sum, exact, never the boundary figure', () => {
    // The realistic shape: the node settled model calls AND its step row carries a (different) boundary cost.
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 9_000_000 }),
      steps: [stepRow('a', { costMicrocents: 9_000_000 })],
      events: [
        coverageStarted(0),
        started(1, 'a'),
        settled(2, 'a', 1_000_000),
        settled(3, 'a', 2_000_000),
        completed(4, 'a'),
      ],
    });
    const cost = rowOf(model.rows, 'a').cost;
    expect(cost).toMatchObject({ source: 'attempts', microcents: 3_000_000, approximate: false });
    expect(cost.text).toBe('$0.0300');
    expect(cost.text.startsWith('~')).toBe(false);
    // Only the settled sum is attributed: the boundary figure is not added, and the rest is unattributed.
    expect(model.unattributedMicrocents).toBe(6_000_000);
  });

  it('says `not recorded` — never a zero amount — when neither source exists', () => {
    const model = buildRunDetailModel({
      run: runRecord(),
      steps: [stepRow('quiet', { costMicrocents: 0 })],
      events: [coverageStarted(0), started(1, 'quiet'), completed(2, 'quiet')],
    });
    const cost = rowOf(model.rows, 'quiet').cost;
    expect(cost).toEqual({
      source: 'none',
      approximate: false,
      unpricedCalls: 0,
      text: NOT_RECORDED,
    });
    expect(cost.text).not.toMatch(/\$|0/);
  });

  it('qualifies an unpriced call and an unverified history instead of showing a bare amount', () => {
    const unpriced = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 5_000_000 }),
      steps: [stepRow('a')],
      events: [
        coverageStarted(0),
        started(1, 'a'),
        settled(2, 'a', 5_000_000),
        settled(3, 'a', 0, { priced: false }),
        completed(4, 'a'),
      ],
    });
    expect(rowOf(unpriced.rows, 'a').cost.text).toBe('$0.0500 known; price unknown for 1 call');
    expect(unpriced.header.costText).toBe('$0.0500 known; price unknown for 1 call');

    const legacy = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 5_000_000 }),
      steps: [stepRow('a')],
      events: [started(1, 'a'), settled(2, 'a', 5_000_000), completed(3, 'a')],
    });
    expect(rowOf(legacy.rows, 'a').cost.text).toBe('$0.0500 known; usage unverified');
  });

  it('shows a verified, fully priced zero as free and an unverified zero as a qualified amount', () => {
    const verified = buildRunDetailModel({
      run: runRecord(),
      steps: [],
      events: [coverageStarted(0)],
    });
    expect(verified.header.costText).toBe('free');
    const unverified = buildRunDetailModel({ run: runRecord(), steps: [], events: [] });
    expect(unverified.header.costText).toBe('$0.0000 known; usage unverified');
  });

  it('qualifies the run total by a usage invocation that never settled', () => {
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 5_000_000 }),
      steps: [stepRow('a')],
      events: [
        coverageStarted(0),
        started(1, 'a'),
        {
          type: 'cost:usage_pending',
          ...base(2),
          nodeId: 'a',
          model: 'model-a',
          invocation: { producerId: 'p', ordinal: 1, dispatchId: 'd', round: 0, chainAttempt: 1 },
        },
        completed(3, 'a'),
      ],
    });
    expect(model.header.costText).toBe('$0.0500 known; 1 usage pending');
  });

  it('degrades a contradictory accounting log to unverified instead of throwing out of a display model', () => {
    const pending = (sequenceNumber: number): RunEvent => ({
      type: 'cost:usage_pending',
      ...base(sequenceNumber),
      nodeId: 'a',
      model: 'model-a',
      invocation: { producerId: 'p', ordinal: 1, dispatchId: 'd', round: 0, chainAttempt: 1 },
    });
    // A repeated ordinal breaks the fold's "ordinals only increase" invariant.
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 5_000_000 }),
      steps: [],
      events: [coverageStarted(0), pending(1), pending(2)],
    });
    expect(model.header.costText).toBe('$0.0500 known; usage unverified');
  });
});

describe('attempt grouping: the node:started partition', () => {
  // The settled rows' own `attemptNumber` counts WITHIN a fallback chain and resets for each node retry: here the
  // first dispatch tried two models (1, 2) and the retry's first call is attempt 1 again.
  const retriedNode: RunEvent[] = [
    started(1, 'x', 1),
    settled(2, 'x', 1_000_000, { attemptNumber: 1, model: 'primary' }),
    settled(3, 'x', 2_000_000, { attemptNumber: 2, model: 'fallback' }),
    retrying(4, 'x', 1),
    started(5, 'x', 2),
    settled(6, 'x', 4_000_000, { attemptNumber: 1, model: 'primary' }),
    completed(7, 'x'),
  ];

  it('puts a settled row with the nearest EARLIER node:started of its node, whatever its own attemptNumber says', () => {
    const logs = indexNodeEvents(retriedNode);
    const groups = logs.get('x')?.groups ?? [];
    expect(groups.map((group) => group.attemptNumber)).toEqual([1, 2]);
    expect(groups.map((group) => group.settled.map((row) => row.costMicrocents))).toEqual([
      [1_000_000, 2_000_000],
      [4_000_000],
    ]);
  });

  it('does not depend on the order the events arrive in', () => {
    const reversed = [...retriedNode].reverse();
    const groups = indexNodeEvents(reversed).get('x')?.groups ?? [];
    expect(groups.map((group) => group.settled.map((row) => row.costMicrocents))).toEqual([
      [1_000_000, 2_000_000],
      [4_000_000],
    ]);
  });

  it('keeps two interleaved nodes apart (a fan-out) and counts a node`s attempts by its own node:started', () => {
    const events: RunEvent[] = [
      started(1, 'p'),
      started(2, 'q'),
      settled(3, 'q', 3_000_000),
      settled(4, 'p', 1_000_000),
      started(5, 'p', 2),
      settled(6, 'p', 2_000_000),
    ];
    const logs = indexNodeEvents(events);
    expect(logs.get('p')?.groups.map((g) => g.settled.map((r) => r.costMicrocents))).toEqual([
      [1_000_000],
      [2_000_000],
    ]);
    expect(logs.get('q')?.groups.map((g) => g.settled.map((r) => r.costMicrocents))).toEqual([
      [3_000_000],
    ]);
  });

  it('counts an attempt per node:started and still totals every settled row of the node', () => {
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 7_000_000 }),
      steps: [
        stepRow('x', { status: 'failed', attemptNumber: 1 }),
        stepRow('x', { attemptNumber: 2 }),
      ],
      events: [coverageStarted(0), ...retriedNode],
    });
    const row = rowOf(model.rows, 'x');
    expect(row.attemptCount).toBe(2);
    expect(row.cost).toMatchObject({ source: 'attempts', microcents: 7_000_000 });
  });

  it('takes the attempt count from the node:started events, not from the step rows', () => {
    // Three dispatches in the log, but one step row (the table keeps the last attempt's row).
    const events = [started(1, 'x', 1), started(2, 'x', 2), started(3, 'x', 3), completed(4, 'x')];
    const model = buildRunDetailModel({
      run: runRecord(),
      steps: [stepRow('x', { attemptNumber: 3 })],
      events,
    });
    expect(rowOf(model.rows, 'x').attemptCount).toBe(3);
    // And the other way round: more step rows than node:started events in the log.
    const fewer = buildRunDetailModel({
      run: runRecord(),
      steps: [
        stepRow('x', { attemptNumber: 1, status: 'failed' }),
        stepRow('x', { attemptNumber: 2 }),
        stepRow('x', { attemptNumber: 3 }),
      ],
      events: [started(1, 'x', 3), completed(2, 'x')],
    });
    expect(rowOf(fewer.rows, 'x').attemptCount).toBe(1);
  });

  it('falls back to the step-row count only when the log holds no node:started for the node', () => {
    const model = buildRunDetailModel({
      run: runRecord(),
      steps: [
        stepRow('x', { attemptNumber: 1, status: 'failed' }),
        stepRow('x', { attemptNumber: 2 }),
      ],
      events: [],
    });
    expect(rowOf(model.rows, 'x').attemptCount).toBe(2);
  });

  it('keeps a settled row that precedes every node:started out of every attempt but inside the node total', () => {
    const logs = indexNodeEvents([
      settled(1, 'x', 1_000_000),
      started(2, 'x'),
      settled(3, 'x', 2_000_000),
    ]);
    const log = logs.get('x');
    expect(log?.settledBeforeStart.map((row) => row.costMicrocents)).toEqual([1_000_000]);
    expect(log?.groups.map((group) => group.settled.length)).toEqual([1]);
  });
});

describe('a settled row that precedes every node:started', () => {
  it('counts toward the node`s total although it belongs to no attempt', () => {
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 3_000_000 }),
      steps: [stepRow('x')],
      events: [
        coverageStarted(0),
        settled(1, 'x', 1_000_000),
        started(2, 'x'),
        settled(3, 'x', 2_000_000),
        completed(4, 'x'),
      ],
    });
    const row = rowOf(model.rows, 'x');
    expect(row.cost).toMatchObject({ source: 'attempts', microcents: 3_000_000 });
    expect(row.attemptCount).toBe(1);
    expect(model.unattributedMicrocents).toBe(0);
  });

  it('is the node`s only source when no node:started was read at all (a log cut short)', () => {
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 1_500_000 }),
      steps: [stepRow('x')],
      events: [coverageStarted(0), settled(1, 'x', 1_500_000)],
    });
    expect(rowOf(model.rows, 'x').cost).toMatchObject({
      source: 'attempts',
      microcents: 1_500_000,
    });
  });
});

describe('unattributed cost', () => {
  const events: RunEvent[] = [
    coverageStarted(0),
    started(1, 'a'),
    settled(2, 'a', 3_000_000),
    completed(3, 'a'),
    started(4, 'b'),
    completed(5, 'b'),
    started(6, 'c'),
    completed(7, 'c'),
  ];
  const steps = [
    stepRow('a'),
    stepRow('b', { costMicrocents: 2_000_000 }),
    stepRow('c', { costMicrocents: 0 }),
  ];

  it('is the run total minus the nodes that have a source (attempts and boundary), and shows a row', () => {
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 10_000_000 }),
      steps,
      events,
    });
    expect(model.unattributedMicrocents).toBe(5_000_000);
    expect(model.unattributedRow).toEqual({ label: 'unattributed', text: '$0.0500' });
  });

  it('clamps at zero and shows no row when the nodes already account for more than the run total', () => {
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 1_000_000 }),
      steps,
      events,
    });
    expect(model.unattributedMicrocents).toBe(0);
    expect(model.unattributedRow).toBeUndefined();
  });

  it('shows no row when the nodes account for the run exactly', () => {
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 5_000_000 }),
      steps,
      events,
    });
    expect(model.unattributedMicrocents).toBe(0);
    expect(model.unattributedRow).toBeUndefined();
  });
});

describe('firstFailedNodeId', () => {
  it('names the first node whose LAST attempt failed, and skips a node that failed and then succeeded', () => {
    const model = buildRunDetailModel({
      run: runRecord({ status: 'failed' }),
      steps: [
        stepRow('a'),
        stepRow('retried', { status: 'failed', attemptNumber: 1 }),
        stepRow('retried', { status: 'completed', attemptNumber: 2 }),
        stepRow('broken', { status: 'failed' }),
        stepRow('later', { status: 'failed' }),
      ],
      events: [
        started(1, 'a'),
        completed(2, 'a'),
        started(3, 'retried', 1),
        retrying(4, 'retried', 1),
        started(5, 'retried', 2),
        completed(6, 'retried'),
        started(7, 'broken'),
        failed(8, 'broken'),
        started(9, 'later'),
        failed(10, 'later'),
      ],
    });
    expect(rowOf(model.rows, 'retried').status).toBe('completed');
    expect(model.firstFailedNodeId).toBe('broken');
  });

  it('is absent when no node`s last attempt failed', () => {
    const model = buildRunDetailModel({
      run: runRecord(),
      steps: [
        stepRow('retried', { status: 'failed', attemptNumber: 1 }),
        stepRow('retried', { status: 'completed', attemptNumber: 2 }),
      ],
      events: [],
    });
    expect(model.firstFailedNodeId).toBeUndefined();
  });

  it('follows execution order, not the order of the step rows', () => {
    const model = buildRunDetailModel({
      run: runRecord({ status: 'failed' }),
      steps: [stepRow('second', { status: 'failed' }), stepRow('first', { status: 'failed' })],
      events: [started(1, 'first'), failed(2, 'first'), started(3, 'second'), failed(4, 'second')],
    });
    expect(model.firstFailedNodeId).toBe('first');
  });
});

describe('node status', () => {
  const running = stepRow('n', { status: 'running' });

  it('shows a step row left `running` under a finished run as `stopped`, in every finished state', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const model = buildRunDetailModel({
        run: runRecord({ status }),
        steps: [running],
        events: [],
      });
      expect(rowOf(model.rows, 'n')).toMatchObject({ status: 'stopped', glyph: '■' });
    }
  });

  it('keeps `running` while the run is not finished (running or paused)', () => {
    for (const status of ['pending', 'running', 'paused'] as const) {
      const model = buildRunDetailModel({
        run: runRecord({ status }),
        steps: [running],
        events: [],
      });
      expect(rowOf(model.rows, 'n').status).toBe('running');
    }
  });

  it('shows a decided human gate as completed even though no node:completed closes its row', () => {
    const gate = stepRow('approve', { nodeType: 'human_in_the_loop', status: 'running' });
    const decided = buildRunDetailModel({
      run: runRecord({ status: 'failed' }),
      steps: [gate],
      events: [started(1, 'approve'), gateResumed(2, 'approve')],
    });
    expect(rowOf(decided.rows, 'approve').status).toBe('completed');
    const undecided = buildRunDetailModel({
      run: runRecord({ status: 'failed' }),
      steps: [gate],
      events: [started(1, 'approve')],
    });
    expect(rowOf(undecided.rows, 'approve').status).toBe('stopped');
  });

  it('reads the status of a node`s LAST attempt', () => {
    const model = buildRunDetailModel({
      run: runRecord(),
      steps: [
        stepRow('n', { attemptNumber: 1, status: 'failed' }),
        stepRow('n', { attemptNumber: 2, status: 'completed' }),
      ],
      events: [],
    });
    expect(rowOf(model.rows, 'n')).toMatchObject({ status: 'completed', glyph: '✓' });
  });
});

describe('skipped nodes', () => {
  it('reads a node with a node:skipped event and no step row as a skipped row with its reason and type', () => {
    const model = buildRunDetailModel({
      run: runRecord(),
      steps: [stepRow('a')],
      events: [
        started(1, 'a'),
        completed(2, 'a'),
        skipped(3, 'left', 'branch_not_taken'),
        skipped(4, 'right', 'upstream_unreachable'),
      ],
      nodeTypes: new Map([['left', 'agent']]),
    });
    expect(model.rows.map((row) => row.nodeId)).toEqual(['a', 'left', 'right']);
    expect(rowOf(model.rows, 'left')).toMatchObject({
      status: 'skipped',
      glyph: '⊘',
      skippedReason: 'branch not taken',
      nodeType: 'agent',
      attemptCount: 0,
      cost: { source: 'none', text: NOT_RECORDED },
    });
    expect(rowOf(model.rows, 'right')).toMatchObject({
      status: 'skipped',
      skippedReason: 'upstream unreachable',
    });
    expect(rowOf(model.rows, 'right').nodeType).toBeUndefined();
  });
});

describe('execution order', () => {
  it('orders by the first event each node produced, not by step-row or authored order', () => {
    const model = buildRunDetailModel({
      run: runRecord(),
      steps: [stepRow('b'), stepRow('a')],
      events: [started(1, 'a'), started(2, 'b')],
      workflowNodeOrder: ['b', 'a'],
    });
    expect(model.rows.map((row) => row.nodeId)).toEqual(['a', 'b']);
  });

  it('places nodes with no event after the eventful ones, by authored position, then step-row position', () => {
    const model = buildRunDetailModel({
      run: runRecord(),
      steps: [stepRow('x'), stepRow('y'), stepRow('z'), stepRow('w')],
      events: [started(5, 'w')],
      workflowNodeOrder: ['z', 'y'],
    });
    expect(model.rows.map((row) => row.nodeId)).toEqual(['w', 'z', 'y', 'x']);
  });
});

describe('tool activity', () => {
  it('says `not recorded (older log)` when the terminal event carries no toolActivity field, and plain `not recorded` when there is no terminal', () => {
    expect(buildToolActivity(undefined)).toEqual({ recorded: false, text: NOT_RECORDED });
    const model = buildRunDetailModel({
      run: runRecord(),
      steps: [stepRow('a'), stepRow('b', { status: 'running' })],
      events: [started(1, 'a'), completed(2, 'a'), started(3, 'b')],
    });
    expect(rowOf(model.rows, 'a').toolActivity).toEqual({
      recorded: false,
      text: NOT_RECORDED_OLDER_LOG,
    });
    expect(NOT_RECORDED_OLDER_LOG).toBe('not recorded (older log)');
    // A node with no terminal makes no claim about an older log: it simply has no record yet.
    expect(rowOf(model.rows, 'b').toolActivity).toEqual({ recorded: false, text: NOT_RECORDED });
    // The same wording for a failed terminal.
    const failedModel = buildRunDetailModel({
      run: runRecord({ status: 'failed' }),
      steps: [stepRow('c', { status: 'failed' })],
      events: [started(1, 'c'), failed(2, 'c')],
    });
    expect(rowOf(failedModel.rows, 'c').toolActivity).toEqual({
      recorded: false,
      text: NOT_RECORDED_OLDER_LOG,
    });
  });

  it('distinguishes an EMPTY trace (`no tool calls`) from an absent one and from a non-empty one', () => {
    const model = buildRunDetailModel({
      run: runRecord(),
      steps: [stepRow('a'), stepRow('b', { status: 'failed' }), stepRow('c')],
      events: [
        started(1, 'a'),
        completed(2, 'a', { toolActivity: [] }),
        started(3, 'b'),
        failed(4, 'b', { toolActivity: [] }),
        started(5, 'c'),
        completed(6, 'c', { toolActivity: [{ toolId: 'read_file', ok: true, durationMs: 3 }] }),
      ],
    });
    for (const nodeId of ['a', 'b']) {
      expect(rowOf(model.rows, nodeId).toolActivity).toEqual({
        recorded: true,
        entries: [],
        truncated: 0,
        text: 'no tool calls',
      });
    }
    expect(rowOf(model.rows, 'c').toolActivity).toEqual({
      recorded: true,
      entries: [{ toolId: 'read_file', ok: true, durationMs: 3, outcome: 'ok' }],
      truncated: 0,
      text: '1 tool call',
    });
  });

  it('shows an unpaired entry (ok false, no duration) as `no result recorded`, a failed result as failed', () => {
    const view = buildToolActivity({
      ...completedEvent(),
      toolActivity: [
        { toolId: 'read_file', ok: true, durationMs: 12 },
        { toolId: 'run_command', ok: false, durationMs: 40 },
        { toolId: 'search', ok: false },
      ],
      toolActivityTruncated: 3,
    });
    expect(view).toEqual({
      recorded: true,
      truncated: 3,
      text: '6 tool calls',
      entries: [
        { toolId: 'read_file', ok: true, durationMs: 12, outcome: 'ok' },
        { toolId: 'run_command', ok: false, durationMs: 40, outcome: 'failed' },
        { toolId: 'search', ok: false, outcome: NO_RESULT_RECORDED },
      ],
    });
  });

  it('sanitizes a tool id', () => {
    const view = buildToolActivity({
      ...completedEvent(),
      toolActivity: [{ toolId: 'bad\u001b[31m\ntool', ok: true, durationMs: 1 }],
    });
    expect(view.recorded && view.entries[0]?.toolId).toBe('bad tool');
  });

  it('reads the node`s terminal with the HIGHEST sequence number, whatever order the events arrive in', () => {
    const model = buildRunDetailModel({
      run: runRecord({ status: 'failed' }),
      steps: [stepRow('a', { status: 'failed' })],
      events: [
        failed(9, 'a', { toolActivity: [{ toolId: 'late', ok: false, durationMs: 1 }] }),
        completed(4, 'a', { toolActivity: [{ toolId: 'early', ok: true, durationMs: 1 }] }),
        started(1, 'a'),
      ],
    });
    const trace = rowOf(model.rows, 'a').toolActivity;
    expect(trace.recorded && trace.entries.map((entry) => entry.toolId)).toEqual(['late']);
  });
});

function completedEvent(): Extract<RunEvent, { type: 'node:completed' }> {
  return {
    type: 'node:completed',
    ...base(1),
    nodeId: 'a',
    output: 'ok',
    tokensUsed: { input: 1, output: 1 },
    durationMs: 1,
  };
}

describe('the header', () => {
  it('states status, workflow slug, start, duration, tokens and the qualified cost', () => {
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 5_000_000 }),
      steps: [],
      events: [coverageStarted(0)],
      workflowSlug: 'deploy',
    });
    expect(model.header).toEqual({
      runId: RUN_ID,
      shortId: 'aaaaaaaa',
      status: 'completed',
      workflow: 'deploy',
      startedAt: '2026-11-22T10:00:00.000Z',
      durationMs: 90_000,
      tokens: { input: 10, output: 5 },
      tokensText: '↑10 ↓5',
      totalCostMicrocents: 5_000_000,
      costText: '$0.0500',
    });
  });

  it('shows the workflow id when no slug is given, and has no duration for a run that is not completed', () => {
    const model = buildRunDetailModel({
      run: openRunRecord({ status: 'running' }),
      steps: [],
      events: [],
    });
    expect(model.header.workflow).toBe('workflow-uuid');
    expect(model.header.durationMs).toBeUndefined();
  });

  it('passes every free-text label through the sanitize floor', () => {
    const model = buildRunDetailModel({
      run: runRecord(),
      steps: [stepRow('node\u001b[2J\nid')],
      events: [],
      workflowSlug: 'evil\u001b]0;title\u0007\nslug',
    });
    expect(model.header.workflow).toBe('evil slug');
    expect(model.rows[0]?.label).toBe('node id');
    // The raw id survives only as the lookup identity.
    expect(model.rows[0]?.nodeId).toBe('node\u001b[2J\nid');
  });

  it('shows a failed run`s stored error sanitized, scrubbed of secrets and bounded', () => {
    const message = `bad\u001b[31m\nnews sk-ant-api03-${'A'.repeat(40)} ${'x'.repeat(400)}`;
    const model = buildRunDetailModel({
      run: runRecord({
        status: 'failed',
        errorJson: JSON.stringify({ code: 'tool_failed', message, nodeId: 'broken\nnode' }),
      }),
      steps: [],
      events: [],
    });
    const error = model.header.error;
    expect(error?.code).toBe('tool_failed');
    expect(error?.nodeId).toBe('broken node');
    expect(error?.message).not.toContain('\u001b');
    expect(error?.message).not.toContain('\n');
    expect(error?.message).not.toContain('sk-ant-api03');
    expect(Array.from(error?.message ?? '').length).toBeLessThanOrEqual(301);
    expect(error?.message?.endsWith('…')).toBe(true);
  });
});

describe('the run id and project root are read back from the history file', () => {
  it('passes a run id with control characters through the one-line floor, in the header', () => {
    const model = buildRunDetailModel({
      run: runRecord({ id: 'ab\u001b[2Jcd\nef\u0007gh-rest' }),
      steps: [],
      events: [],
    });
    expect(model.header.shortId).toBe('abcd');
    // The raw id survives as the identity a drill-down looks up with, as the node id does.
    expect(model.header.runId).toBe('ab\u001b[2Jcd\nef\u0007gh-rest');
  });

  it('cuts first (a forged id costs a bound) and keeps a plain id as its first 8 characters', () => {
    expect(shortRunId(RUN_ID)).toBe('aaaaaaaa');
    expect(shortRunId('x'.repeat(1_000_000))).toBe('xxxxxxxx');
    expect(shortRunId('\u202eabcdefgh')).not.toContain('\u202e');
  });
});

describe('readStoredError and clipCodePoints', () => {
  it('clips a stored code and node id to 128 code points after the one-line floor, marking the cut', () => {
    const view = readStoredError(
      JSON.stringify({
        code: `${'c'.repeat(200)}\u001b[31m`,
        message: 'm',
        nodeId: `${'n'.repeat(MAX_IDENTIFIER_CHARS + 1)}`,
      }),
    );
    expect(view?.code).toBe(`${'c'.repeat(MAX_IDENTIFIER_CHARS)}…`);
    expect(view?.nodeId).toBe(`${'n'.repeat(MAX_IDENTIFIER_CHARS)}…`);
    // Exactly at the bound is kept whole, and a cut never splits a code point.
    expect(readStoredError(JSON.stringify({ code: 'k'.repeat(MAX_IDENTIFIER_CHARS) }))?.code).toBe(
      'k'.repeat(MAX_IDENTIFIER_CHARS),
    );
    expect(
      readStoredError(JSON.stringify({ code: '\u{1F600}'.repeat(MAX_IDENTIFIER_CHARS + 5) }))?.code,
    ).toBe(`${'\u{1F600}'.repeat(MAX_IDENTIFIER_CHARS)}…`);
  });

  it('cuts a pathological code or node id to a bound before any filter reads it', () => {
    const view = readStoredError(
      JSON.stringify({ code: 'c'.repeat(5_000_000), nodeId: 'n'.repeat(5_000_000) }),
    );
    expect(Array.from(view?.code ?? '')).toHaveLength(MAX_IDENTIFIER_CHARS + 1);
    expect(Array.from(view?.nodeId ?? '')).toHaveLength(MAX_IDENTIFIER_CHARS + 1);
    // The bound is on what the filter is handed, not only on what is shown.
    const handed: number[] = [];
    boundedIdentifier('x'.repeat(5_000_000), (text) => {
      handed.push(text.length);
      return text;
    });
    expect(handed).toEqual([65_536]);
  });

  it('masks a secret in the stored code, as it does in the message', () => {
    const secret = `sk-ant-api03-${'G'.repeat(40)}`;
    const view = readStoredError(
      JSON.stringify({ code: `leak ${secret}`, message: `leak ${secret}` }),
    );
    expect(view?.code).not.toContain('sk-ant-api03');
    expect(view?.message).not.toContain('sk-ant-api03');
    // The node id is an identifier the workflow authored: it passes the floor and the cut, not the scrubber.
    expect(readStoredError(JSON.stringify({ nodeId: 'plain-node' }))?.nodeId).toBe('plain-node');
  });

  it('boundedIdentifier runs its filter before the final cut, so a secret is masked before any of it can be clipped', () => {
    const secret = `sk-ant-api03-${'H'.repeat(40)}`;
    const text = `${'a'.repeat(100)} ${secret}`;
    // Cut first, the secret would be left half-written (and unrecognizable); filtered first, it is masked whole.
    const shown = boundedIdentifier(text, (value) => value.replace(secret, '[MASKED]'));
    expect(shown).toBe(`${'a'.repeat(100)} [MASKED]`);
    expect(shown).not.toContain('sk-ant');
  });

  it('has no error for an absent document and a fixed sentence for an unreadable one', () => {
    expect(readStoredError(undefined)).toBeUndefined();
    expect(readStoredError('{not json')).toEqual({ message: 'the error record could not be read' });
    expect(readStoredError('[1,2]')).toEqual({ message: 'the error record could not be read' });
  });

  it('cuts at a code-point boundary and says whether it cut', () => {
    expect(clipCodePoints('abc', 3)).toEqual({ text: 'abc', truncated: false });
    expect(clipCodePoints('abcd', 3)).toEqual({ text: 'abc', truncated: true });
    expect(clipCodePoints('a\u{1F600}b', 2)).toEqual({ text: 'a\u{1F600}', truncated: true });
  });
});
