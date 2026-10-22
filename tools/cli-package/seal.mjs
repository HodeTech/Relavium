/**
 * Bind the sole prepack result to independently inspected bytes. No build or archive extraction.
 * Every input is explicit: the owned candidate root, its private staging directory and the source
 * identity the producer captured from the original checkout. Nothing resolves a repository from
 * this module's own location, so a candidate copy cannot be sealed against different files.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { inspectPackageArchive } from './archive.mjs';
import { originFromEnvironment, validatePackageReceipt } from './binding.mjs';
import { flatFiles, oneTarball, readOrdinaryFile, sha256 } from './files.mjs';

export function producerNodeMajor(root) {
  const declared = readOrdinaryFile(join(root, '.nvmrc'), 20).toString('utf8').trim();
  assert.match(declared, /^[1-9]\d*$/u, 'PACKED_CLI_INVALID_PRODUCER_NODE');
  const major = Number(declared);
  assert.ok(
    Number.isSafeInteger(major) && major >= 22 && major <= 100,
    'PACKED_CLI_INVALID_PRODUCER_NODE',
  );
  return major;
}

export function expectedPackManifest(root) {
  const require = createRequire(join(root, 'apps/cli/package.json'));
  const { parse } = require('yaml');
  const catalog = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).catalog;
  const manifest = JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, value] of Object.entries(manifest[field] ?? {})) {
      if (value === 'catalog:') {
        assert.equal(typeof catalog[name], 'string', 'PACKED_CLI_UNKNOWN_CATALOG_DEPENDENCY');
        manifest[field][name] = catalog[name];
      } else if (value === 'workspace:*') {
        assert.match(name, /^@relavium\/[a-z-]+$/u);
        manifest[field][name] = JSON.parse(
          readFileSync(
            join(root, 'packages', name.slice('@relavium/'.length), 'package.json'),
            'utf8',
          ),
        ).version;
      }
    }
  }
  // pnpm removes the executed packaging lifecycle, preserving normal public metadata/scripts.
  delete manifest.scripts.prepack;
  return manifest;
}

/**
 * The finalized public files of a candidate: exactly the runtime outputs named by its staged
 * metafile, byte-identical to the finalizer's private hash record, plus canonical migrations and
 * the public documents. The finalized dist holds no map and no build metadata.
 */
export function finalizedPublicFiles(root, staging) {
  const cli = join(root, 'apps/cli');
  const files = new Map();
  const graph = JSON.parse(readOrdinaryFile(join(staging, 'metafile-esm.json'), 4 * 1024 * 1024));
  const outputs = Object.keys(graph.outputs)
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => !path.endsWith('.map'));
  assert.ok(outputs.length > 0 && outputs.length <= 256);
  const actual = [];
  for (const path of outputs) {
    assert.match(path, /^dist\/[A-Za-z0-9_-]+\.js$/u, 'PACKED_CLI_UNREVIEWED_GRAPH_OUTPUT');
    const bytes = readOrdinaryFile(join(cli, path), 8 * 1024 * 1024);
    files.set(`package/${path}`, bytes);
    actual.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  assert.deepEqual(
    readdirSync(join(cli, 'dist')).sort(),
    outputs.map((path) => basename(path)).sort(),
    'PACKED_CLI_EXTRA_FINAL_OUTPUT',
  );
  const record = JSON.parse(readOrdinaryFile(join(staging, 'finalized.json'), 1024 * 1024));
  const byPath = (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  assert.deepEqual(
    [...record.outputs].sort(byPath),
    actual.sort(byPath),
    'PACKED_CLI_FINALIZED_RECORD_DRIFT',
  );
  const canonical = flatFiles(join(root, 'packages/db/drizzle'), 'package/drizzle');
  const copied = flatFiles(join(cli, 'drizzle'), 'package/drizzle');
  assert.deepEqual(copied, canonical, 'PACKED_CLI_MIGRATION_COPY_CHANGED');
  for (const [path, bytes] of canonical) files.set(path, bytes);
  for (const name of ['package.json', 'README.md', 'CHANGELOG.md'])
    files.set(`package/${name}`, readOrdinaryFile(join(cli, name), 128 * 1024));
  files.set('package/LICENSE', readOrdinaryFile(join(root, 'LICENSE'), 128 * 1024));
  return files;
}

/**
 * @param {string} artifactDirectory the public artifact directory holding exactly one tarball
 * @param {{repository: string, staging: string, source: string, dirty: boolean}} candidate
 */
export async function sealPackage(artifactDirectory, { repository, staging, source, dirty }) {
  const tarball = oneTarball(artifactDirectory);
  assert.match(source, /^[0-9a-f]{40}$/u, 'PACKED_CLI_SOURCE_IDENTITY');
  assert.equal(typeof dirty, 'boolean', 'PACKED_CLI_SOURCE_IDENTITY');
  const archive = inspectPackageArchive(readOrdinaryFile(tarball, 16 * 1024 * 1024), {
    expectedFiles: finalizedPublicFiles(repository, staging),
    expectedPackage: expectedPackManifest(repository),
  });
  const origin = originFromEnvironment(process.env);
  const pnpm = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).packageManager;
  assert.equal(pnpm, 'pnpm@9.12.3');
  const receipt = {
    version: 1,
    mode: 'compiled_package_test',
    source,
    dirty,
    packageVersion: archive.package.version,
    tarball: basename(tarball),
    tarballSha256: archive.sha256,
    archiveBytes: archive.bytes,
    files: archive.files,
    package: archive.package,
    origin,
    toolchain: { node: process.version, pnpm: '9.12.3' },
  };
  validatePackageReceipt(receipt, {
    source,
    origin,
    nodeMajor: producerNodeMajor(repository),
    allowLocal: origin.kind === 'local',
  });
  writeFileSync(
    join(artifactDirectory, 'package-test-receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx' },
  );
  return receipt;
}
