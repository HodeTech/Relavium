/**
 * `CR-10` / `CR-92` certified against the REAL `history.db`, not the in-memory reference
 * ([ADR-0078](../../../../docs/decisions/0078-ordered-durable-append-and-the-terminal-outbox.md)).
 *
 * **Why this file has to exist.** Both items were proven in `packages/core` against `InMemoryRunStore`, which
 * the engine ships as a reference precisely so a core test needs no filesystem. But the guard that matters is
 * the one inside the SQLite store's `IMMEDIATE` transaction, the outbox that matters is the one that writes a
 * real file beside a real database, and the phase document says in terms that the certification belongs
 * here. A reference implementation that agrees with the real one is a claim until someone runs both.
 *
 * Everything below drives `createRunHistoryStore` over an on-disk `better-sqlite3` database and
 * `createFileTerminalOutbox` over an on-disk file — the same two objects `relavium run` wires.
 *
 * **Run this through turbo, not bare `vitest`.** `apps/cli` resolves `@relavium/core` and `@relavium/db`
 * from their BUILT `dist`, so a bare `pnpm vitest run` here tests whatever was last compiled — measured:
 * breaking the engine's fence handling and re-running without a rebuild left these tests green. Both
 * `pnpm turbo run test` and the documented `pnpm turbo run lint typecheck test` rebuild first.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WorkflowEngine,
  createAppendAudit,
  createInMemoryHost,
  formatAppendAudit,
  parseWorkflow,
  type WorkflowDefinition,
} from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import { isAppendConflictError, type RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileTerminalOutbox } from '../engine/terminal-outbox.js';

const WORKFLOW: WorkflowDefinition = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: durability-e2e
  nodes:
    - { id: a, type: input }
    - { id: b, type: output }
  edges:
    - { from: a, to: b }
`,
);

const TS = '2026-01-01T00:00:00.000Z';

describe('CR-10 / CR-92 against the real history.db', () => {
  let dir: string;
  let client: DbClient;
  let dbPath: string;
  let outboxPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relavium-durability-'));
    dbPath = join(dir, 'history.db');
    outboxPath = join(dir, 'terminal-outbox.ndjson');
    client = createClient(dbPath);
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function realStore() {
    return createRunHistoryStore(client.db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: {
        slug: WORKFLOW.workflow.id,
        name: WORKFLOW.workflow.id,
        definitionJson: JSON.stringify(WORKFLOW),
      },
    });
  }

  it('CR-10: a full run over the REAL store commits a clean prefix with no overlapping asks', async () => {
    // The append audit wrapped around the SQLite store — the same predicate `packages/core` runs against the
    // reference, now measuring the store `relavium run` actually uses.
    const inner = realStore();
    const audit = createAppendAudit(inner);
    const host = createInMemoryHost({
      store: audit.store,
      // The DURABLE lease, from the same database the run persists to. Pairing a real store with the
      // in-memory reference silently fences every run: the engine claims a fence the store has never heard
      // of, so the very first guarded write is refused (ADR-0079 §2). That is the mechanism working — and
      // it is why a host must not mix the two backends.
      runLeases: createRunLeasePort(inner),
    });
    const engine = new WorkflowEngine({ host, executor: passthroughExecutor() });
    const handle = engine.start({ workflow: WORKFLOW, inputs: {} });
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);

    expect(events.at(-1)?.type).toBe('run:completed');
    expect(handle.durability()).toBe('durable');

    const verdict = audit.verdict(handle.runId);
    expect(verdict.holds, formatAppendAudit(verdict)).toBe(true);
    expect(verdict.overlapViolations).toEqual([]);
    expect(verdict.asked.length).toBeGreaterThan(2);
    expect(verdict.committed).toEqual(verdict.asked);
  });

  it('CR-10: the REAL store refuses a stale append with a typed conflict, and writes nothing', async () => {
    // The guard inside the IMMEDIATE transaction, exercised on disk. The rollback half matters as much as
    // the refusal: a partial write would leave derived `runs`/`step_executions` rows with no event.
    const store = realStore();
    const workflowId = await store.resolveWorkflowId(WORKFLOW.workflow.id);
    const runId = 'run-real';
    await store.persistEvent(
      {
        type: 'run:started',
        runId,
        sequenceNumber: 0,
        timestamp: TS,
        workflowId,
        inputs: {},
        executionMode: 'local',
      },
      { expectedLastSequenceNumber: -1 },
    );

    await expect(
      store.persistEvent(
        {
          type: 'node:skipped',
          runId,
          sequenceNumber: 2,
          timestamp: TS,
          nodeId: 'b',
          reason: 'branch_not_taken',
        },
        { expectedLastSequenceNumber: 1 }, // sequence 1 was never written — this would leave a hole
      ),
    ).rejects.toSatisfy(isAppendConflictError);

    expect(store.loadRunEvents(runId).map((e) => e.sequenceNumber)).toEqual([0]);
  });

  it('CR-92: a refused terminal is held in the real FILE outbox and reported uncertain', async () => {
    const inner = realStore();
    const refusing = {
      resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      readWorkflowSnapshot: (runId: string) => inner.readWorkflowSnapshot(runId),
      persistEvent: async (event: RunEvent, ctx?: Parameters<typeof inner.persistEvent>[1]) => {
        if (event.type === 'run:completed') throw new Error('the terminal write failed');
        await inner.persistEvent(event, ctx);
      },
    };
    const outbox = createFileTerminalOutbox(outboxPath);
    const host = createInMemoryHost({
      store: refusing,
      terminalOutbox: outbox,
      runLeases: createRunLeasePort(inner),
    });
    const engine = new WorkflowEngine({ host, executor: passthroughExecutor() });
    const handle = engine.start({ workflow: WORKFLOW, inputs: {} });
    // Drain the stream so the run settles; the events themselves are not what this test asserts on.
    for await (const event of handle.events) void event;

    expect(handle.durability()).toBe('uncertain');
    // The payload is on DISK, in a file the database fault cannot reach — the whole point of §4's separate
    // file rather than an in-database row.
    const held = await outbox.list();
    expect(held.map((e) => e.runId)).toEqual([handle.runId]);
    // …and the database really does lack the terminal.
    expect(inner.loadRunEvents(handle.runId).some((e) => e.type === 'run:completed')).toBe(false);
  });

  it('CR-92: the drain retries that terminal into the real store, and live/history then agree', async () => {
    // The acceptance sentence: "the test proves live, history, resume and reconcile agree." Here across a
    // process-like boundary — the terminal is written by a LATER engine reading the outbox file.
    const inner = realStore();
    let refuse = true;
    const store = {
      resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      readWorkflowSnapshot: (runId: string) => inner.readWorkflowSnapshot(runId),
      persistEvent: async (event: RunEvent, ctx?: Parameters<typeof inner.persistEvent>[1]) => {
        if (refuse && event.type === 'run:completed') throw new Error('the terminal write failed');
        await inner.persistEvent(event, ctx);
      },
    };
    const outbox = createFileTerminalOutbox(outboxPath);
    const host = createInMemoryHost({
      store,
      terminalOutbox: outbox,
      runLeases: createRunLeasePort(inner),
    });
    const handle = new WorkflowEngine({ host, executor: passthroughExecutor() }).start({
      workflow: WORKFLOW,
      inputs: {},
    });
    // Drain the stream so the run settles; the events themselves are not what this test asserts on.
    for await (const event of handle.events) void event;
    expect(handle.durability()).toBe('uncertain');

    // A later start: the store is healthy, and a FRESH outbox object reads the same file — proving the
    // handoff is the file, not in-process state.
    refuse = false;
    const laterHost = createInMemoryHost({
      store,
      terminalOutbox: createFileTerminalOutbox(outboxPath),
      runLeases: createRunLeasePort(inner),
    });
    const repaired = await new WorkflowEngine({
      host: laterHost,
      executor: passthroughExecutor(),
    }).reconcile();

    expect(repaired.map((e) => e.type)).toEqual(['run:completed']);
    const durable = inner.loadRunEvents(handle.runId);
    const terminals = durable.filter((e) => e.type === 'run:completed' || e.type === 'run:failed');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe('run:completed'); // NOT relabelled `failed` by reconciliation
    expect(await createFileTerminalOutbox(outboxPath).list()).toEqual([]); // forgotten once it landed
  });

  it('CR-92: `run` DRAINS at start — the retry path the exit code promises actually exists', async () => {
    // The defect this closes was severe and was mine: `reconcile()` — the only thing that drained — has no
    // shipping caller anywhere in the monorepo, so the outbox, the drain and the certification above were
    // all unreachable from the real binary. A user who saw exit code 5 had no command that would ever move
    // their run to durable, while that exit code's own documentation said one would.
    const inner = realStore();
    let refuse = true;
    const store = {
      resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      readWorkflowSnapshot: (runId: string) => inner.readWorkflowSnapshot(runId),
      persistEvent: async (event: RunEvent, ctx?: Parameters<typeof inner.persistEvent>[1]) => {
        if (refuse && event.type === 'run:completed') throw new Error('the terminal write failed');
        await inner.persistEvent(event, ctx);
      },
    };
    const outbox = createFileTerminalOutbox(outboxPath);
    const first = new WorkflowEngine({
      host: createInMemoryHost({
        store,
        terminalOutbox: outbox,
        runLeases: createRunLeasePort(inner),
      }),
      executor: passthroughExecutor(),
    }).start({ workflow: WORKFLOW, inputs: {} });
    for await (const event of first.events) void event;
    expect(first.durability()).toBe('uncertain');

    // The next start, through the PUBLIC entry point a surface calls — not `reconcile()`.
    refuse = false;
    const drained = await new WorkflowEngine({
      host: createInMemoryHost({
        store,
        terminalOutbox: createFileTerminalOutbox(outboxPath),
        runLeases: createRunLeasePort(inner),
      }),
      executor: passthroughExecutor(),
    }).drainTerminalOutbox();

    expect(drained.map((e) => e.type)).toEqual(['run:completed']);
    expect(inner.loadRunEvents(first.runId).some((e) => e.type === 'run:completed')).toBe(true);
  });
});

/** A minimal executor: `input` and `output` vertices settle immediately with no provider involved. */
function passthroughExecutor() {
  return {
    execute: () => Promise.resolve({ kind: 'completed' as const, output: {} }),
  };
}

describe('CR-11: a parked process cannot speak for a run it gave up (ADR-0079 §4/§5)', () => {
  let dir: string;
  let client: DbClient;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relavium-park-'));
    client = createClient(join(dir, 'history.db'));
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const GATED: WorkflowDefinition = parseWorkflow(
    `schema_version: '1.0'
workflow:
  id: park-e2e
  nodes:
    - { id: a, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: b, type: output }
  edges:
    - { from: a, to: g }
    - { from: g, to: b }
`,
  );

  function gatedStore() {
    return createRunHistoryStore(client.db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: {
        slug: GATED.workflow.id,
        name: GATED.workflow.id,
        definitionJson: JSON.stringify(GATED),
      },
    });
  }

  /**
   * Park a run at its human gate and hand back its id — the lease is released by then (§4).
   *
   * The stream is drained on a BACKGROUND promise rather than with a `break`: breaking out of the `for await`
   * abandons the stream, which tears the execution down and makes a later `cancel()` a no-op — the run would
   * then record nothing for a reason that has nothing to do with ownership.
   */
  async function parkedRun(store: ReturnType<typeof gatedStore>): Promise<{
    runId: string;
    cancel: () => void;
    drained: Promise<void>;
  }> {
    const host = createInMemoryHost({ store, runLeases: createRunLeasePort(store) });
    // NOT `passthroughExecutor` — it completes every vertex, gate included, so the run would finish without
    // ever pausing and nothing here would be about ownership.
    const engine = new WorkflowEngine({
      host,
      executor: {
        execute: (ctx) =>
          Promise.resolve(
            ctx.vertex.id === 'g'
              ? { kind: 'paused' as const, gate: { gateType: 'approval' as const, message: 'ok?' } }
              : { kind: 'completed' as const, output: {} },
          ),
      },
    });
    const handle = engine.start({ workflow: GATED, inputs: {} });
    let parked: () => void = () => undefined;
    const reachedPause = new Promise<void>((resolve) => {
      parked = resolve;
    });
    const drained = (async () => {
      for await (const event of handle.events) if (event.type === 'run:paused') parked();
    })();
    await reachedPause;
    return { runId: handle.runId, cancel: () => engine.cancel(handle.runId), drained };
  }

  it('a cancel on a parked run whose lease ANOTHER process took writes NO second terminal', async () => {
    // The defect this closes: a gate park releases the lease, but the parked process keeps its gate timer,
    // its run timeout and cooperative cancel armed — and a terminal is exempt from the append guard, while
    // an ABSENT fence is a pass rather than a refusal. So the parked process could write `run:cancelled`
    // into a run another process was finishing, putting TWO terminals in one log.
    const store = gatedStore();
    const { runId, cancel, drained } = await parkedRun(store);
    expect(store.leases.read(runId)).toBeUndefined(); // §4: the park really did give ownership up

    // A second process takes the run over — the ordinary `relavium gate` resume.
    expect(store.leases.acquire(runId, 'another-process', 60_000)).toBeDefined();

    cancel(); // …and the FIRST process is Ctrl-C'd, as a user dismissing a stale prompt would.
    // Bounded rather than `await drained`: this test's claim is about what is WRITTEN, and a fenced loser
    // deliberately writes no terminal, so its stream close is a separate property proven in
    // `packages/core/src/engine/run-lease.test.ts` against the engine source. Waiting unbounded here would
    // couple this assertion to that one.
    await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 1_000))]);

    const terminals = store
      .loadRunEvents(runId)
      .filter((event) => event.type === 'run:cancelled' || event.type === 'run:failed');
    expect(terminals).toEqual([]); // it does NOT claim an outcome for a run it no longer owns
  });

  it('a cancel on a parked run NOBODY took over still records the cancellation', async () => {
    // The other half, and the reason the fix re-acquires rather than simply refusing: the common case is a
    // user cancelling their OWN parked run, and that must still be recorded. A fix that only fenced would
    // silently drop it.
    const store = gatedStore();
    const { runId, cancel, drained } = await parkedRun(store);
    cancel();
    await drained;

    const terminals = store
      .loadRunEvents(runId)
      .filter((event) => event.type === 'run:cancelled' || event.type === 'run:failed');
    expect(terminals.map((event) => event.type)).toEqual(['run:cancelled']);
  });
});
