import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(join(process.argv[2], 'package.json'));
// This process has no keyring replacement hook. Loading the real addon exercises
// native resolution/ABI only: never construct Entry or call any keychain API.
const keyring = require('@napi-rs/keyring');
assert.equal(typeof keyring.Entry, 'function');
const Database = require('better-sqlite3');
const db = new Database(':memory:');
try {
  assert.equal(db.prepare('select 42 as value').get().value, 42);
} finally {
  db.close();
}
const nativeModules = Object.keys(require.cache).filter((path) => path.endsWith('.node'));
assert.ok(
  nativeModules.some((path) => path.includes('keyring')),
  'Actual native keyring binary must load',
);
assert.ok(
  nativeModules.some((path) => path.includes('better_sqlite3')),
  'Actual native SQLite binary must load',
);
process.stdout.write(
  JSON.stringify({
    nativeModules,
    keyring: require.resolve('@napi-rs/keyring'),
    sqlite: require.resolve('better-sqlite3'),
    keyringCapabilityProof: 'actual native binary loaded; Entry export is a function',
    keyringApiObservation:
      'not instrumented; this load-only probe does not construct Entry or invoke credential APIs',
    sqliteValue: 42,
  }) + '\n',
);
