/** Install the chosen public bytes outside the checkout; never builds or repacks product code. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBootstrap } from '../cli-bootstrap/check.mjs';
import { inspectPackageArchive } from './archive.mjs';
import {
  originFromEnvironment,
  validatePackageReceipt,
  validateConsumerRecord,
} from './binding.mjs';
import { installedInventory, oneTarball, readOrdinaryFile, sha256 } from './files.mjs';
import { exerciseInstalledCommand, isolatedEnvironment, runCommand, runPnpm } from './process.mjs';
import { runInstalledSmoke } from './smoke/index.mjs';
import { completeConsumer } from './consumer-lifetime.mjs';

assert.equal(process.argv.length, 4, 'artifact and report directories required');
const repository = fileURLToPath(new URL('../../', import.meta.url));
const artifactDirectory = resolve(process.argv[2]),
  reportDirectory = resolve(process.argv[3]);
mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
const receipt = JSON.parse(
  readOrdinaryFile(join(artifactDirectory, 'package-test-receipt.json'), 512 * 1024),
);
const origin = originFromEnvironment(process.env);
const source =
  process.env.RELAVIUM_PACKAGE_SOURCE_SHA ??
  (
    await runCommand('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], {
      cwd: repository,
      env: isolatedEnvironment(repository),
    })
  ).stdout.trim();
const nodeMajor = Number(readFileSync(join(repository, '.nvmrc'), 'utf8').trim());
const expected = { source, origin, nodeMajor, allowLocal: origin.kind === 'local' };
validatePackageReceipt(receipt, expected);
const tarball = oneTarball(artifactDirectory);
const bytes = readOrdinaryFile(tarball, 16 * 1024 * 1024);
assert.equal(sha256(bytes), receipt.tarballSha256, 'PACKED_CLI_ARTIFACT_CHANGED');
assert.equal(bytes.length, receipt.archiveBytes);
inspectPackageArchive(bytes, {
  expectedFiles: new Map(
    receipt.files.map((file) => [file.path, { sha256: file.sha256, bytes: file.bytes }]),
  ),
  expectedPackage: receipt.package,
});
const home = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-package-consumer-')));
const inside = (parent, child) => {
  const part = relative(parent, child);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
};
assert.equal(inside(realpathSync(repository), home), false, 'PACKED_CLI_INSTALL_IN_WORKSPACE');
await completeConsumer({
  async exercise() {
    const env = isolatedEnvironment(home);
    writeFileSync(
      join(home, 'package.json'),
      JSON.stringify({
        name: 'relavium-package-consumer',
        private: true,
        version: '0.0.0',
        packageManager: 'pnpm@9.12.3',
        pnpm: { onlyBuiltDependencies: ['better-sqlite3', 'esbuild'] },
      }) + '\n',
    );
    const version = await runPnpm(['--version'], { cwd: home, env });
    assert.equal(version.stdout.trim(), '9.12.3', 'PACKED_CLI_PNPM_VERSION');
    // Installation uses these already-vetted bytes, not a path the publisher could later replace.
    const ownedTarball = join(home, 'artifact.tgz');
    writeFileSync(ownedTarball, bytes, { flag: 'wx' });
    const installation = await runPnpm(
      [
        'add',
        '--prod',
        '--ignore-workspace',
        '--config.engine-strict=true',
        `file:${ownedTarball}`,
      ],
      { cwd: home, env },
    );
    writeFileSync(join(reportDirectory, 'install.log'), installation.stdout + installation.stderr);
    const packageRoot = realpathSync(join(home, 'node_modules/relavium'));
    assert.ok(inside(home, packageRoot), 'PACKED_CLI_INSTALL_ESCAPED');
    const before = installedInventory(packageRoot);
    const wanted = receipt.files
      .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const sorted = (files) =>
      files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    assert.deepEqual(sorted(before), wanted, 'PACKED_CLI_INSTALLED_BYTES_DRIFT');
    if (process.platform !== 'win32')
      for (const file of receipt.files) {
        assert.equal(
          lstatSync(join(packageRoot, file.path.slice('package/'.length))).mode & 0o7777,
          file.mode,
          'PACKED_CLI_INSTALLED_MODE_DRIFT',
        );
      }
    const require = createRequire(join(packageRoot, 'package.json'));
    const dependencies = [];
    for (const name of Object.keys(receipt.package.dependencies).sort()) {
      const entry = realpathSync(
        require.resolve(
          name === '@modelcontextprotocol/sdk' ? '@modelcontextprotocol/sdk/client/index.js' : name,
        ),
      );
      assert.ok(inside(home, entry), 'PACKED_CLI_DEPENDENCY_OUTSIDE_INSTALL');
      let directory = dirname(entry),
        found = false;
      while (inside(home, directory)) {
        let content;
        try {
          content = readOrdinaryFile(join(directory, 'package.json'), 1024 * 1024);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (content !== undefined) {
          const metadata = JSON.parse(content);
          if (metadata.name === name) {
            dependencies.push({ name, version: metadata.version, manifestSha256: sha256(content) });
            found = true;
            break;
          }
        }
        directory = dirname(directory);
      }
      assert.ok(found, 'PACKED_CLI_DEPENDENCY_MANIFEST_MISSING');
    }
    const bootstrap = await runBootstrap(packageRoot);
    writeFileSync(
      join(reportDirectory, 'bootstrap-details.json'),
      JSON.stringify(bootstrap, null, 2),
    );
    const installedCommand = await exerciseInstalledCommand(home, receipt.packageVersion);
    const smoke = await runInstalledSmoke({
      packageRoot,
      supportRoot: reportDirectory,
      artifactSha256: receipt.tarballSha256,
      source,
    });
    assert.equal(smoke.success, true, 'PACKED_CLI_INSTALLED_SMOKE_FAILED');
    assert.deepEqual(installedInventory(packageRoot), before, 'PACKED_CLI_SMOKE_CHANGED_ARTIFACT');
    assert.equal(sha256(readOrdinaryFile(tarball, 16 * 1024 * 1024)), receipt.tarballSha256);
    const leg = process.env.RELAVIUM_PACKAGE_LEG ?? 'local';
    const record = {
      version: 1,
      kind: 'installed-cli-consumer',
      source,
      tarballSha256: receipt.tarballSha256,
      packageVersion: receipt.packageVersion,
      leg,
      origin,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      success: true,
      bootstrap: { controls: bootstrap.controls, entrySha256: bootstrap.entrySha256 },
      installedCommand,
      installedFiles: before,
      dependencies,
      smoke: { success: true, cases: smoke.cases.map(({ id, passed }) => ({ id, passed })) },
    };
    // Local execution is evidence for its actual host, never one of the required four remote legs.
    validateConsumerRecord(record, receipt, { ...expected, allowLocal: true });
    return record;
  },
  cleanup: () => rmSync(home, { recursive: true, force: true }),
  cleanupFailed: () => writeSync(2, 'PACKED_CLI_SECONDARY_INSTALLATION_CLEANUP_FAILED\n'),
  publish(record) {
    writeFileSync(
      join(reportDirectory, 'installed-consumer.json'),
      JSON.stringify(record, null, 2) + '\n',
      { flag: 'wx' },
    );
    console.log(
      JSON.stringify({
        source,
        sha256: receipt.tarballSha256,
        leg: record.leg,
        node: process.version,
        platform: process.platform,
        controls: record.bootstrap.controls,
        smokeCases: record.smoke.cases.length,
      }),
    );
  },
});
