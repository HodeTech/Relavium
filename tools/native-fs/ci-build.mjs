/** CI-only native Linux producer: digest-pinned native images; never emulation/cross-run proof. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const settings = Object.freeze({
  'x86_64-unknown-linux-gnu': {
    arch: 'x64',
    libc: 'gnu',
    base: 'quay.io/pypa/manylinux_2_28_x86_64@sha256:9555ba6c479fa69a2aa80ad1dc57154a60d562b19df159361d9379a02beb1e36',
    nodeSha256: '9122e50f2642afd5f6078cafd1f52ede60fc464284384f05c18a04d13d07ae5a',
  },
  'aarch64-unknown-linux-gnu': {
    arch: 'arm64',
    libc: 'gnu',
    base: 'quay.io/pypa/manylinux_2_28_aarch64@sha256:cb37f0d66c8a75abb93cf6085cad1f1427cd7208f0c0fc48359bb1eea9924f21',
    nodeSha256: '83711d29cbe46375bdffab5419f3d831892e24294169272f6c39edc364556241',
  },
  'x86_64-unknown-linux-musl': { arch: 'x64', libc: 'musl' },
  'aarch64-unknown-linux-musl': { arch: 'arm64', libc: 'musl' },
});
const selected = settings[process.argv[2]];
if (
  process.argv.length !== 3 ||
  !selected ||
  process.platform !== 'linux' ||
  process.arch !== selected.arch ||
  process.getuid() === 0
)
  throw new Error('NATIVE_FS_CI_NATIVE_HOST');
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error !== undefined || result.status !== 0) throw new Error('NATIVE_FS_CI_BUILD');
}
const tag = `relavium-native-fs-${selected.arch}-${selected.libc}`;
run('docker', [
  'build',
  '--no-cache',
  '--pull',
  '--file',
  `tools/native-fs/${selected.libc}.Dockerfile`,
  '--tag',
  tag,
  ...(selected.libc === 'gnu'
    ? [
        '--build-arg',
        `BASE_IMAGE=${selected.base}`,
        '--build-arg',
        `NODE_ARCH=${selected.arch}`,
        '--build-arg',
        `NODE_SHA256=${selected.nodeSha256}`,
      ]
    : []),
  'tools/native-fs',
]);
// The kernel/CPU and Node runtime architecture are native. Run unprivileged, with no host credentials.
run('docker', [
  'run',
  '--rm',
  '--user',
  `${process.getuid()}:${process.getgid()}`,
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--volume',
  `${resolve('.')}:/source`,
  tag,
  'node',
  'tools/native-fs/build.mjs',
  '--verify-profile',
]);
