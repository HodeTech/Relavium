import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

// An external watchdog can stop synchronous backtracking; an in-process test timer cannot.
function runScanner(script, cwd, expected = 'positive\nrefused\n') {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    shell: false,
  });
  assert.equal(result.error, undefined, result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, expected);
}

test('generated-SQL scanning promptly refuses repeated unterminated comment openers', () => {
  const helper = new URL('./portable-checks.mjs', import.meta.url).href;
  runScanner(`
    import assert from 'node:assert/strict';
    import { portableRebuildChecks } from ${JSON.stringify(helper)};
    const padding = '/* x '.repeat(200_000);
    const valid = '/*' + padding + '*/ CHECK("__new_t"."n" > 0)';
    assert.equal(portableRebuildChecks(valid), '/*' + padding + '*/ CHECK("n" > 0)');
    console.log('positive');
    assert.throws(() => portableRebuildChecks(padding), { message: 'Malformed generated SQL token' });
    console.log('refused');
  `);
});

test('actual native trigger inventory accepts long valid padding and still refuses missing columns', () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), 'relavium-trigger-scanner-'));
  try {
    mkdirSync(join(scratch, 'fixtures'));
    writeFileSync(join(scratch, 'package.json'), '{"type":"module"}');
    symlinkSync(
      join(repository, 'packages/db/node_modules'),
      join(scratch, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    // Compile the current actual source, never a stale dist helper or a copied regex.
    for (const name of ['schema', 'fixtures/session-usage-column-inventory']) {
      const source = readFileSync(join(repository, 'packages/db/src', `${name}.ts`), 'utf8');
      const compiled = transpileModule(source, {
        compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
      });
      writeFileSync(join(scratch, `${name}.js`), compiled.outputText);
    }
    const helper = pathToFileURL(join(scratch, 'fixtures/session-usage-column-inventory.js')).href;
    const schema = pathToFileURL(join(scratch, 'schema.js')).href;
    runScanner(
      `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { getTableColumns } from 'drizzle-orm';
      import { agentSessions } from ${JSON.stringify(schema)};
      import { assertSessionUsageColumnInventory, sessionBusinessColumns } from ${JSON.stringify(helper)};
      const Database = createRequire(${JSON.stringify(pathToFileURL(join(scratch, 'package.json')).href)})('better-sqlite3');
      const db = new Database(':memory:');
      try {
        const names = Object.values(getTableColumns(agentSessions)).map(column => column.name);
        db.exec('CREATE TABLE agent_sessions (' + names.map(name => '"' + name + '" TEXT').join(',') + ')');
        const padding = ' '.repeat(1_000_000);
        const trigger = columns => 'CREATE TRIGGER session_usage_owner_update AFTER UPDATE OF ' +
          columns.join(padding + ',') + ' ON agent_sessions BEGIN SELECT 1; END';
        const valid = trigger(sessionBusinessColumns);
        db.exec(valid);
        assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='session_usage_owner_update'").get().sql, valid);
        console.log('native-ready');
        assertSessionUsageColumnInventory(db);
        console.log('positive');
        db.exec('DROP TRIGGER session_usage_owner_update');
        db.exec(trigger(sessionBusinessColumns.slice(1)));
        assert.throws(() => assertSessionUsageColumnInventory(db), { message: 'SESSION_USAGE_TRIGGER_COLUMN_DRIFT' });
        console.log('refused');
      } finally { db.close(); }
    `,
      scratch,
      'native-ready\npositive\nrefused\n',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
