// Copied, unchanged, to the extensionless `status` file next to the private fixture config.
// A copied Node executable named git/git.exe runs this through the real git_status host arm.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { appendFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { setInterval } = require('node:timers');

const config = JSON.parse(readFileSync(join(process.cwd(), 'native-fixture.json'), 'utf8'));
const record = (value) => appendFileSync(config.log, JSON.stringify(value) + '\n', { mode: 0o600 });
assert.equal(process.argv.length, 2, 'Only the fixed status script may execute');
assert.ok(['injected-error', 'leader-exit', 'exit-fallback'].includes(config.mode));
record({ operation: 'native-fixture-root', pid: process.pid });
if (config.mode === 'exit-fallback') {
  process.stdout.write('RELAVIUM_NATIVE_FIXTURE_READY\n');
  setInterval(() => {}, 1000);
} else {
  const descendant = spawn(config.node, [config.descendant, config.log], {
    shell: false,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  assert.ok(Number.isSafeInteger(descendant.pid) && descendant.pid > 0);
  record({ operation: 'native-fixture-descendant', pid: descendant.pid, parentPid: process.pid });
  descendant.on('error', () => {
    process.exitCode = 1;
  });
  descendant.once('message', (message) => {
    assert.equal(message, 'ready');
    descendant.disconnect();
    if (config.mode === 'leader-exit') descendant.unref();
  });
  if (config.mode !== 'leader-exit') setInterval(() => {}, 1000);
}
