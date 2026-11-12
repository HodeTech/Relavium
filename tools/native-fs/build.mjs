/** Contributor-only current-target build. Never used as an installed-user fallback. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNativeProfile } from './profile.mjs';
import {
  inspectNativeAssets,
  nativeSourceBinding,
  NativeAssetError,
  sha256,
  writeNativeAssets,
} from './assets.mjs';
import {
  NATIVE_DIRECTORY,
  NATIVE_LOADER_SHA256,
  NATIVE_TOOLCHAIN,
  hostTarget,
} from './catalog.mjs';
const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const native = join(repository, 'apps/cli/native/fs-metadata');
const libc =
  process.platform === 'linux'
    ? process.report.getReport().header.glibcVersionRuntime
      ? 'gnu'
      : 'musl'
    : 'none';
const target = hostTarget(process.platform, process.arch, libc);
const profileRequested = process.argv.length === 3 && process.argv[2] === '--verify-profile';
if (!(process.argv.length === 2 || profileRequested)) throw new Error('NATIVE_FS_BUILD_ARGUMENTS');
function executeProtocol(bytes) {
  const probeRoot = mkdtempSync(join(tmpdir(), 'relavium-native-probe-'));
  let execution;
  try {
    const probeFile = join(probeRoot, 'metadata.node');
    writeFileSync(probeFile, bytes, { flag: 'wx', mode: 0o600 });
    const probe = spawnSync(
      process.execPath,
      [join(repository, 'tools/native-fs/probe.mjs'), probeFile],
      {
        encoding: 'utf8',
        shell: false,
        timeout: 30_000,
        maxBuffer: 16 * 1024,
      },
    );
    if (probe.status !== 0 || probe.error !== undefined) throw new Error('NATIVE_FS_BUILD_ABI');
    execution = JSON.parse(probe.stdout);
    if (
      execution.node !== process.version ||
      execution.platform !== process.platform ||
      execution.arch !== process.arch ||
      execution.libc !== libc ||
      execution.protocol !== 1
    )
      throw new Error('NATIVE_FS_BUILD_ABI');
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
  return execution;
}
function buildCurrent() {
  const binding = nativeSourceBinding(repository);
  let present;
  try {
    present = inspectNativeAssets(join(repository, 'apps/cli', NATIVE_DIRECTORY), { binding });
  } catch (error) {
    if (!(error instanceof NativeAssetError)) throw error;
  }
  const existing = present?.manifest.assets.find((asset) => asset.target === target);
  if (existing !== undefined && !profileRequested) {
    executeProtocol(present.files.get(`${target}.node`));
    verifyStagedLoader();
    if (JSON.stringify(nativeSourceBinding(repository)) !== JSON.stringify(binding))
      throw new Error('NATIVE_FS_BUILD_SOURCE_CHANGED');
    console.log(
      JSON.stringify({
        target,
        sha256: existing.sha256,
        scope: present.manifest.scope,
        evidence: 'native-protocol-v1-only',
        build: 'verified-source-bound-reuse',
      }),
    );
    return;
  }
  // Cargo also reads ancestor/global configuration. It must not supply an unbound linker,
  // wrapper or source replacement outside this reviewed recipe. No config contents are read.
  const configurationDirectories = new Set([process.env.CARGO_HOME ?? join(homedir(), '.cargo')]);
  for (let directory = native; ; directory = dirname(directory)) {
    configurationDirectories.add(join(directory, '.cargo'));
    if (directory === dirname(directory)) break;
  }
  for (const directory of configurationDirectories) {
    if (['config', 'config.toml'].some((name) => existsSync(join(directory, name))))
      throw new Error('NATIVE_FS_BUILD_UNBOUND_CARGO_CONFIG');
  }

  // Contributor inputs are explicit; ambient wrappers and flags cannot silently alter this recipe.
  const buildEnvironment = { ...process.env, CARGO_INCREMENTAL: '0' };
  for (const key of Object.keys(buildEnvironment)) {
    if (
      /^(?:RUSTC|RUSTC_BOOTSTRAP|RUSTFLAGS|RUSTDOCFLAGS|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_(?!HOME$).*)$/u.test(
        key,
      )
    )
      delete buildEnvironment[key];
  }
  buildEnvironment.CARGO_INCREMENTAL = '0';
  const rustFlags = [
    `--remap-path-prefix=${repository}=relavium`,
    `--remap-path-prefix=${process.env.CARGO_HOME ?? join(homedir(), '.cargo')}=cargo-registry`,
  ];
  if (target.endsWith('-musl')) rustFlags.push('-C', 'target-feature=-crt-static');
  buildEnvironment.CARGO_ENCODED_RUSTFLAGS = rustFlags.join('\u001f');
  if (process.platform === 'darwin') buildEnvironment.MACOSX_DEPLOYMENT_TARGET = '11.0';
  const compiler = spawnSync('rustc', [`+${NATIVE_TOOLCHAIN}`, '--version'], {
    cwd: native,
    encoding: 'utf8',
    shell: false,
  });
  if (compiler.status !== 0 || !compiler.stdout.startsWith(`rustc ${NATIVE_TOOLCHAIN} `))
    throw new Error('NATIVE_FS_BUILD_TOOLCHAIN');
  const build = spawnSync(
    'cargo',
    [`+${NATIVE_TOOLCHAIN}`, 'build', '--release', '--locked', '--target', target],
    { cwd: native, stdio: 'inherit', shell: false, env: buildEnvironment },
  );
  if (build.status !== 0 || build.error !== undefined) throw new Error('NATIVE_FS_BUILD_FAILED');
  const library =
    process.platform === 'win32'
      ? 'relavium_fs_metadata.dll'
      : process.platform === 'darwin'
        ? 'librelavium_fs_metadata.dylib'
        : 'librelavium_fs_metadata.so';
  const bytes = readFileSync(join(native, 'target', target, 'release', library));
  const loader = readFileSync(join(repository, 'tools/native-fs/loader.cjs'));
  const execution = executeProtocol(bytes);
  const validation = profileRequested
    ? validateNativeProfile({ repository, native, target, bytes, environment: buildEnvironment })
    : undefined;
  if (
    sha256(loader) !== NATIVE_LOADER_SHA256 ||
    JSON.stringify(nativeSourceBinding(repository)) !== JSON.stringify(binding)
  )
    throw new Error('NATIVE_FS_BUILD_SOURCE_CHANGED');
  const destination = join(repository, 'apps/cli', NATIVE_DIRECTORY);
  const manifest = {
    version: 1,
    nodeApi: 8,
    protocol: 1,
    toolchain: NATIVE_TOOLCHAIN,
    scope: 'development-current',
    ...binding,
    loaderSha256: NATIVE_LOADER_SHA256,
    assets: [
      {
        target,
        bytes: bytes.length,
        sha256: sha256(bytes),
        execution,
        ...(validation === undefined ? {} : { validation }),
      },
    ],
  };
  writeNativeAssets(
    destination,
    manifest,
    new Map([
      ['loader.cjs', loader],
      ['THIRD_PARTY_NOTICES.txt', readFileSync(join(native, 'THIRD_PARTY_NOTICES.txt'))],
      [`${target}.node`, bytes],
    ]),
  );
  verifyStagedLoader();
  // The receipt proves native execution of protocol v1 only. Profile acceptance has separate gates.
  console.log(
    JSON.stringify({
      target,
      sha256: sha256(bytes),
      scope: manifest.scope,
      evidence: profileRequested
        ? 'named-rust-profile-and-node-lifecycle'
        : 'native-protocol-v1-only',
    }),
  );
}
function verifyStagedLoader() {
  const result = spawnSync(
    process.execPath,
    [
      join(repository, 'tools/native-fs/probe.mjs'),
      '--loader',
      join(repository, 'apps/cli', NATIVE_DIRECTORY, 'loader.cjs'),
    ],
    { encoding: 'utf8', shell: false, timeout: 30_000, maxBuffer: 16 * 1024 },
  );
  if (result.error !== undefined || result.status !== 0)
    throw new Error('NATIVE_FS_BUILD_PLAIN_NODE_LOADER');
  const facts = JSON.parse(result.stdout);
  if (
    facts.node !== process.version ||
    facts.platform !== process.platform ||
    facts.arch !== process.arch ||
    facts.libc !== libc ||
    facts.protocol !== 1
  )
    throw new Error('NATIVE_FS_BUILD_PLAIN_NODE_LOADER');
}
buildCurrent();
