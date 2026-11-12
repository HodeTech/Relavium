/** Synthetic validator fixtures only: these bytes are NEVER native execution or ABI evidence. */
import { NODE_LIFECYCLE_CASES, rustPopulation } from './profile-catalog.mjs';
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeSourceBinding, sha256, writeNativeAssets } from './assets.mjs';
import {
  NATIVE_BUILD_INPUTS,
  NATIVE_DIRECTORY,
  NATIVE_TARGETS,
  NATIVE_TOOLCHAIN,
  NATIVE_LOADER_SHA256,
} from './catalog.mjs';
export function syntheticNativeAssets(repository, { complete = true } = {}) {
  const root = join(repository, 'apps/cli/native/fs-metadata');
  for (const name of NATIVE_BUILD_INPUTS) {
    mkdirSync(dirname(join(repository, name)), { recursive: true });
    writeFileSync(
      join(repository, name),
      readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url))),
    );
  }
  for (const [name, text] of [
    ['Cargo.lock', '# synthetic lock'],
    ['THIRD_PARTY_NOTICES.txt', 'SYNTHETIC NOTICES FIXTURE'],
    ['Cargo.toml', '# synthetic manifest'],
    ['build.rs', '// synthetic'],
    ['rust-toolchain.toml', `[toolchain]\nchannel = "${NATIVE_TOOLCHAIN}"\n`],
    ['src/lib.rs', '// synthetic validator input'],
  ]) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  const loader = readFileSync(fileURLToPath(new URL('./loader.cjs', import.meta.url)));
  const files = new Map([
    ['loader.cjs', loader],
    ['THIRD_PARTY_NOTICES.txt', Buffer.from('SYNTHETIC NOTICES FIXTURE')],
  ]);
  const targets = complete ? NATIVE_TARGETS : [NATIVE_TARGETS[0]];
  const assets = targets.map((target) => {
    const bytes = Buffer.alloc(256);
    bytes.write(`SYNTHETIC VALIDATOR FIXTURE: NOT EXECUTABLE ${target}`, 128);
    const arm = target.startsWith('aarch64');
    if (target.includes('-apple-')) {
      bytes.writeUInt32LE(0xfeedfacf, 0);
      bytes.writeUInt32LE(arm ? 0x0100000c : 0x01000007, 4);
    } else if (target.includes('-windows-')) {
      bytes.write('MZ');
      bytes.writeUInt32LE(64, 60);
      bytes.writeUInt32LE(0x00004550, 64);
      bytes.writeUInt16LE(arm ? 0xaa64 : 0x8664, 68);
    } else {
      bytes.writeUInt32BE(0x7f454c46, 0);
      bytes[4] = 2;
      bytes[5] = 1;
      bytes.writeUInt16LE(arm ? 183 : 62, 18);
    }
    files.set(`${target}.node`, bytes);
    return {
      target,
      bytes: bytes.length,
      sha256: sha256(bytes),
      validation: {
        version: 1,
        rustPassed: rustPopulation(
          target.includes('-apple-') ? 'darwin' : target.includes('-windows-') ? 'win32' : 'linux',
        ).passed,
        rustIgnored: rustPopulation(
          target.includes('-apple-') ? 'darwin' : target.includes('-windows-') ? 'win32' : 'linux',
        ).ignored,
        nodeCases: [...NODE_LIFECYCLE_CASES],
        requiresCreationMaskProbe: false,
      },
      execution: {
        node: 'v22.0.0',
        protocol: 1,
        platform: target.includes('apple')
          ? 'darwin'
          : target.includes('windows')
            ? 'win32'
            : 'linux',
        arch: target.startsWith('aarch64') ? 'arm64' : 'x64',
        libcVersion: target.endsWith('-gnu') ? '2.28' : target.endsWith('-musl') ? '1.2.5' : 'none',
        libc: target.endsWith('-gnu') ? 'gnu' : target.endsWith('-musl') ? 'musl' : 'none',
      },
    };
  });
  const manifest = {
    version: 1,
    nodeApi: 8,
    protocol: 1,
    toolchain: NATIVE_TOOLCHAIN,
    scope: complete ? 'release-complete' : 'development-current',
    ...nativeSourceBinding(repository),
    loaderSha256: NATIVE_LOADER_SHA256,
    assets,
  };
  const directory = join(repository, 'apps/cli', NATIVE_DIRECTORY);
  writeNativeAssets(directory, manifest, files);
  return { directory, manifest, files };
}
