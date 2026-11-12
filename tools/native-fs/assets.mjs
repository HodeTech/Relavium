/** Bounded source-bound asset validation, shared by build, closure and package production. */
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { validateProfileEvidence } from './profile.mjs';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readOrdinaryFile } from '../cli-package/files.mjs';
import {
  NATIVE_BUILD_INPUTS,
  NATIVE_DIRECTORY,
  NATIVE_DIST_DIRECTORY,
  NATIVE_LIMITS,
  NATIVE_LOADER_SHA256,
  NATIVE_TARGETS,
  NATIVE_TOOLCHAIN,
  hostTarget,
} from './catalog.mjs';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[0-9a-f]{64}$/u;
const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
export class NativeAssetError extends Error {
  constructor(code) {
    super(`NATIVE_FS_ASSET_${code}`);
    this.name = 'NativeAssetError';
    this.code = code;
  }
}
function refuse(code) {
  throw new NativeAssetError(code);
}
/** Format/CPU identity is independent of the execution receipt; libc still needs native execution. */
export function assertNativeBinary(bytes, target) {
  const arm = target.startsWith('aarch64');
  if (target.includes('-apple-')) assertMachBinary(bytes, arm);
  else if (target.includes('-windows-')) assertPeBinary(bytes, arm);
  else if (target.includes('-linux-')) assertElfBinary(bytes, arm);
  else refuse('BINARY_TARGET');
}
function assertMachBinary(bytes, arm) {
  if (
    bytes.length < 32 ||
    bytes.readUInt32LE(0) !== 0xfeedfacf ||
    bytes.readUInt32LE(4) !== (arm ? 0x0100000c : 0x01000007)
  )
    refuse('BINARY_TARGET');
}
function assertPeBinary(bytes, arm) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') refuse('BINARY_TARGET');
  const offset = bytes.readUInt32LE(60);
  if (
    offset < 64 ||
    offset + 24 > bytes.length ||
    bytes.readUInt32LE(offset) !== 0x00004550 ||
    bytes.readUInt16LE(offset + 4) !== (arm ? 0xaa64 : 0x8664)
  )
    refuse('BINARY_TARGET');
}
function assertElfBinary(bytes, arm) {
  if (
    bytes.length < 64 ||
    bytes.readUInt32BE(0) !== 0x7f454c46 ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== (arm ? 183 : 62)
  )
    refuse('BINARY_TARGET');
}

function read(path, limit) {
  try {
    const stat = lstatSync(path);
    if (stat.nlink !== 1) refuse('FILE_KIND');
    return readOrdinaryFile(path, limit);
  } catch (error) {
    if (error instanceof NativeAssetError) throw error;
    refuse('UNREADABLE');
  }
}
export function captureNativeInputs(repository) {
  const root = join(repository, 'apps/cli/native/fs-metadata');
  const names = [
    'Cargo.lock',
    'Cargo.toml',
    'build.rs',
    'rust-toolchain.toml',
    'THIRD_PARTY_NOTICES.txt',
  ];
  function visit(directory, prefix) {
    if (!lstatSync(directory).isDirectory()) refuse('SOURCE_KIND');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!/^[a-z][a-z0-9_-]*(?:\.rs)?$/u.test(entry.name)) refuse('SOURCE_NAME');
      if (entry.isDirectory()) visit(join(directory, entry.name), `${prefix}/${entry.name}`);
      else if (entry.isFile() && entry.name.endsWith('.rs')) names.push(`${prefix}/${entry.name}`);
      else refuse('SOURCE_KIND');
      if (names.length > NATIVE_LIMITS.sourceFiles) refuse('SOURCE_BOUND');
    }
  }
  visit(join(root, 'src'), 'src');
  names.sort();
  const sourceFiles = names.map((name) => {
    const bytes = read(join(root, name), NATIVE_LIMITS.sourceBytes);
    return {
      path: `apps/cli/native/fs-metadata/${name}`,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
  const buildFiles = NATIVE_BUILD_INPUTS.map((path) => {
    const bytes = read(join(repository, path), NATIVE_LIMITS.sourceBytes);
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const toolchain = read(join(root, 'rust-toolchain.toml'), 1024).toString('utf8');
  if (!toolchain.includes(`channel = "${NATIVE_TOOLCHAIN}"`)) refuse('TOOLCHAIN');
  const files = [...sourceFiles, ...buildFiles].sort((left, right) =>
    left.path < right.path ? -1 : 1,
  );
  const byPath = new Map(files.map((entry) => [entry.path, entry.sha256]));
  return {
    files,
    binding: {
      sourceSha256: sha256(
        Buffer.from(
          JSON.stringify(
            sourceFiles.map((entry) => [
              entry.path.slice('apps/cli/native/fs-metadata/'.length),
              entry.sha256,
            ]),
          ),
        ),
      ),
      buildSha256: sha256(
        Buffer.from(JSON.stringify(buildFiles.map((entry) => [entry.path, entry.sha256]))),
      ),
      lockSha256: byPath.get('apps/cli/native/fs-metadata/Cargo.lock'),
      noticesSha256: byPath.get('apps/cli/native/fs-metadata/THIRD_PARTY_NOTICES.txt'),
    },
  };
}
export function nativeSourceBinding(repository) {
  return captureNativeInputs(repository).binding;
}
export function validateNativeManifest(value, { complete = false, binding } = {}) {
  if (
    !exact(value, [
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
    value.version !== 1 ||
    value.nodeApi !== 8 ||
    value.protocol !== 1 ||
    value.toolchain !== NATIVE_TOOLCHAIN ||
    !['development-current', 'release-complete'].includes(value.scope) ||
    value.loaderSha256 !== NATIVE_LOADER_SHA256 ||
    !SHA.test(value.sourceSha256) ||
    !SHA.test(value.buildSha256) ||
    !SHA.test(value.lockSha256) ||
    !SHA.test(value.noticesSha256) ||
    !Array.isArray(value.assets)
  )
    refuse('MANIFEST');
  const targets = value.assets.map((asset) => asset?.target);
  if (
    value.scope === 'release-complete'
      ? !isDeepStrictEqual(targets, NATIVE_TARGETS)
      : targets.length !== 1 || !NATIVE_TARGETS.includes(targets[0])
  )
    refuse('TARGET_INVENTORY');
  if (complete && value.scope !== 'release-complete') refuse('INCOMPLETE');
  if (
    binding !== undefined &&
    (value.sourceSha256 !== binding.sourceSha256 ||
      value.buildSha256 !== binding.buildSha256 ||
      value.lockSha256 !== binding.lockSha256 ||
      value.noticesSha256 !== binding.noticesSha256)
  )
    refuse('SOURCE_BINDING');
  for (const asset of value.assets) validateNativeAsset(asset, value.scope);
  return value;
}
function validateExecutionReceipt(execution, scope) {
  if (
    !exact(execution, ['node', 'platform', 'arch', 'libc', 'libcVersion', 'protocol']) ||
    execution.protocol !== 1 ||
    !(execution.libc === 'none'
      ? execution.libcVersion === 'none'
      : /^\d+\.\d+(?:\.\d+)?$/u.test(execution.libcVersion)) ||
    (scope === 'release-complete' &&
      (execution.node !== 'v22.0.0' ||
        (execution.libc === 'gnu' && execution.libcVersion !== '2.28') ||
        (execution.libc === 'musl' && execution.libcVersion !== '1.2.5'))) ||
    !/^v(?:22|2[4-9]|[3-9]\d)\.\d+\.\d+$/u.test(execution.node)
  )
    refuse('EXECUTION_RECEIPT');
}
function validateNativeAsset(asset, scope) {
  if (
    !exact(asset, [
      'target',
      'bytes',
      'sha256',
      'execution',
      ...(Object.hasOwn(asset, 'validation') ? ['validation'] : []),
    ]) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1 ||
    asset.bytes > NATIVE_LIMITS.binaryBytes ||
    !SHA.test(asset.sha256)
  )
    refuse('EXECUTION_RECEIPT');
  validateExecutionReceipt(asset.execution, scope);
  if (scope === 'release-complete' && asset.validation === undefined) refuse('PROFILE_REQUIRED');
  if (asset.validation !== undefined) {
    try {
      validateProfileEvidence(asset.validation, asset.execution.platform, {
        requireDistinctOwner: scope === 'release-complete',
      });
    } catch {
      refuse('PROFILE_EVIDENCE');
    }
  }
  let observed;
  try {
    observed = hostTarget(asset.execution.platform, asset.execution.arch, asset.execution.libc);
  } catch {
    refuse('EXECUTION_RECEIPT');
  }
  if (
    observed !== asset.target ||
    (asset.execution.platform !== 'linux' && asset.execution.libc !== 'none')
  )
    refuse('EXECUTION_RECEIPT');
}
export function inspectNativeAssets(directory, options = {}) {
  let manifest;
  try {
    manifest = JSON.parse(
      read(join(directory, 'native-assets.json'), NATIVE_LIMITS.manifestBytes).toString('utf8'),
    );
  } catch (error) {
    if (error instanceof NativeAssetError) throw error;
    refuse('MANIFEST');
  }
  validateNativeManifest(manifest, options);
  const expected = [
    'loader.cjs',
    'native-assets.json',
    'THIRD_PARTY_NOTICES.txt',
    ...manifest.assets.map((asset) => `${asset.target}.node`),
  ].sort();
  if (
    !lstatSync(directory).isDirectory() ||
    !isDeepStrictEqual(readdirSync(directory).sort(), expected)
  )
    refuse('INVENTORY');
  const files = new Map(
    expected.map((name) => [name, read(join(directory, name), nativeFileLimit(name))]),
  );
  if (sha256(files.get('THIRD_PARTY_NOTICES.txt')) !== manifest.noticesSha256) refuse('NOTICES');
  if (sha256(files.get('loader.cjs')) !== NATIVE_LOADER_SHA256) refuse('LOADER');
  for (const asset of manifest.assets) {
    const bytes = files.get(`${asset.target}.node`);
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) refuse('BINARY_BINDING');
    assertNativeBinary(bytes, asset.target);
  }
  return { manifest, files };
}
export function writeNativeAssets(directory, manifest, files) {
  validateNativeManifest(manifest);
  // Always replace a complete previously validated inventory, never merge stale target bytes.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  for (const [name, bytes] of files) {
    assert.ok(
      name === 'loader.cjs' ||
        name === 'THIRD_PARTY_NOTICES.txt' ||
        NATIVE_TARGETS.some((target) => name === `${target}.node`),
    );
    writeFileSync(join(directory, name), bytes, { flag: 'wx', mode: 0o644 });
    chmodSync(join(directory, name), 0o644);
  }
  writeFileSync(join(directory, 'native-assets.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o644,
  });
  chmodSync(join(directory, 'native-assets.json'), 0o644);
  inspectNativeAssets(directory);
}
export function copyNativeAssets({
  repository,
  candidate = repository,
  destination,
  complete = false,
}) {
  const binding = nativeSourceBinding(candidate);
  const checked = inspectNativeAssets(join(repository, 'apps/cli', NATIVE_DIRECTORY), {
    binding,
    complete,
  });
  writeNativeAssets(
    destination ?? join(candidate, 'apps/cli', NATIVE_DIST_DIRECTORY),
    checked.manifest,
    new Map([...checked.files].filter(([name]) => name !== 'native-assets.json')),
  );
  return checked.manifest;
}

function nativeFileLimit(name) {
  if (name.endsWith('.node')) return NATIVE_LIMITS.binaryBytes;
  if (name === 'THIRD_PARTY_NOTICES.txt') return NATIVE_LIMITS.sourceBytes;
  return NATIVE_LIMITS.manifestBytes;
}
