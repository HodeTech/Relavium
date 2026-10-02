/** Offline regression for the guard's probe ownership, independent of Vitest collection semantics. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const scriptText = readFileSync(join(repository, 'tools/test-isolation/check.mjs'), 'utf8');
const configText = readFileSync(join(repository, 'vitest.config.ts'), 'utf8');
const collector = `
import {writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
if (process.env.GUARD_PROBE_ROLE === 'A') {
  writeFileSync(join(process.cwd(),'ready'),'1');
  const deadline = Date.now() + 5000;
  while (!existsSync(join(process.cwd(),'release'))) {
    if (Date.now() > deadline) throw new Error('release timeout');
    await delay(5);
  }
}
function tests(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry => {
    const path=join(dir,entry.name);
    return entry.isDirectory() ? tests(path) : entry.name === 'probe.test.ts' ? [{file:path}] : [];
  });
}
const excluded=readFileSync(join(process.cwd(),'vitest.config.ts'),'utf8').includes("'docs/analysis/private/**'");
process.stdout.write(JSON.stringify(excluded ? [] : tests(join(process.cwd(),'docs/analysis/private'))));`;

function fixture(config) {
  const dir = mkdtempSync(join(tmpdir(), 'relavium-guard-ownership-'));
  mkdirSync(join(dir, 'tools/test-isolation'), { recursive: true });
  writeFileSync(join(dir, 'tools/test-isolation/check.mjs'), scriptText);
  writeFileSync(join(dir, 'vitest.config.ts'), config);
  writeFileSync(join(dir, 'package.json'), '{}');
  mkdirSync(join(dir, 'node_modules/vitest'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules/vitest/package.json'),
    JSON.stringify({ name: 'vitest', bin: { vitest: 'vitest.mjs' } }),
  );
  writeFileSync(join(dir, 'node_modules/vitest/vitest.mjs'), collector);
  return dir;
}

const preserved = fixture(configText);
try {
  const sentinels = [
    'docs/analysis/private/__test_isolation_fixture__/prior-analysis.txt',
    '__test_isolation_detector_probe__/prior-analysis.txt',
  ];
  for (const path of sentinels) {
    const target = join(preserved, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, 'pre-existing private artifact');
  }
  const result = spawnSync(process.execPath, [join(preserved, 'tools/test-isolation/check.mjs')], {
    cwd: preserved,
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 0, result.stderr);
  for (const path of sentinels) {
    assert.equal(
      readFileSync(join(preserved, path), 'utf8'),
      'pre-existing private artifact',
      `guard modified a pre-existing artifact: ${path}`,
    );
  }
} finally {
  rmSync(preserved, { recursive: true, force: true });
}

const brokenConfig = configText.replace("  'docs/analysis/private/**',\n", '');
assert.notEqual(brokenConfig, configText, 'private exclusion mutation did not apply');
const concurrent = fixture(brokenConfig);
const children = [];
const completions = [];
function start(role) {
  const child = spawn(process.execPath, [join(concurrent, 'tools/test-isolation/check.mjs')], {
    cwd: concurrent,
    env: { ...process.env, GUARD_PROBE_ROLE: role },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
  completions.push(done);
  return done;
}
try {
  const a = start('A');
  for (let i = 0; i < 400 && !existsSync(join(concurrent, 'ready')); i += 1) await delay(5);
  assert.ok(existsSync(join(concurrent, 'ready')), 'guard A never reached collection');
  const b = await start('B');
  writeFileSync(join(concurrent, 'release'), '1');
  const first = await a;
  for (const result of [first, b]) {
    assert.equal(result.signal, null, 'guard did not finish within the probe deadline');
    assert.equal(result.code, 1, 'concurrent guard erased a probe and falsely passed');
    assert.ok(result.stderr.includes('docs/analysis/private'), result.stderr);
  }
  console.log(
    '✓ test-isolation probes preserve existing artifacts and remain effective concurrently.',
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.allSettled(completions);
  rmSync(concurrent, { recursive: true, force: true });
}
