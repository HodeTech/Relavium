import type { RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { reconstructCheckpointState } from './checkpoint.js';
import { InMemoryRunStore, createInMemoryCheckpointer } from './execution-host.js';

const TS = '2026-01-01T00:00:00.000Z';
const base = (sequenceNumber: number) => ({ runId: 'r1', sequenceNumber, timestamp: TS });

const started: RunEvent = {
  type: 'run:started',
  ...base(0),
  workflowId: '00000000-0000-4000-8000-000000000001',
  inputs: {},
  executionMode: 'local',
};
const completed = (seq: number, nodeId: string, output: unknown): RunEvent => ({
  type: 'node:completed',
  ...base(seq),
  nodeId,
  output,
  tokensUsed: { input: 0, output: 0 },
  durationMs: 1,
});

describe('reconstructCheckpointState', () => {
  it('returns undefined for a run with no run:started', () => {
    expect(reconstructCheckpointState([completed(1, 'a', 1)])).toBeUndefined();
  });

  it('reconstructs a completed run (status + nodeStates + lastSequenceNumber)', () => {
    const state = reconstructCheckpointState([
      started,
      completed(1, 'a', { v: 1 }),
      {
        type: 'run:completed',
        ...base(2),
        outputs: {},
        totalTokensUsed: { input: 0, output: 0 },
        totalCostMicrocents: 0,
        durationMs: 1,
      },
    ]);
    expect(state?.runStatus).toBe('completed');
    expect(state?.workflowId).toBe('00000000-0000-4000-8000-000000000001'); // captured from run:started
    expect(state?.startedAtMs).toBe(Date.parse(TS)); // original start epoch, so resumed durationMs is total
    expect(state?.nodeStates.get('a')).toEqual({ status: 'completed', output: { v: 1 } });
    expect(state?.completedNodeIds).toEqual(['a']);
    expect(state?.lastSequenceNumber).toBe(2);
  });

  it('OMITS a node that started but never finished — so the rehydrating engine re-runs it (trap b)', () => {
    const state = reconstructCheckpointState([
      started,
      completed(1, 'a', 'A'),
      { type: 'node:started', ...base(2), nodeId: 'b', nodeType: 'agent' }, // crashed mid-flight
    ]);
    expect(state?.runStatus).toBe('running');
    expect(state?.nodeStates.has('a')).toBe(true);
    expect(state?.nodeStates.has('b')).toBe(false); // absent → engine seeds 'pending' → re-runs
  });

  it('restores a condition selectedTargets + the dimmed branch as skipped (resume routes correctly)', () => {
    const state = reconstructCheckpointState([
      started,
      {
        type: 'node:completed',
        ...base(1),
        nodeId: 'gate',
        output: { decision: true },
        tokensUsed: { input: 0, output: 0 },
        durationMs: 1,
        selected: ['hi'],
      },
      { type: 'node:skipped', ...base(2), nodeId: 'lo', reason: 'branch_not_taken' },
    ]);
    expect(state?.nodeStates.get('gate')).toEqual({
      status: 'completed',
      output: { decision: true },
      selectedTargets: ['hi'],
    });
    expect(state?.nodeStates.get('lo')).toEqual({ status: 'skipped' });
  });

  it('reconstructs a gate-parked run (paused status + pendingGates + paused node)', () => {
    const state = reconstructCheckpointState([
      started,
      {
        type: 'human_gate:paused',
        ...base(1),
        nodeId: 'gate',
        gateId: 'g1',
        gateType: 'approval',
        message: 'ok?',
      },
      { type: 'run:paused', ...base(2), pendingGateCount: 1, gateIds: ['g1'] },
    ]);
    expect(state?.runStatus).toBe('paused');
    expect(state?.nodeStates.get('gate')).toEqual({ status: 'paused' });
    expect(state?.pendingGates).toEqual([{ gateId: 'g1', nodeId: 'gate' }]);
  });

  it('a resumed gate clears the pending gate + records the decision as the node output', () => {
    const state = reconstructCheckpointState([
      started,
      {
        type: 'human_gate:paused',
        ...base(1),
        nodeId: 'gate',
        gateId: 'g1',
        gateType: 'approval',
        message: 'ok?',
      },
      {
        type: 'human_gate:resumed',
        ...base(2),
        nodeId: 'gate',
        decision: 'approved',
        decidedBy: 'u1',
      },
    ]);
    expect(state?.pendingGates).toEqual([]);
    expect(state?.resolvedGateIds).toContain('g1'); // moved to resolved → idempotent re-delivery is a no-op
    expect(state?.nodeStates.get('gate')).toEqual({
      status: 'completed',
      output: { decision: 'approved' },
    });
  });

  it('a resumed gate with a payload records the payload as the output', () => {
    const state = reconstructCheckpointState([
      started,
      {
        type: 'human_gate:paused',
        ...base(1),
        nodeId: 'gate',
        gateId: 'g1',
        gateType: 'input',
        message: 'value?',
      },
      {
        type: 'human_gate:resumed',
        ...base(2),
        nodeId: 'gate',
        decision: 'input_provided',
        decidedBy: 'u1',
        payload: { x: 7 },
      },
    ]);
    expect(state?.nodeStates.get('gate')).toEqual({ status: 'completed', output: { x: 7 } });
  });

  it('restores running token + cost tallies so a resumed run keeps cumulative totals', () => {
    const state = reconstructCheckpointState([
      started,
      {
        type: 'node:completed',
        ...base(1),
        nodeId: 'a',
        output: 'A',
        tokensUsed: { input: 10, output: 5 },
        durationMs: 1,
      },
      {
        type: 'cost:updated',
        ...base(2),
        nodeId: 'a',
        model: 'm',
        inputTokens: 10,
        outputTokens: 5,
        costMicrocents: 700,
        cumulativeCostMicrocents: 700,
      },
      {
        type: 'node:completed',
        ...base(3),
        nodeId: 'b',
        output: 'B',
        tokensUsed: { input: 20, output: 8 },
        durationMs: 1,
      },
      {
        type: 'cost:updated',
        ...base(4),
        nodeId: 'b',
        model: 'm',
        inputTokens: 20,
        outputTokens: 8,
        costMicrocents: 900,
        cumulativeCostMicrocents: 1600,
      },
    ]);
    expect(state?.totalInputTokens).toBe(30);
    expect(state?.totalOutputTokens).toBe(13);
    expect(state?.cumulativeCostMicrocents).toBe(1600); // the last running total, not a re-sum
  });

  it('folds node:retrying as non-state-bearing — a retry-then-recover ends `completed` (1.S)', () => {
    const state = reconstructCheckpointState([
      started,
      { type: 'node:started', ...base(1), nodeId: 'a', nodeType: 'transform' },
      {
        type: 'node:retrying',
        ...base(2),
        nodeId: 'a',
        attemptNumber: 1,
        error: { code: 'tool_failed', message: 'transient', retryable: true },
        delayMs: 10,
      },
      { type: 'node:started', ...base(3), nodeId: 'a', nodeType: 'transform', attemptNumber: 2 },
      {
        type: 'node:completed',
        ...base(4),
        nodeId: 'a',
        output: 'A',
        tokensUsed: { input: 0, output: 0 },
        durationMs: 1,
        attemptNumber: 2,
      },
    ]);
    // node:retrying is ignored by the fold; the terminal node:completed wins → completed (not failed/limbo).
    expect(state?.nodeStates.get('a')).toEqual({ status: 'completed', output: 'A' });
  });

  it('records a failed node with its typed failure', () => {
    const state = reconstructCheckpointState([
      started,
      {
        type: 'node:failed',
        ...base(1),
        nodeId: 'a',
        error: { code: 'tool_failed', message: 'boom', retryable: false },
      },
    ]);
    expect(state?.nodeStates.get('a')).toEqual({
      status: 'failed',
      error: { code: 'tool_failed', message: 'boom', retryable: false },
    });
  });
});

describe('createInMemoryCheckpointer', () => {
  it('loads reconstructed state from an InMemoryRunStore event log', async () => {
    const store = new InMemoryRunStore();
    await store.persistEvent(started);
    await store.persistEvent(completed(1, 'a', 'A'));
    const cp = createInMemoryCheckpointer(store);
    const state = await cp.load('r1');
    expect(state?.runStatus).toBe('running');
    expect(state?.nodeStates.get('a')).toEqual({ status: 'completed', output: 'A' });
  });

  it('returns undefined for an unknown run', async () => {
    const cp = createInMemoryCheckpointer(new InMemoryRunStore());
    expect(await cp.load('nope')).toBeUndefined();
  });

  it('returns undefined for an opaque (non-in-memory) store — a custom store supplies its own', async () => {
    const opaque = {
      resolveWorkflowId: () => Promise.resolve('x'),
      persistEvent: () => Promise.resolve(),
      listInterruptedRuns: () => Promise.resolve([]),
    };
    const cp = createInMemoryCheckpointer(opaque);
    expect(await cp.load('r1')).toBeUndefined();
  });
});
