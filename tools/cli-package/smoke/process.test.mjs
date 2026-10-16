import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { explicitEnvironment, invoke, MAX_OUTPUT_BYTES, startOwned } from './process.mjs';

const options = { cwd: tmpdir(), env: explicitEnvironment(tmpdir(), tmpdir()) };
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
};
test('owned child deadline joins the actual hung process', async () => {
  const owned = startOwned(['-e', 'setInterval(() => {}, 1000)'], { ...options, timeout: 200 });
  const pid = owned.child.pid;
  try {
    await assert.rejects(owned.result(), /deadline exceeded/);
  } finally {
    await owned.close();
  }
  assert.ok(gone(pid));
});
test('output ceiling rejects and joins the actual flooding process', async () => {
  const owned = startOwned(
    ['-e', 'setInterval(() => process.stdout.write("x".repeat(65536)), 1)'],
    options,
  );
  const pid = owned.child.pid;
  try {
    await assert.rejects(owned.result(), /output byte ceiling/);
  } finally {
    await owned.close();
  }
  assert.ok(gone(pid));
  assert.ok(owned.output().stdout.length <= MAX_OUTPUT_BYTES);
});
test('explicit close joins a live child on assertion failure', async () => {
  const owned = startOwned(['-e', 'setInterval(() => {}, 1000)'], options);
  const pid = owned.child.pid;
  await owned.close();
  assert.ok(gone(pid));
});
test('child environment does not inherit provider credentials or Node preload hooks', () => {
  for (const key of [
    'NODE_OPTIONS',
    'NODE_PATH',
    'OPENAI_API_KEY',
    'RELAVIUM_OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
  ])
    assert.equal(Object.hasOwn(options.env, key), false);
});
test('normal bounded child output preserves actual exit and output', async () => {
  const result = await invoke(
    ['-e', 'process.stdout.write("synthetic-marker"); process.exitCode = 4'],
    options,
  );
  assert.equal(result.code, 4);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'synthetic-marker');
});
