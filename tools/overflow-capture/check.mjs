/** Exercise the built maintainer command offline, including the real stdin/file/signal boundary. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';

const main = fileURLToPath(new URL('./capture.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'relavium-capture-check-'));
const loader = join(dir, 'fake-fetch.mjs');
const key = 'capture-probe-key-12345'; // Explicitly synthetic; never a live capture fixture.
const duplicateSecret = `{"duplicate":"${key.replace('capture-', String.raw`\u0063apture-`)}","duplicate":"safe"}`;
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

async function run(argv = args, mode = 'safe', input = key, interrupt = false) {
  rmSync(marker, { force: true });
  const child = spawn(process.execPath, ['--import', pathToFileURL(loader).href, main, ...argv], {
    env: {
      ...process.env,
      CAPTURE_PROBE_MODE: mode,
      CAPTURE_PROBE_MARKER: marker,
      CAPTURE_PROBE_OUT: out,
      CAPTURE_PROBE_RACE_READY: raceReady,
      CAPTURE_PROBE_RACE_RELEASE: raceRelease,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.on('error', () => {}); // Early argument refusal may close the pipe before our synthetic write.
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    let hasClosed = false;
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        hasClosed = true;
        resolve({ code, signal });
      });
    });
    if (mode === 'cleanup-race') {
      for (let i = 0; i < 400; i += 1) {
        if (hasClosed || existsSync(raceReady)) break;
        await sleep(5);
      }
      assert.ok(
        hasClosed || existsSync(raceReady),
        'cleanup race never reached a terminal or stat',
      );
      if (existsSync(raceReady)) {
        rmSync(out);
        writeFileSync(out, 'replacement user file');
        writeFileSync(raceRelease, '1');
      }
    }
    if (interrupt) {
      for (let i = 0; i < 200 && !existsSync(marker); i += 1) await sleep(10);
      assert.ok(existsSync(marker), 'child never reached the mocked transport');
      child.kill('SIGTERM');
    }
    const result = await closed;
    assert.ok(!(stdout + stderr).includes(key), 'key escaped to command output');
    assert.equal(result.signal, null, 'command hung or terminated without its cleanup');
    return {
      ...result,
      stdout,
      stderr,
      calls: existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0,
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

try {
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
