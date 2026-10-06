import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type AgentSessionRecord, effectScope } from '@relavium/shared';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { createEffectJournalStore } from './effect-journal-store.js';
import { agentSessions, runEffects, sessionMessages } from './schema.js';
import { SessionEffectTurnError } from './session-effect-turns.js';
import { createSessionStore } from './session-store.js';

const timestamp = '2026-10-02T00:00:00.000Z';
const record: AgentSessionRecord = {
  id: 's1',
  agentSlug: 'chatter',
  context: { workingDir: '/workspace', fsScopeTier: 'sandboxed' },
  status: 'active',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  totalConservativeMicrocents: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};
let root: string;
let client: DbClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-session-effect-key-'));
  client = createClient(join(root, 'history.db'));
});
afterEach(() => {
  client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

function key(): number | undefined {
  return client.db
    .select({ key: agentSessions.effectTurnHighWater })
    .from(agentSessions)
    .where(eq(agentSessions.id, 's1'))
    .get()?.key;
}

function refusal(action: () => number, code: SessionEffectTurnError['code']): void {
  try {
    action();
    throw new Error('unexpected allocation');
  } catch (error) {
    expect(error).toBeInstanceOf(SessionEffectTurnError);
    if (error instanceof SessionEffectTurnError) expect(error.code).toBe(code);
  }
}

describe('fresh one-shot effect identity', () => {
  it('atomically retains only hidden bookkeeping, never a resumable session or transcript', () => {
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    expect(store.reserveOneShotEffectTurnKey('once', 1234)).toBe(1);
    expect(store.listSessions()).toEqual([]);
    expect(store.loadFull('once')).toBeUndefined();
    expect(client.db.select().from(sessionMessages).all()).toEqual([]);
    expect(client.db.select().from(agentSessions).get()).toMatchObject({
      id: 'once',
      agentSlug: 'one-shot',
      effectTurnHighWater: 1,
      deletedAt: 1234,
      agentSnapshot: null,
      workingDir: null,
      gitRef: null,
      title: null,
      contextJson: '{}',
    });
    const other = createClient(join(root, 'history.db'));
    try {
      expect(createSessionStore(other.db).listSessions()).toEqual([]);
      refusal(
        () => createSessionStore(other.db).reserveOneShotEffectTurnKey('once', 2345),
        'history_invalid',
      );
      refusal(() => createSessionStore(other.db).reserveEffectTurnKey('once'), 'session_missing');
    } finally {
      other.sqlite.close();
    }
  });

  it('refuses an outer transaction, a live session, and an existing row-less effect scope', () => {
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    client.db.transaction(() =>
      refusal(() => store.reserveOneShotEffectTurnKey('once', 1234), 'transaction_active'),
    );
    store.createSession(record);
    refusal(() => store.reserveOneShotEffectTurnKey('s1', 1234), 'history_invalid');
    const journal = createEffectJournalStore(client.db, { uuid: () => 'effect', now: () => 1234 });
    journal.prepare(
      { scope: 'session:orphan:8', slot: 0, toolId: 'run_command' },
      { kind: 'session', sessionId: 'orphan', turn: 8 },
      { providerAttempt: 1, toolCallId: 'legacy' },
      3,
      'd',
    );
    refusal(() => store.reserveOneShotEffectTurnKey('orphan', 1234), 'history_invalid');
    expect(client.db.select().from(agentSessions).all()).toHaveLength(1);
  });
});

describe('durable session effect-turn high-water mark (ADR-0098)', () => {
  it('does not repeat per-session history work for hundreds of empty idle sessions on reopen', () => {
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    for (let index = 0; index < 200; index++)
      store.createSession({ ...record, id: `idle-${index}` });
    const prepare = vi.spyOn(client.sqlite, 'prepare');
    let statements = 0;
    try {
      runMigrations(client.db);
      statements = prepare.mock.calls.length;
    } finally {
      prepare.mockRestore();
    }
    // A fixed opening query set, rather than hundreds of repeated empty history reads/writes.
    expect(statements).toBeLessThan(40);
    expect(
      client.db.select({ key: agentSessions.effectTurnHighWater }).from(agentSessions).all(),
    ).toEqual(Array.from({ length: 200 }, () => ({ key: 0 })));
    expect(store.reserveEffectTurnKey('idle-199')).toBe(1);
  });

  it('seeds evidence across batch boundaries and keeps encoded identities independent', () => {
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    const ids = Array.from({ length: 260 }, (_, index) => `batch-${index}`);
    ids[127] = 'encoded:%_/雪';
    ids[128] = 'encoded:%_/雪-other';
    let effectId = 0;
    const journal = createEffectJournalStore(client.db, {
      uuid: () => `batch-effect-${++effectId}`,
      now: () => 0,
    });
    for (const id of ids) store.createSession({ ...record, id });
    for (const index of [0, 127, 128, 259]) {
      const id = ids[index];
      if (id === undefined) throw new Error('missing fixture session');
      journal.prepare(
        {
          scope: effectScope({ kind: 'session', sessionId: id, turn: index + 2 }),
          slot: 0,
          toolId: 'run_command',
        },
        { kind: 'session', sessionId: id, turn: index + 2 },
        { providerAttempt: 1, toolCallId: 'legacy' },
        3,
        'digest',
      );
    }
    // A row-less neighbouring scope cannot establish a floor for a different encoded identity.
    journal.prepare(
      {
        scope: effectScope({ kind: 'session', sessionId: 'encoded:%_/雪-orphan', turn: 900 }),
        slot: 0,
        toolId: 'run_command',
      },
      { kind: 'session', sessionId: 'encoded:%_/雪-orphan', turn: 900 },
      { providerAttempt: 1, toolCallId: 'orphan' },
      3,
      'digest',
    );
    runMigrations(client.db);
    for (const index of [0, 127, 128, 259]) {
      const id = ids[index];
      if (id === undefined) throw new Error('missing fixture session');
      expect(store.reserveEffectTurnKey(id)).toBe(index + 3);
    }
    expect(store.reserveEffectTurnKey('batch-258')).toBe(1);
  });

  it('propagates operational database failures instead of treating them as corrupt session history', () => {
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    store.createSession(record);
    store.appendMessage({
      id: 'legacy-terminal',
      sessionId: 's1',
      sequenceNumber: 0,
      role: 'assistant',
      content: [{ type: 'text', text: 'complete' }],
      timestamp,
    });
    client.sqlite.exec(`
      CREATE TRIGGER reject_effect_key_backfill
      BEFORE UPDATE OF effect_turn_high_water ON agent_sessions
      BEGIN
        SELECT RAISE(ABORT, 'controlled backfill failure');
      END;
    `);
    expect(() => runMigrations(client.db)).toThrow('controlled backfill failure');
    expect(key()).toBe(0);
    expect(client.sqlite.inTransaction).toBe(false);
    client.sqlite.exec('DROP TRIGGER reject_effect_key_backfill');
    expect(() => runMigrations(client.db)).not.toThrow();
    expect(store.reserveEffectTurnKey('s1')).toBe(2);
  });

  it.each(['notnum', '01', '-1', '9007199254740992'])(
    'keeps a corrupt legacy scope %s fail-closed without preventing database reopen or other sessions',
    (suffix) => {
      runMigrations(client.db);
      const store = createSessionStore(client.db);
      store.createSession(record);
      store.createSession({ ...record, id: 'good' });
      store.appendMessage({
        id: 'good-terminal',
        sessionId: 'good',
        sequenceNumber: 0,
        role: 'assistant',
        content: [{ type: 'text', text: 'complete' }],
        timestamp,
      });
      client.db
        .insert(runEffects)
        .values({
          id: 'corrupt-effect',
          scope: `session:s1:${suffix}`,
          slot: 0,
          toolId: 'run_command',
          tier: 3,
          state: 'committed',
          argsDigest: 'digest',
          attemptJson: '{"providerAttempt":1,"toolCallId":"old"}',
          createdAt: 0,
          updatedAt: 0,
        })
        .run();
      client.sqlite.close();
      client = createClient(join(root, 'history.db'));
      expect(() => runMigrations(client.db)).not.toThrow();
      expect(key()).toBe(0);
      expect(client.db.select().from(runEffects).get()).toMatchObject({
        scope: `session:s1:${suffix}`,
        state: 'committed',
        argsDigest: 'digest',
      });
      const reopened = createSessionStore(client.db);
      refusal(() => reopened.reserveEffectTurnKey('s1'), 'history_invalid');
      expect(key()).toBe(0);
      expect(reopened.reserveEffectTurnKey('good')).toBe(2);
      expect(() => runMigrations(client.db)).not.toThrow();
      expect(reopened.reserveEffectTurnKey('good')).toBe(3);
      refusal(() => reopened.reserveEffectTurnKey('s1'), 'history_invalid');
      expect(client.db.select().from(runEffects).all()).toHaveLength(1);
    },
  );

  it('keeps malformed legacy assistant data quarantined from allocation while another session seeds', () => {
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    store.createSession(record);
    store.createSession({ ...record, id: 'good' });
    store.appendMessage({
      id: 'bad-terminal',
      sessionId: 's1',
      sequenceNumber: 0,
      role: 'assistant',
      content: [{ type: 'text', text: 'complete' }],
      timestamp,
    });
    store.appendMessage({
      id: 'good-terminal',
      sessionId: 'good',
      sequenceNumber: 0,
      role: 'assistant',
      content: [{ type: 'text', text: 'complete' }],
      timestamp,
    });
    client.db
      .update(sessionMessages)
      .set({ contentParts: '{' })
      .where(eq(sessionMessages.id, 'bad-terminal'))
      .run();
    expect(() => runMigrations(client.db)).not.toThrow();
    expect(key()).toBe(0);
    refusal(() => store.reserveEffectTurnKey('s1'), 'history_invalid');
    expect(store.reserveEffectTurnKey('good')).toBe(2);
    expect(
      client.db
        .select({ content: sessionMessages.contentParts })
        .from(sessionMessages)
        .where(eq(sessionMessages.id, 'bad-terminal'))
        .get()?.content,
    ).toBe('{');
  });

  it('issues distinct keys across independent stores, a crash with no transcript, and reopen', () => {
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    store.createSession(record);
    expect(store.reserveEffectTurnKey('s1')).toBe(1);
    expect(createSessionStore(client.db).reserveEffectTurnKey('s1')).toBe(2);
    client.sqlite.close();
    client = createClient(join(root, 'history.db'));
    runMigrations(client.db);
    expect(createSessionStore(client.db).reserveEffectTurnKey('s1')).toBe(3);
    expect(key()).toBe(3);
  });

  it('cannot be clobbered by stale session updates or atomic turn flushes', () => {
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    store.createSession(record);
    store.reserveEffectTurnKey('s1');
    store.updateSession({ ...record, status: 'idle' });
    expect(key()).toBe(1);
    store.writeTurn({ messages: [], session: record });
    expect(key()).toBe(1);
    expect(store.reserveEffectTurnKey('s1')).toBe(2);
  }, 30_000);

  it.each(['deferred', 'immediate', 'exclusive'] as const)(
    'refuses issuance inside an outer %s transaction before any key can escape a rollback',
    (behavior) => {
      runMigrations(client.db);
      const store = createSessionStore(client.db);
      store.createSession(record);
      const rollback = new Error('owned transaction rollback');
      expect(() =>
        client.db.transaction(
          () => {
            expect(client.sqlite.inTransaction).toBe(true);
            refusal(() => store.reserveEffectTurnKey('s1'), 'transaction_active');
            expect(key()).toBe(0);
            throw rollback;
          },
          { behavior },
        ),
      ).toThrow(rollback);
      expect(client.sqlite.inTransaction).toBe(false);
      expect(key()).toBe(0);
      expect(store.reserveEffectTurnKey('s1')).toBe(1);
      expect(store.reserveEffectTurnKey('s1')).toBe(2);
    },
  );

  it('fails closed at exhaustion without changing the mark', () => {
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    store.createSession(record);
    client.db
      .update(agentSessions)
      .set({ effectTurnHighWater: Number.MAX_SAFE_INTEGER })
      .where(eq(agentSessions.id, 's1'))
      .run();
    refusal(() => store.reserveEffectTurnKey('s1'), 'key_exhausted');
    expect(key()).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses corrupt persisted mark %s', (value) => {
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    store.createSession(record);
    client.db
      .update(agentSessions)
      .set({ effectTurnHighWater: value })
      .where(eq(agentSessions.id, 's1'))
      .run();
    refusal(() => store.reserveEffectTurnKey('s1'), 'history_invalid');
  });

  it('does not allocate for missing or soft-deleted sessions', () => {
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    refusal(() => store.reserveEffectTurnKey('missing'), 'session_missing');
    store.createSession({ ...record, deletedAt: timestamp });
    refusal(() => store.reserveEffectTurnKey('s1'), 'session_missing');
    expect(key()).toBe(0);
  });

  it('backfills a real 0016 database before cleanup and never regresses after sweeping', () => {
    const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
    const legacyDir = join(root, 'legacy');
    mkdirSync(join(legacyDir, 'meta'), { recursive: true });
    for (const name of readdirSync(migrations)) {
      if (/^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 16) {
        copyFileSync(join(migrations, name), join(legacyDir, name));
      }
    }
    const journal: unknown = JSON.parse(
      readFileSync(join(migrations, 'meta/_journal.json'), 'utf8'),
    );
    if (
      typeof journal !== 'object' ||
      journal === null ||
      !('entries' in journal) ||
      !Array.isArray(journal.entries)
    ) {
      throw new Error('invalid migration journal');
    }
    const entries: readonly unknown[] = journal.entries;
    writeFileSync(
      join(legacyDir, 'meta/_journal.json'),
      JSON.stringify({
        ...journal,
        entries: entries.filter(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            'idx' in entry &&
            typeof entry.idx === 'number' &&
            entry.idx <= 16,
        ),
      }),
    );
    migrate(client.db, { migrationsFolder: legacyDir });
    expect(() => client.db.run(sql`SELECT effect_turn_high_water FROM agent_sessions`)).toThrow();
    client.db.run(sql`INSERT INTO agent_sessions (id,agent_slug,context_json,created_at,updated_at)
      VALUES ('s1','chatter','{}',0,0)`);
    const journalStore = createEffectJournalStore(client.db, { uuid: () => 'e1', now: () => 0 });
    const correlation = { kind: 'session' as const, sessionId: 's1', turn: 11 };
    const identity = { scope: effectScope(correlation), slot: 0, toolId: 'run_command' };
    journalStore.prepare(
      identity,
      correlation,
      { providerAttempt: 1, toolCallId: 'session' },
      3,
      'digest',
    );
    journalStore.settle(identity, 'committed', 'old result');
    runMigrations(client.db);
    expect(key()).toBe(11);
    journalStore.sweepCommittedForSession(
      's1',
      journalStore.readSessionDisclosureSnapshot('s1').committed,
    );
    expect(createSessionStore(client.db).reserveEffectTurnKey('s1')).toBe(12);
    runMigrations(client.db);
    expect(createSessionStore(client.db).reserveEffectTurnKey('s1')).toBe(13);
  });

  it('seeds from all historical terminals, ignoring compaction and tool preambles', () => {
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    store.createSession(record);
    for (let seq = 0; seq < 3; seq += 1)
      store.appendMessage({
        id: `m${String(seq)}`,
        sessionId: 's1',
        sequenceNumber: seq,
        role: 'assistant',
        content: [{ type: 'text', text: seq === 2 ? '' : 'final' }],
        timestamp,
      });
    store.appendMessage({
      id: 'm3',
      sessionId: 's1',
      sequenceNumber: 3,
      role: 'system',
      content: [],
      compaction: { droppedThroughSequence: 2 },
      timestamp,
    });
    store.appendMessage({
      id: 'm4',
      sessionId: 's1',
      sequenceNumber: 4,
      role: 'assistant',
      content: [
        { type: 'text', text: 'preamble' },
        { type: 'tool_call', id: 'session-tool:1:0', name: 'read_file', argsBytes: 2 },
      ],
      timestamp,
    });
    runMigrations(client.db);
    expect(key()).toBe(3);
    expect(store.reserveEffectTurnKey('s1')).toBe(4);
  });

  it('matches only the encoded session scope, including wildcard-like ids', () => {
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    store.createSession({ ...record, id: 's_%:x' });
    const journalStore = createEffectJournalStore(client.db, { uuid: () => 'e1', now: () => 0 });
    const correlation = { kind: 'session' as const, sessionId: 'sZZ:x', turn: 99 };
    journalStore.prepare(
      { scope: effectScope(correlation), slot: 0, toolId: 'run_command' },
      correlation,
      { providerAttempt: 1, toolCallId: 'session' },
      3,
      'digest',
    );
    expect(store.reserveEffectTurnKey('s_%:x')).toBe(1);
  });
});
