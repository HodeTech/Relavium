import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test(
  'the actual generation entrypoint preserves multiline constraint meaning and history',
  { timeout: 30_000 },
  () => {
    const repository = fileURLToPath(new URL('../../', import.meta.url));
    const scratch = mkdtempSync(join(tmpdir(), 'relavium-db-generation-'));
    const packageRoot = join(scratch, 'packages/db');
    const migrations = join(packageRoot, 'drizzle');
    const tools = join(scratch, 'tools/db-sync');
    const forbidden = 'prefix\n  CONSTRAINT "embedded" CHECK("__new_example"."n" > 0)\nsuffix';
    const schema = (updated) => `
    import { sql } from 'drizzle-orm';
    import { sqliteTable, integer, text, check } from 'drizzle-orm/sqlite-core';
    export const example = sqliteTable('example', { n: integer('n').notNull(), s: text('s').notNull() },
      (t) => [check('valid', sql\`typeof(\${t.n}) = 'integer'${updated ? '\n and' : ' and'} \${t.n} > ${updated ? '0' : '-1'}\`),
        check('literal', sql.raw(${JSON.stringify(`s <> '${updated ? forbidden : 'old'}'`)}))]);
  `;
    const generate = () => {
      const result = spawnSync(process.execPath, [join(tools, 'generate.mjs')], {
        cwd: packageRoot,
        encoding: 'utf8',
        timeout: 10_000,
        shell: false,
      });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    };
    const history = () =>
      new Map(
        readdirSync(migrations)
          .filter((name) => name.endsWith('.sql'))
          .map((name) => [name, readFileSync(join(migrations, name), 'utf8')]),
      );
    let db;
    try {
      mkdirSync(migrations, { recursive: true });
      mkdirSync(tools, { recursive: true });
      for (const name of ['generate.mjs', 'portable-checks.mjs'])
        cpSync(new URL(name, import.meta.url), join(tools, name));
      symlinkSync(
        join(repository, 'packages/db/node_modules'),
        join(packageRoot, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      writeFileSync(join(packageRoot, 'package.json'), '{"type":"module"}');
      writeFileSync(
        join(packageRoot, 'drizzle.config.ts'),
        "export default { dialect: 'sqlite', schema: './schema.ts', out: './drizzle' };",
      );
      writeFileSync(join(packageRoot, 'schema.ts'), schema(false));
      generate();
      const original = history();
      const snapshot = readFileSync(join(migrations, 'meta/0000_snapshot.json'));
      const journal = JSON.parse(readFileSync(join(migrations, 'meta/_journal.json'), 'utf8'));
      writeFileSync(join(packageRoot, 'schema.ts'), schema(true));
      generate();
      const all = history();
      assert.equal(all.size, 2);
      for (const [name, bytes] of original) assert.equal(all.get(name), bytes);
      assert.deepEqual(readFileSync(join(migrations, 'meta/0000_snapshot.json')), snapshot);
      const currentJournal = JSON.parse(
        readFileSync(join(migrations, 'meta/_journal.json'), 'utf8'),
      );
      assert.deepEqual(currentJournal.entries.slice(0, journal.entries.length), journal.entries);
      const Database = createRequire(join(repository, 'packages/db/package.json'))(
        'better-sqlite3',
      );
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      for (const bytes of all.values()) db.transaction(() => db.exec(bytes))();
      const insert = db.prepare('INSERT INTO example (n, s) VALUES (?, ?)');
      assert.throws(() => insert.run(1, forbidden), /CHECK constraint failed: literal/);
      insert.run(1, forbidden.replace('"__new_example".', ''));
      assert.throws(() => insert.run(0, 'valid text'), /CHECK constraint failed: valid/);
      assert.equal(db.prepare('SELECT count(*) AS n FROM example').get().n, 1);
      const rebuilt = [...all.values()].at(-1);
      assert.ok(rebuilt.includes('CHECK(typeof("n")'));
      assert.ok(rebuilt.includes(forbidden));
      generate();
      assert.deepEqual(history(), all);
      const manifest = JSON.parse(
        readFileSync(join(repository, 'packages/db/package.json'), 'utf8'),
      );
      assert.equal(manifest.scripts['db:generate'], 'node ../../tools/db-sync/generate.mjs');
    } finally {
      db?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
