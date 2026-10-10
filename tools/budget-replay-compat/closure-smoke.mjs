/** Real CommonJS lookup controls and graph interventions, in invocation-owned fixtures only. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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
import { dependencyArchiveMagic, snapshotDependencyClosure } from './dependency-closure.mjs';

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
  // The production ESM loader needs TypeScript only for source transpilation. This synthetic graph loads
  // no TS source; a pinned inert module permits exercising that EXACT loader's dependency resolve hook.
  const typescript = packageFixture(
    'typescript',
    '1.0.0',
    {},
    "module.exports = { version: 'fixture-only' };\n",
  );
  const esm = packageFixture(
    'fixture-esm',
    '1.0.0',
    {
      type: 'module',
      dependencies: { 'fixture-shared': '^1' },
    },
    "import shared from 'fixture-shared'; export default shared;\n",
  );
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
  edge(esm, shared1, 'dependencies', '^1');
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
    rootImports: [primary, secondary, esm, typescript].map((pin) => ({
      name: pin.name,
      target: pin.relativePackageRoot,
    })),
  };
  const portableBytes = Buffer.concat([
    dependencyArchiveMagic,
    ...packages.flatMap((pin) =>
      pin.files.map((file) => readFileSync(join(repository, pin.relativePackageRoot, file.path))),
    ),
  ]);
  const results = [];
  function caseDirectory(label) {
    const directory = join(root, label);
    mkdirSync(join(directory, 'node_modules'), { recursive: true });
    mkdirSync(join(directory, 'logs'));
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n');
    return directory;
  }
  const control = caseDirectory('control');
  const runtime = snapshotDependencyClosure(repository, control, pins, portableBytes);
  mkdirSync(join(control, 'frozen'));
  writeFileSync(join(control, 'frozen/source-manifest.json'), '{"files":[]}\n');
  for (const file of ['dependency-runtime.mjs', 'loader.mjs', 'register.mjs'])
    cpSync(join(tooling, file), join(control, file));
  writeFileSync(
    join(control, 'probe.mjs'),
    `import './dependency-runtime.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
assert.deepEqual(require('fixture-primary'), { shared: 'one', peer: 'peer', absent: true });
assert.equal(require('fixture-secondary'), 'two');
assert.equal((await import('fixture-esm')).default, 'one');
`,
  );
  for (const file of ['dependency-runtime.mjs', 'loader.mjs', 'register.mjs', 'probe.mjs']) {
    const bytes = readFileSync(join(control, file));
    runtime.files.push({
      path: file,
      bytes: bytes.length,
      sha256: digest(bytes),
      workerTool: true,
    });
  }
  writeFileSync(join(control, 'dependency-runtime.json'), `${JSON.stringify(runtime, null, 2)}\n`);
  function runProbe(label) {
    const child = spawnSync(
      process.execPath,
      ['--import', join(control, 'register.mjs'), join(control, 'probe.mjs')],
      {
        cwd: control,
        env: { ...environment, COMPAT_SOURCE: 'frozen', COMPAT_LABEL: label, NODE_PATH: '' },
        encoding: 'utf8',
        timeout: 8000,
      },
    );
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
  // Installed portable drift must be irrelevant to this immutable archived closure.
  for (const [label, name] of [
    ['installed-cjs-edge-drift', shared1.name],
    ['installed-peer-edge-drift', peer.name],
    ['installed-new-optional', 'fixture-optional'],
  ]) {
    const link = join(repository, primary.relativePackageRoot, 'node_modules', name);
    const original = name === shared1.name ? shared1 : name === peer.name ? peer : undefined;
    if (original) unlinkSync(link);
    symlinkSync(unpinned, link, 'dir');
    try {
      const directory = caseDirectory(label);
      snapshotDependencyClosure(repository, directory, pins, portableBytes);
      assert.equal(
        readFileSync(
          join(directory, 'dependencies', shared1.relativePackageRoot, 'index.js'),
          'utf8',
        ),
        "module.exports = 'one';\n",
      );
      results.push({ label, frozenBytesAndGraphRetained: true });
    } finally {
      unlinkSync(link);
      if (original) symlinkSync(join(repository, original.relativePackageRoot), link, 'dir');
    }
  }
  const extra = join(repository, shared1.relativePackageRoot, 'extra.js');
  writeFileSync(extra, 'module.exports = 1;\n');
  try {
    const directory = caseDirectory('installed-unlisted-file');
    snapshotDependencyClosure(repository, directory, pins, portableBytes);
    assert.equal(
      existsSync(join(directory, 'dependencies', shared1.relativePackageRoot, 'extra.js')),
      false,
    );
    results.push({ label: 'installed-unlisted-file', frozenBytesRetained: true });
  } finally {
    unlinkSync(extra);
  }
  // No portable live install is required, even for previously present peers/two-version graphs.
  snapshotDependencyClosure(
    join(root, 'missing-install'),
    caseDirectory('missing-live-install'),
    pins,
    portableBytes,
  );
  results.push({ label: 'missing-live-install', frozenBytesAndGraphRetained: true });
  const tampered = Buffer.from(portableBytes);
  tampered[dependencyArchiveMagic.length] ^= 1;
  for (const [label, bytes, message] of [
    ['archive-byte-drift', tampered, /fixture-shared\/index.js/],
    ['archive-truncated', portableBytes.subarray(0, -1), /truncated portable archive/],
    [
      'archive-trailing-byte',
      Buffer.concat([portableBytes, Buffer.from('x')]),
      /unlisted trailing/,
    ],
  ]) {
    assert.throws(
      () => snapshotDependencyClosure(repository, caseDirectory(label), pins, bytes),
      message,
    );
    assert.equal(existsSync(marker), false);
    results.push({ label, refusedBeforeWorker: true });
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
    assert.match(child.stderr, /Unpinned runtime dependency|Runtime dependency edge changed/);
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
  // All targets below are ALREADY pinned and byte-identical. Membership/digest alone cannot detect a
  // wrong issuer edge. Each probe uses a fresh worker, and every literal copied link is restored finally.
  for (const [label, issuer, name, original] of [
    ['runtime-cjs-pinned-edge', primary, shared1.name, shared1],
    ['runtime-peer-pinned-edge', primary, peer.name, peer],
    ['runtime-optional-presence', primary, 'fixture-optional', undefined],
    ['runtime-esm-pinned-edge', esm, shared1.name, shared1],
    ['runtime-root-import', undefined, primary.name, primary],
  ]) {
    const link = issuer
      ? join(control, 'dependencies', issuer.relativePackageRoot, 'node_modules', name)
      : join(control, 'node_modules', name);
    const target = issuer ? shared2 : secondary;
    if (original) unlinkSync(link);
    symlinkSync(join(control, 'dependencies', target.relativePackageRoot), link, 'dir');
    try {
      const child = runProbe(label);
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /Runtime dependency (edge|resolution) changed/);
      assert.equal(existsSync(marker), false);
    } finally {
      unlinkSync(link);
      if (original)
        symlinkSync(join(control, 'dependencies', original.relativePackageRoot), link, 'dir');
    }
  }
  assert.equal(runProbe('restored-cjs-esm-graph-control').status, 0);
  writeFileSync(
    join(root, 'results.json'),
    `${JSON.stringify({ completed: true, results, markerLoaded: false }, null, 2)}\n`,
  );
}
