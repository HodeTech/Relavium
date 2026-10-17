// Exact fixture descendant only. No transport, provider, keychain or ambient process discovery.
const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const { setInterval } = require('node:timers');
assert.equal(process.argv.length, 3);
appendFileSync(
  process.argv[2],
  JSON.stringify({
    operation: 'native-fixture-descendant-ready',
    pid: process.pid,
    parentPid: process.ppid,
  }) + '\n',
  { mode: 0o600 },
);
process.send('ready');
process.stdout.write('RELAVIUM_NATIVE_FIXTURE_READY\n');
setInterval(() => {}, 1000);
