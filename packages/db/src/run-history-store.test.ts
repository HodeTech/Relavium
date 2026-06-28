import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { runCosts, runEvents, runs, stepExecutions, workflows } from './schema.js';
import {
  createRunHistoryReader,
  createRunHistoryStore,
  loadRunSnapshot,
  type RunHistoryReader,
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
    expect(row?.projectRoot).toBeNull(); // no deps.projectRoot ⇒ NULL (a resume then falls back to the resumer's cwd)
  });

  it('run:started persists deps.projectRoot, and loadRunSnapshot reads it back (save_to resume re-jail)', async () => {
    const rooted = createRunHistoryStore(client.db, {
      uuid: () => counterUuid(++next),
      now: () => TS_MS,
      projectRoot: '/orig/project',
      workflow: WORKFLOW,
    });
    const workflowId = await rooted.resolveWorkflowId('demo');
    await rooted.persistEvent(
      ev('run:started', 0, { workflowId, inputs: {}, executionMode: 'local' }),
    );
    // The originating run's cwd is durable, so a cross-process `relavium gate` resume re-jails save_to under it
    // (a run started in dir A and resumed from B still writes its deliverables under A).
    expect(loadRunSnapshot(client.db, 'run-1')?.projectRoot).toBe('/orig/project');
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

    it('returns undefined for a soft-deleted run (a deleted run is not resumable)', async () => {
      const wf = await store.resolveWorkflowId('demo');
      await store.persistEvent({
        ...ev('run:started', 0, { workflowId: wf, inputs: {}, executionMode: 'local' }),
        runId: 'run-del',
      });
      expect(loadRunSnapshot(client.db, 'run-del')).toBeDefined();
      client.db.update(runs).set({ deletedAt: TS_MS }).where(eq(runs.id, 'run-del')).run();
      expect(loadRunSnapshot(client.db, 'run-del')).toBeUndefined();
    });
  });
});

describe('createRunHistoryReader', () => {
  let client: DbClient;
  let reader: RunHistoryReader;
  let next: number;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    next = 0;
    reader = createRunHistoryReader(client.db);
  });

  afterEach(() => {
    client.sqlite.close();
  });

  /** A fresh workflow-scoped writer (the store is one-workflow-scoped) used only to SEED rows for the reader. */
  function storeFor(slug: string): RunHistoryStore {
    return createRunHistoryStore(client.db, {
      uuid: () => counterUuid(++next),
      now: () => TS_MS,
      workflow: {
        slug,
        name: slug,
        definitionJson: JSON.stringify({
          workflow: { id: slug, name: slug, nodes: [], edges: [] },
        }),
      },
    });
  }

  /**
   * Build a RunEvent for an arbitrary runId + timestamp (the file-level `ev` hard-codes both). Constructed
   * through `RunEventSchema.parse` (no `as` cast) — `rest: EventBody<T>` keeps the input per-variant
   * type-checked, and the schema validates the assembled event, so a bad fixture fails loudly here.
   */
  function evRun<T extends RunEvent['type']>(
    runId: string,
    type: T,
    seq: number,
    rest: EventBody<T>,
    ts: string,
  ): RunEvent {
    return RunEventSchema.parse({ type, runId, timestamp: ts, sequenceNumber: seq, ...rest });
  }

  /**
   * Seed one run (started → one node lifecycle), optionally driven to a paused gate or a clean completion.
   * `atMs` becomes the run's `createdAt`, so a test can order runs deterministically (the fixed-clock store
   * would otherwise tie every `createdAt`, leaving the latest-per-workflow pick to the arbitrary id tiebreak).
   */
  async function seedRun(
    slug: string,
    runId: string,
    opts: { readonly paused?: boolean; readonly completed?: boolean; readonly atMs?: number } = {},
  ): Promise<string> {
    const ts = new Date(opts.atMs ?? TS_MS).toISOString();
    const store = storeFor(slug);
    const workflowId = await store.resolveWorkflowId(slug);
    await store.persistEvent(
      evRun(runId, 'run:started', 0, { workflowId, inputs: {}, executionMode: 'local' }, ts),
    );
    await store.persistEvent(
      evRun(runId, 'node:started', 1, { nodeId: 'n1', nodeType: 'transform' }, ts),
    );
    await store.persistEvent(
      evRun(
        runId,
        'node:completed',
        2,
        {
          nodeId: 'n1',
          output: {},
          tokensUsed: { input: 1, output: 2 },
          durationMs: 5,
          cumulativeCostMicrocents: 100,
        },
        ts,
      ),
    );
    if (opts.paused) {
      await store.persistEvent(
        evRun(runId, 'node:started', 3, { nodeId: 'g', nodeType: 'human_in_the_loop' }, ts),
      );
      await store.persistEvent(
        evRun(
          runId,
          'human_gate:paused',
          4,
          { nodeId: 'g', gateId: 'gate-1', gateType: 'approval', message: 'ship it?' },
          ts,
        ),
      );
    }
    if (opts.completed) {
      await store.persistEvent(
        evRun(
          runId,
          'run:completed',
          3,
          {
            outputs: { ok: true },
            totalTokensUsed: { input: 1, output: 2 },
            totalCostMicrocents: 100,
            durationMs: 9,
          },
          ts,
        ),
      );
    }
    return workflowId;
  }

  it('listActiveRuns returns only non-terminal runs, newest first', async () => {
    await seedRun('alpha', 'run-done', { completed: true, atMs: TS_MS });
    await seedRun('alpha', 'run-paused', { paused: true, atMs: TS_MS + 1000 });
    await seedRun('beta', 'run-running', { atMs: TS_MS + 2000 }); // started, node done, no terminal/pause → 'running'

    const active = reader.listActiveRuns();
    // newest createdAt first; the completed run is excluded.
    expect(active.map((r) => r.id)).toEqual(['run-running', 'run-paused']);
    expect(active.find((r) => r.id === 'run-paused')?.status).toBe('paused');
    expect(active.find((r) => r.id === 'run-running')?.status).toBe('running');
  });

  it('loadLatestRunPerWorkflow keeps the newest run per workflow (ROW_NUMBER), joined by slug', async () => {
    // Two runs of 'alpha' at distinct createdAt so the latest is unambiguous (not the id tiebreak).
    await seedRun('alpha', 'alpha-old', { completed: true, atMs: TS_MS });
    await seedRun('alpha', 'alpha-new', { paused: true, atMs: TS_MS + 1000 });
    await seedRun('beta', 'beta-1', { completed: true, atMs: TS_MS });

    const summaries = reader.loadLatestRunPerWorkflow();
    const bySlug = new Map(summaries.map((s) => [s.slug, s]));
    expect([...bySlug.keys()].sort()).toEqual(['alpha', 'beta']);
    // 'alpha' has two runs; the newer createdAt (alpha-new) wins — its folded status is 'paused'.
    expect(bySlug.get('alpha')?.lastRun.id).toBe('alpha-new');
    expect(bySlug.get('alpha')?.lastRun.status).toBe('paused');
    expect(bySlug.get('beta')?.lastRun.status).toBe('completed');
  });

  it('loadStepExecutions returns per-node rows in execution order, with ISO timestamps', async () => {
    await seedRun('alpha', 'run-1', { paused: true });

    const steps = reader.loadStepExecutions('run-1');
    expect(steps.map((s) => s.nodeId)).toEqual(['n1', 'g']);
    const n1 = steps[0];
    expect(n1?.status).toBe('completed');
    expect(n1?.nodeType).toBe('transform');
    expect(n1?.durationMs).toBe(5);
    expect(n1?.startedAt).toBe(TS); // epoch-ms → ISO at the read boundary
    // The gate node started but never completed → its step row stays 'running' (a live ghost `status` surfaces).
    expect(steps[1]?.status).toBe('running');
    expect(steps[1]?.completedAt).toBeUndefined();
  });

  it('loadRun / loadRunEvents resolve an unknown runId to undefined / empty', () => {
    expect(reader.loadRun('nope')).toBeUndefined();
    expect(reader.loadRunEvents('nope')).toEqual([]);
  });

  it('loadLatestRunPerWorkflow breaks a createdAt tie deterministically by id desc', async () => {
    // Both runs of 'alpha' share createdAt (same atMs), so ONLY the `id desc` tiebreak decides the winner —
    // the lexically-greater id ('r-zzz' > 'r-aaa') must win, deterministically (no incidental row order).
    await seedRun('alpha', 'r-aaa', { completed: true, atMs: TS_MS });
    await seedRun('alpha', 'r-zzz', { paused: true, atMs: TS_MS });

    const summaries = reader.loadLatestRunPerWorkflow();
    expect(summaries.find((s) => s.slug === 'alpha')?.lastRun.id).toBe('r-zzz');
  });

  it('loadLatestRunPerWorkflow excludes a soft-deleted workflow', async () => {
    await seedRun('alpha', 'a1', { completed: true });
    await seedRun('gamma', 'g1', { completed: true });
    // Soft-delete the 'gamma' workflow row — its run must drop out of the CTE (isNull(workflows.deletedAt)).
    client.db.update(workflows).set({ deletedAt: TS_MS }).where(eq(workflows.slug, 'gamma')).run();

    const slugs = reader.loadLatestRunPerWorkflow().map((s) => s.slug);
    expect(slugs).toContain('alpha');
    expect(slugs).not.toContain('gamma');
  });

  it('loadRun excludes a soft-deleted run (matching listRuns), so logs/status read it as not-found', async () => {
    await seedRun('alpha', 'r1', { completed: true });
    expect(reader.loadRun('r1')).toBeDefined();
    client.db.update(runs).set({ deletedAt: TS_MS }).where(eq(runs.id, 'r1')).run();

    expect(reader.loadRun('r1')).toBeUndefined();
    expect(reader.listRuns().map((r) => r.id)).not.toContain('r1');
    // loadRunEvents is keyed by runId alone (caller validates via loadRun first) — still returns the log.
    expect(reader.loadRunEvents('r1').length).toBeGreaterThan(0);
  });

  it('a store created over the same db delegates its reads to the reader (one implementation)', async () => {
    await seedRun('alpha', 'run-1', { completed: true });
    const store = storeFor('alpha');
    // The store's listRuns/loadRun/loadRunEvents are the reader's — same rows, same order.
    expect(store.listRuns().map((r) => r.id)).toEqual(reader.listRuns().map((r) => r.id));
    expect(store.loadRunEvents('run-1')).toHaveLength(reader.loadRunEvents('run-1').length);
  });

  it('listRuns({ limit }) bounds to the indexed top-N; { status } filters; both compose (2.5.B Home)', async () => {
    await seedRun('alpha', 'run-a', { completed: true, atMs: TS_MS + 1000 });
    await seedRun('alpha', 'run-b', { paused: true, atMs: TS_MS + 2000 });
    await seedRun('beta', 'run-c', { completed: true, atMs: TS_MS + 3000 });

    // limit → the two newest by created_at DESC (served off idx_runs_created, no filesort).
    expect(reader.listRuns({ limit: 2 }).map((r) => r.id)).toEqual(['run-c', 'run-b']);
    // status → only matching runs, newest-first (filtered via idx_runs_status: status equality + created_at
    // order; the id tiebreak is the index's missing last term — a small bounded sort, see the listRuns JSDoc).
    expect(reader.listRuns({ status: 'completed' }).map((r) => r.id)).toEqual(['run-c', 'run-a']);
    expect(reader.listRuns({ status: 'paused' }).map((r) => r.id)).toEqual(['run-b']);
    // status + limit compose; omitting both returns the full list (the `relavium list` contract).
    expect(reader.listRuns({ status: 'completed', limit: 1 }).map((r) => r.id)).toEqual(['run-c']);
    expect(reader.listRuns().map((r) => r.id)).toEqual(['run-c', 'run-b', 'run-a']);
  });

  it('loadWorkflowSlugs maps ids → slug (indexed PK lookup), excludes soft-deleted, empty input ⇒ no query', async () => {
    const alphaId = await seedRun('alpha', 'run-a', { completed: true });
    const betaId = await seedRun('beta', 'run-b', { completed: true });

    const map = reader.loadWorkflowSlugs([alphaId, betaId]);
    expect(map.get(alphaId)).toBe('alpha');
    expect(map.get(betaId)).toBe('beta');

    // empty input returns an empty map without a query; a mixed batch resolves the known id and omits the unknown.
    expect(reader.loadWorkflowSlugs([]).size).toBe(0);
    const mixed = reader.loadWorkflowSlugs([alphaId, counterUuid(999)]);
    expect(mixed.get(alphaId)).toBe('alpha');
    expect(mixed.has(counterUuid(999))).toBe(false);
    expect(mixed.size).toBe(1);

    // a soft-deleted workflow drops out (its runs read as unlabeled in the Home, matching loadLatestRunPerWorkflow).
    client.db.update(workflows).set({ deletedAt: TS_MS }).where(eq(workflows.slug, 'beta')).run();
    const after = reader.loadWorkflowSlugs([alphaId, betaId]);
    expect(after.get(alphaId)).toBe('alpha');
    expect(after.has(betaId)).toBe(false);
  });
});
