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
import { createClient, createRunHistoryStore, runMigrations, type DbClient } from '@relavium/db';
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
    const audit = createAppendAudit(realStore());
    const host = createInMemoryHost({ store: audit.store });
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
      persistEvent: async (event: RunEvent, ctx?: Parameters<typeof inner.persistEvent>[1]) => {
        if (event.type === 'run:completed') throw new Error('the terminal write failed');
        await inner.persistEvent(event, ctx);
      },
    };
    const outbox = createFileTerminalOutbox(outboxPath);
    const host = createInMemoryHost({ store: refusing, terminalOutbox: outbox });
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
      persistEvent: async (event: RunEvent, ctx?: Parameters<typeof inner.persistEvent>[1]) => {
        if (refuse && event.type === 'run:completed') throw new Error('the terminal write failed');
        await inner.persistEvent(event, ctx);
      },
    };
    const outbox = createFileTerminalOutbox(outboxPath);
    const host = createInMemoryHost({ store, terminalOutbox: outbox });
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
      persistEvent: async (event: RunEvent, ctx?: Parameters<typeof inner.persistEvent>[1]) => {
        if (refuse && event.type === 'run:completed') throw new Error('the terminal write failed');
        await inner.persistEvent(event, ctx);
      },
    };
    const outbox = createFileTerminalOutbox(outboxPath);
    const first = new WorkflowEngine({
      host: createInMemoryHost({ store, terminalOutbox: outbox }),
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
