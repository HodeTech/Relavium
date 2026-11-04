import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMMIT,
  SOURCES,
  TREE,
  candidate,
  cliRequire,
  coreChunk,
  digest,
  fresh,
  git,
  posixModes,
  rerecordMaps,
  scratch,
  seal,
  ts,
} from './candidate-fixture.mjs';
import { ENGINE_PACKAGES } from './finalize.mjs';
import {
  MANIFEST_INPUTS,
  ManifestError,
  readPrivateManifest,
  sealPrivateManifest,
  verifySealedDist,
} from './manifest.mjs';

const refuses = (code) => (error) => error instanceof ManifestError && error.code === code;
const repository = fileURLToPath(new URL('../../', import.meta.url));

test('the manifest inputs are every build configuration the real repository extends', () => {
  // Each configuration a build reads, followed through its `extends` chain, is a digested input.
  const roots = [
    'apps/cli/tsconfig.json',
    ...ENGINE_PACKAGES.map((name) => `packages/${name}/tsconfig.build.json`),
  ];
  const reached = new Set();
  const follow = (path) => {
    reached.add(path);
    const { config, error } = ts.readConfigFile(
      join(repository, ...path.split('/')),
      ts.sys.readFile,
    );
    assert.equal(error, undefined, path);
    if (config.extends === undefined) return;
    assert.equal(typeof config.extends, 'string', path);
    assert.match(config.extends, /^\.\.?\//u, `${path} extends a relative configuration`);
    follow(posix.normalize(posix.join(posix.dirname(path), config.extends)));
  };
  for (const root of roots) follow(root);
  // With the lock, the workspace and npm configuration, the tsup configuration and every package
  // manifest the build installs, that is exactly the input list.
  const expected = new Set([
    ...reached,
    '.npmrc',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'apps/cli/package.json',
    'apps/cli/tsup.config.ts',
    ...ENGINE_PACKAGES.map((name) => `packages/${name}/package.json`),
  ]);
  assert.equal(MANIFEST_INPUTS.length, expected.size);
  assert.deepEqual(new Set(MANIFEST_INPUTS), expected);
  for (const path of MANIFEST_INPUTS)
    assert.ok(existsSync(join(repository, ...path.split('/'))), path);
});

test('the manifest binds the commit, toolchain, inputs, finalized pairs, sources and tarball', async () => {
  const fixture = await candidate();
  const manifest = await seal(fixture);
  assert.deepEqual(manifest.source, { commit: COMMIT, tree: TREE, dirty: true });
  assert.equal(manifest.packageVersion, '0.1.1');
  assert.equal(manifest.target, 'node22');
  assert.equal(manifest.tarballSha256, 'a'.repeat(64));
  assert.equal(manifest.toolchain.node, process.version);
  assert.equal(manifest.toolchain.pnpm, '9.12.3');
  assert.equal(manifest.toolchain.typescript, ts.version);
  // The installed tsup, and the esbuild tsup itself resolves.
  assert.equal(manifest.toolchain.tsup, cliRequire('tsup/package.json').version);
  assert.equal(
    manifest.toolchain.esbuild,
    createRequire(cliRequire.resolve('tsup/package.json'))('esbuild/package.json').version,
  );
  assert.deepEqual(Object.keys(manifest.inputs), [...MANIFEST_INPUTS]);
  for (const path of MANIFEST_INPUTS) {
    assert.equal(
      manifest.inputs[path],
      digest(readFileSync(join(fixture.root, ...path.split('/')))),
      path,
    );
  }
  assert.deepEqual(
    manifest.outputs.map((output) => output.path),
    fixture.outputs.map((output) => output.path).sort(),
  );
  for (const output of manifest.outputs) {
    assert.equal(output.sha256, digest(readFileSync(join(fixture.cli, output.path))));
    assert.deepEqual(output.map, {
      path: `${output.path}.map`,
      sha256: digest(
        readFileSync(join(fixture.staging, 'maps', `${posix.basename(output.path)}.map`)),
      ),
    });
  }
  assert.deepEqual(Object.keys(manifest.sources), Object.keys(SOURCES).sort());
  for (const [path, value] of Object.entries(manifest.sources)) {
    assert.equal(value, digest(readFileSync(join(fixture.root, ...path.split('/')))));
  }
  // Written once, owner-only, holding no absolute path, and read back exactly.
  const text = readFileSync(join(fixture.staging, 'manifest.json'), 'utf8');
  assert.deepEqual(JSON.parse(text), manifest);
  assert.deepEqual(readPrivateManifest(fixture.staging), manifest);
  assert.equal(text.includes(scratch), false);
  if (posixModes)
    assert.equal(statSync(join(fixture.staging, 'manifest.json')).mode & 0o777, 0o600);
  await assert.rejects(seal(fixture), (error) => error.code === 'EEXIST');
});

test('the package version and tarball digest are the inspected archive’s', async () => {
  const fixture = await candidate();
  fixture.archive.package.version = '9.8.7';
  fixture.archive.sha256 = 'e'.repeat(64);
  const manifest = await seal(fixture);
  assert.equal(manifest.packageVersion, '9.8.7');
  assert.equal(manifest.tarballSha256, 'e'.repeat(64));
  // Every version a receipt admits: a prerelease with build metadata, and exactly 100 characters.
  for (const version of ['1.0.0-rc.1+build.5', `0.1.1-${'a'.repeat(94)}`]) {
    const admitted = await candidate();
    admitted.archive.package.version = version;
    assert.equal((await seal(admitted)).packageVersion, version);
  }
});

test('the tree is asked of the original checkout through isolated Git', async () => {
  const fixture = await candidate();
  // Sources and toolchain come from the candidate, so an absent checkout serves only Git.
  const checkout = join(scratch, 'absent-checkout');
  let seen;
  await sealPrivateManifest({
    candidate: fixture.root,
    staging: fixture.staging,
    checkout,
    source: COMMIT,
    dirty: false,
    archive: fixture.archive,
    run: async (command, args, options) => {
      seen = options;
      return git(command, args);
    },
  });
  assert.equal(seen.cwd, checkout);
  assert.equal(seen.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(seen.env.GIT_NO_REPLACE_OBJECTS, '1');
  assert.equal(seen.env.GIT_DIR, undefined);
  assert.ok(Number.isFinite(seen.timeoutMs) && seen.timeoutMs >= 10_000);
});

test('the manifest refuses drifted maps and tarball entries, unpaired records and a missing tree', async () => {
  for (const [label, change, code] of [
    [
      'a staged map changed after the finalizer recorded it',
      (fixture) =>
        writeFileSync(join(fixture.staging, 'maps', `${coreChunk(fixture)}.map`), '{"sources":[]}'),
      'MAP_DRIFT',
    ],
    [
      'a staged map changed to bytes of the same length',
      (fixture) => {
        const path = join(fixture.staging, 'maps', `${coreChunk(fixture)}.map`);
        const text = readFileSync(path, 'utf8');
        assert.equal(text.startsWith('{"version":3,'), true);
        writeFileSync(path, text.replace('{"version":3,', '{"version":4,'));
      },
      'MAP_DRIFT',
    ],
    [
      'a recorded map size that disagrees with its bytes',
      (fixture) => {
        const name = coreChunk(fixture);
        rerecordMaps(fixture, (record) => {
          record.maps.find((map) => map.path === `dist/${name}.map`).bytes += 1;
        });
      },
      'MAP_DRIFT',
    ],
    [
      'a recorded map that is not JSON',
      (fixture) => {
        writeFileSync(join(fixture.staging, 'maps', `${coreChunk(fixture)}.map`), 'not json');
        rerecordMaps(fixture);
      },
      'MAP_DRIFT',
    ],
    [
      'a recorded map without sources',
      (fixture) => {
        writeFileSync(join(fixture.staging, 'maps', `${coreChunk(fixture)}.map`), '{"version":3}');
        rerecordMaps(fixture);
      },
      'MAP_DRIFT',
    ],
    [
      'a tarball entry that is not the finalized JS',
      (fixture) => (fixture.archive.files[0].sha256 = 'd'.repeat(64)),
      'TARBALL_DRIFT',
    ],
    [
      'an output without its map in the record',
      (fixture) => rerecordMaps(fixture, (record) => record.maps.pop()),
      'RECORD',
    ],
    [
      'a map that pairs no output',
      (fixture) =>
        rerecordMaps(fixture, (record) =>
          record.maps.push({ path: 'dist/unpaired.js.map', bytes: 2, sha256: digest('{}') }),
        ),
      'RECORD',
    ],
    [
      'a null map entry',
      (fixture) => rerecordMaps(fixture, (record) => record.maps.push(null)),
      'RECORD',
    ],
    [
      'an output outside dist',
      (fixture) => {
        const name = coreChunk(fixture);
        rerecordMaps(fixture, (record) => {
          record.outputs.find((output) => output.path === `dist/${name}`).path = `dist/../${name}`;
          record.maps.find((map) => map.path === `dist/${name}.map`).path = `dist/../${name}.map`;
        });
      },
      'RECORD',
    ],
    [
      'outputs that are not a list',
      (fixture) =>
        writeFileSync(
          join(fixture.staging, 'finalized.json'),
          JSON.stringify({ outputs: {}, maps: [] }),
        ),
      'RECORD',
    ],
    ['a missing record', (fixture) => rmSync(join(fixture.staging, 'finalized.json')), 'RECORD'],
    [
      'a build configuration without its target',
      (fixture) => writeFileSync(join(fixture.cli, 'tsup.config.ts'), 'export default {};\n'),
      'TARGET',
    ],
    [
      'a build configuration with two top-level targets',
      (fixture) =>
        writeFileSync(
          join(fixture.cli, 'tsup.config.ts'),
          "export default {\n  target: 'node20',\n  target: 'node22',\n};\n",
        ),
      'TARGET',
    ],
    [
      'a target that is not a Node target (the seal validates what it writes)',
      (fixture) =>
        writeFileSync(
          join(fixture.cli, 'tsup.config.ts'),
          "export default {\n  target: 'es2022',\n};\n",
        ),
      'SHAPE',
    ],
    [
      'a missing manifest input',
      (fixture) => rmSync(join(fixture.root, 'pnpm-lock.yaml')),
      'UNREADABLE_INPUT',
    ],
    [
      'an uninstalled toolchain',
      (fixture) =>
        rmSync(join(fixture.root, 'apps', 'cli', 'node_modules'), { recursive: true, force: true }),
      'TOOLCHAIN',
    ],
  ]) {
    const fixture = await candidate();
    change(fixture);
    await assert.rejects(seal(fixture), refuses(code), label);
    assert.equal(existsSync(join(fixture.staging, 'manifest.json')), false, label);
  }
  const fixture = await candidate();
  for (const run of [
    async () => ({ stdout: 'not a tree\n', stderr: '' }),
    async () => {
      throw new Error('git failed');
    },
  ]) {
    await assert.rejects(
      sealPrivateManifest({
        candidate: fixture.root,
        staging: fixture.staging,
        checkout: fixture.root,
        source: COMMIT,
        dirty: false,
        archive: fixture.archive,
        run,
      }),
      refuses('SOURCE_TREE'),
    );
  }
});

test('only the top-level target line of the build configuration counts', async () => {
  const fixture = await candidate();
  writeFileSync(
    join(fixture.cli, 'tsup.config.ts'),
    "// target: 'node18',\nexport default {\n  // target: 'node20',\n  esbuildOptions: {\n    target: 'node20',\n  },\n  target: 'node22',\n};\n",
  );
  assert.equal((await seal(fixture)).target, 'node22');
});

test('a final map naming a source outside the admitted roots refuses before it is read', async () => {
  writeFileSync(join(scratch, 'outside.ts'), 'export {};\n');
  for (const name of ['apps/cli/src/../../../../outside.ts', 'node_modules/yaml/dist/index.ts']) {
    const fixture = await candidate();
    const path = join(fixture.staging, 'maps', `${coreChunk(fixture)}.map`);
    const map = JSON.parse(readFileSync(path, 'utf8'));
    map.sources.push(name);
    writeFileSync(path, JSON.stringify(map));
    rerecordMaps(fixture);
    await assert.rejects(seal(fixture), refuses('SOURCE_PATH'), name);
    assert.equal(existsSync(join(fixture.staging, 'manifest.json')), false, name);
  }
});

test('every manifest read is bounded', async () => {
  const pad = (text, size) => text + ' '.repeat(Math.max(0, size - Buffer.byteLength(text)));
  for (const [label, change, code] of [
    [
      'build configuration',
      (fixture) => {
        const path = join(fixture.cli, 'tsup.config.ts');
        writeFileSync(path, pad(readFileSync(path, 'utf8'), 128 * 1024 + 1));
      },
      'UNREADABLE_INPUT',
    ],
    [
      'lockfile',
      (fixture) =>
        writeFileSync(join(fixture.root, 'pnpm-lock.yaml'), pad('# lock\n', 16 * 1024 * 1024 + 1)),
      'UNREADABLE_INPUT',
    ],
    [
      'source',
      (fixture) => {
        const path = join(fixture.root, 'packages', 'core', 'src', 'parser.ts');
        writeFileSync(path, pad(readFileSync(path, 'utf8'), 8 * 1024 * 1024 + 1));
      },
      'UNREADABLE_INPUT',
    ],
    [
      'map',
      (fixture) => {
        const path = join(fixture.staging, 'maps', `${coreChunk(fixture)}.map`);
        writeFileSync(path, pad(readFileSync(path, 'utf8'), 16 * 1024 * 1024 + 1));
        rerecordMaps(fixture);
      },
      'UNREADABLE_INPUT',
    ],
    [
      'record',
      (fixture) => {
        const path = join(fixture.staging, 'finalized.json');
        writeFileSync(path, pad(readFileSync(path, 'utf8'), 1024 * 1024 + 1));
      },
      'RECORD',
    ],
  ]) {
    const fixture = await candidate();
    change(fixture);
    await assert.rejects(seal(fixture), refuses(code), label);
  }
  const fixture = await candidate();
  await seal(fixture);
  const path = join(fixture.staging, 'manifest.json');
  const text = readFileSync(path, 'utf8');
  rmSync(path);
  writeFileSync(path, pad(text, 4 * 1024 * 1024 + 1));
  assert.throws(() => readPrivateManifest(fixture.staging), refuses('UNREADABLE'));
  const empty = fresh('no-manifest');
  mkdirSync(empty);
  assert.throws(() => readPrivateManifest(empty), refuses('UNREADABLE'));
});

/** A sealed fixture whose manifest records the digest of an actual tarball file. */
async function sealedWithTarball() {
  const fixture = await candidate();
  const artifact = fresh('artifact');
  mkdirSync(artifact);
  const tarball = join(artifact, 'relavium-0.1.1.tgz');
  writeFileSync(tarball, 'synthetic tarball bytes');
  fixture.archive.sha256 = digest(readFileSync(tarball));
  return { fixture, tarball, manifest: await seal(fixture) };
}

test('the dist and the tarball are verified against the manifest just sealed', async () => {
  const sealed = await sealedWithTarball();
  verifySealedDist({
    candidate: sealed.fixture.root,
    manifest: sealed.manifest,
    tarball: sealed.tarball,
  });
  for (const [label, change, code] of [
    [
      'one more byte in a chunk no anchor lies in',
      (fixture) => {
        const path = join(fixture.cli, 'dist', 'index.js');
        writeFileSync(path, `${readFileSync(path, 'utf8')} `);
      },
      'DIST_DRIFT',
    ],
    [
      'an extra file',
      (fixture) => writeFileSync(join(fixture.cli, 'dist', 'extra.js'), ''),
      'DIST_DRIFT',
    ],
    [
      'a removed chunk',
      (fixture) => rmSync(join(fixture.cli, 'dist', coreChunk(fixture))),
      'DIST_DRIFT',
    ],
    [
      'a chunk replaced by a link to the same bytes',
      (fixture) => {
        const path = join(fixture.cli, 'dist', 'index.js');
        const copy = join(fixture.work, 'index.js');
        writeFileSync(copy, readFileSync(path));
        rmSync(path);
        symlinkSync(copy, path);
      },
      'DIST_DRIFT',
    ],
    ['no dist', (fixture) => rmSync(join(fixture.cli, 'dist'), { recursive: true }), 'DIST_DRIFT'],
    [
      'a replaced tarball',
      (_fixture, tarball) => writeFileSync(tarball, 'other bytes'),
      'TARBALL_CHANGED',
    ],
    ['a missing tarball', (_fixture, tarball) => rmSync(tarball), 'TARBALL_CHANGED'],
  ]) {
    const { fixture, tarball, manifest } = await sealedWithTarball();
    change(fixture, tarball);
    assert.throws(
      () => verifySealedDist({ candidate: fixture.root, manifest, tarball }),
      refuses(code),
      label,
    );
  }
});

test('every output is checked, each read is bounded, and so is the tarball', async () => {
  // A same-length change in any output refuses, the first as much as the last.
  const sealed = await sealedWithTarball();
  assert.ok(sealed.manifest.outputs.length >= 2);
  for (const output of sealed.manifest.outputs) {
    const path = join(sealed.fixture.cli, ...output.path.split('/'));
    const saved = readFileSync(path);
    const changed = Buffer.from(saved);
    changed[changed.length - 1] = changed[changed.length - 1] === 0x0a ? 0x20 : 0x0a;
    writeFileSync(path, changed);
    assert.throws(
      () =>
        verifySealedDist({
          candidate: sealed.fixture.root,
          manifest: sealed.manifest,
          tarball: sealed.tarball,
        }),
      refuses('DIST_DRIFT'),
      output.path,
    );
    writeFileSync(path, saved);
  }
  // An output over 8 MiB, or a tarball over 16 MiB, refuses even when the manifest records its digest.
  const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x20);
  const output = sealed.manifest.outputs[0];
  writeFileSync(join(sealed.fixture.cli, ...output.path.split('/')), big);
  assert.throws(
    () =>
      verifySealedDist({
        candidate: sealed.fixture.root,
        manifest: {
          ...sealed.manifest,
          outputs: sealed.manifest.outputs.map((entry) =>
            entry === output ? { ...entry, sha256: digest(big) } : entry,
          ),
        },
        tarball: sealed.tarball,
      }),
    refuses('DIST_DRIFT'),
  );
  const fresh = await sealedWithTarball();
  const bigger = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20);
  writeFileSync(fresh.tarball, bigger);
  assert.throws(
    () =>
      verifySealedDist({
        candidate: fresh.fixture.root,
        manifest: { ...fresh.manifest, tarballSha256: digest(bigger) },
        tarball: fresh.tarball,
      }),
    refuses('TARBALL_CHANGED'),
  );
});

test('a refusal is a ManifestError naming only its fixed code', () => {
  const empty = fresh('no-manifest');
  mkdirSync(empty);
  assert.throws(() => readPrivateManifest(empty), {
    name: 'ManifestError',
    code: 'UNREADABLE',
    message: 'PACKED_CLI_MANIFEST_UNREADABLE',
  });
});

test('a sealed manifest that is not exactly the validated shape refuses on read', async () => {
  const fixture = await candidate();
  const valid = await seal(fixture);
  const hex = (c, n = 64) => c.repeat(n);
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(String(i).padStart(5, '0')));
  const output = (name) => ({
    path: `dist/${name}.js`,
    sha256: hex('1'),
    map: { path: `dist/${name}.js.map`, sha256: hex('2') },
  });
  const cases = [
    ['extra top-level key', (m) => (m.extra = 1)],
    ['missing top-level key', (m) => delete m.target],
    ['version 2', (m) => (m.version = 2)],
    ['source extra key', (m) => (m.source.extra = 1)],
    ['commit not hex', (m) => (m.source.commit = 'x')],
    ['commit with suffix', (m) => (m.source.commit = `${hex('c', 40)}0`)],
    ['commit short', (m) => (m.source.commit = hex('c', 39))],
    ['tree not hex', (m) => (m.source.tree = 'x')],
    ['dirty as string', (m) => (m.source.dirty = 'true')],
    ['packageVersion as array', (m) => (m.packageVersion = ['0.1.1'])],
    ['packageVersion not semver', (m) => (m.packageVersion = '0.1')],
    ['packageVersion with trailing text', (m) => (m.packageVersion = '0.1.1 x')],
    ['packageVersion over 100 characters', (m) => (m.packageVersion = `0.1.1-${'a'.repeat(95)}`)],
    ['packageVersion with a plus in its build', (m) => (m.packageVersion = '0.1.1+a+b')],
    ['packageVersion with an empty prerelease', (m) => (m.packageVersion = '0.1.1-')],
    ['target as array', (m) => (m.target = ['node22'])],
    ['target not nodeNN', (m) => (m.target = 'es2022')],
    ['toolchain extra key', (m) => (m.toolchain.extra = '1.0.0')],
    ['node version malformed', (m) => (m.toolchain.node = 'v22')],
    ['pnpm other', (m) => (m.toolchain.pnpm = '9.12.4')],
    ['typescript malformed', (m) => (m.toolchain.typescript = 'x')],
    ['tsup malformed', (m) => (m.toolchain.tsup = 'x')],
    ['esbuild malformed', (m) => (m.toolchain.esbuild = 'x')],
    ['inputs missing one', (m) => delete m.inputs['.npmrc']],
    ['inputs extra one', (m) => (m.inputs['extra.json'] = hex('3'))],
    ['input digest not hex', (m) => (m.inputs['.npmrc'] = 'x')],
    ['input digest uppercase', (m) => (m.inputs['.npmrc'] = hex('A'))],
    ['input digest short', (m) => (m.inputs['.npmrc'] = hex('3', 63))],
    ['input digest with prefix', (m) => (m.inputs['.npmrc'] = `z${hex('3')}`)],
    ['tarball digest not hex', (m) => (m.tarballSha256 = 'x')],
    ['tarball digest as array', (m) => (m.tarballSha256 = [hex('a')])],
    ['outputs not an array', (m) => (m.outputs = {})],
    ['outputs empty', (m) => (m.outputs = [])],
    ['outputs over the bound', (m) => (m.outputs = many(257, (i) => output(`c${i}`)))],
    ['output extra key', (m) => (m.outputs[0].extra = 1)],
    // Paired map paths and the order stay valid, so only the path pattern can refuse these.
    [
      'output path escaping',
      (m) => {
        m.outputs[0].path = 'dist/../x.js';
        m.outputs[0].map.path = 'dist/../x.js.map';
      },
    ],
    [
      'output path not anchored',
      (m) => {
        m.outputs.at(-1).path = 'x/dist/zz.js';
        m.outputs.at(-1).map.path = 'x/dist/zz.js.map';
      },
    ],
    ['output digest not hex', (m) => (m.outputs[0].sha256 = 'x')],
    ['output map extra key', (m) => (m.outputs[0].map.extra = 1)],
    ['output map path not paired', (m) => (m.outputs[0].map.path = 'dist/other.js.map')],
    ['output map digest not hex', (m) => (m.outputs[0].map.sha256 = 'x')],
    ['outputs unsorted', (m) => m.outputs.reverse()],
    ['outputs duplicated', (m) => m.outputs.push(m.outputs.at(-1))],
    ['sources an array', (m) => (m.sources = [])],
    ['sources null', (m) => (m.sources = null)],
    ['sources empty', (m) => (m.sources = {})],
    [
      'sources over the bound',
      (m) =>
        (m.sources = Object.fromEntries(many(8193, (i) => [`apps/cli/src/s${i}.ts`, hex('4')]))),
    ],
    [
      'source outside the admitted roots',
      (m) => (m.sources['node_modules/yaml/index.ts'] = hex('4')),
    ],
    [
      'source escaping by dot segments',
      (m) => (m.sources['apps/cli/src/../../../x.ts'] = hex('4')),
    ],
    ['source not anchored', (m) => (m.sources['x/apps/cli/src/a.ts'] = hex('4'))],
    ['source in another package', (m) => (m.sources['packages/other/src/a.ts'] = hex('4'))],
    ['source outside src', (m) => (m.sources['apps/cli/a.ts'] = hex('4'))],
    ['source not TypeScript', (m) => (m.sources['apps/cli/src/a.js'] = hex('4'))],
    ['source digest not hex', (m) => (m.sources[Object.keys(m.sources)[0]] = 'x')],
    [
      'sources unsorted',
      (m) => (m.sources = Object.fromEntries(Object.entries(m.sources).reverse())),
    ],
  ];
  for (const [label, change] of cases) {
    const variant = JSON.parse(JSON.stringify(valid));
    change(variant);
    // Keep sources sorted after an addition unless the case is about order.
    if (
      label !== 'sources unsorted' &&
      variant.sources !== null &&
      !Array.isArray(variant.sources)
    ) {
      variant.sources = Object.fromEntries(
        Object.entries(variant.sources).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    const staging = fresh('shape');
    mkdirSync(staging);
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(variant));
    assert.throws(() => readPrivateManifest(staging), refuses('SHAPE'), label);
  }
});
