/** Bind the sole prepack result to independently inspected bytes. No build or archive extraction. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectPackageArchive } from './archive.mjs';
import { originFromEnvironment, validatePackageReceipt } from './binding.mjs';
import { flatFiles, oneTarball, readOrdinaryFile } from './files.mjs';
import { isolatedEnvironment, runCommand } from './process.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));

export function expectedPackManifest(root = repository) {
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

export function finalizedPublicFiles(root = repository) {
  const cli = join(root, 'apps/cli');
  const files = new Map();
  const graph = JSON.parse(readOrdinaryFile(join(cli, 'dist/metafile-esm.json'), 4 * 1024 * 1024));
  const outputs = Object.keys(graph.outputs).map((path) => path.replaceAll('\\', '/'));
  assert.ok(outputs.length > 0 && outputs.length <= 256);
  for (const path of outputs) {
    assert.match(path, /^dist\/[A-Za-z0-9_-]+\.js$/u, 'PACKED_CLI_UNREVIEWED_GRAPH_OUTPUT');
    files.set(`package/${path}`, readOrdinaryFile(join(cli, path), 8 * 1024 * 1024));
  }
  assert.deepEqual(
    readdirSync(join(cli, 'dist')).sort(),
    [...outputs.map((path) => basename(path)), 'metafile-esm.json'].sort(),
    'PACKED_CLI_EXTRA_FINAL_OUTPUT',
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

export async function sealPackage(artifactDirectory) {
  const tarball = oneTarball(artifactDirectory);
  const source = (
    await runCommand('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], {
      cwd: repository,
      env: isolatedEnvironment(repository),
    })
  ).stdout.trim();
  assert.match(source, /^[0-9a-f]{40}$/u);
  const dirty =
    (
      await runCommand('git', ['status', '--porcelain'], {
        cwd: repository,
        env: isolatedEnvironment(repository),
      })
    ).stdout !== '';
  const archive = inspectPackageArchive(readOrdinaryFile(tarball, 16 * 1024 * 1024), {
    expectedFiles: finalizedPublicFiles(),
    expectedPackage: expectedPackManifest(),
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
    nodeMajor: 24,
    allowLocal: origin.kind === 'local',
  });
  writeFileSync(
    join(artifactDirectory, 'package-test-receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx' },
  );
  return receipt;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 3, 'one artifact directory required');
  console.log(JSON.stringify(await sealPackage(resolve(process.argv[2]))));
}
