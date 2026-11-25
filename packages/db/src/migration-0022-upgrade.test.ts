import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
import { createRunHistoryReader } from './run-history-store.js';
import { createRunPinStore } from './run-pins.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
let client: DbClient | undefined, temporary: string | undefined;
afterEach(() => {
  client?.sqlite.close();
  if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
});

/** The legacy run row's columns, in the shape an older writer (the 0021 binary) names them. */
const legacyRunSql =
  'INSERT INTO runs (id, workflow_id, workflow_definition_snapshot, project_root, status, input_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

/** The migrations folder as it stood when 0022 was the newest: 0000 through 0022, with its journal. */
function migrationsThrough0022(): string {
  const folder = join(temporary ?? tmpdir(), 'through-0022');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const metadata = readMigrationFiles({ migrationsFolder });
  const names = readdirSync(migrationsFolder)
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name))
    .sort()
    .slice(0, 23);
  expect(names.at(-1)).toBe('0022_lethal_jackpot.sql');
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
  return folder;
}

/** A database as migration 0021 left it, holding one workflow, three runs and a run's worth of children. */
function openOld(): DbClient {
  temporary = mkdtempSync(join(tmpdir(), 'relavium-migration-0022-'));
  const folder = join(temporary, 'old-migrations');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const metadata = readMigrationFiles({ migrationsFolder });
  const names = readdirSync(migrationsFolder)
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name))
    .sort()
    .slice(0, 22);
  expect(names.at(-1)).toBe('0021_busy_mastermind.sql');
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
  const sqlite = client.sqlite;
  sqlite
    .prepare(
      'INSERT INTO workflows (id, name, slug, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('wf-1', 'Demo', 'demo', '{"legacy":true}', 100, 100);
  const insertRun = sqlite.prepare(legacyRunSql);
  insertRun.run('run-a', 'wf-1', '{"graph":"a"}', '/legacy', 'completed', '{"x":1}', 1000, 1000);
  insertRun.run('run-b', 'wf-1', '{"graph":"b"}', '/legacy', 'failed', '{}', 2000, 2000);
  insertRun.run('run-c', 'wf-1', '{"graph":"c"}', null, 'completed', '{}', 3000, 3000); // never recorded a project
  sqlite
    .prepare(
      'INSERT INTO step_executions (id, run_id, node_id, node_type, attempt_number, status, input_json, output_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run('step-1', 'run-a', 'n1', 'agent', 1, 'completed', '{}', '{"answer":"legacy"}', 1100, 1100);
  sqlite
    .prepare(
      'INSERT INTO run_events (id, run_id, seq, event_type, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('event-1', 'run-a', 0, 'node:started', '{"type":"node:started"}', 1100);
  sqlite
    .prepare(
      'INSERT INTO run_costs (id, run_id, node_id, input_tokens, output_tokens, cost_microcents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run('cost-1', 'run-a', 'n1', 5, 6, 700, 1200);
  sqlite
    .prepare(
      'INSERT INTO run_leases (run_id, owner_id, generation, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('run-b', 'owner-1', 2, 99_999, 2000, 2000);
  return client;
}

const dumpOf = (opened: DbClient): Record<string, unknown[]> =>
  Object.fromEntries(
    ['workflows', 'runs', 'step_executions', 'run_events', 'run_costs', 'run_leases'].map(
      (table) => [table, opened.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()],
    ),
  );

const schemaOf = (opened: DbClient): unknown[] =>
  opened.sqlite
    .prepare(
      "SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();

describe('migration 0022 — run_pins and the project-scoped runs index (ADR-0140 §4)', () => {
  it('is purely additive: one table and one index, and no statement that rebuilds an existing table', () => {
    const file = readdirSync(migrationsFolder).find((name) => /^0022_.*\.sql$/u.test(name));
    expect(file).toBeDefined();
    const statements = readFileSync(join(migrationsFolder, file ?? ''), 'utf8')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim());
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE `run_pins` \(/u);
    expect(statements[1]).toMatch(/^CREATE INDEX `idx_runs_project_created` ON `runs`/u);
    for (const statement of statements)
      expect(statement).not.toMatch(/\b(DROP|RENAME|ALTER)\b|__new_/iu);
  });

  it('keeps every legacy row byte-identical and every existing schema object where it was', () => {
    const opened = openOld();
    const rows = dumpOf(opened);
    const before = schemaOf(opened);
    // Through 0022 only: this pins what 0022 does to an existing schema, and a later additive migration (0023 adds columns to
    // `session_messages`, which rewrites that table's stored SQL text in place) is not 0022's doing.
    migrate(opened.db, { migrationsFolder: migrationsThrough0022() });
    expect(dumpOf(opened)).toEqual(rows);
    // Nothing that existed moved: same b-tree root page and same SQL text, so no table was rebuilt.
    const after = schemaOf(opened);
    for (const entry of before) expect(after).toContainEqual(entry);
    // Exactly two objects are new: the table and the index (the PK's automatic index is `sqlite_`-prefixed).
    expect(after).toHaveLength(before.length + 2);
    expect(opened.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(opened.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('creates run_pins with its columns, its composite key and its kind CHECK', () => {
    const opened = openOld();
    migrate(opened.db, { migrationsFolder });
    expect(
      opened.sqlite
        .prepare(
          'SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid',
        )
        .all('run_pins'),
    ).toEqual([
      { name: 'kind', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
      { name: 'project_root', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 2 },
      { name: 'ref', type: 'TEXT', notnull: 1, dflt_value: null, pk: 3 },
      { name: 'pinned_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    ]);
    const insert = opened.sqlite.prepare(
      'INSERT INTO run_pins (kind, project_root, ref, pinned_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('run', '', 'run-a', 1);
    insert.run('workflow', '/legacy', 'demo', 2);
    insert.run('workflow', '/other', 'demo', 3); // the same slug in another project is another pin
    expect(() => insert.run('run', '', 'run-a', 9)).toThrow(/UNIQUE/u); // the key is the identity
    expect(() => insert.run('bogus', '', 'x', 1)).toThrow(/CHECK/u);
    expect(() => insert.run(null, '', 'x', 1)).toThrow(/NOT NULL/u);
    // The empty project root is the column default, which is how a run pin is written by a store that omits it.
    opened.sqlite
      .prepare('INSERT INTO run_pins (kind, ref, pinned_at) VALUES (?, ?, ?)')
      .run('run', 'run-b', 4);
    expect(
      opened.sqlite.prepare("SELECT project_root FROM run_pins WHERE ref = 'run-b'").get(),
    ).toEqual({ project_root: '' });
  });

  it('creates idx_runs_project_created as a partial (project_root, created_at DESC, id DESC) index and fills it from legacy rows', () => {
    const opened = openOld();
    migrate(opened.db, { migrationsFolder });
    const created = opened.sqlite
      .prepare(
        "SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_runs_project_created'",
      )
      .get();
    expect(created).toMatchObject({ tbl_name: 'runs' });
    expect(JSON.stringify(created)).toMatch(/where .*deleted_at.* is null/iu); // a partial index
    expect(
      opened.sqlite
        .prepare(
          'SELECT name, "desc" AS descending FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno',
        )
        .all('idx_runs_project_created'),
    ).toEqual([
      { name: 'project_root', descending: 0 },
      { name: 'created_at', descending: 1 },
      { name: 'id', descending: 1 },
    ]);
    // A legacy row is found through it: the project's runs, newest first, and not the row with no project.
    const reader = createRunHistoryReader(opened.db);
    expect(
      reader.listRunSummaries({ limit: 10, projectRoot: '/legacy' }).map((row) => row.id),
    ).toEqual(['run-b', 'run-a']);
    expect(reader.listRunSummaries({ limit: 10 }).map((row) => row.id)).toEqual([
      'run-c',
      'run-b',
      'run-a',
    ]);
  });

  it('accepts a run written by an older binary after the migration, and the new index stays consistent', () => {
    const opened = openOld();
    migrate(opened.db, { migrationsFolder });
    // An older writer names exactly the 0021 column set and knows nothing of run_pins or the index.
    opened.sqlite
      .prepare(legacyRunSql)
      .run('run-d', 'wf-1', '{"graph":"d"}', '/legacy', 'running', '{}', 4000, 4000);
    opened.sqlite.prepare("UPDATE runs SET status = 'failed' WHERE id = 'run-a'").run();
    opened.sqlite.prepare("UPDATE runs SET deleted_at = 5000 WHERE id = 'run-b'").run();
    opened.sqlite
      .prepare(
        "INSERT INTO runs (id, workflow_id, workflow_definition_snapshot, created_at, updated_at) VALUES ('run-e', 'wf-1', '{}', 6000, 6000)",
      )
      .run();

    const reader = createRunHistoryReader(opened.db);
    expect(
      reader.listRunSummaries({ limit: 10, projectRoot: '/legacy' }).map((row) => row.id),
    ).toEqual(['run-d', 'run-a']);
    expect(reader.loadRunDetail('run-e')).toMatchObject({
      id: 'run-e',
      outputJson: null,
      outputByteLength: null,
      errorJson: null,
      errorByteLength: null,
    });
    // The pin store works on the migrated database, and a pin never touches a run.
    const pins = createRunPinStore(opened.db);
    expect(pins.pinItem({ kind: 'run', projectRoot: '', ref: 'run-d', at: 7000 })).toBe('pinned');
    expect(opened.sqlite.prepare("SELECT status FROM runs WHERE id = 'run-d'").get()).toEqual({
      status: 'running',
    });
    expect(opened.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});
