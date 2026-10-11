import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';

import { portableRebuildChecks } from './portable-checks.mjs';

test('rebuild CHECKs lose temporary qualifiers without changing literals or foreign keys', () => {
  const source = `CREATE TABLE \`__new_example\` (
  FOREIGN KEY ("owner") REFERENCES "owners"("id"),
  CONSTRAINT "valid" CHECK(typeof("__new_example"."n") = 'integer' and "__new_example"."n" > 0),
  CONSTRAINT "text" CHECK("__new_example"."s" <> 'it''s "__new_example"."n"')
);`;
  const expected = `CREATE TABLE \`__new_example\` (
  FOREIGN KEY ("owner") REFERENCES "owners"("id"),
  CONSTRAINT "valid" CHECK(typeof("n") = 'integer' and "n" > 0),
  CONSTRAINT "text" CHECK("s" <> 'it''s "__new_example"."n"')
);`;
  assert.equal(portableRebuildChecks(source), expected);
  assert.equal(portableRebuildChecks(expected), expected);
});

test('the committed rebuild is already portable and retains all seven CHECKs', () => {
  const source = readFileSync(
    new URL('../../packages/db/drizzle/0019_regular_stingray.sql', import.meta.url),
    'utf8',
  );
  assert.equal(portableRebuildChecks(source), source);
  assert.equal((source.match(/\bCHECK\(/g) ?? []).length, 7);
});

test('every committed migration already has portable rebuild CHECKs', () => {
  const directory = new URL('../../packages/db/drizzle/', import.meta.url);
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql'))) {
    const source = readFileSync(new URL(name, directory), 'utf8');
    assert.equal(portableRebuildChecks(source), source, name);
  }
});
