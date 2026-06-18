import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXECUTION_MODES, RunStatusSchema } from '@relavium/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  mediaObjects,
  mediaReferences,
  messages,
  runEvents,
  runs,
  stepExecutions,
  workflows,
} from './schema.js';

/**
 * 0.I smoke test: apply every migration to a fresh on-disk SQLite database via the
 * client factory, assert the Phase-1 schema materializes, and round-trip a row through
 * `runs` + `run_events` — schema correctness only, no engine.
 */

const TS = 1_700_000_000_000; // fixed epoch-ms so assertions are deterministic

/**
 * The thirteen Phase-1 local tables (database-schema.md) — nine run-history + two agent-session (1.X)
 * + two media retention (1.AF: media_objects + media_references, ADR-0042).
 */
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
  'agent_sessions',
  'session_messages',
  'media_objects',
  'media_references',
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
      'idx_agent_sessions_status',
      'idx_session_messages_seq',
      'media_objects_handle_unique',
      'idx_media_references_unique',
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

  it('the 0000 migration DDL matches the committed snapshot (column-level fidelity)', () => {
    // Byte-for-byte snapshot of the one migration — pins every column's name/type/notnull/default/pk
    // and the CHECK/index DDL, so a silent schema regeneration is caught.
    const ddl = readFileSync(
      fileURLToPath(new URL('../drizzle/0000_organic_the_santerians.sql', import.meta.url)),
      'utf8',
    );
    expect(ddl).toMatchSnapshot();
  });

  it('the 0001 migration DDL matches the committed snapshot (agent_sessions + session_messages, 1.X)', () => {
    // Byte-for-byte snapshot of the session-persistence migration — pins the two tables' columns,
    // the fs_scope_tier/status CHECKs, the cascade FK, and the unique (session_id, sequence_number) index.
    const ddl = readFileSync(
      fileURLToPath(new URL('../drizzle/0001_pale_scorpion.sql', import.meta.url)),
      'utf8',
    );
    expect(ddl).toMatchSnapshot();
  });

  it('the 0002 migration DDL matches the committed snapshot (media_objects + media_references, 1.AF)', () => {
    // Byte-for-byte snapshot of the media-retention migration — pins the two tables' columns, the
    // modality/scope_kind CHECKs, the handle UNIQUE + the cascade FK to media_objects(handle), and the
    // (handle, scope_kind, scope_id) per-distinct-reference unique index (ADR-0042).
    const ddl = readFileSync(
      fileURLToPath(new URL('../drizzle/0002_round_umar.sql', import.meta.url)),
      'utf8',
    );
    expect(ddl).toMatchSnapshot();
  });

  it('round-trips media_objects + media_references and enforces the refcount/authz junction (1.AF)', () => {
    const handle = `media://sha256-${'a'.repeat(64)}`;
    client.db
      .insert(mediaObjects)
      .values({
        id: randomUUID(),
        handle,
        mimeType: 'image/png',
        modality: 'image',
        byteLength: 1234,
        lastReferencedAt: TS,
        createdAt: TS,
      })
      .run();
    // a run reference (lifetime) and a session reference (authz) on the same handle
    client.db
      .insert(mediaReferences)
      .values([
        { id: randomUUID(), handle, scopeKind: 'run', scopeId: 'run-1', createdAt: TS },
        { id: randomUUID(), handle, scopeKind: 'session', scopeId: 'sess-1', createdAt: TS },
      ])
      .run();
    // the refcount derives from the row count
    expect(
      client.db.select().from(mediaReferences).where(eq(mediaReferences.handle, handle)).all(),
    ).toHaveLength(2);
    // a scope references a handle at most once (the per-distinct-reference UNIQUE)
    expect(() =>
      client.db
        .insert(mediaReferences)
        .values({ id: randomUUID(), handle, scopeKind: 'run', scopeId: 'run-1', createdAt: TS })
        .run(),
    ).toThrow(/UNIQUE constraint failed/i);
    // scope_kind is CHECK-constrained to the closed set
    expect(() =>
      client.db
        .insert(mediaReferences)
        // @ts-expect-error — a deliberately invalid scope_kind to verify the DB CHECK rejects it at runtime
        .values({ id: randomUUID(), handle, scopeKind: 'bogus', scopeId: 'x', createdAt: TS })
        .run(),
    ).toThrow(/CHECK constraint failed/i);
    // an FK to a non-existent handle is rejected
    expect(() =>
      client.db
        .insert(mediaReferences)
        .values({
          id: randomUUID(),
          handle: `media://sha256-${'b'.repeat(64)}`,
          scopeKind: 'run',
          scopeId: 'r',
          createdAt: TS,
        })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/i);
    // deleting the object cascades its references
    client.db.delete(mediaObjects).where(eq(mediaObjects.handle, handle)).run();
    expect(
      client.db.select().from(mediaReferences).where(eq(mediaReferences.handle, handle)).all(),
    ).toHaveLength(0);
  });

  it('rejects a step_executions row whose run_id does not exist (foreign_keys = ON rejects)', () => {
    expect(() =>
      client.db
        .insert(stepExecutions)
        .values({
          id: randomUUID(),
          runId: randomUUID(), // no such run
          nodeId: 'n1',
          nodeType: 'agent',
          createdAt: TS,
          updatedAt: TS,
        })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/i);
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
    // WAL is a no-op for an in-memory database — SQLite keeps journal_mode = 'memory'.
    expect(mem.sqlite.pragma('journal_mode', { simple: true })).toBe('memory');
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

  it('rejects a SQLite URI path (file:…) instead of silently opening a literal file', () => {
    expect(() => createClient('file::memory:?cache=shared')).toThrow(
      /URI paths are not supported/i,
    );
  });

  it('rejects a duplicate (run_id, seq) in run_events (the unique gap-detection invariant)', () => {
    const workflowId = randomUUID();
    const runId = randomUUID();
    client.db
      .insert(workflows)
      .values({
        id: workflowId,
        name: 'U',
        slug: 'uniq-seq',
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
    const ev = () => ({ id: randomUUID(), runId, seq: 5, eventType: 'agent:token', ts: TS });
    client.db.insert(runEvents).values(ev()).run();
    expect(() => client.db.insert(runEvents).values(ev()).run()).toThrow(/UNIQUE/i);
  });
});
