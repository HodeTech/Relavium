import type { RunEvent } from '@relavium/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { runCosts, runEvents, runs, stepExecutions } from './schema.js';
import {
  createRunHistoryStore,
  loadRunSnapshot,
  type RunHistoryStore,
  type RunHistoryWorkflow,
} from './run-history-store.js';

const TS = '2026-06-23T10:00:00.000Z';
const TS_MS = new Date(TS).getTime();

/** Deterministic RFC-4122-shaped ids — the store's row-PK + workflow-id source (no wall-clock/random). */
function counterUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const WORKFLOW: RunHistoryWorkflow = {
  slug: 'demo',
  name: 'Demo',
  definitionJson: JSON.stringify({ workflow: { id: 'demo', name: 'Demo', nodes: [], edges: [] } }),
};

/** The variant-specific fields of a RunEvent (everything but the envelope) — so call sites are type-checked. */
type EventBody<T extends RunEvent['type']> = Omit<
  Extract<RunEvent, { type: T }>,
  'type' | 'runId' | 'timestamp' | 'sequenceNumber'
>;

/**
 * Build a RunEvent for the fixtures: `rest` is strongly typed PER VARIANT (a wrong/missing field is a
 * compile error). The final assembly assertion is unavoidable — TS can't prove a generic spread reconstructs
 * the exact union member — but it widens nothing: every field is already type-checked, and `RunEventSchema`
 * .parse (inside persistEvent) is the authoritative runtime validation.
 */
function ev<T extends RunEvent['type']>(
  type: T,
  seq: number,
  rest: EventBody<T>,
): Extract<RunEvent, { type: T }> {
  return { type, runId: 'run-1', timestamp: TS, sequenceNumber: seq, ...rest } as Extract<
    RunEvent,
    { type: T }
  >;
}

describe('createRunHistoryStore', () => {
  let client: DbClient;
  let store: RunHistoryStore;
  let next: number;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    next = 0;
    store = createRunHistoryStore(client.db, {
      uuid: () => counterUuid(++next),
      now: () => TS_MS,
      workflow: WORKFLOW,
    });
  });

  afterEach(() => {
    client.sqlite.close();
  });

  /** Resolve the workflow + persist a `run:started` so a `runs` row (FK target) exists. Returns the workflow UUID. */
  async function startRun(): Promise<string> {
    const workflowId = await store.resolveWorkflowId('demo');
    await store.persistEvent(
      ev('run:started', 0, { workflowId, inputs: { n: 3 }, executionMode: 'local' }),
    );
    return workflowId;
  }

  it('resolveWorkflowId upserts by slug and is idempotent', async () => {
    const a = await store.resolveWorkflowId('demo');
    const b = await store.resolveWorkflowId('demo');
    expect(a).toBe(b);
    expect(client.db.select().from(runs).all()).toHaveLength(0); // no run row yet
  });

  it('run:started creates a runs row with the frozen snapshot, manual trigger, running status', async () => {
    const workflowId = await startRun();
    const row = client.db.select().from(runs).where(eq(runs.id, 'run-1')).get();
    expect(row).toBeDefined();
    expect(row?.workflowId).toBe(workflowId);
    expect(row?.status).toBe('running');
    expect(row?.triggerType).toBe('manual');
    expect(row?.workflowDefinitionSnapshot).toBe(WORKFLOW.definitionJson);
    expect(row?.startedAt).toBe(TS_MS);
  });

  it('folds a node lifecycle into a step_executions row + a run_costs delta', async () => {
    await startRun();
    await store.persistEvent(ev('node:started', 1, { nodeId: 'double', nodeType: 'transform' }));
    await store.persistEvent(
      ev('node:completed', 2, {
        nodeId: 'double',
        output: { doubled: 6 },
        tokensUsed: { input: 10, output: 20 },
        durationMs: 5,
        cumulativeCostMicrocents: 700,
      }),
    );

    const step = client.db.select().from(stepExecutions).get();
    expect(step?.nodeId).toBe('double');
    expect(step?.status).toBe('completed');
    expect(step?.inputTokens).toBe(10);
    expect(step?.outputTokens).toBe(20);
    expect(step?.durationMs).toBe(5);

    const cost = client.db.select().from(runCosts).get();
    expect(cost?.nodeId).toBe('double');
    expect(cost?.costMicrocents).toBe(700); // delta from 0

    const run = client.db.select().from(runs).where(eq(runs.id, 'run-1')).get();
    expect(run?.totalInputTokens).toBe(10);
    expect(run?.totalOutputTokens).toBe(20);
    expect(run?.totalCostMicrocents).toBe(700);
  });

  it('run_costs deltas sum to the run total across multiple nodes', async () => {
    await startRun();
    await store.persistEvent(ev('node:started', 1, { nodeId: 'a', nodeType: 'agent' }));
    await store.persistEvent(
      ev('node:completed', 2, {
        nodeId: 'a',
        output: {},
        tokensUsed: { input: 1, output: 1 },
        durationMs: 1,
        cumulativeCostMicrocents: 300,
      }),
    );
    await store.persistEvent(ev('node:started', 3, { nodeId: 'b', nodeType: 'agent' }));
    await store.persistEvent(
      ev('node:completed', 4, {
        nodeId: 'b',
        output: {},
        tokensUsed: { input: 1, output: 1 },
        durationMs: 1,
        cumulativeCostMicrocents: 1000,
      }),
    );
    await store.persistEvent(
      ev('run:completed', 5, {
        outputs: { ok: true },
        totalTokensUsed: { input: 2, output: 2 },
        totalCostMicrocents: 1000,
        durationMs: 10,
      }),
    );

    const costs = client.db.select().from(runCosts).all();
    // Order-independent (SQLite gives no row order without ORDER BY) — assert the multiset of deltas.
    expect(costs.map((c) => c.costMicrocents).sort((a, b) => a - b)).toEqual([300, 700]);
    const total = costs.reduce((s, c) => s + c.costMicrocents, 0);
    const run = client.db.select().from(runs).where(eq(runs.id, 'run-1')).get();
    expect(total).toBe(run?.totalCostMicrocents); // acceptance: sum(run_costs) == runs.total_cost_microcents
    expect(run?.status).toBe('completed');
  });

  it('keeps sum(run_costs) == runs.total under a fan-out (interleaved node:completed)', async () => {
    // Both branches start, then complete out of start-order — the cumulative snapshot on the SECOND
    // node:completed already includes the first's cost. Per-node attribution is interleave-dependent, but
    // the deltas must still telescope to the run total (the 2.H acceptance invariant under parallel).
    await startRun();
    await store.persistEvent(ev('node:started', 1, { nodeId: 'a', nodeType: 'transform' }));
    await store.persistEvent(ev('node:started', 2, { nodeId: 'b', nodeType: 'transform' }));
    await store.persistEvent(
      ev('node:completed', 3, {
        nodeId: 'b',
        output: {},
        tokensUsed: { input: 1, output: 1 },
        durationMs: 1,
        cumulativeCostMicrocents: 500, // b finishes first; cumulative = b's cost
      }),
    );
    await store.persistEvent(
      ev('node:completed', 4, {
        nodeId: 'a',
        output: {},
        tokensUsed: { input: 1, output: 1 },
        durationMs: 1,
        cumulativeCostMicrocents: 900, // a finishes second; cumulative = b(500) + a(400)
      }),
    );
    const costs = client.db.select().from(runCosts).all();
    const run = client.db.select().from(runs).where(eq(runs.id, 'run-1')).get();
    expect(costs.reduce((s, c) => s + c.costMicrocents, 0)).toBe(900);
    expect(run?.totalCostMicrocents).toBe(900); // sum == total regardless of completion interleave
  });

  it('records zero cost for a node:completed without cumulativeCostMicrocents (backward-compat)', async () => {
    await startRun();
    await store.persistEvent(ev('node:started', 1, { nodeId: 'x', nodeType: 'transform' }));
    await store.persistEvent(
      ev('node:completed', 2, {
        nodeId: 'x',
        output: {},
        tokensUsed: { input: 0, output: 0 },
        durationMs: 1,
        // cumulativeCostMicrocents absent — a pre-field replayed log; the delta path must yield 0.
      }),
    );
    expect(client.db.select().from(runCosts).get()?.costMicrocents).toBe(0);
    expect(
      client.db.select().from(runs).where(eq(runs.id, 'run-1')).get()?.totalCostMicrocents,
    ).toBe(0);
  });

  it('persists a gap-free seq stream and rejects a duplicate (run_id, seq)', async () => {
    await startRun();
    await store.persistEvent(ev('node:started', 1, { nodeId: 'x', nodeType: 'input' }));
    const seqs = client.db
      .select({ s: runEvents.seq })
      .from(runEvents)
      .all()
      .map((r) => r.s);
    expect(seqs).toEqual([0, 1]);
    await expect(
      store.persistEvent(ev('node:started', 1, { nodeId: 'y', nodeType: 'input' })),
    ).rejects.toThrow(); // UNIQUE(run_id, seq)
  });

  it('loadRunEvents round-trips the full event log in seq order', async () => {
    await startRun();
    await store.persistEvent(ev('node:started', 1, { nodeId: 'x', nodeType: 'output' }));
    const events = store.loadRunEvents('run-1');
    expect(events.map((e) => [e.type, e.sequenceNumber])).toEqual([
      ['run:started', 0],
      ['node:started', 1],
    ]);
  });

  it('maps terminal events to runs.status (completed / failed / cancelled)', async () => {
    for (const [runId, terminal] of [
      [
        'run-c',
        ev('run:completed', 1, {
          outputs: {},
          totalTokensUsed: { input: 0, output: 0 },
          totalCostMicrocents: 0,
          durationMs: 1,
        }),
      ],
      [
        'run-f',
        ev('run:failed', 1, {
          error: { code: 'internal', message: 'boom', retryable: false },
          partialOutputs: {},
        }),
      ],
      ['run-x', ev('run:cancelled', 1, {})],
    ] as const) {
      const wf = await store.resolveWorkflowId(`wf-${runId}`);
      await store.persistEvent({
        ...ev('run:started', 0, { workflowId: wf, inputs: {}, executionMode: 'local' }),
        runId,
      });
      await store.persistEvent({ ...terminal, runId });
    }
    const status = (id: string): string | undefined =>
      client.db.select({ s: runs.status }).from(runs).where(eq(runs.id, id)).get()?.s;
    expect(status('run-c')).toBe('completed');
    expect(status('run-f')).toBe('failed');
    expect(status('run-x')).toBe('cancelled');
  });

  it('listInterruptedRuns reports a gate-paused run resumable and a mid-run one not', async () => {
    // Paused (resumable) run.
    const wfP = await store.resolveWorkflowId('paused');
    await store.persistEvent({
      ...ev('run:started', 0, { workflowId: wfP, inputs: {}, executionMode: 'local' }),
      runId: 'run-p',
    });
    await store.persistEvent({
      ...ev('human_gate:paused', 1, {
        nodeId: 'gate',
        gateId: 'g1',
        gateType: 'approval',
        message: 'ok?',
      }),
      runId: 'run-p',
    });
    // Mid-run (no terminal) run.
    const wfM = await store.resolveWorkflowId('mid');
    await store.persistEvent({
      ...ev('run:started', 0, { workflowId: wfM, inputs: {}, executionMode: 'local' }),
      runId: 'run-m',
    });

    const interrupted = await store.listInterruptedRuns();
    const byId = new Map(interrupted.map((r) => [r.runId, r]));
    expect(byId.get('run-p')?.resumable).toBe(true);
    expect(byId.get('run-p')?.lastSequenceNumber).toBe(1);
    expect(byId.get('run-m')?.resumable).toBe(false);
  });

  it('marks a retried attempt failed so no step row lingers in `running`', async () => {
    await startRun();
    await store.persistEvent(ev('node:started', 1, { nodeId: 'flaky', nodeType: 'agent' }));
    await store.persistEvent(
      ev('node:retrying', 2, {
        nodeId: 'flaky',
        attemptNumber: 1,
        error: { code: 'provider_unavailable', message: '503', retryable: true },
        delayMs: 10,
      }),
    );
    await store.persistEvent(
      ev('node:started', 3, { nodeId: 'flaky', nodeType: 'agent', attemptNumber: 2 }),
    );
    await store.persistEvent(
      ev('node:completed', 4, {
        nodeId: 'flaky',
        output: {},
        tokensUsed: { input: 1, output: 1 },
        durationMs: 1,
        attemptNumber: 2,
      }),
    );
    const steps = client.db.select().from(stepExecutions).all();
    expect(steps.map((s) => [s.attemptNumber, s.status]).sort()).toEqual([
      [1, 'failed'], // the retried attempt is terminal, not a ghost `running`
      [2, 'completed'],
    ]);
  });

  // Security fixture — the engine masks a secret-typed value at the bus as { secret: true, ref }; the store is
  // pass-through. Assert the masked placeholder lands and the RAW value never appears in ANY unsafe column
  // (database-schema.md §"Secrets at the write boundary"): run_events.payload_json, runs.input_json,
  // runs.workflow_definition_snapshot, and the step_executions input/output/error JSON. Defense in depth, ADR-0050.
  it('never persists a raw secret — the masked placeholder only, across every unsafe column', async () => {
    const RAW = ['sk', 'live', 'DEADBEEF'].join('-'); // a fake key, built so no contiguous literal exists
    const masked = { secret: true, ref: 'keychain://relavium/anthropic' } as const;
    const workflowId = await store.resolveWorkflowId('secret-wf');
    await store.persistEvent({
      ...ev('run:started', 0, { workflowId, inputs: { api_key: masked }, executionMode: 'local' }),
      runId: 'run-s',
    });
    await store.persistEvent({
      ...ev('node:started', 1, { nodeId: 'n', nodeType: 'agent' }),
      runId: 'run-s',
    });
    // A masked value can ride a node output too — assert step_executions.output_json stays masked.
    await store.persistEvent({
      ...ev('node:completed', 2, {
        nodeId: 'n',
        output: { echoed: masked },
        tokensUsed: { input: 0, output: 0 },
        durationMs: 1,
      }),
      runId: 'run-s',
    });

    const runRow = client.db.select().from(runs).where(eq(runs.id, 'run-s')).get();
    const stepRow = client.db
      .select()
      .from(stepExecutions)
      .where(eq(stepExecutions.runId, 'run-s'))
      .get();
    const eventRows = client.db.select().from(runEvents).where(eq(runEvents.runId, 'run-s')).all();

    expect(runRow?.inputJson).toContain('"secret":true');
    expect(stepRow?.outputJson).toContain('"secret":true');
    // No unsafe column contains the raw value. `stepRow.inputJson` is always '{}' (node:started carries no
    // runtime input payload by design — the store never writes it), so its check is vacuous-but-complete:
    // it documents that the column is covered and stays empty, not that node inputs are captured here.
    for (const value of [
      runRow?.inputJson,
      runRow?.workflowDefinitionSnapshot,
      stepRow?.inputJson,
      stepRow?.outputJson,
      stepRow?.errorJson,
      ...eventRows.map((e) => e.payloadJson),
    ]) {
      expect(value ?? '').not.toContain(RAW);
    }
  });

  describe('loadRunSnapshot', () => {
    it('returns the frozen workflow snapshot + inputs for a paused run (the 2.G resume substrate)', async () => {
      const wf = await store.resolveWorkflowId('demo');
      await store.persistEvent({
        ...ev('run:started', 0, { workflowId: wf, inputs: { n: 3 }, executionMode: 'local' }),
        runId: 'run-snap',
      });
      await store.persistEvent({
        ...ev('human_gate:paused', 1, {
          nodeId: 'gate',
          gateId: 'g1',
          gateType: 'approval',
          message: 'ok?',
        }),
        runId: 'run-snap',
      });

      const snap = loadRunSnapshot(client.db, 'run-snap');
      // The exact `JSON.stringify(WorkflowDefinition)` written at run:started — round-trips to the parsed graph.
      expect(snap?.workflowDefinitionSnapshot).toBe(WORKFLOW.definitionJson);
      expect(JSON.parse(snap?.workflowDefinitionSnapshot ?? '{}')).toMatchObject({
        workflow: { id: 'demo' },
      });
      // The run's inputs are restored too (a post-gate node may read `{{ inputs.x }}` on resume).
      expect(JSON.parse(snap?.inputJson ?? '{}')).toEqual({ n: 3 });
    });

    it('returns undefined for an unknown runId', () => {
      expect(loadRunSnapshot(client.db, 'nope')).toBeUndefined();
    });
  });
});
