/** Real CommonJS lookup controls and graph interventions, in invocation-owned fixtures only. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { snapshotDependencyClosure } from './dependency-closure.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function checkClosureGuards(owned, tooling, environment) {
  const root = join(owned, 'closure-guards');
  mkdirSync(root);
  const repository = join(root, 'installed');
  mkdirSync(repository);
  const packages = [];
  function packageFixture(name, version, metadata, body) {
    const relativePackageRoot = `node_modules/.pnpm/${name}@${version}/node_modules/${name}`;
    const path = join(repository, relativePackageRoot);
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, 'package.json'),
      JSON.stringify({ name, version, main: 'index.js', ...metadata }),
    );
    writeFileSync(join(path, 'index.js'), body);
    const files = ['index.js', 'package.json'].map((file) => {
      const bytes = readFileSync(join(path, file));
      return { path: file, bytes: bytes.length, sha256: digest(bytes) };
    });
    const pin = {
      name,
      version,
      relativePackageRoot,
      packageJsonSha256: files[1].sha256,
      baselineLockPackageKey: `${name}@${version}`,
      files,
      edges: [],
    };
    packages.push(pin);
    return pin;
  }
  const shared1 = packageFixture('fixture-shared', '1.0.0', {}, "module.exports = 'one';\n");
  const shared2 = packageFixture('fixture-shared', '2.0.0', {}, "module.exports = 'two';\n");
  const peer = packageFixture('fixture-peer', '1.0.0', {}, "module.exports = 'peer';\n");
  const primary = packageFixture(
    'fixture-primary',
    '1.0.0',
    {
      dependencies: { 'fixture-shared': '^1' },
      peerDependencies: { 'fixture-peer': '^1' },
      optionalDependencies: { 'fixture-optional': '^1' },
    },
    `let absent = false;
try { require.resolve('fixture-optional'); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  absent = true;
}
module.exports = { shared: require('fixture-shared'), peer: require('fixture-peer'), absent };
`,
  );
  const secondary = packageFixture(
    'fixture-secondary',
    '1.0.0',
    {
      dependencies: { 'fixture-shared': '^2' },
    },
    "module.exports = require('fixture-shared');\n",
  );
  function edge(from, target, kind, specifier) {
    from.edges.push({
      kind,
      name: target.name,
      specifier,
      optional: false,
      target: target.relativePackageRoot,
    });
    const link = join(repository, from.relativePackageRoot, 'node_modules', target.name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(repository, target.relativePackageRoot), link, 'dir');
  }
  edge(primary, shared1, 'dependencies', '^1');
  edge(primary, peer, 'peerDependencies', '^1');
  edge(secondary, shared2, 'dependencies', '^2');
  primary.edges.push({
    kind: 'optionalDependencies',
    name: 'fixture-optional',
    specifier: '^1',
    optional: true,
    absent: true,
  });
  const pins = {
    schemaVersion: 2,
    packages,
    rootImports: [primary, secondary].map((pin) => ({
      name: pin.name,
      target: pin.relativePackageRoot,
    })),
  };
  const results = [];
  function caseDirectory(label) {
    const directory = join(root, label);
    mkdirSync(join(directory, 'node_modules'), { recursive: true });
    mkdirSync(join(directory, 'logs'));
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n');
    return directory;
  }
  const control = caseDirectory('control');
  snapshotDependencyClosure(repository, control, pins);
  cpSync(join(tooling, 'dependency-runtime.mjs'), join(control, 'dependency-runtime.mjs'));
  writeFileSync(
    join(control, 'probe.mjs'),
    `import './dependency-runtime.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
assert.deepEqual(require('fixture-primary'), { shared: 'one', peer: 'peer', absent: true });
assert.equal(require('fixture-secondary'), 'two');
`,
  );
  function runProbe(label) {
    const child = spawnSync(process.execPath, [join(control, 'probe.mjs')], {
      cwd: control,
      env: { ...environment, COMPAT_LABEL: label, NODE_PATH: '' },
      encoding: 'utf8',
      timeout: 8000,
    });
    writeFileSync(join(control, `logs/${label}.stdout.log`), child.stdout ?? '');
    writeFileSync(join(control, `logs/${label}.stderr.log`), child.stderr ?? '');
    const record = {
      label,
      pid: child.pid,
      status: child.status,
      signal: child.signal,
      error: child.error?.code,
      timedOut: child.error?.code === 'ETIMEDOUT',
      workerClosed: child.status !== null || child.signal !== null,
    };
    results.push(record);
    writeFileSync(
      join(control, `logs/${label}.process.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    return child;
  }
  assert.equal(runProbe('cjs-peer-two-versions-absent-optional-control').status, 0);

  const unpinned = join(root, 'unpinned');
  mkdirSync(unpinned);
  const marker = join(root, 'unexpected-module-load');
  writeFileSync(
    join(unpinned, 'package.json'),
    '{"name":"fixture-shared","version":"1.0.0","main":"index.js"}',
  );
  writeFileSync(
    join(unpinned, 'index.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded'); module.exports = 'one';\n`,
  );
  for (const [label, name, message] of [
    ['redirected-cjs-edge', shared1.name, /dependency edge changed/],
    ['redirected-peer-edge', peer.name, /dependency edge changed/],
    ['newly-resolving-optional', 'fixture-optional', /previously absent optional edge/],
  ]) {
    const link = join(repository, primary.relativePackageRoot, 'node_modules', name);
    const original = name === shared1.name ? shared1 : name === peer.name ? peer : undefined;
    if (original) unlinkSync(link);
    symlinkSync(unpinned, link, 'dir');
    try {
      assert.throws(
        () => snapshotDependencyClosure(repository, caseDirectory(label), pins),
        message,
      );
      results.push({ label, refusedBeforeWorker: true });
    } finally {
      unlinkSync(link);
      if (original) symlinkSync(join(repository, original.relativePackageRoot), link, 'dir');
    }
  }
  const extra = join(repository, shared1.relativePackageRoot, 'extra.js');
  writeFileSync(extra, 'module.exports = 1;\n');
  try {
    assert.throws(
      () => snapshotDependencyClosure(repository, caseDirectory('unlisted-file'), pins),
      /portable file inventory/,
    );
    results.push({ label: 'unlisted-file', refusedBeforeWorker: true });
  } finally {
    unlinkSync(extra);
  }

  // Change only an owned copied edge AFTER preflight. The runtime fence must reject before marker code runs.
  const copiedLink = join(
    control,
    'dependencies',
    primary.relativePackageRoot,
    'node_modules',
    shared1.name,
  );
  unlinkSync(copiedLink);
  symlinkSync(unpinned, copiedLink, 'dir');
  try {
    const child = runProbe('runtime-cjs-unpinned-edge');
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Unpinned runtime dependency/);
    assert.equal(existsSync(marker), false);
  } finally {
    unlinkSync(copiedLink);
    symlinkSync(join(control, 'dependencies', shared1.relativePackageRoot), copiedLink, 'dir');
  }
  const copiedFile = join(control, 'dependencies', shared1.relativePackageRoot, 'index.js');
  const bytes = readFileSync(copiedFile);
  writeFileSync(copiedFile, readFileSync(join(unpinned, 'index.js')));
  try {
    const child = runProbe('runtime-cjs-byte-drift');
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Runtime dependency bytes changed/);
    assert.equal(existsSync(marker), false);
  } finally {
    writeFileSync(copiedFile, bytes);
  }
  writeFileSync(
    join(root, 'results.json'),
    `${JSON.stringify({ completed: true, results, markerLoaded: false }, null, 2)}\n`,
  );
}
