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
    expect(state?.pendingGates).toEqual([{ gateId: 'g1', nodeId: 'gate', isBudgetGate: false }]);
  });

  const mediaJob = (seq: number, nodeId: string, jobId: string): RunEvent => ({
    type: 'media_job:submitted',
    ...base(seq),
    nodeId,
    jobId,
    provider: 'openai',
    model: 'sora',
    modality: 'video',
    startedAt: TS,
    deadlineAt: '2026-01-01T00:30:00.000Z',
  });

  it('parks an in-flight async media job (paused node + pendingMediaJobs entry) — ADR-0045 §2', () => {
    const state = reconstructCheckpointState([started, mediaJob(1, 'gen', 'job-1')]);
    expect(state?.nodeStates.get('gen')).toEqual({ status: 'paused' }); // suspended, NOT absent → re-attach not re-run
    expect(state?.pendingMediaJobs).toEqual([
      {
        nodeId: 'gen',
        jobId: 'job-1',
        provider: 'openai',
        model: 'sora',
        modality: 'video',
        startedAt: TS,
        deadlineAt: '2026-01-01T00:30:00.000Z',
      },
    ]);
  });

  it("clears the node's media-job entry on its terminal node:completed (nothing to re-attach) — ADR-0045 §2", () => {
    const state = reconstructCheckpointState([
      started,
      mediaJob(1, 'gen', 'job-1'),
      completed(2, 'gen', { handle: 'media://sha256-x' }),
    ]);
    expect(state?.pendingMediaJobs).toEqual([]);
    expect(state?.nodeStates.get('gen')?.status).toBe('completed');
  });

  it('latest media_job:submitted wins for a node (a node-retry re-dispatch replaces the entry) — ADR-0045 §2', () => {
    const state = reconstructCheckpointState([
      started,
      mediaJob(1, 'gen', 'job-old'),
      mediaJob(2, 'gen', 'job-new'),
    ]);
    expect(state?.pendingMediaJobs).toHaveLength(1);
    expect(state?.pendingMediaJobs[0]?.jobId).toBe('job-new');
  });

  it('clears a media-job entry on the defensive node:skipped path too (ADR-0045 §2 clear-set)', () => {
    const state = reconstructCheckpointState([
      started,
      mediaJob(1, 'gen', 'job-1'),
      { type: 'node:skipped', ...base(2), nodeId: 'gen', reason: 'upstream_unreachable' },
    ]);
    expect(state?.pendingMediaJobs).toEqual([]);
    expect(state?.nodeStates.get('gen')?.status).toBe('skipped');
  });

  it('a stale/out-of-order media_job:submitted never resurrects an already-settled node (defensive — MJ-2)', () => {
    const state = reconstructCheckpointState([
      started,
      mediaJob(1, 'gen', 'job-1'),
      completed(2, 'gen', { handle: 'media://sha256-x' }),
      mediaJob(3, 'gen', 'job-stale'), // an out-of-order/duplicate submit AFTER the terminal — must be ignored
    ]);
    expect(state?.pendingMediaJobs).toEqual([]); // not re-added
    expect(state?.nodeStates.get('gen')?.status).toBe('completed'); // not re-parked
  });

  it('folds in-flight media jobs across MULTIPLE distinct nodes independently', () => {
    const state = reconstructCheckpointState([
      started,
      mediaJob(1, 'genA', 'job-a'),
      mediaJob(2, 'genB', 'job-b'),
      completed(3, 'genA', { handle: 'media://sha256-a' }), // genA settles; genB stays parked
    ]);
    expect(state?.pendingMediaJobs.map((j) => j.nodeId)).toEqual(['genB']);
    expect(state?.nodeStates.get('genA')?.status).toBe('completed');
    expect(state?.nodeStates.get('genB')?.status).toBe('paused');
  });

  it('keeps isBudgetGate=true across the budget:paused → human_gate:paused pair + restores the cumulative cost — H1/H2', () => {
    // The engine emits budget:paused THEN human_gate:paused with the SAME gateId for a budget gate. The fold
    // must not let the later human_gate:paused downgrade it to a plain human gate — else a resumed REJECTED
    // budget gate would skip the run:failed{budget_exceeded} branch (gated on isBudgetGate) and continue.
    const state = reconstructCheckpointState([
      started,
      {
        type: 'budget:paused',
        ...base(1),
        nodeId: 'n',
        gateId: 'g1',
        spentMicrocents: 900,
        limitMicrocents: 1000,
      },
      {
        type: 'human_gate:paused',
        ...base(2),
        nodeId: 'n',
        gateId: 'g1',
        gateType: 'approval',
        message: 'over budget',
      },
      { type: 'run:paused', ...base(3), pendingGateCount: 1, gateIds: ['g1'] },
    ]);
    expect(state?.runStatus).toBe('paused');
    expect(state?.nodeStates.get('n')).toEqual({ status: 'paused' });
    expect(state?.pendingGates).toEqual([{ gateId: 'g1', nodeId: 'n', isBudgetGate: true }]);
    // H2: the durable budget:paused.spentMicrocents restores the running cost (cost:updated is streamed,
    // not persisted), so the re-seeded governor blocks correctly after resume.
    expect(state?.cumulativeCostMicrocents).toBe(900);
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
    // Exercises the fold's `cost:updated` arm directly (a defensive branch of the pure function — in a real
    // durable log cost:updated is streamed, NOT persisted; the production resume path rides node:completed,
    // covered by the tests below). Kept to pin the token tally + the cost:updated running-total fold.
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

  it('restores the cumulative cost from a durable node:completed at a PLAIN human-gate checkpoint (cost-event persistence)', () => {
    // The previously-lost path: a budgeted/costed run paused at a plain HUMAN gate (not a budget gate) had
    // no durable cost source (cost:updated is streamed, not persisted) and resumed near 0. The running total
    // now rides node:completed.cumulativeCostMicrocents — a REAL durable log (no cost:updated rows) restores it.
    const state = reconstructCheckpointState([
      started,
      {
        type: 'node:completed',
        ...base(1),
        nodeId: 'agent',
        output: 'answer',
        tokensUsed: { input: 30, output: 13 },
        durationMs: 1,
        cumulativeCostMicrocents: 1600, // the durable snapshot — NO cost:updated in this (real-shaped) log
      },
      {
        type: 'human_gate:paused',
        ...base(2),
        nodeId: 'gate',
        gateId: 'g1',
        gateType: 'approval',
        message: 'ok?',
      },
      { type: 'run:paused', ...base(3), pendingGateCount: 1, gateIds: ['g1'] },
    ]);
    expect(state?.runStatus).toBe('paused');
    expect(state?.cumulativeCostMicrocents).toBe(1600); // survives the plain-human-gate resume (was ~0 before)
  });

  it('reconciles two durable cost sources — a later budget:paused.spentMicrocents above a node:completed snapshot', () => {
    // A node completes (running total 800), then the next node's pre-egress trips a budget gate at a higher
    // running total (900). Both are durable cost sources; the fold must end at the higher value.
    const state = reconstructCheckpointState([
      started,
      {
        type: 'node:completed',
        ...base(1),
        nodeId: 'a',
        output: 'A',
        tokensUsed: { input: 0, output: 0 },
        durationMs: 1,
        cumulativeCostMicrocents: 800,
      },
      {
        type: 'budget:paused',
        ...base(2),
        nodeId: 'b',
        gateId: 'g1',
        spentMicrocents: 900,
        limitMicrocents: 1000,
      },
      {
        type: 'human_gate:paused',
        ...base(3),
        nodeId: 'b',
        gateId: 'g1',
        gateType: 'approval',
        message: 'over budget',
      },
      { type: 'run:paused', ...base(4), pendingGateCount: 1, gateIds: ['g1'] },
    ]);
    expect(state?.cumulativeCostMicrocents).toBe(900); // the later, higher budget-pause spend wins
  });

  it('never undercounts: a lower node:completed snapshot after a higher budget:paused keeps the higher (Math.max, order-independent)', () => {
    // The fold's monotonic guard: were a node:completed to carry a LOWER running total than a prior
    // budget:paused (the order-independence case), `Math.max` must keep the higher value — a bare assignment
    // would wrongly drop it. Pins that the cost restore can never go backwards.
    const state = reconstructCheckpointState([
      started,
      {
        type: 'budget:paused',
        ...base(1),
        nodeId: 'a',
        gateId: 'g1',
        spentMicrocents: 900,
        limitMicrocents: 1000,
      },
      {
        type: 'node:completed',
        ...base(2),
        nodeId: 'a',
        output: 'A',
        tokensUsed: { input: 0, output: 0 },
        durationMs: 1,
        cumulativeCostMicrocents: 800, // lower than the prior budget:paused — must NOT lower the cumulative
      },
    ]);
    expect(state?.cumulativeCostMicrocents).toBe(900); // Math.max keeps the higher prior value
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
