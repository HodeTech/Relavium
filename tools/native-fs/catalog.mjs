/** ADR-0125 finite delivery inventory. These are adapter targets, not whole-CLI support claims. */
export const NATIVE_TARGETS = Object.freeze([
  'aarch64-apple-darwin',
  'aarch64-pc-windows-msvc',
  'aarch64-unknown-linux-gnu',
  'aarch64-unknown-linux-musl',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
  'x86_64-unknown-linux-musl',
]);
export const NATIVE_DIRECTORY = 'native/fs-metadata/runtime';
export const NATIVE_DIST_DIRECTORY = 'dist/native-fs';
export const NATIVE_HELPER = 'src/engine/tool-host/fs-native-metadata.ts';
export const NATIVE_SOURCE_IMPORT = '../../../native/fs-metadata/runtime/loader.cjs';
export const NATIVE_OUTPUT_IMPORT = './native-fs/loader.cjs';
export const NATIVE_TOOLCHAIN = '1.98.0';
export const NATIVE_BUILD_INPUTS = Object.freeze([
  '.github/workflows/native-fs.yml',
  'apps/cli/src/engine/tool-host/fs-native-loader-integrity.ts',
  'apps/cli/src/engine/tool-host/fs-native-metadata.ts',
  'tools/cli-package/files.mjs',
  'tools/native-fs/assemble.mjs',
  'tools/native-fs/assets.mjs',
  'tools/native-fs/build.mjs',
  'tools/native-fs/catalog.mjs',
  'tools/native-fs/causal-assets.mjs',
  'tools/native-fs/check-target.mjs',
  'tools/native-fs/ci-build.mjs',
  'tools/native-fs/gnu.Dockerfile',
  'tools/native-fs/loader.cjs',
  'tools/native-fs/lifecycle.mjs',
  'tools/native-fs/profile-catalog.mjs',
  'tools/native-fs/profile.mjs',
  'tools/native-fs/musl.Dockerfile',
  'tools/native-fs/probe.mjs',
  'tools/native-fs/stage.mjs',
]);
export const NATIVE_LIMITS = Object.freeze({
  manifestBytes: 128 * 1024,
  binaryBytes: 8 * 1024 * 1024,
  sourceFiles: 128,
  sourceBytes: 1024 * 1024,
});
// Reviewed shim bytes; a loader change requires a deliberate inventory-pin change too.
export const NATIVE_LOADER_SHA256 =
  '9f234956841c944cdff8024f644fdd08bfcbda7647c0a2359a39ed90ff912b3f';

export function hostTarget(platform = process.platform, arch = process.arch, libc) {
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined;
  if (cpu === undefined) throw new Error('NATIVE_FS_UNSUPPORTED_TARGET');
  if (platform === 'darwin') return `${cpu}-apple-darwin`;
  if (platform === 'win32') return `${cpu}-pc-windows-msvc`;
  if (platform === 'linux' && ['gnu', 'musl'].includes(libc)) return `${cpu}-unknown-linux-${libc}`;
  throw new Error('NATIVE_FS_UNSUPPORTED_TARGET');
}
