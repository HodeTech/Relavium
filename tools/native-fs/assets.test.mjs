import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  linkSync,
  renameSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  captureNativeInputs,
  copyNativeAssets,
  inspectNativeAssets,
  nativeSourceBinding,
  NativeAssetError,
  validateNativeManifest,
  writeNativeAssets,
  sha256,
} from './assets.mjs';
import { syntheticNativeAssets } from './fixture.mjs';
import { hostTarget, NATIVE_DIRECTORY, NATIVE_TARGETS } from './catalog.mjs';
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-native-assets-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
let index = 0;
function fixture(options) {
  const root = join(scratch, `case-${index++}`);
  mkdirSync(root);
  return { root, ...syntheticNativeAssets(root, options) };
}
function refusal(work, code) {
  assert.throws(work, (error) => error instanceof NativeAssetError && error.code === code);
}

test('finite target selection covers eight targets and refuses unsupported platforms and unknown libc', () => {
  assert.equal(NATIVE_TARGETS.length, 8);
  for (const platform of ['darwin', 'win32', 'linux'])
    for (const arch of ['x64', 'arm64']) {
      for (const libc of platform === 'linux' ? ['gnu', 'musl'] : ['none'])
        assert.ok(NATIVE_TARGETS.includes(hostTarget(platform, arch, libc)));
    }
  assert.throws(() => hostTarget('linux', 'x64', undefined));
  assert.throws(() => hostTarget('freebsd', 'x64', 'none'));
  assert.throws(() => hostTarget('win32', 'ia32', 'none'));
});

test('synthetic inventory controls source, lock, target, receipt and exact byte bindings; no native proof claimed', () => {
  const value = fixture();
  assert.equal(
    inspectNativeAssets(value.directory, {
      complete: true,
      binding: nativeSourceBinding(value.root),
    }).files.size,
    11,
  );
  for (const [name, change, code] of [
    [
      'partial',
      (m) => {
        m.scope = 'development-current';
        m.assets = m.assets.slice(0, 1);
      },
      'INCOMPLETE',
    ],
    ['missing', (m) => m.assets.pop(), 'TARGET_INVENTORY'],
    [
      'protocol-only release',
      (m) => {
        delete m.assets[0].validation;
      },
      'PROFILE_REQUIRED',
    ],
    [
      'invalid capability receipt',
      (m) => {
        m.assets[0].validation.requiresCreationMaskProbe = 'false';
      },
      'PROFILE_EVIDENCE',
    ],
    [
      'imprecise runtime floor',
      (m) => {
        m.assets[0].execution.node = 'v22.13.0';
      },
      'EXECUTION_RECEIPT',
    ],
    [
      'newer GNU baseline',
      (m) => {
        m.assets.find((asset) => asset.target.endsWith('-gnu')).execution.libcVersion = '2.36';
      },
      'EXECUTION_RECEIPT',
    ],
    [
      'unknown musl baseline',
      (m) => {
        m.assets.find((asset) => asset.target.endsWith('-musl')).execution.libcVersion = '1.2.4';
      },
      'EXECUTION_RECEIPT',
    ],
    [
      'duplicate',
      (m) => {
        m.assets[1] = m.assets[0];
      },
      'TARGET_INVENTORY',
    ],
    [
      'wrong host',
      (m) => {
        m.assets[0].execution.arch = 'x64';
      },
      'EXECUTION_RECEIPT',
    ],
    [
      'cross compile claim',
      (m) => {
        m.assets[0].execution.platform = 'linux';
      },
      'PROFILE_EVIDENCE',
    ],
    [
      'toolchain',
      (m) => {
        m.toolchain = 'stable';
      },
      'MANIFEST',
    ],
    [
      'loader pin',
      (m) => {
        m.loaderSha256 = '0'.repeat(64);
      },
      'MANIFEST',
    ],
    [
      'oversize',
      (m) => {
        m.assets[0].bytes = 8 * 1024 * 1024 + 1;
      },
      'EXECUTION_RECEIPT',
    ],
  ]) {
    const copy = JSON.parse(JSON.stringify(value.manifest));
    change(copy);
    refusal(() => validateNativeManifest(copy, { complete: true }), code);
    assert.ok(name);
  }
});

test('incomplete local inventory cannot enter a candidate; stale source refuses independently', () => {
  const local = fixture({ complete: false });
  refusal(() => copyNativeAssets({ repository: local.root, complete: true }), 'INCOMPLETE');
  const full = fixture();
  appendFileSync(join(full.root, 'apps/cli/native/fs-metadata/src/lib.rs'), '\n// changed source');
  refusal(() => copyNativeAssets({ repository: full.root, complete: true }), 'SOURCE_BINDING');
});

test('candidate binding is checked against isolated chosen source, not original mutable checkout', () => {
  const original = fixture();
  const candidate = fixture();
  appendFileSync(
    join(candidate.root, 'apps/cli/native/fs-metadata/build.rs'),
    '\n// chosen source differs',
  );
  refusal(
    () =>
      copyNativeAssets({
        repository: original.root,
        candidate: candidate.root,
        destination: join(candidate.root, 'copied'),
        complete: true,
      }),
    'SOURCE_BINDING',
  );
});

test('changed shim, binary, extra files and symbolic links each fail closed', () => {
  for (const [mutate, code] of [
    [(value) => appendFileSync(join(value.directory, 'loader.cjs'), '\n// mutation'), 'LOADER'],
    [
      (value) => appendFileSync(join(value.directory, `${NATIVE_TARGETS[0]}.node`), 'mutation'),
      'BINARY_BINDING',
    ],
    [(value) => writeFileSync(join(value.directory, 'extra.node'), 'x'), 'INVENTORY'],
    [
      (value) => {
        const file = join(value.directory, `${NATIVE_TARGETS[0]}.node`);
        const bytes = readFileSync(file);
        rmSync(file);
        writeFileSync(join(value.root, 'outside'), bytes);
        symlinkSync(join(value.root, 'outside'), file);
      },
      'UNREADABLE',
    ],
  ]) {
    const value = fixture();
    mutate(value);
    refusal(() => inspectNativeAssets(value.directory), code);
  }
});

test('generated runtime and Cargo target output never enter the source identity', () => {
  const value = fixture();
  const before = nativeSourceBinding(value.root);
  mkdirSync(join(value.root, 'apps/cli/native/fs-metadata/target'));
  writeFileSync(
    join(value.root, 'apps/cli/native/fs-metadata/target/untrusted.rs'),
    'ignored build state',
  );
  assert.deepEqual(nativeSourceBinding(value.root), before);
  assert.ok(value.directory.endsWith(NATIVE_DIRECTORY));
});

test('runtime shim selects only the literal host asset and refuses tampering before native acquisition (synthetic loader witness)', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const original = Module._extensions['.node'];
  const observed = [];
  // This records acquisition only. No synthetic byte is called native execution evidence.
  Module._extensions['.node'] = (module, path) => {
    observed.push(path);
    module.exports = { synthetic: true };
  };
  const previous = process.env.RELAVIUM_FS_METADATA_LIBRARY;
  process.env.RELAVIUM_FS_METADATA_LIBRARY = join(scratch, 'model-selected.node');
  try {
    const good = fixture();
    const value = require(join(good.directory, 'loader.cjs')).loadFsMetadataAddon();
    assert.equal(value.synthetic, true);
    const libc =
      process.platform === 'linux'
        ? process.report.getReport().header.glibcVersionRuntime
          ? 'gnu'
          : 'musl'
        : 'none';
    assert.deepEqual(observed, [
      join(good.directory, `${hostTarget(process.platform, process.arch, libc)}.node`),
    ]);
    for (const mutate of [
      ...NATIVE_TARGETS.filter((name) => name.endsWith('-windows-msvc')).map(
        (target) => (value) => {
          const manifest = JSON.parse(
            readFileSync(join(value.directory, 'native-assets.json'), 'utf8'),
          );
          const asset = manifest.assets.find((entry) => entry.target === target);
          asset.execution.platform = 'darwin';
          delete asset.validation.genuineOwnerContext;
          writeFileSync(join(value.directory, 'native-assets.json'), JSON.stringify(manifest));
        },
      ),
      (value) =>
        appendFileSync(
          join(value.directory, `${hostTarget(process.platform, process.arch, libc)}.node`),
          'changed',
        ),
      (value) => {
        const manifest = JSON.parse(
          readFileSync(join(value.directory, 'native-assets.json'), 'utf8'),
        );
        manifest.assets[0].target = '../../model-selected';
        writeFileSync(join(value.directory, 'native-assets.json'), JSON.stringify(manifest));
      },
      (value) => writeFileSync(join(value.directory, 'unreviewed.node'), 'extra'),
      (value) => appendFileSync(join(value.directory, 'THIRD_PARTY_NOTICES.txt'), 'changed'),
    ]) {
      const value = fixture();
      mutate(value);
      observed.length = 0;
      assert.throws(() => require(join(value.directory, 'loader.cjs')).loadFsMetadataAddon(), {
        message: 'NATIVE_FS_ASSET_UNAVAILABLE',
      });
      assert.deepEqual(observed, []);
    }
  } finally {
    Module._extensions['.node'] = original;
    if (previous === undefined) delete process.env.RELAVIUM_FS_METADATA_LIBRARY;
    else process.env.RELAVIUM_FS_METADATA_LIBRARY = previous;
  }
});

test('installed shim admits hardlinked regular assets while retaining path and content checks', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const original = Module._extensions['.node'];
  Module._extensions['.node'] = (module) => {
    module.exports = { synthetic: true };
  };
  try {
    const value = fixture();
    const links = join(value.root, 'package-store');
    mkdirSync(links);
    for (const name of [
      'loader.cjs',
      'native-assets.json',
      'THIRD_PARTY_NOTICES.txt',
      ...NATIVE_TARGETS.map((target) => `${target}.node`),
    ]) {
      linkSync(join(value.directory, name), join(links, name));
      assert.ok(statSync(join(value.directory, name)).nlink > 1);
    }
    assert.equal(
      require(join(value.directory, 'loader.cjs')).loadFsMetadataAddon().synthetic,
      true,
    );
    const notices = join(value.directory, 'THIRD_PARTY_NOTICES.txt');
    appendFileSync(notices, 'changed');
    assert.throws(() => require(join(value.directory, 'loader.cjs')).loadFsMetadataAddon(), {
      message: 'NATIVE_FS_ASSET_UNAVAILABLE',
    });
    const symlinked = fixture();
    const manifest = join(symlinked.directory, 'native-assets.json');
    const moved = join(symlinked.root, 'manifest');
    renameSync(manifest, moved);
    symlinkSync(moved, manifest, 'file');
    assert.throws(() => require(join(symlinked.directory, 'loader.cjs')).loadFsMetadataAddon(), {
      message: 'NATIVE_FS_ASSET_UNAVAILABLE',
    });
  } finally {
    Module._extensions['.node'] = original;
  }
});

test('installed shim refuses an identity swap while its opened manifest is read', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const value = fixture();
  const manifest = join(value.directory, 'native-assets.json');
  const original = fs.readFileSync;
  let swapped = false;
  try {
    fs.readFileSync = (file, ...options) => {
      const bytes = original(file, ...options);
      if (typeof file === 'number' && !swapped) {
        swapped = true;
        renameSync(manifest, join(value.root, 'old-manifest'));
        writeFileSync(manifest, bytes);
      }
      return bytes;
    };
    assert.throws(() => require(join(value.directory, 'loader.cjs')).loadFsMetadataAddon(), {
      message: 'NATIVE_FS_ASSET_UNAVAILABLE',
    });
    assert.equal(swapped, true);
  } finally {
    fs.readFileSync = original;
  }
});

test('causal staging copies closed native inputs and opaque assets without evaluating the addon', async () => {
  const { captureCausalNativeAssets, verifyCausalNativeAssets, verifyCausalNativeInputs } =
    await import('./causal-assets.mjs');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const value = fixture();
  const graph = join(scratch, `isolated-${index++}`);
  const before = new Set(Object.keys(require.cache));
  const capture = captureCausalNativeAssets(value.root, graph);
  assert.ok(capture.inputs.some((entry) => entry.path.endsWith('Cargo.lock')));
  assert.ok(capture.inputs.some((entry) => entry.path.endsWith('fs-native-metadata.ts')));
  assert.equal(capture.assets.length, 11);
  assert.ok(capture.assets.some((entry) => entry.path.endsWith('/loader.cjs')));
  assert.ok(
    !Object.keys(require.cache).some((path) => !before.has(path) && path.startsWith(graph)),
  );
  const { verifyResolved } = await import('../usage-coverage-controls/source-graph.mjs');
  const state = {
    files: new Map(capture.inputs.map((entry) => [join(graph, entry.path), entry])),
    external: new Map(),
    infrastructure: new Map(capture.assets.map((entry) => [join(graph, entry.path), entry])),
  };
  for (const entry of capture.assets)
    assert.equal(verifyResolved(state, join(graph, entry.path)).owned, false);
  assert.equal(verifyResolved(state, join(graph, capture.inputs[0].path)).owned, true);
  verifyCausalNativeAssets(graph, capture);
  verifyCausalNativeInputs(value.root, capture);
});

test('causal staging refuses stale native receipts and never overwrites a different chosen helper', async () => {
  const { captureCausalNativeAssets } = await import('./causal-assets.mjs');
  const stale = fixture();
  appendFileSync(
    join(stale.root, 'apps/cli/native/fs-metadata/src/lib.rs'),
    '\n// source changed after native receipt',
  );
  refusal(
    () => captureCausalNativeAssets(stale.root, join(scratch, `isolated-${index++}`)),
    'SOURCE_BINDING',
  );
  const value = fixture();
  const graph = join(scratch, `isolated-${index++}`);
  const helper = join(graph, 'apps/cli/src/engine/tool-host/fs-native-metadata.ts');
  mkdirSync(join(graph, 'apps/cli/src/engine/tool-host'), { recursive: true });
  writeFileSync(helper, 'chosen isolated helper differs');
  assert.throws(
    () => captureCausalNativeAssets(value.root, graph),
    /NATIVE_FS_CAUSAL_CAPTURE_MISMATCH/u,
  );
  assert.equal(readFileSync(helper, 'utf8'), 'chosen isolated helper differs');
});

test('causal phase validation refuses mutated helper/recipe, binary hash and semantically equal swapped manifest; restoration revalidates', async () => {
  const { captureCausalNativeAssets, verifyCausalNativeAssets } =
    await import('./causal-assets.mjs');
  const value = fixture();
  const graph = join(scratch, `isolated-${index++}`);
  const capture = captureCausalNativeAssets(value.root, graph);
  for (const path of [
    'apps/cli/src/engine/tool-host/fs-native-metadata.ts',
    'tools/native-fs/build.mjs',
  ]) {
    const target = join(graph, path);
    const bytes = readFileSync(target);
    appendFileSync(target, '\n// intentional mutation');
    refusal(() => verifyCausalNativeAssets(graph, capture), 'SOURCE_BINDING');
    writeFileSync(target, bytes);
    verifyCausalNativeAssets(graph, capture);
  }
  const binary = join(graph, 'apps/cli', NATIVE_DIRECTORY, `${NATIVE_TARGETS[0]}.node`);
  const original = readFileSync(binary);
  appendFileSync(binary, 'changed');
  refusal(() => verifyCausalNativeAssets(graph, capture), 'BINARY_BINDING');
  writeFileSync(binary, original);
  verifyCausalNativeAssets(graph, capture);
  const manifest = join(graph, 'apps/cli', NATIVE_DIRECTORY, 'native-assets.json');
  const bytes = readFileSync(manifest);
  writeFileSync(manifest, JSON.stringify(JSON.parse(bytes), null, 4));
  assert.throws(() => verifyCausalNativeAssets(graph, capture), /NATIVE_FS_CAUSAL_ASSET_CHANGED/u);
  writeFileSync(manifest, bytes);
  verifyCausalNativeAssets(graph, capture);
});

test('causal isolated assets remain independent of a later moving developer input; the final developer check refuses it', async () => {
  const { captureCausalNativeAssets, verifyCausalNativeAssets, verifyCausalNativeInputs } =
    await import('./causal-assets.mjs');
  const value = fixture();
  const graph = join(scratch, `isolated-${index++}`);
  const capture = captureCausalNativeAssets(value.root, graph);
  appendFileSync(join(value.root, 'tools/native-fs/build.mjs'), '\n// moving developer recipe');
  verifyCausalNativeAssets(graph, capture);
  assert.throws(
    () => verifyCausalNativeInputs(value.root, capture),
    /NATIVE_FS_CAUSAL_SOURCE_CHANGED/u,
  );
});

test('synthetic Windows same-owner receipts cannot pass CI certification or complete eight-target assembly', () => {
  // All fixture binaries and receipts here are synthetic validator inputs, never native proof.
  for (const target of NATIVE_TARGETS.filter((name) => name.includes('-windows-'))) {
    const value = fixture();
    const asset = value.manifest.assets.find((entry) => entry.target === target);
    asset.validation.genuineOwnerContext = 'same';
    const local = { ...value.manifest, scope: 'development-current', assets: [asset] };
    validateNativeManifest(local);
    const filesFor = (selected) =>
      new Map(
        [...value.files].filter(
          ([name]) =>
            name === 'loader.cjs' ||
            name === 'THIRD_PARTY_NOTICES.txt' ||
            name === `${selected}.node`,
        ),
      );
    writeNativeAssets(value.directory, local, filesFor(target));
    const certify = () =>
      spawnSync(process.execPath, [join(value.root, 'tools/native-fs/check-target.mjs')], {
        env: { ...process.env, RELAVIUM_EXPECTED_NATIVE_TARGET: target },
        encoding: 'utf8',
        timeout: 10_000,
      });
    const refused = certify();
    assert.equal(refused.error, undefined);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /NATIVE_FS_WINDOWS_DISTINCT_OWNER_REQUIRED/u);
    asset.validation.genuineOwnerContext = 'distinct';
    writeNativeAssets(value.directory, local, filesFor(target));
    const admitted = certify();
    assert.equal(admitted.status, 0, admitted.stderr);
    const original = value.files.get(`${target}.node`);
    assert.ok(original);
    const contaminated = Buffer.concat([original, Buffer.from('RELAVIUM_NATIVE_OWNER_CONTEXT')]);
    value.files.set(`${target}.node`, contaminated);
    asset.bytes = contaminated.length;
    asset.sha256 = sha256(contaminated);
    writeNativeAssets(value.directory, local, filesFor(target));
    const testBinary = certify();
    assert.equal(testBinary.status, 1);
    assert.equal(testBinary.stdout, '');
    assert.match(testBinary.stderr, /NATIVE_FS_TEST_ONLY_BINARY/u);
    value.files.set(`${target}.node`, original);
    asset.bytes = original.length;
    asset.sha256 = sha256(original);
    asset.validation.genuineOwnerContext = 'same';
    const inputs = join(value.root, 'native-producer-fixtures');
    mkdirSync(inputs);
    const environment = {
      ...process.env,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_SHA: 'a'.repeat(40),
    };
    for (const entry of value.manifest.assets) {
      const directory = join(inputs, `native-fs-123-1-${entry.target}`);
      mkdirSync(directory);
      writeFileSync(
        join(directory, 'delivery.json'),
        JSON.stringify({
          version: 1,
          runId: '123',
          attempt: '1',
          sourceSha: environment.GITHUB_SHA,
          target: entry.target,
        }),
      );
      writeNativeAssets(
        join(directory, 'assets'),
        { ...value.manifest, scope: 'development-current', assets: [entry] },
        filesFor(entry.target),
      );
    }
    const assembly = spawnSync(
      process.execPath,
      [join(value.root, 'tools/native-fs/assemble.mjs'), inputs],
      {
        env: environment,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(assembly.error, undefined);
    assert.equal(assembly.status, 1);
    assert.equal(assembly.stdout, '');
    assert.match(assembly.stderr, /NATIVE_FS_WINDOWS_DISTINCT_OWNER_REQUIRED/u);
    refusal(() => validateNativeManifest(value.manifest), 'PROFILE_EVIDENCE');
    asset.validation.genuineOwnerContext = 'distinct';
    writeNativeAssets(
      join(inputs, `native-fs-123-1-${target}`, 'assets'),
      { ...value.manifest, scope: 'development-current', assets: [asset] },
      filesFor(target),
    );
    const complete = spawnSync(
      process.execPath,
      [join(value.root, 'tools/native-fs/assemble.mjs'), inputs],
      {
        env: environment,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(complete.status, 0, complete.stderr);
    const assembled = inspectNativeAssets(value.directory, {
      complete: true,
      binding: nativeSourceBinding(value.root),
    });
    assert.equal(assembled.manifest.scope, 'release-complete');
    for (const win of assembled.manifest.assets.filter(
      (entry) => entry.execution.platform === 'win32',
    ))
      assert.equal(win.validation.genuineOwnerContext, 'distinct');
  }
});

test('format and CPU mismatch refuse even when an altered binary matches its declared digest and length', () => {
  const value = fixture();
  for (const target of NATIVE_TARGETS) {
    const wrong = target.startsWith('aarch64')
      ? target.replace('aarch64', 'x86_64')
      : target.replace('x86_64', 'aarch64');
    const bytes = value.files.get(`${wrong}.node`);
    const original = value.files.get(`${target}.node`);
    assert.equal(bytes.length, original.length);
    const manifest = JSON.parse(JSON.stringify(value.manifest));
    manifest.assets.find((asset) => asset.target === target).sha256 = sha256(bytes);
    writeFileSync(join(value.directory, `${target}.node`), bytes);
    writeFileSync(join(value.directory, 'native-assets.json'), JSON.stringify(manifest));
    refusal(() => inspectNativeAssets(value.directory), 'BINARY_TARGET');
    writeFileSync(join(value.directory, `${target}.node`), original);
  }
});

test('same-length Cargo.lock tampering changes lock and source digests and refuses previously bound assets', () => {
  const value = fixture();
  const before = captureNativeInputs(value.root);
  const path = join(value.root, 'apps/cli/native/fs-metadata/Cargo.lock');
  const bytes = readFileSync(path);
  bytes[0] ^= 1;
  writeFileSync(path, bytes);
  const after = captureNativeInputs(value.root);
  assert.deepEqual(
    after.files.map((file) => file.bytes),
    before.files.map((file) => file.bytes),
  );
  assert.notEqual(after.binding.lockSha256, before.binding.lockSha256);
  assert.notEqual(after.binding.sourceSha256, before.binding.sourceSha256);
  assert.equal(after.binding.buildSha256, before.binding.buildSha256);
  refusal(() => copyNativeAssets({ repository: value.root, complete: true }), 'SOURCE_BINDING');
});

test('source capture refuses invalid names, linked source, excessive population/bytes and a changed toolchain', () => {
  for (const [mutate, code] of [
    [(root) => writeFileSync(join(root, 'src/Unexpected.rs'), ''), 'SOURCE_NAME'],
    [(root) => symlinkSync(join(root, 'Cargo.lock'), join(root, 'src/linked.rs')), 'SOURCE_KIND'],
    [
      (root) => writeFileSync(join(root, 'src/large.rs'), 'x'.repeat(1024 * 1024 + 1)),
      'UNREADABLE',
    ],
    [
      (root) => {
        for (let index = 0; index < 124; index++)
          writeFileSync(join(root, `src/source_${index}.rs`), '');
      },
      'SOURCE_BOUND',
    ],
    [
      (root) =>
        writeFileSync(join(root, 'rust-toolchain.toml'), '[toolchain]\nchannel = "stable"\n'),
      'TOOLCHAIN',
    ],
  ]) {
    const value = fixture();
    mutate(join(value.root, 'apps/cli/native/fs-metadata'));
    refusal(() => captureNativeInputs(value.root), code);
  }
});
