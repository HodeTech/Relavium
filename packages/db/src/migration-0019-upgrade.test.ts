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

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';

import { createClient, type DbClient } from './client.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
let client: DbClient | undefined;
let temporary: string | undefined;
afterEach(() => {
  client?.sqlite.close();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

function openAt0018(): DbClient {
  temporary = mkdtempSync(join(tmpdir(), 'relavium-migration-0019-'));
  const truncated = join(temporary, 'migrations');
  mkdirSync(join(truncated, 'meta'), { recursive: true });
  const metadata = readMigrationFiles({ migrationsFolder });
  const names = readdirSync(migrationsFolder)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort()
    .slice(0, 19);
  expect(names.at(-1)).toBe('0018_windy_rhodey.sql');
  names.forEach((name) => copyFileSync(join(migrationsFolder, name), join(truncated, name)));
  writeFileSync(
    join(truncated, 'meta/_journal.json'),
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
  migrate(client.db, { migrationsFolder: truncated });
  return client;
}

describe('migration 0019 — retained 0018 invocations and portable rebuilt CHECKs', () => {
  it('preserves money and identities, seeds monotonic ordinals and keeps foreign keys enabled', () => {
    const { db, sqlite } = openAt0018();
    sqlite.exec(`
      INSERT INTO agent_sessions (id, agent_slug, created_at, updated_at, total_cost_microcents)
        VALUES ('retained', 'chat', 0, 0, 42), ('empty', 'chat', 0, 0, 17);
      INSERT INTO session_usage_invocations
        (session_id, producer_id, ordinal, dispatch_id, round, chain_attempt, model)
        VALUES ('retained', 'producer', 2, 'dispatch', 0, 1, 'model'),
               ('retained', 'producer', 9, 'dispatch', 1, 2, 'model');
    `);
    migrate(db, { migrationsFolder });
    expect(
      sqlite
        .prepare(
          `SELECT id, total_cost_microcents, usage_invocation_high_water
      FROM agent_sessions ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: 'empty', total_cost_microcents: 17, usage_invocation_high_water: 0 },
      { id: 'retained', total_cost_microcents: 42, usage_invocation_high_water: 9 },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT ordinal, round, chain_attempt, coverage_state
      FROM session_usage_invocations ORDER BY ordinal`,
        )
        .all(),
    ).toEqual([
      { ordinal: 2, round: 0, chain_attempt: 1, coverage_state: 'pending' },
      { ordinal: 9, round: 1, chain_attempt: 2, coverage_state: 'pending' },
    ]);
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(() =>
      sqlite.exec(`UPDATE agent_sessions SET usage_invocation_high_water = 8
      WHERE id = 'retained'`),
    ).toThrow('session_usage_metadata_invalid');
    sqlite.exec(`DELETE FROM agent_sessions WHERE id = 'retained'`);
    expect(sqlite.prepare('SELECT count(*) AS n FROM session_usage_invocations').get()).toEqual({
      n: 0,
    });
    migrate(db, { migrationsFolder });
  });

  it('retains every rebuilt constraint after rename', () => {
    // The installed 3.53 driver also accepts the old SQL. Pin portable syntax as well as
    // native semantics so a future 3.54 driver is not the first place this fails.
    expect(readFileSync(join(migrationsFolder, '0019_regular_stingray.sql'), 'utf8')).not.toContain(
      '"__new_session_usage_invocations".',
    );
    const { db, sqlite } = openAt0018();
    migrate(db, { migrationsFolder });
    sqlite.exec(`INSERT INTO agent_sessions (id, agent_slug, created_at, updated_at)
      VALUES ('s', 'chat', 0, 0)`);
    const insert = sqlite.prepare(`INSERT INTO session_usage_invocations
      (session_id, producer_id, ordinal, dispatch_id, round, chain_attempt, model, coverage_state)
      VALUES ('s', ?, ?, ?, ?, ?, ?, ?)`);
    const valid = ['p', 1, 'd', 0, 1, 'm', 'pending'];
    for (const [index, invalid] of [
      [0, ''],
      [1, 0],
      [2, ''],
      [3, -1],
      [4, 0],
      [5, ''],
      [6, 'complete'],
    ] satisfies [number, string | number][]) {
      const values = [...valid];
      values[index] = invalid;
      expect(() => insert.run(...values)).toThrow(/CHECK constraint failed/);
    }
    insert.run(...valid);
    expect(sqlite.prepare('SELECT count(*) AS n FROM session_usage_invocations').get()).toEqual({
      n: 1,
    });
  });
});
