import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient, type DbClient } from './client.js';
import { ERROR_CODES } from '@relavium/shared';
import { createSessionStore, SessionMessageBoundaryError } from './session-store.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
let client: DbClient | undefined, temporary: string | undefined;
afterEach(() => {
  client?.sqlite.close();
  if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
});

/** A database as migration 0020 left it, holding one legacy session. */
function openOld(): DbClient {
  temporary = mkdtempSync(join(tmpdir(), 'relavium-migration-0021-'));
  const folder = join(temporary, 'old-migrations');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const metadata = readMigrationFiles({ migrationsFolder });
  const names = readdirSync(migrationsFolder)
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name))
    .sort()
    .slice(0, 21);
  expect(names.at(-1)).toBe('0020_cultured_pet_avengers.sql');
  for (const name of names) copyFileSync(join(migrationsFolder, name), join(folder, name));
  writeFileSync(
    join(folder, 'meta/_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: names.map((name, idx) => ({
        idx,
        version: '6',
        when: metadata[idx]?.folderMillis,
        tag: name.slice(0, -4),
        breakpoints: true,
      })),
    }),
  );
  client = createClient(join(temporary, 'history.db'));
  migrate(client.db, { migrationsFolder: folder });
  client.sqlite
    .prepare(
      'INSERT INTO agent_sessions (id, agent_slug, working_dir, fs_scope_tier, context_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      'legacy',
      'chat',
      '/workspace',
      'project',
      JSON.stringify({ workingDir: '/workspace', fsScopeTier: 'project' }),
      0,
      0,
    );
  return client;
}

const insertSql =
  'INSERT INTO session_messages (id, session_id, sequence_number, role, content_parts, compaction_dropped_through_sequence, interruption_reason, interruption_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';

describe('migration 0021 — interruption rows (ADR-0119)', () => {
  it('keeps every legacy row byte-identical, with NULL interruption columns, and an older writer still works', () => {
    const opened = openOld();
    const text = JSON.stringify([{ type: 'text', text: 'legacy private context' }]);
    opened.sqlite
      .prepare(
        'INSERT INTO session_messages (id, session_id, sequence_number, role, content_parts, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('old-user', 'legacy', 0, 'user', text, 0);
    opened.sqlite
      .prepare(
        'INSERT INTO session_messages (id, session_id, sequence_number, role, content_parts, compaction_dropped_through_sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('old-marker', 'legacy', 1, 'system', '[]', 0, 0);
    // The reason the migration is hand-written: the table keeps its triggers (ADR-0104) and its b-tree root page.
    const schemaOf = () =>
      opened.sqlite
        .prepare(
          "SELECT type, name, rootpage FROM sqlite_master WHERE tbl_name = 'session_messages' ORDER BY type, name",
        )
        .all();
    const before = schemaOf();
    expect(before.some((entry) => (entry as { type: string }).type === 'trigger')).toBe(true);
    migrate(opened.db, { migrationsFolder });
    expect(schemaOf()).toEqual(before);
    expect(
      opened.sqlite
        .prepare(
          'SELECT id, content_parts, compaction_dropped_through_sequence AS c, interruption_reason AS r, interruption_code AS k FROM session_messages ORDER BY sequence_number',
        )
        .all(),
    ).toEqual([
      { id: 'old-user', content_parts: text, c: null, r: null, k: null },
      { id: 'old-marker', content_parts: '[]', c: 0, r: null, k: null },
    ]);
    // An older binary names only the old column set.
    opened.sqlite
      .prepare(
        'INSERT INTO session_messages (id, session_id, sequence_number, role, content_parts, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('old-writer', 'legacy', 2, 'user', text, 0);
    const store = createSessionStore(opened.db);
    expect(store.loadMessages('legacy').map((row) => row.id)).toEqual([
      'old-user',
      'old-marker',
      'old-writer',
    ]);
    expect(
      opened.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_session_messages_%' ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: 'idx_session_messages_seq' }, { name: 'idx_session_messages_session' }]);
  });

  it('stores a valid interruption row and refuses every forged shape at rest', () => {
    const opened = openOld();
    migrate(opened.db, { migrationsFolder });
    const insert = opened.sqlite.prepare(insertSql);
    let sequence = 0;
    const add = (
      role: string,
      compaction: number | null,
      reason: string | null,
      code: string | null,
    ): void => {
      insert.run(`m-${sequence}`, 'legacy', sequence++, role, '[]', compaction, reason, code, 0);
    };
    // valid
    add('system', null, 'aborted', null);
    add('system', null, 'denied', null);
    add('system', null, 'turn_limit', null);
    add('system', null, 'failed', 'tool_failed');
    add('user', null, null, null);
    // forged
    expect(() => add('system', null, 'cancelled', null)).toThrow(/CHECK/u); // unknown reason
    expect(() => add('system', null, 'failed', 'not_a_code')).toThrow(/CHECK/u); // unknown code
    expect(() => add('system', null, 'failed', null)).toThrow(/CHECK/u); // failed without its code
    expect(() => add('system', null, 'aborted', 'tool_failed')).toThrow(/CHECK/u); // a code on a non-failed reason
    expect(() => add('user', null, 'aborted', null)).toThrow(/CHECK/u); // not a system row
    expect(() => add('assistant', null, 'denied', null)).toThrow(/CHECK/u); // not a system row
    expect(() => add('system', 3, 'aborted', null)).toThrow(/CHECK/u); // also a boundary marker
    expect(() => add('system', null, null, 'tool_failed')).toThrow(/CHECK/u); // a code with no reason
    // An interruption row carries no content: the database refuses text on it, not only the schema.
    expect(() =>
      insert.run(
        'forged-content',
        'legacy',
        sequence,
        'system',
        JSON.stringify([{ type: 'text', text: 'injected' }]),
        null,
        'aborted',
        null,
        0,
      ),
    ).toThrow(/CHECK/u);
  });

  it('accepts every error code the closed taxonomy can put on a failed interruption (the CHECK list cannot drift)', () => {
    const opened = openOld();
    migrate(opened.db, { migrationsFolder });
    const store = createSessionStore(opened.db);
    // The migration enumerates the codes; a code added to ERROR_CODES without a new migration would pass the schema and
    // fail this CHECK, latching a durability failure in a live session.
    for (const [index, code] of ERROR_CODES.entries())
      expect(() =>
        store.appendMessage({
          id: `code-${code}`,
          sessionId: 'legacy',
          sequenceNumber: index,
          role: 'system',
          content: [],
          interruption: { reason: 'failed', code },
          timestamp: '2026-11-16T00:00:00.000Z',
        }),
      ).not.toThrow();
    expect(store.loadMessages('legacy')).toHaveLength(ERROR_CODES.length);
  });

  it('round-trips an interruption row through the session store and refuses a forged one on read', () => {
    const opened = openOld();
    migrate(opened.db, { migrationsFolder });
    const store = createSessionStore(opened.db);
    store.appendMessage({
      id: 'marker',
      sessionId: 'legacy',
      sequenceNumber: 0,
      role: 'system',
      content: [],
      interruption: { reason: 'failed', code: 'provider_unavailable' },
      timestamp: '2026-11-16T00:00:00.000Z',
    });
    expect(store.loadMessages('legacy')[0]).toMatchObject({
      role: 'system',
      content: [],
      interruption: { reason: 'failed', code: 'provider_unavailable' },
    });
    // the store refuses an invalid value at its own boundary, before the database
    expect(() =>
      store.appendMessage({
        id: 'forged',
        sessionId: 'legacy',
        sequenceNumber: 1,
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
        interruption: { reason: 'aborted' },
        timestamp: '2026-11-16T00:00:00.000Z',
      }),
    ).toThrow(SessionMessageBoundaryError);
  });

  it('refuses to load a session whose row was tampered with past the database CHECKs', () => {
    const opened = openOld();
    migrate(opened.db, { migrationsFolder });
    const store = createSessionStore(opened.db);
    // Whoever can edit history.db can switch the CHECKs off; the read side must still fail closed, with a fixed error
    // that does not echo the stored text.
    opened.sqlite.pragma('ignore_check_constraints = ON');
    opened.sqlite
      .prepare(insertSql)
      .run(
        'tampered',
        'legacy',
        0,
        'system',
        JSON.stringify([{ type: 'text', text: 'SECRET-INJECTED-TEXT' }]),
        null,
        'aborted',
        null,
        0,
      );
    opened.sqlite.pragma('ignore_check_constraints = OFF');
    let refusal: unknown;
    try {
      store.loadMessages('legacy');
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SessionMessageBoundaryError);
    expect(String((refusal as Error).message)).not.toContain('SECRET-INJECTED-TEXT');
  });
});
