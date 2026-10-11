import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentSessionRecord, SessionMessage } from '@relavium/shared';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { agentSessions, sessionUsageCoverage, sessionUsageInvocations } from './schema.js';
import {
  assertSessionUsageColumnInventory,
  sessionBusinessColumns,
} from './fixtures/session-usage-column-inventory.js';
import { createSessionStore } from './session-store.js';
import { createSessionUsageStore, type FreshSessionSeed } from './session-usage-store.js';
import { SessionUsageError, withSessionUsageWrite } from './session-usage-write.js';

const timestamp = '2026-10-10T00:00:00.000Z';
const seed = (id = 's1'): FreshSessionSeed => ({
  id,
  agentSlug: 'chatter',
  context: { workingDir: '/work', fsScopeTier: 'sandboxed' },
  createdAt: timestamp,
});
const record = (id = 's1'): AgentSessionRecord => ({
  ...seed(id),
  status: 'active',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  totalConservativeMicrocents: 0,
  updatedAt: timestamp,
});
const message = (sessionId = 's1', sequenceNumber = 0): SessionMessage => ({
  id: `${sessionId}-${String(sequenceNumber)}`,
  sessionId,
  sequenceNumber,
  role: 'user',
  content: [{ type: 'text', text: 'hello' }],
  timestamp,
});

let client: DbClient;
beforeEach(() => {
  client = createClient();
  runMigrations(client.db);
});
afterEach(() => {
  vi.restoreAllMocks();
  client.sqlite.close();
});

function state(id = 's1') {
  return client.db
    .select({
      revision: agentSessions.usageMutationRevision,
      ack: agentSessions.usageAckRevision,
      taint: agentSessions.usageUnverified,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, id))
    .get();
}
function fresh(id = 's1'): void {
  createSessionUsageStore(client.db).createFreshSession(seed(id));
}
function oldWrite(id = 's1'): void {
  client.db.run(
    sql`UPDATE agent_sessions SET total_cost_microcents = total_cost_microcents + 0 WHERE id = ${id}`,
  );
}

describe('ADR-0104 session coverage foundations', () => {
  it('installs twelve triggers; migration 0018 does not rebuild an existing table', () => {
    const triggers = client.db
      .all<{
        name: string;
      }>(sql`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
      .map((row) => row.name);
    expect(triggers).toEqual([
      'session_costs_usage_delete',
      'session_costs_usage_insert',
      'session_costs_usage_update',
      'session_messages_usage_delete',
      'session_messages_usage_insert',
      'session_messages_usage_update',
      'session_usage_bounds_insert',
      'session_usage_bounds_update',
      'session_usage_high_water_insert',
      'session_usage_high_water_update',
      'session_usage_owner_insert',
      'session_usage_owner_update',
    ]);
    const migration = readFileSync(
      new URL('../drizzle/0018_windy_rhodey.sql', import.meta.url),
      'utf8',
    );
    expect(migration).not.toMatch(/DROP TABLE|RENAME TO|__new_/i);
  });

  it('matches every native and modelled owner column to the actual revision trigger', () => {
    expect(() => assertSessionUsageColumnInventory(client.sqlite)).not.toThrow();
  });

  it('refuses an unclassified native business column', () => {
    client.sqlite.exec('ALTER TABLE agent_sessions ADD COLUMN future_business TEXT');
    expect(() => assertSessionUsageColumnInventory(client.sqlite)).toThrow(
      'SESSION_USAGE_TRIGGER_COLUMN_DRIFT',
    );
  });

  it('detects a missing business assignment in the actual trigger, even when unchanged', () => {
    fresh();
    const row = client.sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE name='session_usage_owner_update'")
      .get();
    if (typeof row !== 'object' || row === null || !('sql' in row) || typeof row.sql !== 'string')
      throw new Error('missing trigger');
    const weakened = row.sql.replace(/\btitle,\s*/, '');
    expect(weakened).not.toBe(row.sql);
    client.sqlite.exec('DROP TRIGGER session_usage_owner_update');
    client.sqlite.exec(weakened);
    client.sqlite.exec("UPDATE agent_sessions SET title=title WHERE id='s1'");
    expect(state()).toEqual({ revision: 1, ack: 1, taint: false });
    expect(() => assertSessionUsageColumnInventory(client.sqlite)).toThrow(
      'SESSION_USAGE_TRIGGER_COLUMN_DRIFT',
    );
  });

  it('keeps generic and predecessor creation unverified; only explicit fresh creation acknowledges complete zero', () => {
    const store = createSessionStore(client.db);
    store.createSession(record('generic'));
    client.db.run(
      sql`INSERT INTO agent_sessions (id, agent_slug, created_at, updated_at) VALUES ('old', 'chatter', 0, 0)`,
    );
    fresh();
    expect(state()).toEqual({ revision: 1, ack: 1, taint: false });
    expect(state('generic')).toEqual({ revision: 1, ack: 1, taint: true });
    expect(state('old')).toEqual({ revision: 1, ack: 0, taint: true });
    expect(createSessionUsageStore(client.db).loadCoverage('old')?.coverage).toEqual({
      unverified: true,
      pendingInvocations: 0,
      unknownCalls: 0,
    });
    expect(createSessionUsageStore(client.db).loadCoverage('absent')).toBeUndefined();
  });

  it('refuses existing owners, hidden tombstones and historical seed fields without changing their state', () => {
    fresh();
    const usage = createSessionUsageStore(client.db);
    expect(() => usage.createFreshSession(seed())).toThrow(SessionUsageError);
    client.db.run(sql`UPDATE agent_sessions SET deleted_at = 1 WHERE id = 's1'`);
    const before = state();
    expect(createSessionStore(client.db).loadSession('s1')).toBeUndefined();
    expect(() => usage.createFreshSession(seed())).toThrow(SessionUsageError);
    expect(state()).toEqual(before);
    expect(() => usage.createFreshSession(record('imported'))).toThrow(SessionUsageError);
    expect(state('imported')).toBeUndefined();
  });

  it.each(sessionBusinessColumns)('tracks even unchanged business assignments to %s', (column) => {
    fresh();
    // All identifiers are fixed test inventory, never user-controlled SQL.
    client.sqlite.exec(`UPDATE agent_sessions SET ${column} = ${column} WHERE id = 's1'`);
    expect(state()).toEqual({ revision: 2, ack: 1, taint: false });
    expect(createSessionUsageStore(client.db).loadCoverage('s1')?.coverage.unverified).toBe(true);
    expect(state()).toEqual({ revision: 2, ack: 1, taint: false }); // reads cannot launder the mismatch
  });

  it.each([false, true])(
    'excludes bookkeeping and allocator writes with recursive_triggers=%s',
    (recursive) => {
      client.sqlite.pragma(`recursive_triggers = ${recursive ? 'ON' : 'OFF'}`);
      fresh();
      client.db.run(
        sql`UPDATE agent_sessions SET usage_ack_revision = usage_mutation_revision, usage_unverified = 0, usage_pending_invocations = 0, usage_unknown_calls = 0 WHERE id = 's1'`,
      );
      expect(createSessionStore(client.db).reserveEffectTurnKey('s1')).toBe(1);
      expect(state()).toEqual({ revision: 1, ack: 1, taint: false });
      createSessionStore(client.db).reserveOneShotEffectTurnKey('one-shot', 1);
      expect(state('one-shot')).toEqual({ revision: 1, ack: 1, taint: true });
    },
  );

  it.each(['session_messages', 'session_costs'])(
    'tracks %s insertion, mutation, reparent and deletion for both owners',
    (table) => {
      fresh();
      fresh('s2');
      if (table === 'session_messages')
        client.db.run(
          sql`INSERT INTO session_messages (id,session_id,sequence_number,role,created_at) VALUES ('child','s1',0,'user',0)`,
        );
      else
        client.db.run(
          sql`INSERT INTO session_costs (id,session_id,model,created_at,updated_at) VALUES ('child','s1','model',0,0)`,
        );
      expect(state()?.revision).toBe(2);
      client.sqlite.exec(`UPDATE ${table} SET id = id WHERE id = 'child'`);
      expect(state()?.revision).toBe(3);
      client.sqlite.exec(`UPDATE ${table} SET session_id = 's2' WHERE id = 'child'`);
      expect(state()?.revision).toBe(4);
      expect(state('s2')?.revision).toBe(2);
      client.sqlite.exec(`DELETE FROM ${table} WHERE id = 'child'`);
      expect(state()?.revision).toBe(4);
      expect(state('s2')?.revision).toBe(3);
    },
  );

  it.each(['update', 'append', 'turn', 'actual', 'conservative', 'release', 'empty-release'])(
    'the %s writer latches entry mismatch and acknowledges its own final writes in one outer transaction',
    (kind) => {
      fresh();
      const store = createSessionStore(client.db);
      if (kind === 'release')
        store.recordSessionConservativeCommitment({
          id: 'hold',
          sessionId: 's1',
          model: 'model',
          estimateMicrocents: 50,
          ts: 1,
        });
      oldWrite();
      const before = state();
      const transaction = vi.spyOn(client.db, 'transaction');
      if (kind === 'update') store.updateSession(record());
      if (kind === 'append') store.appendMessage(message());
      if (kind === 'turn')
        store.writeTurn({ session: record(), messages: [{ message: message() }] });
      if (kind === 'actual')
        store.recordSessionCost({
          id: 'cost',
          sessionId: 's1',
          model: 'model',
          inputTokens: 0,
          outputTokens: 0,
          costMicrocents: 0,
          priced: true,
          ts: 1,
        });
      if (kind === 'conservative')
        store.recordSessionConservativeCommitment({
          id: 'hold',
          sessionId: 's1',
          model: 'model',
          estimateMicrocents: 50,
          ts: 1,
        });
      if (kind === 'release' || kind === 'empty-release')
        store.releaseSessionConservativeCommitments('s1', 2);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transaction.mock.calls[0]?.[1]).toEqual({ behavior: 'immediate' });
      expect(state()?.ack).toBe(state()?.revision);
      expect(state()?.revision).toBeGreaterThanOrEqual(before?.revision ?? -1);
      expect(state()?.taint).toBe(true);
      store.updateSession(record());
      store.releaseSessionConservativeCommitments('s1', 3);
      expect(state()?.taint).toBe(true);
    },
  );

  it('classifies all turn owners at entry rather than after one sibling was mutated', () => {
    fresh();
    fresh('s2');
    oldWrite('s2');
    createSessionStore(client.db).writeTurn({
      messages: [{ message: message() }, { message: message('s2') }],
      session: record(),
    });
    expect(state()?.taint).toBe(false);
    expect(state('s2')?.taint).toBe(true);
    expect(state('s2')?.ack).toBe(state('s2')?.revision);
  });

  it('rolls business writes, sticky taint and acknowledgement back together on an acknowledgement fault', () => {
    fresh();
    oldWrite();
    const before = state();
    client.sqlite.exec(
      "CREATE TRIGGER fail_usage_ack BEFORE UPDATE OF usage_ack_revision ON agent_sessions BEGIN SELECT RAISE(ABORT, 'test_ack_failure'); END",
    );
    expect(() =>
      createSessionStore(client.db).writeTurn({
        messages: [{ message: message() }],
        session: { ...record(), title: 'must roll back' },
      }),
    ).toThrow();
    expect(state()).toEqual(before);
    expect(createSessionStore(client.db).loadMessages('s1')).toEqual([]);
    expect(createSessionStore(client.db).loadSession('s1')?.title).toBeUndefined();
  });

  it('refuses nested transactions and fails closed at the exact safe revision ceiling', () => {
    fresh();
    const store = createSessionStore(client.db);
    expect(() => client.db.transaction(() => store.updateSession(record()))).toThrow(
      SessionUsageError,
    );
    client.db.run(
      sql`UPDATE agent_sessions SET usage_mutation_revision = 9007199254740991, usage_ack_revision = 9007199254740991 WHERE id = 's1'`,
    );
    let failure: unknown;
    try {
      store.appendMessage(message());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SessionUsageError);
    if (failure instanceof SessionUsageError) expect(failure.code).toBe('revision_exhausted');
    expect(store.loadMessages('s1')).toEqual([]);
    expect(state()).toEqual({
      revision: Number.MAX_SAFE_INTEGER,
      ack: Number.MAX_SAFE_INTEGER,
      taint: false,
    });
    expect(() =>
      client.db.run(
        sql`UPDATE agent_sessions SET usage_mutation_revision = 9007199254740992 WHERE id = 's1'`,
      ),
    ).toThrow();
    expect(() =>
      client.db.run(sql`UPDATE agent_sessions SET usage_pending_invocations = -1 WHERE id = 's1'`),
    ).toThrow();
  });

  it('qualifies aggregate and model coverage from one snapshot, without granting authority or revising bookkeeping', () => {
    fresh();
    withSessionUsageWrite(client.db, ['s1'], (tx) => {
      tx.insert(sessionUsageCoverage)
        .values({ sessionId: 's1', model: 'model', pendingInvocations: 2, unknownCalls: 3 })
        .run();
      tx.update(agentSessions)
        .set({ usagePendingInvocations: 2, usageUnknownCalls: 3 })
        .where(eq(agentSessions.id, 's1'))
        .run();
      tx.insert(sessionUsageInvocations)
        .values({
          sessionId: 's1',
          producerId: 'producer',
          ordinal: 1,
          dispatchId: 'dispatch',
          round: 0,
          chainAttempt: 1,
          model: 'model',
        })
        .run();
    });
    expect(state()).toEqual({ revision: 1, ack: 1, taint: false });
    oldWrite();
    const usage = createSessionUsageStore(client.db);
    const transaction = vi.spyOn(client.db, 'transaction');
    const snapshot = usage.loadCoverage('s1');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(snapshot).toEqual({
      coverage: { unverified: true, pendingInvocations: 2, unknownCalls: 3 },
      models: [
        { model: 'model', coverage: { unverified: true, pendingInvocations: 2, unknownCalls: 3 } },
      ],
    });
    expect(state()?.taint).toBe(false);
    createSessionStore(client.db).releaseSessionConservativeCommitments('s1', 0);
    expect(usage.loadCoverage('s1')).toEqual(snapshot);
    client.db.run(sql`DELETE FROM agent_sessions WHERE id = 's1'`);
    expect(client.db.select().from(sessionUsageCoverage).all()).toEqual([]);
    expect(client.db.select().from(sessionUsageInvocations).all()).toEqual([]);
    createSessionStore(client.db).createSession(record());
    expect(usage.loadCoverage('s1')?.coverage.unverified).toBe(true);
  });

  it('bounds dormant identity records and keeps duplicate correlation separate from all money tables', () => {
    fresh();
    const row = {
      sessionId: 's1',
      producerId: 'producer',
      ordinal: 1,
      dispatchId: 'dispatch',
      round: 0,
      chainAttempt: 1,
      model: 'model',
    };
    client.db.insert(sessionUsageInvocations).values(row).run();
    expect(() => client.db.insert(sessionUsageInvocations).values(row).run()).toThrow();
    for (const invalid of [
      { ...row, ordinal: 2, model: '' },
      { ...row, ordinal: 2, producerId: 'x'.repeat(257) },
      { ...row, ordinal: 2, round: 0.5 },
      { ...row, ordinal: 0 },
    ]) {
      expect(() => client.db.insert(sessionUsageInvocations).values(invalid).run()).toThrow();
    }
    expect(createSessionStore(client.db).loadSessionCosts('s1')).toEqual([]);
    expect(createSessionStore(client.db).loadSession('s1')?.totalCostMicrocents).toBe(0);
  });
});

it('upgrades native 0017 data without changing amounts, holds, transcript or existing table root pages', () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-usage-migration-'));
  const old = createClient(join(root, 'history.db'));
  try {
    const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
    const directory = join(root, 'migrations');
    mkdirSync(join(directory, 'meta'), { recursive: true });
    // The fixture is repository-owned JSON; validate only the fields used to select its frozen prefix.
    const journal: unknown = JSON.parse(
      readFileSync(join(migrations, 'meta/_journal.json'), 'utf8'),
    );
    if (
      typeof journal !== 'object' ||
      journal === null ||
      !('entries' in journal) ||
      !Array.isArray(journal.entries)
    )
      throw new Error('invalid migration journal');
    const entries: unknown[] = journal.entries;
    const kept = entries.filter(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        'idx' in entry &&
        typeof entry.idx === 'number' &&
        entry.idx <= 17,
    );
    for (const entry of kept) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('tag' in entry) ||
        typeof entry.tag !== 'string'
      )
        throw new Error('invalid migration tag');
      copyFileSync(join(migrations, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
    }
    writeFileSync(
      join(directory, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: kept }),
    );
    migrate(old.db, { migrationsFolder: directory });
    old.db.run(
      sql`INSERT INTO agent_sessions (id,agent_slug,total_cost_microcents,total_conservative_microcents,created_at,updated_at) VALUES ('legacy','chatter',123,456,0,0)`,
    );
    old.db.run(
      sql`INSERT INTO session_costs (id,session_id,model,cost_microcents,conservative_microcents,created_at,updated_at) VALUES ('cost','legacy','model',123,456,0,0)`,
    );
    old.db.run(
      sql`INSERT INTO session_messages (id,session_id,sequence_number,role,content,created_at) VALUES ('message','legacy',0,'user','retained',0)`,
    );
    const roots = (): unknown =>
      old.db.all(
        sql`SELECT name, rootpage FROM sqlite_master WHERE type='table' AND name IN ('agent_sessions','session_messages','session_costs') ORDER BY name`,
      );
    const before = roots();
    migrate(old.db, { migrationsFolder: migrations });
    expect(roots()).toEqual(before);
    expect(
      old.db.all(
        sql`SELECT total_cost_microcents AS actual, total_conservative_microcents AS held, usage_unverified AS unverified FROM agent_sessions WHERE id='legacy'`,
      ),
    ).toEqual([{ actual: 123, held: 456, unverified: 1 }]);
    expect(
      old.db.all(
        sql`SELECT cost_microcents AS actual, conservative_microcents AS held FROM session_costs`,
      ),
    ).toEqual([{ actual: 123, held: 456 }]);
    expect(old.db.all(sql`SELECT content FROM session_messages`)).toEqual([
      { content: 'retained' },
    ]);
    expect(createSessionUsageStore(old.db).loadCoverage('legacy')?.coverage).toEqual({
      unverified: true,
      pendingInvocations: 0,
      unknownCalls: 0,
    });
  } finally {
    old.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
