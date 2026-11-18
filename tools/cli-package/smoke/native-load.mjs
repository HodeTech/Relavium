import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { writeSync } from 'node:fs';
import { NATIVE_LOAD_DIAGNOSTIC_PREFIX, nativeAssetLinks } from './failure-diagnostic.mjs';
const require = createRequire(join(process.argv[2], 'package.json'));
let stage = 'keyring-load';
let loaderOutcome = 'not-attempted';
const assets = nativeAssetLinks(process.argv[2]);
try {
  // This process has no keyring replacement hook. Loading the real addon exercises
  // native resolution/ABI only: never construct Entry or call any keychain API.
  const keyring = require('@napi-rs/keyring');
  stage = 'keyring-export';
  assert.equal(typeof keyring.Entry, 'function');
  stage = 'sqlite-load';
  const Database = require('better-sqlite3');
  stage = 'metadata-loader';
  const metadataLoader = join(process.argv[2], 'dist/native-fs/loader.cjs');
  let loader;
  try {
    loader = require(metadataLoader);
  } catch (error) {
    loaderOutcome = 'other';
    throw error;
  }
  stage = 'metadata-load';
  let metadata;
  try {
    metadata = loader.loadFsMetadataAddon();
    loaderOutcome = 'success';
  } catch (error) {
    loaderOutcome =
      error instanceof Error && error.message === 'NATIVE_FS_ASSET_UNAVAILABLE'
        ? 'refusal'
        : 'other';
    throw error;
  }
  stage = 'metadata-protocol';
  assert.equal(typeof metadata.protocolVersion, 'function');
  assert.equal(metadata.protocolVersion(), 1);
  stage = 'sqlite-open';
  const db = new Database(':memory:');
  try {
    stage = 'sqlite-query';
    assert.equal(db.prepare('select 42 as value').get().value, 42);
  } finally {
    db.close();
  }
  stage = 'native-cache';
  const nativeModules = Object.keys(require.cache).filter((path) => path.endsWith('.node'));
  assert.ok(
    nativeModules.some((path) => path.includes('keyring')),
    'Actual native keyring binary must load',
  );
  assert.ok(
    nativeModules.some((path) => path.includes('better_sqlite3')),
    'Actual native SQLite binary must load',
  );
  assert.ok(
    nativeModules.some((path) => path.includes('native-fs')),
    'Actual metadata binary must coexist with SQLite and keyring',
  );
  process.stdout.write(
    JSON.stringify({
      nativeModules,
      keyring: require.resolve('@napi-rs/keyring'),
      sqlite: require.resolve('better-sqlite3'),
      metadataLoader,
      metadataProtocol: 1,
      metadataCapabilityProof: 'native protocol v1 only; no filesystem profile acceptance',
      keyringCapabilityProof: 'actual native binary loaded; Entry export is a function',
      keyringApiObservation:
        'not instrumented; this load-only probe does not construct Entry or invoke credential APIs',
      sqliteValue: 42,
    }) + '\n',
  );
} catch (error) {
  // Secondary, bounded and content-free: never relay an exception or path.
  try {
    writeSync(
      2,
      NATIVE_LOAD_DIAGNOSTIC_PREFIX + JSON.stringify({ stage, loaderOutcome, assets }) + '\n',
    );
  } catch {
    // The original error remains primary if the diagnostic sink is unavailable.
  }
  throw error;
}
