import {
  copyFileSync,
  existsSync,
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

import { effectScope, type EffectCorrelation } from '@relavium/shared';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { createEffectJournalStore } from './effect-journal-store.js';
import { agentSessions, runEffects } from './schema.js';
import {
  checkpointSessionEffectPrivacy,
  SessionEffectPrivacyError,
} from './session-effect-privacy.js';
import { createSessionStore } from './session-store.js';

const TOKEN = 'SYNTHETIC_SESSION_RESULT_PRIVATE_0098_7e482d';
let root: string;
let client: DbClient;
let count: number;
const journal = () =>
  createEffectJournalStore(client.db, { uuid: () => `effect-${String(++count)}`, now: () => 1 });
function planted(
  turn: number,
  state: 'prepared' | 'committed' | 'ambiguous' = 'committed',
  sessionId = 'orphan',
) {
  const correlation: EffectCorrelation = { kind: 'session', sessionId, turn };
  const identity = { scope: effectScope(correlation), slot: 0, toolId: 'run_command' };
  journal().prepare(
    identity,
    correlation,
    { providerAttempt: 1, toolCallId: 'session' },
    3,
    'digest',
    'target-key',
  );
  if (state !== 'prepared') journal().settle(identity, state);
  // Simulate PRE-upgrade data or a hostile older writer. The new writer cannot retain a session result.
  client.db
    .update(runEffects)
    .set({ resultJson: JSON.stringify({ result: `${TOKEN}${'x'.repeat(8192)}` }) })
    .where(eq(runEffects.scope, identity.scope))
    .run();
  return identity;
}
function bytesContainToken(): boolean {
  return [client.path, `${client.path}-wal`].some(
    (path) => existsSync(path) && readFileSync(path).includes(Buffer.from(TOKEN)),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-session-privacy-'));
  client = createClient(join(root, 'history.db'));
  count = 0;
  client.sqlite.pragma('wal_autocheckpoint = 0');
});
afterEach(() => {
  vi.restoreAllMocks();
  client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

describe('session-effect logical and physical privacy (ADR-0098)', () => {
  it('opens with secure deletion and reports the in-memory checkpoint correctly', () => {
    expect(client.sqlite.pragma('secure_delete', { simple: true })).toBe(1);
    const memory = createClient();
    try {
      expect(runMigrations(memory.db)).toBe('complete');
    } finally {
      memory.sqlite.close();
    }
  });

  it('clears EVERY legacy session result, including unresolved and hidden one-shot rows, preserving run results and all other fields', () => {
    runMigrations(client.db);
    createSessionStore(client.db).reserveOneShotEffectTurnKey('once', 1);
    planted(9);
    planted(10, 'prepared');
    planted(11, 'ambiguous');
    planted(1, 'committed', 'once');
    const run: EffectCorrelation = { kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 1 };
    const runId = { scope: effectScope(run), slot: 0, toolId: 'run_command' };
    journal().prepare(runId, run, { providerAttempt: 1, toolCallId: 'provider' }, 3, 'run digest');
    journal().settle(runId, 'committed', { result: 'run replay survives' });
    const before = client.db.select().from(runEffects).all();
    expect(bytesContainToken()).toBe(true);
    expect(runMigrations(client.db)).toBe('complete');
    expect(client.db.select().from(runEffects).all()).toEqual(
      before.map((row) => (row.scope.startsWith('session:') ? { ...row, resultJson: null } : row)),
    );
    expect(
      journal().prepare(
        runId,
        run,
        { providerAttempt: 2, toolCallId: 'provider2' },
        3,
        'run digest',
      ),
    ).toEqual({ outcome: 'replay', result: { result: 'run replay survives' } });
    expect(bytesContainToken()).toBe(false); // Connection remains OPEN: close cannot be the erasure mechanism.
  });

  it.each(['committed', 'ambiguous'] as const)(
    'does not inspect a %s session result and leaves no payload bytes',
    (state) => {
      runMigrations(client.db);
      const correlation: EffectCorrelation = { kind: 'session', sessionId: 's1', turn: 1 };
      const id = { scope: effectScope(correlation), slot: 0, toolId: 'run_command' };
      journal().prepare(
        id,
        correlation,
        { providerAttempt: 1, toolCallId: 'session-tool:1:0' },
        3,
        'digest',
      );
      const toJSON = vi.fn(() => {
        throw new Error(TOKEN);
      });
      journal().settle(id, state, { token: TOKEN, toJSON });
      expect(toJSON).not.toHaveBeenCalled();
      expect(client.db.select().from(runEffects).get()?.resultJson).toBeNull();
      expect(bytesContainToken()).toBe(false);
    },
  );

  it('erases planted post-upgrade payload bytes after each session sweep, not just on open', () => {
    runMigrations(client.db);
    planted(1);
    expect(bytesContainToken()).toBe(true);
    const snapshot = journal().readSessionDisclosureSnapshot('orphan');
    expect(journal().sweepCommittedForSession('orphan', snapshot.committed)).toEqual({
      deleted: 1,
      checkpoint: 'complete',
    });
    expect(client.sqlite.open).toBe(true);
    expect(bytesContainToken()).toBe(false);
  });

  it('reports a busy reader as DEFERRED and retries physical erasure on an EMPTY later sweep', () => {
    runMigrations(client.db);
    planted(1);
    expect(checkpointSessionEffectPrivacy(client.db)).toBe('complete');
    expect(readFileSync(client.path).includes(Buffer.from(TOKEN))).toBe(true);
    const reader = createClient(client.path);
    reader.sqlite.exec('BEGIN');
    reader.sqlite.prepare('SELECT * FROM run_effects').all();
    // Keep this adversarial test finite: production retains its existing 5-second busy timeout.
    client.sqlite.pragma('busy_timeout = 0');
    try {
      expect(runMigrations(client.db)).toBe('deferred');
      expect(client.db.select().from(runEffects).get()?.resultJson).toBeNull();
      expect(bytesContainToken()).toBe(true);
      reader.sqlite.exec('ROLLBACK');
      expect(journal().sweepCommittedForSession('orphan', []).checkpoint).toBe('complete');
      expect(bytesContainToken()).toBe(false);
    } finally {
      if (reader.sqlite.inTransaction) reader.sqlite.exec('ROLLBACK');
      reader.sqlite.close();
    }
  });

  it('seeds the high-water key from a real 0016 database BEFORE clearing legacy results', () => {
    const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
    const legacyDir = join(root, 'legacy');
    mkdirSync(join(legacyDir, 'meta'), { recursive: true });
    for (const name of readdirSync(migrations)) {
      if (/^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 16)
        copyFileSync(join(migrations, name), join(legacyDir, name));
    }
    const metadata: unknown = JSON.parse(
      readFileSync(join(migrations, 'meta/_journal.json'), 'utf8'),
    );
    if (
      metadata === null ||
      typeof metadata !== 'object' ||
      !('entries' in metadata) ||
      !Array.isArray(metadata.entries)
    )
      throw new Error('invalid migration metadata');
    const entries: readonly unknown[] = metadata.entries;
    writeFileSync(
      join(legacyDir, 'meta/_journal.json'),
      JSON.stringify({
        ...metadata,
        entries: entries.filter(
          (entry) =>
            entry !== null &&
            typeof entry === 'object' &&
            'idx' in entry &&
            typeof entry.idx === 'number' &&
            entry.idx <= 16,
        ),
      }),
    );
    migrate(client.db, { migrationsFolder: legacyDir });
    client.sqlite.exec(
      "INSERT INTO agent_sessions (id, agent_slug, context_json, created_at, updated_at) VALUES ('s1', 'chatter', '{}', 0, 0)",
    );
    planted(17, 'committed', 's1');
    expect(runMigrations(client.db)).toBe('complete');
    expect(
      client.db.select({ highWater: agentSessions.effectTurnHighWater }).from(agentSessions).get()
        ?.highWater,
    ).toBe(17);
    expect(client.db.select().from(runEffects).get()?.resultJson).toBeNull();
    const snapshot = journal().readSessionDisclosureSnapshot('s1');
    journal().sweepCommittedForSession('s1', snapshot.committed);
    expect(createSessionStore(client.db).reserveEffectTurnKey('s1')).toBe(18);
    expect(bytesContainToken()).toBe(false);
  });

  it('refuses an unexpected checkpoint response or driver failure with a fixed safe error', () => {
    runMigrations(client.db);
    const pragma = vi.spyOn(client.sqlite, 'pragma').mockReturnValue([]);
    expect(() => checkpointSessionEffectPrivacy(client.db)).toThrow(SessionEffectPrivacyError);
    pragma.mockReturnValue([{ busy: 0, log: 4, checkpointed: 2 }]);
    expect(() => checkpointSessionEffectPrivacy(client.db)).toThrow(SessionEffectPrivacyError);
    pragma.mockImplementation(() => {
      throw new Error(TOKEN);
    });
    expect(() => checkpointSessionEffectPrivacy(client.db)).toThrow(
      'session effect WAL checkpoint failed',
    );
  });
});
