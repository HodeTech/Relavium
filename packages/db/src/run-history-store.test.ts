import type { RunEvent } from '@relavium/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { runCosts, runEvents, runs, stepExecutions } from './schema.js';
import {
  createRunHistoryStore,
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

/** Build a valid RunEvent — `RunEventSchema.parse` (inside persistEvent) is the real validation. */
function ev<T extends RunEvent['type']>(
  type: T,
  seq: number,
  rest: Record<string, unknown>,
): RunEvent {
  return { type, runId: 'run-1', timestamp: TS, sequenceNumber: seq, ...rest } as RunEvent;
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
    expect(costs.map((c) => c.costMicrocents)).toEqual([300, 700]); // deltas
    const total = costs.reduce((s, c) => s + c.costMicrocents, 0);
    const run = client.db.select().from(runs).where(eq(runs.id, 'run-1')).get();
    expect(total).toBe(run?.totalCostMicrocents); // acceptance: sum(run_costs) == runs.total_cost_microcents
    expect(run?.status).toBe('completed');
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

  // Security fixture — the engine masks a secret-typed input at the bus as { secret: true, ref }; the store
  // is pass-through. Assert the masked placeholder is what lands, and the raw secret value never appears in
  // any unsafe column (run_events.payload_json, runs.input_json). Defense in depth — ADR-0050.
  it('never persists a raw secret — the masked placeholder is stored verbatim', async () => {
    const RAW = ['sk', 'live', 'DEADBEEF'].join('-'); // a fake key, built so no contiguous literal exists
    const workflowId = await store.resolveWorkflowId('secret-wf');
    await store.persistEvent({
      ...ev('run:started', 0, {
        workflowId,
        inputs: { api_key: { secret: true, ref: 'keychain://relavium/anthropic' } },
        executionMode: 'local',
      }),
      runId: 'run-s',
    });

    const runRow = client.db.select().from(runs).where(eq(runs.id, 'run-s')).get();
    const eventRow = client.db.select().from(runEvents).where(eq(runEvents.runId, 'run-s')).get();
    expect(runRow?.inputJson).toContain('"secret":true');
    expect(runRow?.inputJson).not.toContain(RAW);
    expect(eventRow?.payloadJson).toContain('"secret":true');
    expect(eventRow?.payloadJson).not.toContain(RAW);
  });
});
