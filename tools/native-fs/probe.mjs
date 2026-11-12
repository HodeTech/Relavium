/** Contributor/CI-only child: a receipt exists only after the actual native call returns. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const loaderMode = process.argv.length === 4 && process.argv[2] === '--loader';
if (!(process.argv.length === 3 || loaderMode)) throw new Error('NATIVE_FS_PROBE_ARGUMENTS');
let addon;
if (loaderMode) {
  // Contributor child imports only the exact source-bound staged shim supplied by build.mjs.
  // eslint-disable-next-line no-restricted-syntax -- Tooling-only plain Node CJS namespace regression probe; never a product loader.
  const namespace = await import(pathToFileURL(process.argv[3]).href);
  assert.equal(typeof namespace.loadFsMetadataAddon, 'function');
  addon = namespace.loadFsMetadataAddon();
} else addon = createRequire(import.meta.url)(process.argv[2]);
assert.equal(typeof addon.protocolVersion, 'function');
assert.equal(addon.protocolVersion(), 1);
const libc =
  process.platform === 'linux'
    ? process.report.getReport().header.glibcVersionRuntime
      ? 'gnu'
      : 'musl'
    : 'none';
let libcVersion = 'none';
if (libc === 'gnu') libcVersion = process.report.getReport().header.glibcVersionRuntime;
if (libc === 'musl') {
  const cpu = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : undefined;
  assert.ok(cpu !== undefined);
  const result = spawnSync(`/lib/ld-musl-${cpu}.so.1`, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 16 * 1024,
    shell: false,
  });
  assert.equal(result.error, undefined);
  const version = /^Version (\d+\.\d+\.\d+)$/mu.exec(result.stderr);
  assert.ok(version !== null);
  libcVersion = version[1];
}
console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    libc,
    libcVersion,
    protocol: 1,
  }),
);
