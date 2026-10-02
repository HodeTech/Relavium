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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { createEffectJournalStore } from './effect-journal-store.js';
import { agentSessions } from './schema.js';
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

describe('durable session effect-turn high-water mark (ADR-0098)', () => {
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
  });

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
    journalStore.sweepCommittedForSession('s1', 100);
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
