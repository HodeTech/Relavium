// Copied, unchanged, to the extensionless `status` file next to the private fixture config.
// A copied Node executable named git/git.exe runs this through the real git_status host arm.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { appendFileSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { setInterval, clearInterval } = require('node:timers');

const config = JSON.parse(readFileSync(join(process.cwd(), 'native-fixture.json'), 'utf8'));
const record = (value) => appendFileSync(config.log, JSON.stringify(value) + '\n', { mode: 0o600 });
assert.equal(process.argv.length, 2, 'Only the fixed status script may execute');
assert.ok(
  [
    'injected-error',
    'leader-exit',
    'exit-fallback',
    'bootstrap-fatal',
    'bootstrap-background',
    'bootstrap-output',
  ].includes(config.mode),
);
assert.ok(Number.isSafeInteger(config.owner) && config.owner > 0);
// The fixture never outlives the smoke worker that owns its case: an interrupted consumer kills that
// worker, and nothing else would stop a target in its own process group. Unreferenced, so it never
// keeps a fixture alive that would otherwise exit.
setInterval(() => {
  try {
    process.kill(config.owner, 0);
  } catch (error) {
    if (error.code === 'ESRCH') process.exit(0);
  }
}, 100).unref();
record({ operation: 'native-fixture-root', pid: process.pid });
if (config.mode === 'exit-fallback') {
  process.stdout.write('RELAVIUM_NATIVE_FIXTURE_READY\n');
  setInterval(() => {}, 1000);
} else {
  const descendant = spawn(config.node, [config.descendant, config.log, String(config.owner)], {
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
  if (config.mode === 'bootstrap-background') {
    const finish = setInterval(() => {
      if (!existsSync(config.release + '.target-exit')) return;
      clearInterval(finish);
      // Fixture-owned normal completion, not product fatal cleanup: join the exact created child.
      descendant.kill('SIGTERM');
    }, 25);
  } else if (config.mode !== 'leader-exit') setInterval(() => {}, 1000);
}
