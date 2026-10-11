/** Separate current physical source, Git provenance and installed native dependency authority. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
  writeSync,
  lstatSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { snapshotDependencyClosure } from './dependency-closure.mjs';
import { checkClosureGuards } from './closure-smoke.mjs';
import { systemTool } from './system-tools.mjs';
import { verifyBaselineProvenance, checkBaselineProvenanceGuards } from './baseline-provenance.mjs';
import { installSessionSourceSupplement } from './session-source-supplement.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function replayRoots({ provenanceRoot, currentSourceRoot, installedDependencyRoot }) {
  return {
    provenanceRoot: realpathSync(provenanceRoot),
    currentSourceRoot: realpathSync(currentSourceRoot),
    installedDependencyRoot: realpathSync(installedDependencyRoot),
  };
}
export function readReplayArtifacts(tooling) {
  const archive = readFileSync(join(tooling, 'frozen/pre-w7-source.tar.gz'));
  assert.equal(archive.length, 843319);
  assert.equal(digest(archive), 'cf980edd6d4d8a8652fa236c1c0d46055249fe59944ec284a120aea19c6b10bb');
  const dependencyBytes = readFileSync(join(tooling, 'frozen/dependencies.json.gz'));
  assert.equal(
    digest(dependencyBytes),
    '7cce53b58c5eade131f59dcce426519980b9cdc27644d9fbade5087b625bd529',
  );
  const pins = JSON.parse(gunzipSync(dependencyBytes).toString('utf8'));
  const portableArchive = readFileSync(join(tooling, 'frozen/dependency-bytes.bin.gz'));
  assert.equal(portableArchive.length, 20143535);
  assert.equal(
    digest(portableArchive),
    '807644e6f71d153f7bfa4e0f47a3304f851391ee40ad18635ded1468a8fc5c49',
  );
  const portableBytes = gunzipSync(portableArchive, { maxOutputLength: 112929573 });
  assert.equal(portableBytes.length, 112929573);
  assert.equal(
    digest(portableBytes),
    'e37029d0ea9fdfbae33a97e2fce68a260bb2ad1af2ce867d6b28f2f9abcedd53',
  );

  return { archive, pins, portableBytes };
}

export function prepareReplayEnvironment({
  roots,
  tooling,
  owned,
  environment,
  artifacts,
  verifyGuards = true,
  evaluation,
}) {
  const { archive, pins, portableBytes } = artifacts;
  writeFileSync(join(owned, 'frozen-pre-w7-source.tar.gz'), archive);
  execFileSync(
    systemTool('tar'),
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
  writeFileSync(
    join(owned, 'baseline-provenance.json'),
    `${JSON.stringify(verifyBaselineProvenance(roots.provenanceRoot, join(owned, 'frozen'), frozenManifest), null, 2)}\n`,
  );
  if (verifyGuards)
    checkBaselineProvenanceGuards(
      roots.provenanceRoot,
      join(owned, 'frozen'),
      frozenManifest,
      owned,
    );
  installSessionSourceSupplement(roots.provenanceRoot, tooling, owned);

  const producerFiles = [];
  const expectedSource = evaluation?.manifestPath
    ? JSON.parse(readFileSync(evaluation.manifestPath, 'utf8'))
    : undefined;
  if (expectedSource)
    assert.equal(realpathSync(expectedSource.sourceRoot), roots.currentSourceRoot);
  const expectedFiles = expectedSource
    ? new Map(expectedSource.files.map((file) => [file.path, file]))
    : undefined;
  function snapshot(path) {
    const full = join(roots.currentSourceRoot, path);
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const child = join(path, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Source link forbidden: ${child}`);
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
    const original = join(roots.currentSourceRoot, path);
    assert.equal(realpathSync(original), original, `Source symlink forbidden: ${path}`);
    assert.ok(lstatSync(original).isFile(), `Source must be regular: ${path}`);
    const bytes = readFileSync(original);
    if (expectedFiles) {
      const expected = expectedFiles.get(path);
      assert.ok(expected, `Source absent from outer manifest: ${path}`);
      assert.equal(bytes.length, expected.bytes, path);
      assert.equal(digest(bytes), expected.sha256, path);
    }
    const target = join(owned, 'producer', path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    producerFiles.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  for (const name of ['shared', 'llm', 'core', 'db', 'mcp']) {
    snapshot(`packages/${name}/src`);
    copySource(`packages/${name}/package.json`);
  }
  snapshot('packages/db/drizzle');
  for (const path of ['pnpm-lock.yaml', 'package.json', 'apps/cli/src/engine/checkpointer.ts'])
    copySource(path);
  producerFiles.sort((a, b) => a.path.localeCompare(b.path));
  for (const file of producerFiles) {
    const bytes = readFileSync(join(roots.currentSourceRoot, file.path));
    assert.equal(bytes.length, file.bytes, `Source changed during capture: ${file.path}`);
    assert.equal(digest(bytes), file.sha256, `Source changed during capture: ${file.path}`);
  }
  writeFileSync(
    join(owned, 'producer-source-manifest.json'),
    `${JSON.stringify({ files: producerFiles }, null, 2)}\n`,
  );
  writeFileSync(
    join(owned, 'producer-version.json'),
    `${JSON.stringify(
      {
        head: execFileSync(systemTool('git'), ['rev-parse', 'HEAD'], {
          cwd: roots.provenanceRoot,
          encoding: 'utf8',
        }).trim(),
        status: execFileSync(systemTool('git'), ['status', '--porcelain'], {
          cwd: roots.provenanceRoot,
          encoding: 'utf8',
        }),
        sourceManifestSha256: digest(readFileSync(join(owned, 'producer-source-manifest.json'))),
        currentSourceRoot: roots.currentSourceRoot,
        provenanceRoot: roots.provenanceRoot,
        installedDependencyRoot: roots.installedDependencyRoot,
        gitMetadataScope:
          'Capture provenance only; copied mutable source is identified by its manifest, not asserted equal to HEAD.',
        outerSourceManifestSha256: evaluation?.manifestPath
          ? digest(readFileSync(evaluation.manifestPath))
          : null,
      },
      null,
      2,
    )}\n`,
  );
  const workerFiles = [
    'loader.mjs',
    'register.mjs',
    'dependency-runtime.mjs',
    'evaluation.mjs',
    'producer-common.mjs',
    'legacy-producer.mjs',
    'producer.mjs',
    'usage-producer.mjs',
    'predecessor.mjs',
    'ordinary-gate-producer.mjs',
    'ordinary-gate-predecessor.mjs',
    'session-new.mjs',
    'session-old.mjs',
    'session-reopened.mjs',
  ];
  for (const file of workerFiles) {
    const path = `tools/budget-replay-compat/${file}`;
    const bytes = readFileSync(join(tooling, file));
    if (expectedFiles) {
      const expected = expectedFiles.get(path);
      assert.ok(expected, `Worker absent from outer manifest: ${path}`);
      assert.equal(bytes.length, expected.bytes, path);
      assert.equal(digest(bytes), expected.sha256, path);
    }
    cpSync(join(tooling, file), join(owned, file));
  }
  writeFileSync(
    join(owned, 'evaluation-context.json'),
    `${JSON.stringify(
      {
        directory: evaluation?.directory ?? join(owned, 'evaluation'),
        phase: evaluation?.phase ?? 'required-smoke',
        mutationId: evaluation?.mutationId ?? null,
        currentSourceRoot: roots.currentSourceRoot,
        outerSourceManifestSha256: evaluation?.manifestPath
          ? digest(readFileSync(evaluation.manifestPath))
          : null,
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(evaluation?.directory ?? join(owned, 'evaluation'), { recursive: true });

  writeSync(1, `Budget replay evidence: ${owned}\n`);
  const dependencyRuntime = snapshotDependencyClosure(
    roots.installedDependencyRoot,
    owned,
    pins,
    portableBytes,
  );
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
  if (verifyGuards) checkClosureGuards(owned, tooling, environment);

  return { producerFiles, frozenManifest, dependencyRuntime, workerFiles };
}
