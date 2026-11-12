/** CI-only native Linux producer: digest-pinned native images; never emulation/cross-run proof. */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
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
const tag = `relavium-native-fs-${selected.arch}-${selected.libc}-${process.getuid()}-${process.getgid()}`;
run('docker', [
  'build',
  '--no-cache',
  '--pull',
  '--file',
  `tools/native-fs/${selected.libc}.Dockerfile`,
  '--tag',
  tag,
  '--build-arg',
  `FIXTURE_UID=${process.getuid()}`,
  '--build-arg',
  `FIXTURE_GID=${process.getgid()}`,
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
  '--env',
  'RELAVIUM_REQUIRE_LOWER=1',
  '--volume',
  `${resolve('.')}:/source`,
  tag,
  'node',
  'tools/native-fs/build.mjs',
  '--verify-profile',
]);

// Compile without capabilities; the later isolated probe receives only the exact
// Cargo-reported test executable, never the source tree or network access.
const aclDirectory = mkdtempSync(join(tmpdir(), 'relavium-native-acl-'));
try {
  const compiled = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--volume',
      `${resolve('.')}:/source:ro`,
      '--volume',
      `${aclDirectory}:/probe`,
      '--env',
      'CARGO_TARGET_DIR=/probe/target',
      tag,
      'cargo',
      'test',
      '--locked',
      '--no-run',
      '--message-format=json',
      '--manifest-path',
      '/source/apps/cli/native/fs-metadata/Cargo.toml',
    ],
    {
      encoding: 'utf8',
      shell: false,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  if (compiled.error !== undefined || compiled.status !== 0 || typeof compiled.stdout !== 'string')
    throw new Error('NATIVE_FS_ACL_COMPILE');
  const lines = compiled.stdout.split('\n');
  if (lines.length > 10000) throw new Error('NATIVE_FS_ACL_ARTIFACT');
  const matches = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      throw new Error('NATIVE_FS_ACL_ARTIFACT');
    }
    if (
      item.reason === 'compiler-artifact' &&
      item.manifest_path === '/source/apps/cli/native/fs-metadata/Cargo.toml' &&
      item.target?.name === 'relavium_fs_metadata' &&
      item.profile?.test === true &&
      typeof item.executable === 'string'
    )
      matches.push(item.executable);
  }
  if (
    matches.length !== 1 ||
    !/^\/probe\/target\/debug\/deps\/relavium_fs_metadata-[0-9a-f]+$/u.test(matches[0])
  )
    throw new Error('NATIVE_FS_ACL_ARTIFACT');
  const candidate = join(aclDirectory, matches[0].slice('/probe/'.length));
  const root = realpathSync(aclDirectory);
  const actual = realpathSync(candidate);
  const within = relative(root, actual);
  const info = lstatSync(candidate);
  if (
    !info.isFile() ||
    within.startsWith(`..${sep}`) ||
    within === '..' ||
    within !== matches[0].slice('/probe/'.length) ||
    info.size <= 0 ||
    info.size > 256 * 1024 * 1024
  )
    throw new Error('NATIVE_FS_ACL_ARTIFACT');
  const binary = join(aclDirectory, 'acl-probe');
  copyFileSync(actual, binary, constants.COPYFILE_EXCL);
  chmodSync(binary, 0o555);
  run('docker', [
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,noexec',
    '--user',
    '0:0',
    '--cap-drop=ALL',
    '--cap-add=SETUID',
    '--cap-add=DAC_OVERRIDE',
    '--security-opt=no-new-privileges',
    '--mount',
    `type=bind,src=${binary},dst=/acl-probe,readonly`,
    tag,
    '/acl-probe',
    '--ignored',
    '--exact',
    'linux::tests::linux_effective_uid_acl_denies_real_uid_root',
    '--test-threads=1',
  ]);
} finally {
  rmSync(aclDirectory, { recursive: true, force: true });
}

// Separate unprivileged, networkless PID namespaces share only the owned
// fixture; both use the exact current-target addon built and verified above.
run('node', [
  'tools/native-fs/pid-namespace-custody.mjs',
  tag,
  resolve(`apps/cli/native/fs-metadata/runtime/${process.argv[2]}.node`),
]);
