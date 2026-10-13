import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnJoined } from './process.mjs';
test('joins a normal process with complete output', async () => {
  const result = await spawnJoined(
    process.execPath,
    ['-e', "process.stdout.write('complete')"],
    {},
    5000,
  );
  assert.equal(result.code, 0);
  assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'complete');
  assert.equal(result.joined, true);
  assert.equal(result.timedOut, false);
});
test('timeout kills and joins the owned runner rather than counting a red result', async () => {
  const result = await spawnJoined(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {}, 150);
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.timedOut, true);
  assert.equal(result.joined, true);
  assert.equal(result.ownedProcessGroup, process.platform !== 'win32');
});
test('spawn failure is retained and joined', async () => {
  const result = await spawnJoined('relavium-not-an-installed-command-08357', [], {}, 5000);
  assert.ok(result.spawnError);
  assert.notEqual(result.code, 0);
  assert.equal(result.joined, true);
});
