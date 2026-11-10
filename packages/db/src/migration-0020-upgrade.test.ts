import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient, type DbClient } from './client.js';
import { createSessionStore } from './session-store.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
let client: DbClient | undefined, temporary: string | undefined;
afterEach(() => {
  client?.sqlite.close();
  if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
});

function openOld(): DbClient {
  temporary = mkdtempSync(join(tmpdir(), 'relavium-migration-0020-'));
  const folder = join(temporary, 'old-migrations');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const metadata = readMigrationFiles({ migrationsFolder });
  const names = readdirSync(migrationsFolder)
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name))
    .sort()
    .slice(0, 20);
  expect(names.at(-1)).toBe('0019_regular_stingray.sql');
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

describe('migration 0020 — independent host display metadata and scoped discovery', () => {
  it('leaves legacy bytes/identity intact and supports an older writer after upgrade', () => {
    const opened = openOld();
    const insert = opened.sqlite.prepare(
      'INSERT INTO session_messages (id, session_id, sequence_number, role, content_parts, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const original = JSON.stringify([{ type: 'text', text: 'legacy expanded private context' }]);
    insert.run('old-user', 'legacy', 0, 'user', original, 0);
    migrate(opened.db, { migrationsFolder });
    expect(
      opened.sqlite
        .prepare('SELECT id, content_parts, user_display_text FROM session_messages')
        .get(),
    ).toEqual({ id: 'old-user', content_parts: original, user_display_text: null });
    // This statement names the old column set, exactly as an older binary does.
    opened.sqlite
      .prepare(
        'INSERT INTO session_messages (id, session_id, sequence_number, role, content_parts, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        'old-answer',
        'legacy',
        1,
        'assistant',
        JSON.stringify([{ type: 'text', text: 'answer' }]),
        0,
      );
    const store = createSessionStore(opened.db);
    expect(store.loadMessages('legacy').map((row) => row.id)).toEqual(['old-user', 'old-answer']);
    expect(store.loadUserDisplayTexts('legacy', [0, 1]).size).toBe(0);
    expect(
      opened.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_sessions_working_dir_updated'",
        )
        .get(),
    ).toEqual({ name: 'idx_agent_sessions_working_dir_updated' });
  });

  it('lets a new writer add display metadata without backfilling old rows', () => {
    const opened = openOld();
    opened.sqlite
      .prepare(
        'INSERT INTO session_messages (id, session_id, sequence_number, role, content_parts, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        'legacy-user',
        'legacy',
        0,
        'user',
        JSON.stringify([{ type: 'text', text: 'legacy private context' }]),
        0,
      );
    migrate(opened.db, { migrationsFolder });
    const store = createSessionStore(opened.db);
    store.appendMessage(
      {
        id: 'new-user',
        sessionId: 'legacy',
        sequenceNumber: 1,
        role: 'user',
        content: [{ type: 'text', text: 'new expanded context' }],
        timestamp: '2026-11-10T00:00:00.000Z',
      },
      { userDisplayText: 'new compact prompt' },
    );
    expect([...store.loadUserDisplayTexts('legacy', [0, 1])]).toEqual([[1, 'new compact prompt']]);
    expect(store.loadMessages('legacy')[0]?.content).toEqual([
      { type: 'text', text: 'legacy private context' },
    ]);
    expect(store.loadMessages('legacy')[1]?.content).toEqual([
      { type: 'text', text: 'new expanded context' },
    ]);
  });
});
