import type { RunDetailRecord, StepSummaryRecord } from '@relavium/db';
import type { RunEvent, ToolActivityEntry } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  DID_NOT_FINISH,
  DID_NOT_RUN,
  IN_PROGRESS,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_IDENTIFIER_CHARS,
  NOT_RECORDED,
  NOT_RECORDED_FOR_ATTEMPT,
  NOT_RECORDED_OLDER_LOG,
  NOT_YET_RUN,
  NO_RESULT_RECORDED,
  absenceText,
  boundedIdentifier,
  buildRunDetailModel,
  buildToolActivity,
  buildToolActivityForAttempt,
  clipCodePoints,
  indexNodeEvents,
  readStoredError,
  scrubbedBounded,
  shortRunId,
  MAX_STORED_ERROR_BYTES,
  SCRUB_INPUT_CHARS,
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
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  } = {},
): RunEvent => ({
  type: 'cost:attempt_settled',
  ...base(sequenceNumber),
  nodeId,
  model: options.model ?? 'model-a',
  attemptNumber: options.attemptNumber ?? 1,
  inputTokens: options.inputTokens ?? 1,
  outputTokens: options.outputTokens ?? 1,
  costMicrocents,
  cumulativeCostMicrocents: costMicrocents,
  priced: options.priced ?? true,
});
const completed = (
  sequenceNumber: number,
  nodeId: string,
  extra: {
    toolActivity?: ToolActivityEntry[];
    toolActivityTruncated?: number;
    attemptNumber?: number;
  } = {},
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
  outputJson: null,
  outputByteLength: null,
  errorJson: null,
  errorByteLength: null,
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

  it('reads the boundary cost over every STORED row of an attempt, even one the collapse drops: the earlier row`s figure survives a later row`s zero', () => {
    // A re-dispatch under one attempt number: the earlier row holds the node-wide boundary figure, the later row (the
    // one the attempt keeps) holds the column's default `0`. The figure is read over the stored rows, not the kept one.
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 4_000_000 }),
      steps: [
        stepRow('a', { attemptNumber: 1, costMicrocents: 4_000_000 }),
        stepRow('a', { attemptNumber: 1, costMicrocents: 0 }),
      ],
      events: [coverageStarted(0), started(1, 'a', 1), started(2, 'a', 1), completed(3, 'a')],
    });
    const cost = rowOf(model.rows, 'a').cost;
    expect(cost).toMatchObject({ source: 'boundary', microcents: 4_000_000, approximate: true });
    expect(cost.text).toBe('~$0.0400');
    expect(model.unattributedMicrocents).toBe(0);
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

describe('node tokens: the settled rows, else a completed step row, else not recorded', () => {
  it('shows a node that FAILED after a billed call the tokens of that call, not 0 in and 0 out beside a cost', () => {
    const model = buildRunDetailModel({
      run: runRecord({ status: 'failed', totalCostMicrocents: 3_000_000 }),
      // `failStepRow` writes no tokens, so the step row of a failed attempt reads 0 / 0.
      steps: [stepRow('a', { status: 'failed', inputTokens: 0, outputTokens: 0 })],
      events: [
        coverageStarted(0),
        started(1, 'a'),
        settled(2, 'a', 3_000_000, { inputTokens: 120, outputTokens: 45 }),
        failed(3, 'a'),
      ],
    });
    const row = rowOf(model.rows, 'a');
    expect(row.tokens).toEqual({ source: 'attempts', input: 120, output: 45, text: '↑120 ↓45' });
    expect(row.cost).toMatchObject({ source: 'attempts', microcents: 3_000_000 });
  });

  it('sums every attempt of a node that completed on its second attempt, as its cost is summed', () => {
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 3_000_000 }),
      // Only the second attempt's step row carries tokens (the first failed).
      steps: [
        stepRow('a', { status: 'failed', attemptNumber: 1, inputTokens: 0, outputTokens: 0 }),
        stepRow('a', { attemptNumber: 2, inputTokens: 30, outputTokens: 6 }),
      ],
      events: [
        coverageStarted(0),
        started(1, 'a', 1),
        settled(2, 'a', 1_000_000, { inputTokens: 100, outputTokens: 20 }),
        retrying(3, 'a', 1),
        started(4, 'a', 2),
        settled(5, 'a', 2_000_000, { inputTokens: 30, outputTokens: 6 }),
        completed(6, 'a', { attemptNumber: 2 }),
      ],
    });
    const row = rowOf(model.rows, 'a');
    expect(row.tokens).toEqual({ source: 'attempts', input: 130, output: 26, text: '↑130 ↓26' });
    expect(row.cost).toMatchObject({ microcents: 3_000_000 });
  });

  it('falls back to the step row for a completed node with no settled rows', () => {
    const model = buildRunDetailModel({
      run: runRecord(),
      steps: [stepRow('a', { inputTokens: 7, outputTokens: 3 })],
      events: [coverageStarted(0), started(1, 'a'), completed(2, 'a')],
    });
    expect(rowOf(model.rows, 'a').tokens).toEqual({
      source: 'step',
      input: 7,
      output: 3,
      text: '↑7 ↓3',
    });
  });

  it('says `not recorded`, never ↑0 ↓0, for a failed node with no settled row, and says why for a node left running', () => {
    const model = buildRunDetailModel({
      run: runRecord({ status: 'failed' }),
      steps: [
        stepRow('a', { status: 'failed', inputTokens: 0, outputTokens: 0 }),
        stepRow('b', { status: 'running', inputTokens: 0, outputTokens: 0 }),
      ],
      events: [coverageStarted(0), started(1, 'a'), failed(2, 'a'), started(3, 'b')],
    });
    expect(rowOf(model.rows, 'a').tokens).toEqual({ source: 'none', text: NOT_RECORDED });
    // `b` is left `running` under a finished run: it never finished, which is not the same as "never recorded".
    expect(rowOf(model.rows, 'b').tokens).toEqual({ source: 'none', text: DID_NOT_FINISH });
    // A completed node whose step rows were not read has no step figure to show either.
    const unread = buildRunDetailModel({
      run: runRecord(),
      steps: [],
      events: [coverageStarted(0), started(1, 'c'), completed(2, 'c')],
    });
    expect(rowOf(unread.rows, 'c').tokens).toEqual({ source: 'none', text: NOT_RECORDED });
  });

  it('gives settled rows precedence over a completed step row, as it does for the cost', () => {
    const model = buildRunDetailModel({
      run: runRecord(),
      steps: [stepRow('a', { inputTokens: 999, outputTokens: 999 })],
      events: [
        coverageStarted(0),
        started(1, 'a'),
        settled(2, 'a', 1, { inputTokens: 4, outputTokens: 2 }),
        completed(3, 'a'),
      ],
    });
    expect(rowOf(model.rows, 'a').tokens).toMatchObject({
      source: 'attempts',
      input: 4,
      output: 2,
    });
  });

  it('sums the whole log for the header when it holds settled rows, else takes the run row`s totals', () => {
    const withRows = buildRunDetailModel({
      run: runRecord({ totalInputTokens: 10, totalOutputTokens: 5 }),
      steps: [],
      events: [
        coverageStarted(0),
        started(1, 'a'),
        settled(2, 'a', 1, { inputTokens: 100, outputTokens: 20 }),
        started(3, 'b'),
        settled(4, 'b', 1, { inputTokens: 30, outputTokens: 6 }),
      ],
    });
    expect(withRows.header.tokens).toEqual({ input: 130, output: 26 });
    expect(withRows.header.tokensText).toBe('↑130 ↓26');
    const withoutRows = buildRunDetailModel({
      run: runRecord({ totalInputTokens: 10, totalOutputTokens: 5 }),
      steps: [],
      events: [coverageStarted(0), started(1, 'a')],
    });
    expect(withoutRows.header.tokens).toEqual({ input: 10, output: 5 });
    expect(withoutRows.header.tokensText).toBe('↑10 ↓5');
  });

  it('says `not recorded`, not a bare ↑0 ↓0, for the header of a run with no settled row and zero run totals', () => {
    const zero = { totalInputTokens: 0, totalOutputTokens: 0 };
    // An empty run: nothing was read, nothing was billed.
    const empty = buildRunDetailModel({
      run: runRecord(zero),
      steps: [],
      events: [coverageStarted(0)],
    });
    expect(empty.header.tokensText).toBe(NOT_RECORDED);
    expect(empty.header.tokens).toEqual({ input: 0, output: 0 });
    // A failed run whose node failed before any billed attempt: the run row's totals were never written.
    const unbilled = buildRunDetailModel({
      run: runRecord({ ...zero, status: 'failed' }),
      steps: [stepRow('a', { status: 'failed' })],
      events: [coverageStarted(0), started(1, 'a'), failed(2, 'a')],
    });
    expect(unbilled.header.tokensText).toBe(NOT_RECORDED);
  });

  it('says `in progress` for the header of a run that has not finished, and `not recorded` for one that has, when nothing is settled and the totals are zero', () => {
    const zero = { totalInputTokens: 0, totalOutputTokens: 0 };
    const headerOf = (status: RunDetailRecord['status']): string =>
      buildRunDetailModel({
        run: openRunRecord({ ...zero, status }),
        steps: [],
        events: [coverageStarted(0), started(1, 'a')],
      }).header.tokensText;
    // A paused run and a running run have no settled row yet and nothing written on the run row.
    expect(headerOf('paused')).toBe('in progress');
    expect(headerOf('running')).toBe('in progress');
    expect(headerOf('pending')).toBe('in progress');
    // A finished run with the same two zeros was never given a figure: that is "not recorded".
    expect(headerOf('completed')).toBe('not recorded');
    expect(headerOf('failed')).toBe('not recorded');
    expect(headerOf('cancelled')).toBe('not recorded');
    // The sentences are the row sentences, not copies of them.
    expect(IN_PROGRESS).toBe('in progress');
    expect(NOT_RECORDED).toBe('not recorded');
  });

  it('keeps the figures of a run that has not finished whenever any exist: run totals, or a settled row', () => {
    const unfinished = { status: 'running' } as const;
    const totals = buildRunDetailModel({
      run: openRunRecord({ ...unfinished, totalInputTokens: 7, totalOutputTokens: 3 }),
      steps: [],
      events: [coverageStarted(0), started(1, 'a')],
    });
    expect(totals.header.tokens).toEqual({ input: 7, output: 3 });
    expect(totals.header.tokensText).toBe('↑7 ↓3');
    const settledRow = buildRunDetailModel({
      run: openRunRecord({ status: 'paused', totalInputTokens: 0, totalOutputTokens: 0 }),
      steps: [],
      events: [
        coverageStarted(0),
        started(1, 'a'),
        settled(2, 'a', 1, { inputTokens: 4, outputTokens: 2 }),
      ],
    });
    expect(settledRow.header.tokens).toEqual({ input: 4, output: 2 });
    expect(settledRow.header.tokensText).toBe('↑4 ↓2');
  });

  it('keeps a recorded header figure: non-zero run totals (even one of the two), or any settled row', () => {
    const noRows = [coverageStarted(0), started(1, 'a')];
    // One total non-zero is a count, not "never written".
    expect(
      buildRunDetailModel({
        run: runRecord({ totalInputTokens: 0, totalOutputTokens: 5 }),
        steps: [],
        events: noRows,
      }).header.tokensText,
    ).toBe('↑0 ↓5');
    expect(
      buildRunDetailModel({
        run: runRecord({ totalInputTokens: 7, totalOutputTokens: 0 }),
        steps: [],
        events: noRows,
      }).header.tokensText,
    ).toBe('↑7 ↓0');
    // A settled row is a recorded figure even when it reports no tokens, whatever the run row holds.
    expect(
      buildRunDetailModel({
        run: runRecord({ totalInputTokens: 0, totalOutputTokens: 0 }),
        steps: [],
        events: [
          coverageStarted(0),
          started(1, 'a'),
          settled(2, 'a', 1, { inputTokens: 0, outputTokens: 0 }),
        ],
      }).header.tokensText,
    ).toBe('↑0 ↓0');
  });

  it('sums every step row of a completed node in the step-row fallback, not just the last one', () => {
    // No settled row, so the node's tokens come from its step rows; both of its attempts completed (a resume
    // re-dispatch), and each row carries its own figures.
    const model = buildRunDetailModel({
      run: runRecord(),
      steps: [
        stepRow('a', { attemptNumber: 1, inputTokens: 7, outputTokens: 3 }),
        stepRow('a', { attemptNumber: 2, inputTokens: 4, outputTokens: 2 }),
      ],
      events: [coverageStarted(0), started(1, 'a', 1), started(2, 'a', 2), completed(3, 'a')],
    });
    expect(rowOf(model.rows, 'a').tokens).toEqual({
      source: 'step',
      input: 11,
      output: 5,
      text: '↑11 ↓5',
    });
  });

  it('counts ONE row`s tokens when a re-dispatched node has two rows under one attempt number, keeping the later row', () => {
    // A budget-approved redispatch or a resume of a node left running: two completed rows, one attempt number, two
    // node:started events. The step-row fallback must not add the attempt's tokens to themselves (↑14 ↓6).
    const events = [coverageStarted(0), started(1, 'a', 1), started(2, 'a', 1), completed(3, 'a')];
    const duplicated = buildRunDetailModel({
      run: runRecord(),
      steps: [
        stepRow('a', { attemptNumber: 1, inputTokens: 7, outputTokens: 3 }),
        stepRow('a', { attemptNumber: 1, inputTokens: 7, outputTokens: 3 }),
      ],
      events,
    });
    expect(rowOf(duplicated.rows, 'a').tokens).toEqual({
      source: 'step',
      input: 7,
      output: 3,
      text: '↑7 ↓3',
    });
    // The later of two differing rows is the one kept.
    const differing = buildRunDetailModel({
      run: runRecord(),
      steps: [
        stepRow('a', { attemptNumber: 1, inputTokens: 7, outputTokens: 3 }),
        stepRow('a', { attemptNumber: 1, inputTokens: 9, outputTokens: 4 }),
      ],
      events,
    });
    expect(rowOf(differing.rows, 'a').tokens).toMatchObject({
      source: 'step',
      input: 9,
      output: 4,
    });
    // With no node:started in the log the attempt count is the step-row count: one attempt, not two rows.
    const unlogged = buildRunDetailModel({
      run: runRecord(),
      steps: [
        stepRow('a', { attemptNumber: 1, inputTokens: 7, outputTokens: 3 }),
        stepRow('a', { attemptNumber: 1, inputTokens: 7, outputTokens: 3 }),
      ],
      events: [],
    });
    expect(rowOf(unlogged.rows, 'a').attemptCount).toBe(1);
  });
});

describe('an absent figure says why it is absent', () => {
  /** A figure's three carriers on a row: tokens, cost, tool trace. */
  const absentTexts = (row: NodeRow): readonly string[] => [
    row.tokens.text,
    row.cost.text,
    row.toolActivity.text,
  ];

  it('says `did not run` for a skipped row: no step row, and a step row whose status is skipped', () => {
    const noStep = buildRunDetailModel({
      run: runRecord(),
      steps: [],
      events: [coverageStarted(0), skipped(1, 'left', 'branch_not_taken')],
    });
    const row = rowOf(noStep.rows, 'left');
    expect(row.status).toBe('skipped');
    expect(absentTexts(row)).toEqual([DID_NOT_RUN, DID_NOT_RUN, DID_NOT_RUN]);
    expect(row.tokens).toEqual({ source: 'none', text: DID_NOT_RUN });
    expect(row.cost).toMatchObject({ source: 'none', text: DID_NOT_RUN });
    expect(row.toolActivity).toEqual({ recorded: false, text: DID_NOT_RUN });
    const withStep = buildRunDetailModel({
      run: runRecord(),
      steps: [stepRow('left', { status: 'skipped' })],
      events: [coverageStarted(0), skipped(1, 'left', 'upstream_unreachable')],
    });
    expect(absentTexts(rowOf(withStep.rows, 'left'))).toEqual([
      DID_NOT_RUN,
      DID_NOT_RUN,
      DID_NOT_RUN,
    ]);
  });

  it('says `did not finish` for a row with no terminal event under a finished run, in every finished state', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const model = buildRunDetailModel({
        run: runRecord({ status }),
        steps: [stepRow('a', { status: 'running' })],
        events: [coverageStarted(0), started(1, 'a')],
      });
      const row = rowOf(model.rows, 'a');
      expect(row.status).toBe('stopped');
      expect(absentTexts(row)).toEqual([DID_NOT_FINISH, DID_NOT_FINISH, DID_NOT_FINISH]);
    }
    // No step row at all: the log alone says it started and never ended.
    const logOnly = buildRunDetailModel({
      run: runRecord({ status: 'failed' }),
      steps: [],
      events: [coverageStarted(0), started(1, 'a')],
    });
    expect(rowOf(logOnly.rows, 'a').status).toBe('stopped');
    expect(absentTexts(rowOf(logOnly.rows, 'a'))).toEqual([
      DID_NOT_FINISH,
      DID_NOT_FINISH,
      DID_NOT_FINISH,
    ]);
  });

  it('says `in progress` for a row still running in a run that has not finished', () => {
    for (const status of ['running', 'paused'] as const) {
      const model = buildRunDetailModel({
        run: openRunRecord({ status }),
        steps: [stepRow('a', { status: 'running' })],
        events: [coverageStarted(0), started(1, 'a')],
      });
      const row = rowOf(model.rows, 'a');
      expect(row.status).toBe('running');
      expect(absentTexts(row)).toEqual([IN_PROGRESS, IN_PROGRESS, IN_PROGRESS]);
      expect(row.toolActivity).toEqual({ recorded: false, text: IN_PROGRESS });
    }
  });

  it('keeps `not recorded` for a completed or failed row whose data is genuinely absent', () => {
    const model = buildRunDetailModel({
      run: runRecord({ status: 'failed' }),
      // Their step rows are read, but the log holds only the start of each: no settled row, no terminal, and the
      // step rows carry no figure a completed node could show.
      steps: [stepRow('done', { status: 'completed' }), stepRow('broke', { status: 'failed' })],
      events: [coverageStarted(0), started(1, 'done'), started(2, 'broke')],
    });
    for (const nodeId of ['done', 'broke']) {
      const row = rowOf(model.rows, nodeId);
      expect(row.toolActivity).toEqual({ recorded: false, text: NOT_RECORDED });
      expect(row.cost).toMatchObject({ source: 'none', text: NOT_RECORDED });
    }
    expect(rowOf(model.rows, 'broke').tokens).toEqual({ source: 'none', text: NOT_RECORDED });
    // A completed node whose step rows were not read has no figure to show either.
    const unread = buildRunDetailModel({
      run: runRecord(),
      steps: [],
      events: [coverageStarted(0), started(1, 'c'), completed(2, 'c', { toolActivity: [] })],
    });
    expect(rowOf(unread.rows, 'c').tokens).toEqual({ source: 'none', text: NOT_RECORDED });
    expect(rowOf(unread.rows, 'c').cost).toMatchObject({ text: NOT_RECORDED });
  });

  it('never replaces a figure that exists: a stopped row with a settled call and a boundary cost keeps them', () => {
    const model = buildRunDetailModel({
      run: runRecord({ status: 'failed', totalCostMicrocents: 3_000_000 }),
      steps: [
        stepRow('a', { status: 'running' }),
        stepRow('b', { status: 'running', costMicrocents: 2_000_000 }),
      ],
      events: [
        coverageStarted(0),
        started(1, 'a'),
        settled(2, 'a', 3_000_000, { inputTokens: 9, outputTokens: 4 }),
        started(3, 'b'),
      ],
    });
    expect(rowOf(model.rows, 'a').tokens).toMatchObject({ source: 'attempts', text: '↑9 ↓4' });
    expect(rowOf(model.rows, 'a').cost).toMatchObject({
      source: 'attempts',
      microcents: 3_000_000,
    });
    expect(rowOf(model.rows, 'b').cost).toMatchObject({
      source: 'boundary',
      microcents: 2_000_000,
    });
    // The row with neither still says why.
    expect(rowOf(model.rows, 'b').tokens).toEqual({ source: 'none', text: DID_NOT_FINISH });
  });

  it('maps every row status to its sentence', () => {
    const cases: readonly [Parameters<typeof absenceText>[0], boolean, string][] = [
      ['skipped', true, DID_NOT_RUN],
      ['skipped', false, DID_NOT_RUN],
      ['stopped', true, DID_NOT_FINISH],
      ['running', false, IN_PROGRESS],
      ['pending', true, DID_NOT_RUN],
      ['pending', false, NOT_YET_RUN],
      ['completed', true, NOT_RECORDED],
      ['completed', false, NOT_RECORDED],
      ['failed', true, NOT_RECORDED],
      ['failed', false, NOT_RECORDED],
    ];
    for (const [status, runFinished, text] of cases) {
      expect([status, runFinished, absenceText(status, runFinished)]).toEqual([
        status,
        runFinished,
        text,
      ]);
    }
    expect(DID_NOT_RUN).toBe('did not run');
    expect(DID_NOT_FINISH).toBe('did not finish');
    expect(IN_PROGRESS).toBe('in progress');
    expect(NOT_YET_RUN).toBe('not yet run');
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

  it('qualifies the row by the run`s coverage as the header does: the plain figure when it is complete, `known; usage unverified` when it is not', () => {
    const complete = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 10_000_000 }),
      steps,
      events,
    });
    expect(complete.unattributedRow?.text).toBe('$0.0500');
    expect(complete.header.costText).toBe('$0.1000');
    // The same log without its `cost:coverage_started` is an unverified history: no figure is shown bare.
    const unverified = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 10_000_000 }),
      steps,
      events: events.slice(1),
    });
    expect(unverified.unattributedMicrocents).toBe(5_000_000);
    expect(unverified.unattributedRow?.text).toBe('$0.0500 known; usage unverified');
    expect(unverified.header.costText).toBe('$0.1000 known; usage unverified');
  });

  it('says how many calls had no price, as the header does, since the residual of the run total is as known as the total', () => {
    const model = buildRunDetailModel({
      run: runRecord({ totalCostMicrocents: 10_000_000 }),
      steps,
      events: [...events, settled(8, 'c', 0, { priced: false })],
    });
    expect(model.unattributedRow?.text).toBe('$0.0500 known; price unknown for 1 call');
    expect(model.header.costText).toBe('$0.1000 known; price unknown for 1 call');
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
      tokens: { source: 'none', text: DID_NOT_RUN },
      cost: { source: 'none', text: DID_NOT_RUN },
      toolActivity: { recorded: false, text: DID_NOT_RUN },
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

describe('a node of the frozen workflow with no record', () => {
  it('is listed as pending after the nodes that ran, in the authored order, and says `not yet run` while the run is going', () => {
    const model = buildRunDetailModel({
      run: runRecord({ status: 'running' }),
      steps: [stepRow('b', { status: 'running' })],
      events: [started(1, 'b')],
      workflowNodeOrder: ['a', 'b', 'c', 'd'],
      nodeTypes: new Map([
        ['c', 'agent'],
        ['d', 'transform'],
      ]),
    });
    expect(model.rows.map((row) => row.nodeId)).toEqual(['b', 'a', 'c', 'd']);
    expect(rowOf(model.rows, 'c')).toMatchObject({
      status: 'pending',
      glyph: '○',
      nodeType: 'agent',
      attemptCount: 0,
      tokens: { source: 'none', text: NOT_YET_RUN },
      cost: { source: 'none', text: NOT_YET_RUN },
      toolActivity: { recorded: false, text: NOT_YET_RUN },
    });
  });

  it('says `did not run` once the run has ended, and never drops a node the snapshot does not name', () => {
    const model = buildRunDetailModel({
      run: runRecord({ status: 'failed' }),
      steps: [stepRow('a', { status: 'failed' }), stepRow('extra')],
      events: [started(1, 'a'), started(2, 'extra')],
      workflowNodeOrder: ['a', 'b'],
    });
    expect(model.rows.map((row) => row.nodeId)).toEqual(['a', 'extra', 'b']);
    expect(rowOf(model.rows, 'b')).toMatchObject({
      status: 'pending',
      tokens: { source: 'none', text: DID_NOT_RUN },
    });
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
    // A node with no terminal makes no claim about an older log. `b` was left `running` under a finished run, so
    // it says it never finished; a completed row whose terminal was not read (a cut log) says `not recorded`.
    expect(rowOf(model.rows, 'b').toolActivity).toEqual({ recorded: false, text: DID_NOT_FINISH });
    const cut = buildRunDetailModel({
      run: runRecord(),
      steps: [stepRow('d')],
      events: [started(1, 'd')],
    });
    expect(rowOf(cut.rows, 'd').toolActivity).toEqual({ recorded: false, text: NOT_RECORDED });
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
        completed(6, 'c', {
          toolActivity: [{ toolId: 'read_file', ok: true, resultRecorded: true, durationMs: 3 }],
        }),
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
      entries: [
        {
          toolId: 'read_file',
          ok: true,
          resultRecorded: true,
          durationMs: 3,
          outcome: 'ok',
          text: 'ok in 3ms',
        },
      ],
      truncated: 0,
      text: '1 tool call',
    });
  });

  it('tells the four outcomes apart by resultRecorded: a refusal is a recorded result, never `no result recorded`', () => {
    const view = buildToolActivity({
      ...completedEvent(),
      toolActivity: [
        { toolId: 'read_file', ok: true, resultRecorded: true, durationMs: 12 },
        { toolId: 'run_command', ok: false, resultRecorded: true, durationMs: 340 },
        { toolId: 'write_file', ok: false, resultRecorded: true },
        { toolId: 'search', ok: false, resultRecorded: false },
      ],
      toolActivityTruncated: 3,
    });
    expect(view).toEqual({
      recorded: true,
      truncated: 3,
      text: '7 tool calls',
      entries: [
        {
          toolId: 'read_file',
          ok: true,
          resultRecorded: true,
          durationMs: 12,
          outcome: 'ok',
          text: 'ok in 12ms',
        },
        {
          toolId: 'run_command',
          ok: false,
          resultRecorded: true,
          durationMs: 340,
          outcome: 'failed',
          text: 'failed after 340ms',
        },
        {
          toolId: 'write_file',
          ok: false,
          resultRecorded: true,
          outcome: 'refused',
          text: 'refused',
        },
        {
          toolId: 'search',
          ok: false,
          resultRecorded: false,
          outcome: 'unpaired',
          text: NO_RESULT_RECORDED,
        },
      ],
    });
    // No cause is stated: a fatal tool failure ends the node with the call unpaired just as a cut does.
    expect(NO_RESULT_RECORDED).toBe('no result recorded');
  });

  it('shows a success with no measured duration as plain `ok`, and never says a recorded result is missing', () => {
    const view = buildToolActivity({
      ...completedEvent(),
      toolActivity: [{ toolId: 'read_file', ok: true, resultRecorded: true }],
    });
    expect(view.recorded && view.entries).toEqual([
      { toolId: 'read_file', ok: true, resultRecorded: true, outcome: 'ok', text: 'ok' },
    ]);
    // The text of a recorded entry never carries the unpaired sentence, whatever its ok and duration.
    const recorded = buildToolActivity({
      ...completedEvent(),
      toolActivity: [
        { toolId: 'a', ok: false, resultRecorded: true },
        { toolId: 'b', ok: false, resultRecorded: true, durationMs: 0 },
      ],
    });
    expect(recorded.recorded && recorded.entries.map((entry) => entry.text)).toEqual([
      'refused',
      'failed after 0ms',
    ]);
  });

  it('sanitizes a tool id', () => {
    const view = buildToolActivity({
      ...completedEvent(),
      toolActivity: [
        { toolId: 'bad\u001b[31m\ntool', ok: true, resultRecorded: true, durationMs: 1 },
      ],
    });
    expect(view.recorded && view.entries[0]?.toolId).toBe('bad tool');
  });

  it('shows a terminal`s trace only for the attempt it closed, and says so for another', () => {
    const terminal = {
      ...completedEvent(),
      attemptNumber: 2,
      toolActivity: [{ toolId: 'read_file', ok: true, resultRecorded: true }],
    };
    expect(buildToolActivityForAttempt(terminal, 1)).toEqual({
      recorded: false,
      text: NOT_RECORDED_FOR_ATTEMPT,
    });
    expect(NOT_RECORDED_FOR_ATTEMPT).toBe('not recorded for this attempt');
    expect(buildToolActivityForAttempt(terminal, 2)).toMatchObject({ recorded: true });
    // An absent attemptNumber is attempt 1; no terminal at all is the plain `not recorded`.
    expect(buildToolActivityForAttempt({ ...terminal, attemptNumber: undefined }, 1)).toMatchObject(
      {
        recorded: true,
      },
    );
    expect(buildToolActivityForAttempt({ ...terminal, attemptNumber: undefined }, 2)).toEqual({
      recorded: false,
      text: NOT_RECORDED_FOR_ATTEMPT,
    });
    expect(buildToolActivityForAttempt(undefined, 2)).toEqual({
      recorded: false,
      text: NOT_RECORDED,
    });
  });

  it('reads the node`s terminal with the HIGHEST sequence number, whatever order the events arrive in', () => {
    const model = buildRunDetailModel({
      run: runRecord({ status: 'failed' }),
      steps: [stepRow('a', { status: 'failed' })],
      events: [
        failed(9, 'a', {
          toolActivity: [{ toolId: 'late', ok: false, resultRecorded: true, durationMs: 1 }],
        }),
        completed(4, 'a', {
          toolActivity: [{ toolId: 'early', ok: true, resultRecorded: true, durationMs: 1 }],
        }),
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

  it('bounds and scrubs the labels read back from the history file: a node id, a node type, a workflow, a tool id', () => {
    const secret = `sk-ant-api03-${'L'.repeat(40)}`;
    // Values of exactly the scrub bound are scrubbed whole and then cut to the window a row shows.
    const huge = buildRunDetailModel({
      run: runRecord({ workflowId: 'w'.repeat(SCRUB_INPUT_CHARS) }),
      steps: [stepRow('n'.repeat(SCRUB_INPUT_CHARS), { nodeType: 't'.repeat(SCRUB_INPUT_CHARS) })],
      events: [],
    });
    const clipped = (letter: string): string => `${letter.repeat(MAX_IDENTIFIER_CHARS)}…`;
    expect(huge.rows[0]?.label).toBe(clipped('n'));
    expect(huge.rows[0]?.nodeType).toBe(clipped('t'));
    expect(huge.header.workflow).toBe(clipped('w'));
    // The raw id is the lookup identity, and is never cut.
    expect(huge.rows[0]?.nodeId).toHaveLength(SCRUB_INPUT_CHARS);
    // Above the bound a value is neither scrubbed nor shown in part: a fixed sentence says only its size.
    const oversized = buildRunDetailModel({
      run: runRecord({ workflowId: 'w'.repeat(200_000) }),
      steps: [stepRow('n'.repeat(200_000), { nodeType: 't'.repeat(200_000) })],
      events: [],
    });
    expect(oversized.rows[0]?.label).toBe('text too large to show (200000 bytes)');
    expect(oversized.rows[0]?.nodeType).toBe('text too large to show (200000 bytes)');
    expect(oversized.header.workflow).toBe('text too large to show (200000 bytes)');
    expect(oversized.rows[0]?.nodeId).toHaveLength(200_000);

    const masked = buildRunDetailModel({
      run: runRecord({ workflowId: `flow ${secret}` }),
      steps: [stepRow(`node ${secret}`, { nodeType: `type ${secret}` })],
      events: [],
    });
    for (const shown of [masked.rows[0]?.label, masked.rows[0]?.nodeType, masked.header.workflow]) {
      expect(shown).not.toContain('sk-ant-api03');
    }
    expect(masked.rows[0]?.label.startsWith('node ')).toBe(true);
    expect(masked.header.workflow.startsWith('flow ')).toBe(true);
    // A slug the caller resolved goes through the same filter.
    const slug = buildRunDetailModel({
      run: runRecord(),
      steps: [],
      events: [],
      workflowSlug: `slug ${secret}`,
    });
    expect(slug.header.workflow).not.toContain('sk-ant-api03');

    const trace = buildToolActivity({
      ...completedEvent(),
      toolActivity: [
        { toolId: 't'.repeat(SCRUB_INPUT_CHARS), ok: true, resultRecorded: true },
        { toolId: `tool ${secret}`, ok: true, resultRecorded: true },
        { toolId: 't'.repeat(200_000), ok: true, resultRecorded: true },
      ],
    });
    const ids = trace.recorded ? trace.entries.map((entry) => entry.toolId) : [];
    expect(ids[0]).toBe(clipped('t'));
    expect(ids[1]).not.toContain('sk-ant-api03');
    expect(ids[2]).toBe('text too large to show (200000 bytes)');
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

  it('keeps a pathological code, message or node id to a bound: the scrubbed text is refused above it, and boundedIdentifier cuts before its filter', () => {
    // Under the document gate (1 MiB) a code or a message above the scrub bound is not scrubbed and not shown in
    // part: a fixed sentence says only its size. A node id is not scrubbed, so it is cut to its window instead.
    const view = readStoredError(
      JSON.stringify({
        code: 'c'.repeat(500_000),
        message: 'm'.repeat(300_000),
        nodeId: 'n'.repeat(200_000),
      }),
    );
    expect(view?.code).toBe('text too large to show (500000 bytes)');
    expect(view?.message).toBe('text too large to show (300000 bytes)');
    expect(Array.from(view?.nodeId ?? '')).toHaveLength(MAX_IDENTIFIER_CHARS + 1);
    // The bound is on what a non-scrubbing filter is handed, not only on what is shown.
    const handed: number[] = [];
    boundedIdentifier('x'.repeat(5_000_000), (text) => {
      handed.push(text.length);
      return text;
    });
    expect(handed).toEqual([SCRUB_INPUT_CHARS]);
    expect(SCRUB_INPUT_CHARS).toBe(65_536);
  });

  it('refuses a stored error above 1 MiB with a fixed sentence, and does not parse it', () => {
    expect(MAX_STORED_ERROR_BYTES).toBe(1_048_576);
    const oversized = JSON.stringify({ code: 'c', message: 'm'.repeat(MAX_STORED_ERROR_BYTES) });
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(readStoredError(oversized)).toEqual({
        message: `error record too large to show (${Buffer.byteLength(oversized)} bytes)`,
      });
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
    // The line sits at exactly 1 MiB: that many bytes is read, one byte more is refused.
    const pad = (n: number): string => JSON.stringify({ code: 'c', message: 'm'.repeat(n) });
    const fill = MAX_STORED_ERROR_BYTES - Buffer.byteLength(pad(0));
    expect(Buffer.byteLength(pad(fill))).toBe(MAX_STORED_ERROR_BYTES);
    expect(readStoredError(pad(fill))?.code).toBe('c');
    expect(readStoredError(pad(fill + 1))?.message).toMatch(/^error record too large to show/u);
  });

  it('scrubs a message and a code WHOLE before it cuts them, so a cut never leaves a secret prefix', () => {
    // A URL's userinfo password, placed so that the cut would fall inside it: cut first, the scrubber would see
    // `postgres://app:S3cr3` with no host after it and leave the prefix of the password in view.
    const url = 'postgres://app:S3cr3tPassw0rdValue@db.internal';
    const message = `${'m'.repeat(MAX_ERROR_MESSAGE_CHARS - 26)}${url}`;
    const code = `${'c'.repeat(MAX_IDENTIFIER_CHARS - 26)}${url}`;
    const view = readStoredError(JSON.stringify({ code, message }));
    for (const shown of [view?.message, view?.code]) {
      expect(shown).not.toContain('S3cr3');
      expect(shown).not.toContain('Passw0rd');
    }
    // Both are still cut to their bounds, with the marker.
    expect(Array.from(view?.message ?? '').length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS + 1);
    expect(Array.from(view?.code ?? '').length).toBeLessThanOrEqual(MAX_IDENTIFIER_CHARS + 1);
    // The helper they share says the same of any text.
    expect(scrubbedBounded(`${'x'.repeat(MAX_IDENTIFIER_CHARS - 26)}${url}`)).not.toContain(
      'S3cr3',
    );
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

  it('says only the size of a document the read refused (null text with a byte length), and nothing for one that is not there', () => {
    // The detail read size-gates the document in SQL: an over-bound one arrives as null text and its byte length.
    expect(readStoredError(null, 5_000_000)).toEqual({
      message: 'error record too large to show (5000000 bytes)',
    });
    expect(readStoredError(undefined, 7)).toEqual({
      message: 'error record too large to show (7 bytes)',
    });
    // Both null: the run did not fail, so there is no error to show.
    expect(readStoredError(null, null)).toBeUndefined();
    expect(readStoredError(null)).toBeUndefined();
    // A text that was returned is read as text, whatever byte length rides with it.
    expect(readStoredError(JSON.stringify({ code: 'tool_failed' }), 999)).toEqual({
      code: 'tool_failed',
    });
    // The header says it too.
    const header = buildRunDetailModel({
      run: runRecord({ status: 'failed', errorJson: null, errorByteLength: 2_000_000 }),
      steps: [],
      events: [],
    }).header;
    expect(header.error).toEqual({ message: 'error record too large to show (2000000 bytes)' });
    expect(
      buildRunDetailModel({ run: runRecord({ status: 'failed' }), steps: [], events: [] }).header
        .error,
    ).toBeUndefined();
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

describe('scrubbedBounded scrubs a value whole, or does not show it (ADR-0122 §7.5)', () => {
  const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const tooLarge = (bytes: number): string => `text too large to show (${bytes} bytes)`;

  it('scrubs a value of exactly the bound WHOLE, to its very last character, and returns promptly', () => {
    // The secret ends the value and the whole value is the window, so only a scrub of ALL of it can mask it.
    const value = `${'x'.repeat(SCRUB_INPUT_CHARS - secret.length - 1)} ${secret}`;
    expect(value).toHaveLength(SCRUB_INPUT_CHARS);
    const started = Date.now();
    const shown = scrubbedBounded(value, SCRUB_INPUT_CHARS);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(shown).not.toContain(secret);
    expect(shown).not.toContain('sk-ant');
    expect(shown.startsWith('xxxx')).toBe(true);
    expect(shown).not.toMatch(/^text too large/u);
    // The same value in the default window is scrubbed whole too and then cut.
    expect(scrubbedBounded(value)).toBe(`${'x'.repeat(MAX_IDENTIFIER_CHARS)}…`);
  });

  it('refuses a value one code unit over the bound with a fixed sentence that says only its size in bytes', () => {
    expect(scrubbedBounded('x'.repeat(SCRUB_INPUT_CHARS + 1))).toBe(
      tooLarge(SCRUB_INPUT_CHARS + 1),
    );
    // The number is the UTF-8 byte length, not the count of code units or code points.
    expect(scrubbedBounded('\u00e9'.repeat(SCRUB_INPUT_CHARS + 1))).toBe(
      tooLarge(2 * (SCRUB_INPUT_CHARS + 1)),
    );
    // A window larger than the default does not change what is refused.
    expect(scrubbedBounded('x'.repeat(SCRUB_INPUT_CHARS + 1), 4096)).toBe(
      tooLarge(SCRUB_INPUT_CHARS + 1),
    );
  });

  it('never shows any part of an over-bound value: a secret at its start, or straddling the old cut, leaves nothing', () => {
    const atStart = scrubbedBounded(`${secret} ${'x'.repeat(300_000)}`, 128);
    expect(atStart).toBe(tooLarge(secret.length + 1 + 300_000));
    // A secret that straddles the bound: a cut made before the scrub leaves its recognizable prefix in the window.
    const straddling = `${'x'.repeat(SCRUB_INPUT_CHARS - 12)} ${secret}`;
    const shown = scrubbedBounded(straddling, SCRUB_INPUT_CHARS);
    expect(shown).toBe(tooLarge(straddling.length));
    expect(shown).not.toContain('sk-ant');
    expect(shown).not.toContain('xxxx');
  });
});
