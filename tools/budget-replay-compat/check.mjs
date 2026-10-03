/** ADR-0100: actual current engine writes, actual frozen predecessor refuses. Offline only. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { snapshotDependencyClosure } from './dependency-closure.mjs';
import { checkClosureGuards } from './closure-smoke.mjs';

const tooling = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
const repository = realpathSync(join(tooling, '../..'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const archive = readFileSync(join(tooling, 'frozen/pre-w7-source.tar.gz'));
assert.equal(archive.length, 843319);
assert.equal(digest(archive), 'cf980edd6d4d8a8652fa236c1c0d46055249fe59944ec284a120aea19c6b10bb');
const dependencyBytes = readFileSync(join(tooling, 'frozen/dependencies.json.gz'));
assert.equal(
  digest(dependencyBytes),
  '7cce53b58c5eade131f59dcce426519980b9cdc27644d9fbade5087b625bd529',
);
const pins = JSON.parse(gunzipSync(dependencyBytes).toString('utf8'));

// The only writable tree is this exclusive external allocation. Preserve evidence on success and failure.
const owned = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-budget-replay-')));
writeFileSync(
  join(owned, 'OWNER'),
  `ADR-0100 replay; parent PID ${process.pid}; source ${repository}\n`,
);
for (const directory of [
  'tmp',
  'cache',
  'config',
  'logs',
  'results',
  'raw',
  'databases',
  'node_modules',
  'frozen',
  'producer',
])
  mkdirSync(join(owned, directory));
const environment = {
  ...process.env,
  TMPDIR: join(owned, 'tmp'),
  TMP: join(owned, 'tmp'),
  TEMP: join(owned, 'tmp'),
  XDG_CACHE_HOME: join(owned, 'cache'),
  XDG_CONFIG_HOME: join(owned, 'config'),
  NODE_COMPILE_CACHE: join(owned, 'cache/node-compile'),
  NODE_PATH: '',
};
writeFileSync(join(owned, 'package.json'), '{"type":"module"}\n');
writeFileSync(join(owned, 'frozen-pre-w7-source.tar.gz'), archive);
execFileSync(
  'tar',
  ['-xzf', join(owned, 'frozen-pre-w7-source.tar.gz'), '-C', join(owned, 'frozen')],
  { cwd: owned, env: environment },
);
const frozenManifestBytes = readFileSync(join(owned, 'frozen/source-manifest.json'));
assert.equal(
  digest(frozenManifestBytes),
  'cb3361e5c0f75d427ee936ba43beba871acacbc117729df7820dbb7aa5ec229b',
);
const frozenManifest = JSON.parse(frozenManifestBytes.toString('utf8'));
for (const file of frozenManifest.files ?? frozenManifest) {
  const bytes = readFileSync(join(owned, 'frozen', file.path));
  assert.equal(bytes.length, file.bytes ?? file.size, file.path);
  assert.equal(digest(bytes), file.sha256, file.path);
}
assert.equal(digest(readFileSync(join(owned, 'frozen/pnpm-lock.yaml'))), pins.baselineLockSha256);

const producerFiles = [];
function snapshot(path) {
  const full = join(repository, path);
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) snapshot(child);
    else if (
      entry.isFile() &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx')
    )
      copySource(child);
  }
}
function copySource(path) {
  const bytes = readFileSync(join(repository, path));
  const target = join(owned, 'producer', path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  producerFiles.push({ path, bytes: bytes.length, sha256: digest(bytes) });
}
for (const name of ['shared', 'llm', 'core', 'db']) {
  snapshot(`packages/${name}/src`);
  copySource(`packages/${name}/package.json`);
}
snapshot('packages/db/drizzle');
for (const path of ['pnpm-lock.yaml', 'package.json', 'apps/cli/src/engine/checkpointer.ts'])
  copySource(path);
producerFiles.sort((a, b) => a.path.localeCompare(b.path));
writeFileSync(
  join(owned, 'producer-source-manifest.json'),
  `${JSON.stringify({ files: producerFiles }, null, 2)}\n`,
);
writeFileSync(
  join(owned, 'producer-version.json'),
  `${JSON.stringify(
    {
      head: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8',
      }).trim(),
      status: execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }),
      sourceManifestSha256: digest(readFileSync(join(owned, 'producer-source-manifest.json'))),
    },
    null,
    2,
  )}\n`,
);
const workerFiles = [
  'loader.mjs',
  'register.mjs',
  'dependency-runtime.mjs',
  'producer-common.mjs',
  'legacy-producer.mjs',
  'producer.mjs',
  'predecessor.mjs',
];
for (const file of workerFiles) cpSync(join(tooling, file), join(owned, file));

console.log(`Budget replay evidence: ${owned}`);
const dependencyRuntime = snapshotDependencyClosure(repository, owned, pins);
for (const file of workerFiles) {
  const bytes = readFileSync(join(owned, file));
  dependencyRuntime.files.push({
    path: file,
    bytes: bytes.length,
    sha256: digest(bytes),
    workerTool: true,
  });
}
writeFileSync(
  join(owned, 'dependency-runtime.json'),
  `${JSON.stringify(dependencyRuntime, null, 2)}\n`,
);
const requireOwned = createRequire(join(owned, 'package.json'));
const baselineLock = requireOwned('yaml').parse(
  readFileSync(join(owned, 'frozen/pnpm-lock.yaml'), 'utf8'),
);
for (const pin of pins.packages)
  assert.ok(Object.hasOwn(baselineLock.packages, pin.baselineLockPackageKey), pin.name);
checkClosureGuards(owned, tooling, environment);
const processes = [];
try {
  for (const [stage, mode, script] of [
    ['legacy', 'frozen', 'legacy-producer.mjs'],
    ['producer', 'producer', 'producer.mjs'],
    ['predecessor', 'frozen', 'predecessor.mjs'],
  ]) {
    const args = ['--import', join(owned, 'register.mjs'), join(owned, script)];
    const child = spawn(process.execPath, args, {
      cwd: owned,
      env: { ...environment, COMPAT_SOURCE: mode, COMPAT_LABEL: stage },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 45000);
    let result;
    try {
      result = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => done({ code, signal }));
      });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    const record = {
      stage,
      source: mode,
      command: [process.execPath, ...args],
      cwd: owned,
      pid: child.pid,
      timedOut,
      ...result,
      workerClosed: true,
    };
    processes.push(record);
    writeFileSync(
      join(owned, `logs/${stage}.process.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    writeFileSync(join(owned, `logs/${stage}.stdout.log`), stdout);
    writeFileSync(join(owned, `logs/${stage}.stderr.log`), stderr);
    process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    assert.equal(result.code, 0, `${stage} failed; evidence ${owned}`);
    assert.equal(result.signal, null);
  }
} finally {
  writeFileSync(join(owned, 'worker-closure.json'), `${JSON.stringify({ processes }, null, 2)}\n`);
}
