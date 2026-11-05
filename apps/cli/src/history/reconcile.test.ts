import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflow, WorkflowEngine, type RunStore } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliHost } from '../engine/host.js';
import { createFileTerminalOutbox } from '../engine/terminal-outbox.js';
import { terminalOutboxPath } from './open.js';
import { reconcileInterruptedRuns } from './reconcile.js';
import { openSessionStore } from './session-open.js';

const T0 = '2026-11-05T10:00:00.000Z';

const TWO_NODES = parseWorkflow(`schema_version: '1.0'
workflow:
  id: liveness
  nodes:
    - { id: a, type: input }
    - { id: b, type: output }
  edges:
    - { from: a, to: b }
`);

describe('reconcileInterruptedRuns (2.6.G liveness, #229)', () => {
  let dir: string;
  let client: DbClient;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relavium-reconcile-'));
    mkdirSync(join(dir, '.relavium'));
    client = createClient(join(dir, '.relavium', 'history.db'));
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A store for one workflow; `now` lets a test write a lease that has already expired. */
  function store(now: () => number = () => Date.now()) {
    return createRunHistoryStore(client.db, {
      uuid: () => randomUUID(),
      now,
      workflow: { slug: 'liveness', name: 'liveness', definitionJson: '{}' },
    });
  }

  /** Persist a run that started and then lost its process: no terminal, and (unless a test adds one) no lease. */
  async function startedRun(extra: (runId: string) => readonly unknown[] = () => []) {
    const s = store();
    const runId = randomUUID();
    const workflowId = await s.resolveWorkflowId('liveness');
    const events = [
      { type: 'run:started', runId, workflowId, inputs: {}, executionMode: 'local' },
      { type: 'node:started', runId, nodeId: 'a', nodeType: 'input' },
      ...extra(runId),
    ];
    for (const [index, raw] of events.entries()) {
      const event = RunEventSchema.parse({
        timestamp: T0,
        sequenceNumber: index + 1,
        ...(raw as object),
      });
      await s.persistEvent(event);
    }
    return runId;
  }

  function events(runId: string): readonly RunEvent[] {
    return store().loadRunEvents(runId);
  }

  function terminal(runId: string): RunEvent | undefined {
    return events(runId).find(
      (e) => e.type === 'run:completed' || e.type === 'run:failed' || e.type === 'run:cancelled',
    );
  }

  it('settles a run with no owner as run:failed{internal}', async () => {
    const runId = await startedRun();
    await reconcileInterruptedRuns(client.db, terminalOutboxPath(dir));
    expect(terminal(runId)).toMatchObject({ type: 'run:failed', error: { code: 'internal' } });
    // The row the Home lists moves off `running` — the user-visible half of the repair.
    expect(client.sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).toEqual({
      status: 'failed',
    });
  });

  it('leaves a run alone while another process holds a live lease on it', async () => {
    const runId = await startedRun();
    expect(store().leases.acquire(runId, 'another-process', 60_000)).toBeDefined();
    await reconcileInterruptedRuns(client.db, terminalOutboxPath(dir));
    expect(terminal(runId)).toBeUndefined();
    expect(store().leases.read(runId)).toMatchObject({ ownerId: 'another-process', live: true });
  });

  it('takes over an EXPIRED lease and settles the run', async () => {
    const runId = await startedRun();
    const anHourAgo = store(() => Date.now() - 3_600_000);
    expect(anHourAgo.leases.acquire(runId, 'a-dead-process', 60_000)).toBeDefined();
    await reconcileInterruptedRuns(client.db, terminalOutboxPath(dir));
    expect(terminal(runId)).toMatchObject({ type: 'run:failed', error: { code: 'internal' } });
  });

  it('leaves a run parked at a human gate for `relavium gate`', async () => {
    const runId = await startedRun((id) => [
      {
        type: 'node:completed',
        runId: id,
        nodeId: 'a',
        output: {},
        tokensUsed: { input: 0, output: 0 },
        durationMs: 0,
      },
      { type: 'node:started', runId: id, nodeId: 'g', nodeType: 'human_in_the_loop' },
      {
        type: 'human_gate:paused',
        runId: id,
        nodeId: 'g',
        gateId: 'gate-1',
        gateType: 'approval',
        message: 'ok?',
      },
    ]);
    await reconcileInterruptedRuns(client.db, terminalOutboxPath(dir));
    expect(terminal(runId)).toBeUndefined();
  });

  it('lands a held terminal from the outbox instead of relabelling the run failed', async () => {
    const runId = await startedRun();
    const completed = RunEventSchema.parse({
      type: 'run:completed',
      runId,
      timestamp: T0,
      sequenceNumber: 3,
      outputs: {},
      totalTokensUsed: { input: 0, output: 0 },
      totalCostMicrocents: 0,
      durationMs: 0,
    });
    await createFileTerminalOutbox(terminalOutboxPath(dir)).put(completed);
    await reconcileInterruptedRuns(client.db, terminalOutboxPath(dir));
    expect(terminal(runId)?.type).toBe('run:completed');
    expect(await createFileTerminalOutbox(terminalOutboxPath(dir)).list()).toEqual([]);
  });

  it('a reconcile inside a starting run’s lease window leaves exactly one durable terminal', async () => {
    // `run:started` is durable a few microtask turns before the run acquires its lease. A reconcile in that
    // window settles the run and releases its claim, so the run's own acquire then SUCCEEDS. Before the
    // store refused a second terminal, the run's terminal — exempt from the append guard — landed behind the
    // reconciler's: two terminals in one log. Driven here by running the reconcile inside that window.
    const s = store();
    let injected = false;
    const hooked: RunStore = {
      resolveWorkflowId: (slug) => s.resolveWorkflowId(slug),
      listInterruptedRuns: () => s.listInterruptedRuns(),
      readWorkflowSnapshot: (id) => s.readWorkflowSnapshot(id),
      persistEvent: async (event, ctx) => {
        await s.persistEvent(event, ctx);
        if (event.type === 'run:started' && !injected) {
          injected = true;
          await reconcileInterruptedRuns(client.db, terminalOutboxPath(dir));
        }
      },
    };
    const executed: string[] = [];
    const engine = new WorkflowEngine({
      host: createCliHost(hooked, {
        runLeases: createRunLeasePort(s),
        terminalOutboxPath: terminalOutboxPath(dir),
      }),
      executor: {
        execute: (ctx) => {
          executed.push(ctx.vertex.id);
          return Promise.resolve({ kind: 'completed' as const, output: {} });
        },
      },
    });
    const handle = engine.start({ workflow: TWO_NODES, inputs: {} });
    for await (const event of handle.events) void event;

    expect(injected).toBe(true);
    const terminals = () =>
      events(handle.runId).filter(
        (e) => e.type === 'run:completed' || e.type === 'run:failed' || e.type === 'run:cancelled',
      );
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0]).toMatchObject({ type: 'run:failed', error: { code: 'internal' } });
    expect(executed).toEqual([]); // no node ran for a run the log already calls failed
    // The refused terminal is held, so the run reports `uncertain` — and the next start drops it.
    expect(handle.durability()).toBe('uncertain');
    await reconcileInterruptedRuns(client.db, terminalOutboxPath(dir));
    expect(await createFileTerminalOutbox(terminalOutboxPath(dir)).list()).toEqual([]);
    expect(terminals()).toHaveLength(1);
  });

  it('…and when the reconciler still holds its claim, the run is refused and still leaves one terminal', async () => {
    // The other order inside the same window: the reconciler's terminal is durable and its lease is still
    // live when the run tries to acquire. The acquire is refused, and the run settles at once — so its
    // terminal takes the reconciler's sequence number. The store's terminal refusal stops it, and
    // `UNIQUE(run_id, seq)` would stop it if that refusal were gone, which is why removing the refusal alone
    // does not fail this case. Pinned for the outcome, which must not depend on the order.
    const s = store();
    let injected = false;
    const hooked: RunStore = {
      resolveWorkflowId: (slug) => s.resolveWorkflowId(slug),
      listInterruptedRuns: () => s.listInterruptedRuns(),
      readWorkflowSnapshot: (id) => s.readWorkflowSnapshot(id),
      persistEvent: async (event, ctx) => {
        await s.persistEvent(event, ctx);
        if (event.type === 'run:started' && !injected) {
          injected = true;
          const fence = s.leases.acquire(event.runId, 'a-reconciler', 60_000);
          if (fence === undefined) throw new Error('the reconciler could not claim the run');
          await s.persistEvent(
            RunEventSchema.parse({
              type: 'run:failed',
              runId: event.runId,
              timestamp: T0,
              sequenceNumber: event.sequenceNumber + 1,
              error: { code: 'internal', message: 'reconciled', retryable: false },
              partialOutputs: {},
            }),
            {
              expectedLastSequenceNumber: event.sequenceNumber,
              fence: { ownerId: fence.ownerId, generation: fence.generation },
            },
          );
        }
      },
    };
    const executed: string[] = [];
    const engine = new WorkflowEngine({
      host: createCliHost(hooked, {
        runLeases: createRunLeasePort(s),
        terminalOutboxPath: terminalOutboxPath(dir),
      }),
      executor: {
        execute: (ctx) => {
          executed.push(ctx.vertex.id);
          return Promise.resolve({ kind: 'completed' as const, output: {} });
        },
      },
    });
    const handle = engine.start({ workflow: TWO_NODES, inputs: {} });
    for await (const event of handle.events) void event;

    expect(injected).toBe(true);
    const terminals = events(handle.runId).filter(
      (e) => e.type === 'run:completed' || e.type === 'run:failed' || e.type === 'run:cancelled',
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ error: { message: 'reconciled' } });
    expect(executed).toEqual([]);
  });

  it('openSessionStore pairs the home’s database with that home’s outbox', async () => {
    // The pairing matters because the drain prunes an entry whose run is not open in the database it reads.
    // The Home reaches reconcile only through this opener, so this is the wiring a mismatched path would break.
    const runId = await startedRun();
    await createFileTerminalOutbox(terminalOutboxPath(dir)).put(
      RunEventSchema.parse({
        type: 'run:completed',
        runId,
        timestamp: T0,
        sequenceNumber: 3,
        outputs: {},
        totalTokensUsed: { input: 0, output: 0 },
        totalCostMicrocents: 0,
        durationMs: 0,
      }),
    );
    const opened = openSessionStore(dir);
    try {
      expect(opened.reconcileInterruptedRuns).toBeTypeOf('function');
      await opened.reconcileInterruptedRuns?.();
    } finally {
      opened.close();
    }
    expect(terminal(runId)?.type).toBe('run:completed');
    expect(await createFileTerminalOutbox(terminalOutboxPath(dir)).list()).toEqual([]);
  });

  it('never rejects, even over a closed connection', async () => {
    const runId = await startedRun();
    client.sqlite.close();
    await expect(
      reconcileInterruptedRuns(client.db, terminalOutboxPath(dir)),
    ).resolves.toBeUndefined();
    // Reopen so afterEach can close it, and show the run was not touched by the failed attempt.
    client = createClient(join(dir, '.relavium', 'history.db'));
    expect(terminal(runId)).toBeUndefined();
  });

  it('writes nothing when there is nothing to reconcile', async () => {
    writeFileSync(terminalOutboxPath(dir), '');
    await reconcileInterruptedRuns(client.db, terminalOutboxPath(dir));
    expect(client.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    expect(client.sqlite.prepare('SELECT COUNT(*) AS n FROM workflows').get()).toEqual({ n: 0 });
  });
});
