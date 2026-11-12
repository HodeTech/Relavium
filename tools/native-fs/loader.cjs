'use strict';
/* global __dirname: readonly */
// ADR-0125: trusted package-relative inventory only. No lookup, download, compiler or fallback.
const { createHash } = require('node:crypto');
const {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} = require('node:fs');
const { join } = require('node:path');
const TARGETS = Object.freeze([
  'aarch64-apple-darwin',
  'aarch64-pc-windows-msvc',
  'aarch64-unknown-linux-gnu',
  'aarch64-unknown-linux-musl',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
  'x86_64-unknown-linux-musl',
]);
function refuse() {
  throw new Error('NATIVE_FS_ASSET_UNAVAILABLE');
}
function exact(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function ordinary(name, limit) {
  const path = join(__dirname, name);
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1n ||
    before.size > BigInt(limit)
  )
    refuse();
  const same = (left, right) =>
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!same(before, opened)) refuse();
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (
      BigInt(bytes.length) !== before.size ||
      !same(before, after) ||
      current.isSymbolicLink() ||
      !same(before, current)
    )
      refuse();
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function target() {
  let cpu;
  if (process.arch === 'x64') cpu = 'x86_64';
  else if (process.arch === 'arm64') cpu = 'aarch64';
  if (!cpu) refuse();
  if (process.platform === 'darwin') return `${cpu}-apple-darwin`;
  if (process.platform === 'win32') return `${cpu}-pc-windows-msvc`;
  if (process.platform === 'linux') {
    // Node's own runtime report distinguishes glibc from a native musl Node build.
    const report = process.report.getReport();
    return `${cpu}-unknown-linux-${report.header.glibcVersionRuntime ? 'gnu' : 'musl'}`;
  }
  refuse();
}
function validateManifest(manifest) {
  if (
    !exact(manifest, [
      'version',
      'nodeApi',
      'protocol',
      'toolchain',
      'scope',
      'sourceSha256',
      'buildSha256',
      'lockSha256',
      'loaderSha256',
      'noticesSha256',
      'assets',
    ]) ||
    manifest.version !== 1 ||
    manifest.nodeApi !== 8 ||
    manifest.protocol !== 1 ||
    manifest.toolchain !== '1.98.0' ||
    !['development-current', 'release-complete'].includes(manifest.scope) ||
    !['sourceSha256', 'buildSha256', 'lockSha256', 'loaderSha256', 'noticesSha256'].every((key) =>
      /^[0-9a-f]{64}$/.test(manifest[key]),
    ) ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length < 1 ||
    manifest.assets.length > 8
  )
    refuse();
}
function assetPlatform(target) {
  if (target.endsWith('-apple-darwin')) return 'darwin';
  if (target.endsWith('-windows-msvc')) return 'win32';
  return 'linux';
}
function assetLibc(target) {
  if (target.endsWith('-linux-gnu')) return 'gnu';
  if (target.endsWith('-linux-musl')) return 'musl';
  return 'none';
}
function validateExecution(asset) {
  if (
    !exact(asset.execution, ['node', 'platform', 'arch', 'libc', 'libcVersion', 'protocol']) ||
    asset.execution.platform !== assetPlatform(asset.target) ||
    asset.execution.arch !== (asset.target.startsWith('aarch64-') ? 'arm64' : 'x64') ||
    asset.execution.libc !== assetLibc(asset.target) ||
    !/^v(?:22|2[4-9]|[3-9]\d)\.\d+\.\d+$/.test(asset.execution.node) ||
    asset.execution.protocol !== 1 ||
    !(asset.execution.libc === 'none'
      ? asset.execution.libcVersion === 'none'
      : /^\d+\.\d+(?:\.\d+)?$/.test(asset.execution.libcVersion))
  )
    refuse();
}
function validateAsset(asset, previous, scope) {
  if (
    !exact(asset, [
      'target',
      'bytes',
      'sha256',
      'execution',
      ...(Object.hasOwn(asset, 'validation') ? ['validation'] : []),
    ]) ||
    !TARGETS.includes(asset.target) ||
    asset.target <= previous ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1 ||
    asset.bytes > 8388608 ||
    !/^[0-9a-f]{64}$/.test(asset.sha256)
  )
    refuse();
  validateExecution(asset);
  if (scope === 'release-complete' && asset.validation === undefined) refuse();
  if (asset.validation !== undefined) validateProfile(asset, scope);
}
function validateProfile(asset, scope) {
  if (
    !exact(asset.validation, [
      'version',
      'rustPassed',
      'rustIgnored',
      'nodeCases',
      'requiresCreationMaskProbe',
      ...(asset.target.endsWith('-windows-msvc') ? ['genuineOwnerContext'] : []),
    ]) ||
    asset.validation.version !== 1 ||
    typeof asset.validation.requiresCreationMaskProbe !== 'boolean' ||
    (asset.target.endsWith('-windows-msvc') &&
      (!['same', 'distinct'].includes(asset.validation.genuineOwnerContext) ||
        (scope === 'release-complete' && asset.validation.genuineOwnerContext !== 'distinct'))) ||
    !['rustPassed', 'rustIgnored', 'nodeCases'].every(
      (key) =>
        Array.isArray(asset.validation[key]) &&
        asset.validation[key].length <= 128 &&
        asset.validation[key].every(
          (name) => typeof name === 'string' && /^[a-zA-Z0-9_:-]{1,200}$/.test(name),
        ),
    )
  )
    refuse();
}
function loadFsMetadataAddon() {
  try {
    if (!lstatSync(__dirname).isDirectory()) refuse();
    const manifest = JSON.parse(ordinary('native-assets.json', 131072).toString('utf8'));
    validateManifest(manifest);
    if (digest(ordinary('THIRD_PARTY_NOTICES.txt', 1048576)) !== manifest.noticesSha256) refuse();
    if (digest(ordinary('loader.cjs', 65536)) !== manifest.loaderSha256) refuse();
    let previous = '';
    for (const asset of manifest.assets) {
      validateAsset(asset, previous, manifest.scope);
      previous = asset.target;
    }
    if (
      manifest.scope === 'release-complete' &&
      JSON.stringify(manifest.assets.map((asset) => asset.target)) !== JSON.stringify(TARGETS)
    )
      refuse();
    if (manifest.scope === 'development-current' && manifest.assets.length !== 1) refuse();
    const names = [
      'loader.cjs',
      'native-assets.json',
      'THIRD_PARTY_NOTICES.txt',
      ...manifest.assets.map((asset) => `${asset.target}.node`),
    ].sort();
    if (JSON.stringify(readdirSync(__dirname).sort()) !== JSON.stringify(names)) refuse();
    const selected = manifest.assets.find((asset) => asset.target === target());
    if (!selected) refuse();
    const bytes = ordinary(`${selected.target}.node`, 8388608);
    if (bytes.length !== selected.bytes || digest(bytes) !== selected.sha256) refuse();
    switch (selected.target) {
      case 'aarch64-apple-darwin':
        return require('./aarch64-apple-darwin.node');
      case 'aarch64-pc-windows-msvc':
        return require('./aarch64-pc-windows-msvc.node');
      case 'aarch64-unknown-linux-gnu':
        return require('./aarch64-unknown-linux-gnu.node');
      case 'aarch64-unknown-linux-musl':
        return require('./aarch64-unknown-linux-musl.node');
      case 'x86_64-apple-darwin':
        return require('./x86_64-apple-darwin.node');
      case 'x86_64-pc-windows-msvc':
        return require('./x86_64-pc-windows-msvc.node');
      case 'x86_64-unknown-linux-gnu':
        return require('./x86_64-unknown-linux-gnu.node');
      case 'x86_64-unknown-linux-musl':
        return require('./x86_64-unknown-linux-musl.node');
      default:
        refuse();
    }
  } catch {
    refuse();
  }
}
// Keep the named export visible to Node's CJS namespace lexer as well as require().
exports.loadFsMetadataAddon = loadFsMetadataAddon;
Object.freeze(module.exports);
