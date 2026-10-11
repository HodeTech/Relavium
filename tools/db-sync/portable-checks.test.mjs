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

test('multiline CHECKs preserve nested expressions and comments', () => {
  const source = `CONSTRAINT "valid" CHECK(typeof("__new_example"."n") = 'integer'
    /* CHECK("__new_example"."leave_this_comment") */
    and ("__new_example" /* keep */ . "n" > 0));`;
  assert.equal(
    portableRebuildChecks(source),
    `CONSTRAINT "valid" CHECK(typeof("n") = 'integer'
    /* CHECK("__new_example"."leave_this_comment") */
    and ( /* keep */  "n" > 0));`,
  );
});

test('multiline literals containing constraint-like SQL remain byte-identical', () => {
  const source = `CONSTRAINT "literal" CHECK(s <> 'prefix
  CONSTRAINT "embedded" CHECK("__new_example"."n" > 0)
suffix');`;
  assert.equal(portableRebuildChecks(source), source);
});

test('quoted identifiers, unquoted identifiers and escaped literals retain their meaning', () => {
  assert.equal(
    portableRebuildChecks('CHECK(`__new_t`.`n` + [__new_t].[n] + __new_t.n > 0)'),
    'CHECK(`n` + [n] + n > 0)',
  );
  const source = `-- CHECK("__new_t"."n")
SELECT "__new_t"."n"; CHECK("__new_t"."s" <> 'it''s (CHECK)');`;
  assert.equal(
    portableRebuildChecks(source),
    `-- CHECK("__new_t"."n")
SELECT "__new_t"."n"; CHECK("s" <> 'it''s (CHECK)');`,
  );
  assert.throws(
    () => portableRebuildChecks('CHECK("__new_t"."n" > 0'),
    /Malformed generated CHECK/,
  );
  assert.throws(() => portableRebuildChecks('CHECK(n > 0) /*'), /Malformed generated SQL token/);
  assert.throws(
    () => portableRebuildChecks("CHECK(n <> 'unfinished)"),
    /Malformed generated SQL token/,
  );
  assert.equal(portableRebuildChecks('CHECK("__new_my-table"."n" > 0)'), 'CHECK("n" > 0)');
});

test('escaped quote terminators and adjacent CHECK spans preserve exact source bytes', () => {
  const source = `CHECK(coalesce("__new_a"."n", 0) > 0); CHECK([__new_b].[n] > 0);
SELECT 'a''b', "a""b", \`a\`\`b\`, [a]]b]; -- CHECK(__new_t.n)\r
/* CHECK(__new_t.n) */`;
  const expected = source.replace('"__new_a".', '').replace('[__new_b].', '');
  assert.equal(portableRebuildChecks(source), expected);
  for (const unfinished of ["'escaped''", '"escaped""', '`escaped``', '[escaped]]']) {
    assert.throws(() => portableRebuildChecks(unfinished), {
      message: 'Malformed generated SQL token',
    });
  }
});
