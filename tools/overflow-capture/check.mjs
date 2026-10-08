/** Exercise the built maintainer command offline, including the real stdin/file/signal boundary. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  symlinkSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCaptureCheckRunner } from './check-runner.mjs';
import { checkCaptureRunnerFailures } from './check-runner-smoke.mjs';

const main = fileURLToPath(new URL('./capture.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'relavium-capture-check-'));
const loader = join(dir, 'fake-fetch.mjs');
const key = 'capture-probe-key-12345'; // Explicitly synthetic; never a live capture fixture.
const escapedKey = key.replace('capture-', String.raw`\u0063apture-`);
const duplicateSecret = `{"duplicate":"${escapedKey}","duplicate":"safe"}`;
const out = join(dir, 'capture.json');
const marker = join(dir, 'calls');
const raceReady = join(dir, 'cleanup-stat-ready');
const raceRelease = join(dir, 'cleanup-stat-release');
const args = [
  '--provider',
  'anthropic',
  '--model',
  'claude-example',
  '--input-chars',
  '1024',
  '--out',
  out,
];
writeFileSync(
  loader,
  String.raw`
import fs, { appendFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
// Delay-only regression: return the real lstat result after the parent swaps the pathname. The fixed
// runner has no failure-path lstat/unlink, so it closes before this scheduling point can be reached.
const rawLstat = fs.lstatSync;
let scheduled = false;
fs.lstatSync = function(path, ...args) {
  const result = rawLstat(path, ...args);
  if (process.env.CAPTURE_PROBE_MODE === 'cleanup-race' && !scheduled && path === process.env.CAPTURE_PROBE_OUT) {
    scheduled = true;
    writeFileSync(process.env.CAPTURE_PROBE_RACE_READY, '1');
    const bound = Date.now() + 5000;
    const waitBuf = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(process.env.CAPTURE_PROBE_RACE_RELEASE)) {
      if (Date.now() > bound) throw new Error('race scheduling timeout');
      Atomics.wait(waitBuf, 0, 0, 2);
    }
  }
  return result;
};
syncBuiltinESMExports();
globalThis.fetch = async (url, init) => {
  if (url !== 'https://api.anthropic.com/v1/messages' || init.redirect !== 'error') throw new Error('wrong request');
  appendFileSync(process.env.CAPTURE_PROBE_MARKER, 'call\n');
  switch (process.env.CAPTURE_PROBE_MODE) {
    case 'hang': return new Promise(() => {});
    case 'caller-abort':
      queueMicrotask(() => process.emit('SIGTERM'));
      return new Promise(() => {});
    case 'replacement-success':
    case 'replacement':
      unlinkSync(process.env.CAPTURE_PROBE_OUT);
      writeFileSync(process.env.CAPTURE_PROBE_OUT, 'replacement user file');
      if (process.env.CAPTURE_PROBE_MODE === 'replacement-success') return new Response('{}', {headers:{'content-type':'application/json'}});
      throw new Error('refused after replacement');
    case 'cleanup-race':
    case 'transport': throw new Error(${JSON.stringify(key)});
    case 'secret': return new Response(JSON.stringify({error:${JSON.stringify(key)}}), {status:400,headers:{'content-type':'application/json'}});
    case 'duplicate-secret': return new Response(${JSON.stringify(duplicateSecret)}, {status:400,headers:{'content-type':'application/json'}});
    default: return new Response('{"error":{"message":"offline probe, not provider evidence"}}', {status:400,headers:{'content-type':'application/json'}});
  }
};
`,
);

const run = createCaptureCheckRunner({
  args,
  loader,
  main,
  key,
  out,
  marker,
  raceReady,
  raceRelease,
});

try {
  await checkCaptureRunnerFailures();
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.equal(help.calls, 0);
  assert.ok(help.stdout.includes('Pipe one API key on stdin'));
  for (const [argv, input] of [
    [args.concat('--url', 'https://evil.example'), key],
    [args, 'two\nkeys'],
    [args, 'x'.repeat(1025)],
    [args.map((value) => (value === 'claude-example' ? key : value)), key],
    [args.map((value) => (value === out ? join(dir, key) : value)), key],
  ]) {
    const refused = await run(argv, 'safe', input);
    assert.equal(refused.code, 1);
    assert.equal(refused.calls, 0);
    assert.equal(existsSync(out), false);
  }
  const success = await run();
  assert.equal(success.code, 0);
  assert.equal(success.calls, 1);
  const artifact = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(artifact.response.status, 400);
  assert.equal(
    artifact.response.body,
    '{"error":{"message":"offline probe, not provider evidence"}}',
  );
  assert.ok(!JSON.stringify(artifact).includes(key));
  assert.ok(!Number.isNaN(Date.parse(artifact.capturedAt)));
  if (process.platform !== 'win32') assert.equal(statSync(out).mode & 0o777, 0o600);
  const original = readFileSync(out, 'utf8');
  const existing = await run();
  assert.equal(existing.code, 1);
  assert.equal(existing.calls, 0);
  assert.equal(readFileSync(out, 'utf8'), original);
  rmSync(out);
  const target = join(dir, 'user-file');
  writeFileSync(target, 'user file');
  // Windows symlink creation may require elevation. An existing hard link pins the same refusal there.
  if (process.platform === 'win32') linkSync(target, out);
  else symlinkSync(target, out);
  const linked = await run();
  assert.equal(linked.code, 1);
  assert.equal(linked.calls, 0);
  assert.equal(readFileSync(target, 'utf8'), 'user file');
  rmSync(out);
  for (const mode of [
    'secret',
    'duplicate-secret',
    'transport',
    'caller-abort',
    ...(process.platform === 'win32' ? [] : ['hang']),
  ]) {
    const refused = await run(args, mode, key, mode === 'hang');
    assert.equal(refused.code, 1);
    assert.equal(refused.calls, 1);
    assert.equal(readFileSync(out, 'utf8'), '', 'a refused body must never be written');
    rmSync(out);
  }
  const race = await run(args, 'cleanup-race');
  assert.equal(race.code, 1);
  assert.equal(race.calls, 1);
  assert.equal(
    readFileSync(out, 'utf8'),
    existsSync(raceReady) ? 'replacement user file' : '',
    'failure cleanup deleted a replacement after checking the reserved inode',
  );
  rmSync(out);
  const replaced = await run(args, 'replacement');
  assert.equal(replaced.code, 1);
  assert.equal(
    readFileSync(out, 'utf8'),
    'replacement user file',
    'cleanup deleted a replacement file',
  );
  rmSync(out);
  const replacedSuccess = await run(args, 'replacement-success');
  assert.equal(replacedSuccess.code, 1, 'success reported a response at an unowned destination');
  assert.ok(!replacedSuccess.stdout.includes('capture saved'));
  assert.equal(readFileSync(out, 'utf8'), 'replacement user file');
  console.log(
    '✓ overflow capture command passed offline stdin, file, secrecy and cancellation checks.',
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
