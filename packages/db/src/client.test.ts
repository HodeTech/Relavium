import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXECUTION_MODES, RunStatusSchema } from '@relavium/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { messages, runEvents, runs, stepExecutions, workflows } from './schema.js';

/**
 * 0.I smoke test: apply every migration to a fresh on-disk SQLite database via the
 * client factory, assert the Phase-1 schema materializes, and round-trip a row through
 * `runs` + `run_events` — schema correctness only, no engine.
 */

const TS = 1_700_000_000_000; // fixed epoch-ms so assertions are deterministic

/** The nine Phase-1 local tables (database-schema.md). */
const EXPECTED_TABLES = [
  'llm_providers',
  'model_catalog',
  'agents',
  'workflows',
  'runs',
  'step_executions',
  'messages',
  'run_events',
  'run_costs',
] as const;

let tmpDir: string;
let dbFile: string;
let client: DbClient;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'relavium-db-'));
  dbFile = join(tmpDir, 'test.db');
  client = createClient(dbFile);
  runMigrations(client.db);
});

afterAll(() => {
  client.sqlite.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('@relavium/db migrations + client', () => {
  it('opens a real file and applies WAL + foreign_keys pragmas', () => {
    expect(client.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(client.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('creates every Phase-1 table', () => {
    // drizzle's `db.all<T>()` runs a raw query and returns the rows typed as T[]; the
    // generic is the caller's row contract for the SELECT (safe — we own the query).
    const tables = client.db
      .all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`)
      .map((r) => r.name);
    for (const t of EXPECTED_TABLES) {
      expect(tables).toContain(t);
    }
  });

  it('creates the partial-unique and lookup indexes', () => {
    const indexes = client.db
      .all<{ name: string }>(sql`select name from sqlite_master where type = 'index'`)
      .map((r) => r.name);
    // A representative subset across unique, partial, and composite indexes.
    for (const idx of [
      'idx_workflows_slug',
      'idx_runs_status',
      'idx_run_events_run_seq',
      'idx_step_exec_model',
    ]) {
      expect(indexes).toContain(idx);
    }
  });

  it('round-trips a runs + run_events row', () => {
    const workflowId = randomUUID();
    const runId = randomUUID();
    const eventId = randomUUID();

    client.db
      .insert(workflows)
      .values({
        id: workflowId,
        name: 'Smoke WF',
        slug: 'smoke-wf',
        definition: '{"nodes":[],"edges":[]}',
        createdAt: TS,
        updatedAt: TS,
      })
      .run();

    client.db
      .insert(runs)
      .values({
        id: runId,
        workflowId,
        workflowDefinitionSnapshot: '{"nodes":[],"edges":[]}',
        status: 'running',
        executionMode: 'local',
        createdAt: TS,
        updatedAt: TS,
      })
      .run();

    client.db
      .insert(runEvents)
      .values({ id: eventId, runId, seq: 0, eventType: 'run:started', ts: TS })
      .run();

    const run = client.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(run).toMatchObject({
      id: runId,
      workflowId,
      status: 'running',
      executionMode: 'local',
      triggerType: 'manual', // applied DEFAULT
      totalCostMicrocents: 0, // applied DEFAULT
    });

    const events = client.db.select().from(runEvents).where(eq(runEvents.runId, runId)).all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'run:started', level: 'info', seq: 0 });
  });

  it('cascades run_events, step_executions, and messages when the parent run is deleted', () => {
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepId = randomUUID();

    client.db
      .insert(workflows)
      .values({
        id: workflowId,
        name: 'Cascade WF',
        slug: 'cascade-wf',
        definition: '{}',
        createdAt: TS,
        updatedAt: TS,
      })
      .run();
    client.db
      .insert(runs)
      .values({
        id: runId,
        workflowId,
        workflowDefinitionSnapshot: '{}',
        createdAt: TS,
        updatedAt: TS,
      })
      .run();
    client.db
      .insert(runEvents)
      .values({ id: randomUUID(), runId, seq: 0, eventType: 'run:completed', ts: TS })
      .run();
    // A step_execution and its message — to exercise the chained cascade
    // run → step_executions → messages (the hot runtime path).
    client.db
      .insert(stepExecutions)
      .values({ id: stepId, runId, nodeId: 'n1', nodeType: 'agent', createdAt: TS, updatedAt: TS })
      .run();
    client.db
      .insert(messages)
      .values({
        id: randomUUID(),
        stepExecutionId: stepId,
        runId,
        sequenceNumber: 0,
        role: 'assistant',
        createdAt: TS,
      })
      .run();

    client.db.delete(runs).where(eq(runs.id, runId)).run();

    expect(client.db.select().from(runEvents).where(eq(runEvents.runId, runId)).all()).toHaveLength(
      0,
    );
    expect(
      client.db.select().from(stepExecutions).where(eq(stepExecutions.runId, runId)).all(),
    ).toHaveLength(0);
    expect(client.db.select().from(messages).where(eq(messages.runId, runId)).all()).toHaveLength(
      0,
    );
  });

  it('rejects a status / execution_mode outside the CHECK value set (not just the FK)', () => {
    // Insert a real workflow so the FK is satisfied — then ONLY the CHECK can reject these
    // rows. Without it, a non-existent workflow_id would throw an FK violation and the test
    // would pass even if the CHECK were removed. Assert the specific constraint name fires.
    const workflowId = randomUUID();
    client.db
      .insert(workflows)
      .values({
        id: workflowId,
        name: 'Check WF',
        slug: 'check-wf',
        definition: '{}',
        createdAt: TS,
        updatedAt: TS,
      })
      .run();
    const base = { workflowId, workflowDefinitionSnapshot: '{}', createdAt: TS, updatedAt: TS };
    expect(() =>
      client.db
        .insert(runs)
        // @ts-expect-error — 'bogus' is not a valid status.
        .values({ ...base, id: randomUUID(), status: 'bogus' })
        .run(),
    ).toThrow(/CHECK constraint failed: runs_status_check/i);
    expect(() =>
      client.db
        .insert(runs)
        // @ts-expect-error — 'turbo' is not a valid execution_mode.
        .values({ ...base, id: randomUUID(), executionMode: 'turbo' })
        .run(),
    ).toThrow(/CHECK constraint failed: runs_execution_mode_check/i);
  });
});

describe('@relavium/db migration + constraint invariants', () => {
  const tableCount = () =>
    client.db.all<{ n: number }>(
      sql`select count(*) as n from sqlite_master where type = 'table'`,
    )[0]?.n ?? 0;

  it('runMigrations is idempotent — re-running is a no-op', () => {
    const before = tableCount();
    expect(() => runMigrations(client.db)).not.toThrow();
    expect(tableCount()).toBe(before);
  });

  it('opens an in-memory database and applies every migration', () => {
    const mem = createClient(); // default ':memory:'
    runMigrations(mem.db);
    const tables = mem.db
      .all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`)
      .map((r) => r.name);
    for (const t of EXPECTED_TABLES) expect(tables).toContain(t);
    mem.sqlite.close();
  });

  it('enforces the partial-unique slug index only on non-deleted rows', () => {
    const mk = (deletedAt: number | null) => ({
      id: randomUUID(),
      name: 'P',
      slug: 'puniq',
      definition: '{}',
      deletedAt,
      createdAt: TS,
      updatedAt: TS,
    });
    client.db.insert(workflows).values(mk(null)).run();
    // A second non-deleted row with the same slug violates the partial unique index.
    expect(() => client.db.insert(workflows).values(mk(null)).run()).toThrow(/UNIQUE/i);
    // Soft-delete the live row, and the same slug is free again (the index excludes it).
    client.db.update(workflows).set({ deletedAt: TS }).where(eq(workflows.slug, 'puniq')).run();
    expect(() => client.db.insert(workflows).values(mk(null)).run()).not.toThrow();
  });

  it('the runs CHECKs accept exactly the @relavium/shared enum value sets (no drift)', () => {
    const workflowId = randomUUID();
    client.db
      .insert(workflows)
      .values({
        id: workflowId,
        name: 'C',
        slug: 'chk-nodrift',
        definition: '{}',
        createdAt: TS,
        updatedAt: TS,
      })
      .run();
    for (const status of RunStatusSchema.options) {
      expect(() =>
        client.db
          .insert(runs)
          .values({
            id: randomUUID(),
            workflowId,
            workflowDefinitionSnapshot: '{}',
            status,
            createdAt: TS,
            updatedAt: TS,
          })
          .run(),
      ).not.toThrow();
    }
    for (const executionMode of EXECUTION_MODES) {
      expect(() =>
        client.db
          .insert(runs)
          .values({
            id: randomUUID(),
            workflowId,
            workflowDefinitionSnapshot: '{}',
            executionMode,
            createdAt: TS,
            updatedAt: TS,
          })
          .run(),
      ).not.toThrow();
    }
  });
});
