// A separate native writer sends SIGINT only to its explicitly verified spawning test worker.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from '@relavium/db';

const [database, directory, parentPid, interrupt, holdMs] = process.argv.slice(2);
assert.ok(database && directory && parentPid && holdMs);
assert.equal(Number(parentPid), process.ppid);
assert.ok(interrupt === 'true' || interrupt === 'false');
assert.ok(holdMs === '1200' || holdMs === '5500');
/** @param {string} name */
const waitFor = async (name) => {
  const deadline = Date.now() + 10000;
  while (!existsSync(join(directory, name))) {
    assert.ok(Date.now() < deadline, 'bounded writer readiness timeout');
    await sleep(10);
  }
};
const client = createClient(database);
try {
  await waitFor('native-write-ready');
  client.sqlite.exec('BEGIN IMMEDIATE');
  writeFileSync(join(directory, 'native-writer-locked'), 'locked');
  await waitFor('native-write-enter');
  if (interrupt === 'true') {
    await sleep(200);
    process.kill(Number(parentPid), 'SIGINT');
    writeFileSync(join(directory, 'native-signal-sent'), String(Date.now()));
  }
  await sleep(Number(holdMs));
  client.sqlite.exec('COMMIT');
  writeFileSync(join(directory, 'native-writer-released'), String(Date.now()));
} finally {
  if (client.sqlite.inTransaction) client.sqlite.exec('ROLLBACK');
  client.sqlite.close();
}
