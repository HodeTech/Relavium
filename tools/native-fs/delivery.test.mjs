import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { NATIVE_TARGETS, NATIVE_BUILD_INPUTS } from './catalog.mjs';
const require = createRequire(new URL('../../apps/cli/package.json', import.meta.url));
const ts = require('typescript');
const { parse } = require('yaml');
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const workflow = () => parse(read('.github/workflows/native-fs.yml'));
function checkDelivery(value, ci = parse(read('.github/workflows/ci.yml'))) {
  assert.deepEqual(value.permissions, { contents: 'read' });
  assert.ok(Object.hasOwn(value.on, 'workflow_call'));
  const job = value.jobs['native-fs'];
  assert.equal(job.strategy['fail-fast'], false);
  const rows = job.strategy.matrix.include;
  assert.deepEqual(rows.map((row) => row.target).sort(), NATIVE_TARGETS);
  const runners = {
    'x86_64-apple-darwin': 'macos-15-intel',
    'aarch64-apple-darwin': 'macos-15',
    'x86_64-pc-windows-msvc': 'windows-2022',
    'aarch64-pc-windows-msvc': 'windows-11-arm',
    'x86_64-unknown-linux-gnu': 'ubuntu-24.04',
    'x86_64-unknown-linux-musl': 'ubuntu-24.04',
    'aarch64-unknown-linux-gnu': 'ubuntu-24.04-arm',
    'aarch64-unknown-linux-musl': 'ubuntu-24.04-arm',
  };
  for (const row of rows) {
    assert.equal(row.os, runners[row.target]);
    assert.equal(row.arch, row.target.startsWith('aarch64') ? 'arm64' : 'x64');
  }
  const setup = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(setup.with['node-version'], "${{ runner.os == 'Linux' && '22.13.0' || '22.0.0' }}");
  assert.equal(setup.with.architecture, '${{ matrix.arch }}');
  const dependencies = job.steps.findIndex(
    (step) => step.run === 'pnpm install --frozen-lockfile --ignore-scripts',
  );
  const linux = job.steps.findIndex(
    (step) => step.run === "node tools/native-fs/ci-build.mjs '${{ matrix.target }}'",
  );
  assert.ok(dependencies >= 0 && dependencies < linux);
  assert.equal(job.steps[dependencies].if, "runner.os == 'Linux'");
  assert.ok(
    job.steps.some(
      (step) =>
        step.uses === 'pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320' &&
        step.if === "runner.os == 'Linux'",
    ),
  );
  assert.ok(
    job.steps.some(
      (step) =>
        step.run === 'node tools/native-fs/build.mjs --verify-profile' &&
        step.if === "runner.os != 'Linux'",
    ),
  );
  assert.ok(
    job.steps.some(
      (step) =>
        step.run === "node tools/native-fs/ci-build.mjs '${{ matrix.target }}'" &&
        step.if === "runner.os == 'Linux'",
    ),
  );
  const check = job.steps.findIndex((step) => step.run === 'node tools/native-fs/check-target.mjs');
  const stage = job.steps.findIndex(
    (step) =>
      step.run ===
      "node tools/native-fs/artifact.mjs stage '${{ runner.temp }}/native-fs-artifact'",
  );
  const upload = job.steps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.ok(check >= 0 && stage > check && upload > stage);
  assert.equal(job.steps[stage].env.RELAVIUM_EXPECTED_NATIVE_TARGET, '${{ matrix.target }}');
  assert.equal(
    job.steps[upload].uses,
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  );
  assert.deepEqual(job.steps[upload].with, {
    name: 'native-fs-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.target }}',
    path: '${{ runner.temp }}/native-fs-artifact/*',
    'retention-days': 7,
    'if-no-files-found': 'error',
  });
  assert.equal(ci.jobs['native-fs-assets'].uses, './.github/workflows/native-fs.yml');
  for (const name of ['pack-cli', 'map-controls']) {
    const consumer = ci.jobs[name];
    assert.ok([consumer.needs].flat().includes('native-fs-assets'));
    const download = consumer.steps.findIndex(
      (step) =>
        step.uses?.startsWith('actions/download-artifact@') &&
        step.with.pattern === 'native-fs-${{ github.run_id }}-*',
    );
    const assembly = consumer.steps.findIndex(
      (step) =>
        step.run === "node tools/native-fs/assemble.mjs '${{ runner.temp }}/native-fs-assets'",
    );
    const production = consumer.steps.findIndex((step) =>
      /(?:tools\/cli-package\/pack\.mjs|pnpm check:map-controls)/u.test(step.run ?? ''),
    );
    assert.ok(download >= 0 && assembly > download && production > assembly);
    assert.equal(consumer.steps[download].with['merge-multiple'], false);
    assert.equal(consumer['continue-on-error'], undefined);
  }
}

test('eight native ABI producers execute exact Node floor and complete source-bound assets gate pack and map controls', () => {
  checkDelivery(workflow());
  assert.ok(NATIVE_BUILD_INPUTS.includes('.github/workflows/native-fs.yml'));
  assert.ok(NATIVE_BUILD_INPUTS.includes('tools/native-fs/artifact.mjs'));
  assert.ok(NATIVE_BUILD_INPUTS.includes('tools/native-fs/gnu.Dockerfile'));
  assert.ok(NATIVE_BUILD_INPUTS.includes('tools/native-fs/musl.Dockerfile'));
});

test('delivery controls independently refuse omitted targets, emulated/mismatched runners and missing receipt/assembly dependencies', () => {
  for (const mutate of [
    (value) => value.jobs['native-fs'].strategy.matrix.include.pop(),
    (value) => {
      value.jobs['native-fs'].strategy.matrix.include[0].os = 'ubuntu-latest';
    },
    (value) => {
      value.jobs['native-fs'].strategy.matrix.include[1].arch = 'x64';
    },
    (value) => {
      value.jobs['native-fs'].steps = value.jobs['native-fs'].steps.filter(
        (step) => step.run !== 'node tools/native-fs/check-target.mjs',
      );
    },
    (value) => {
      value.jobs['native-fs'].steps.find((step) =>
        step.uses?.startsWith('actions/setup-node@'),
      ).with['node-version'] = '22';
    },
    (value) => {
      value.jobs['native-fs'].steps.find((step) =>
        step.uses?.startsWith('actions/upload-artifact@'),
      ).with.name = 'native-fs-${{ github.run_id }}-${{ matrix.target }}';
    },
    (value) => {
      value.jobs['native-fs'].steps.find((step) =>
        step.uses?.startsWith('actions/upload-artifact@'),
      ).with.path = 'apps/cli/native/fs-metadata/runtime/*';
    },
    (value) => {
      value.jobs['native-fs'].steps = value.jobs['native-fs'].steps.filter(
        (step) => !step.run?.includes('artifact.mjs stage'),
      );
    },
  ]) {
    const value = workflow();
    mutate(value);
    assert.throws(() => checkDelivery(value));
  }
  for (const name of ['pack-cli', 'map-controls']) {
    for (const mutate of [
      (job) => {
        delete job.needs;
      },
      (job) => {
        job.steps = job.steps.filter((step) => !step.run?.includes('native-fs/assemble.mjs'));
      },
      (job) => {
        job.steps.find((step) => step.with?.pattern?.startsWith('native-fs-')).with[
          'merge-multiple'
        ] = true;
      },
    ]) {
      const ci = parse(read('.github/workflows/ci.yml'));
      mutate(ci.jobs[name]);
      assert.throws(() => checkDelivery(workflow(), ci));
    }
  }
});

test('reviewed shim has exactly three builtin requires and eight literal binary paths, with no dynamic acquisition', () => {
  const source = ts.createSourceFile(
    'loader.cjs',
    read('tools/native-fs/loader.cjs'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(source.parseDiagnostics.length, 0);
  const imports = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      assert.equal(node.arguments.length, 1);
      assert.ok(ts.isStringLiteral(node.arguments[0]));
      imports.push(node.arguments[0].text);
    }
    if (ts.isIdentifier(node))
      assert.ok(
        ![
          'createRequire',
          'dlopen',
          '_load',
          'eval',
          'Function',
          'getBuiltinModule',
          'exec',
          'spawn',
        ].includes(node.text),
      );
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.deepEqual(
    imports.sort(),
    [
      'node:crypto',
      'node:fs',
      'node:path',
      ...NATIVE_TARGETS.map((target) => `./${target}.node`),
    ].sort(),
  );
});

test('Linux baseline recipes pin images and native architecture rather than selecting runtime compilers', () => {
  for (const path of ['tools/native-fs/gnu.Dockerfile', 'tools/native-fs/musl.Dockerfile']) {
    const text = read(path);
    for (const match of text.matchAll(/(?:FROM |ARG RUST_IMAGE=)(\S+)/gu)) {
      if (match[1].startsWith('${')) continue;
      assert.match(match[1], /@sha256:[0-9a-f]{64}$/u);
    }
  }
  const builder = read('tools/native-fs/ci-build.mjs');
  assert.match(builder, /run\('node', \['tools\/native-fs\/lower-host-run\.mjs', tag\]\)/u);
  assert.match(read('tools/native-fs/gnu.Dockerfile'), /node-v22\.0\.0-linux/u);
  assert.match(read('tools/native-fs/musl.Dockerfile'), /node:22\.0\.0-alpine3\.19/u);
  assert.match(builder, /process\.arch !== selected\.arch/u);
  assert.match(builder, /--cap-drop=ALL/u);
  assert.doesNotMatch(builder, /qemu|--platform/u);
});

function checkRelease(value) {
  const admission = value.jobs['native-admission'];
  const native = value.jobs['native-fs-assets'];
  const pack = value.jobs.pack;
  assert.deepEqual(admission.permissions, { contents: 'read' });
  assert.equal(admission.outputs.source, '${{ github.sha }}');
  assert.equal(admission.if, undefined);
  assert.equal(native.needs, 'native-admission');
  assert.equal(native.uses, './.github/workflows/native-fs.yml');
  assert.equal(native.secrets, undefined);
  assert.equal(native.if, undefined);
  assert.deepEqual(native.permissions, { contents: 'read' });
  assert.deepEqual(pack.needs, ['native-admission', 'native-fs-assets']);
  assert.deepEqual(pack.permissions, { contents: 'read' });
  for (const name of [
    'Release ref is reachable from `main`',
    'Tag matches the CLI package version',
  ]) {
    const early = admission.steps.find((step) => step.name === name);
    const recheck = pack.steps.find((step) => step.name === name);
    assert.ok(early && recheck);
    assert.equal(early.run, recheck.run);
    assert.equal(
      early.if,
      name.startsWith('Release ref')
        ? "${{ startsWith(github.ref, 'refs/tags/v') || !inputs.allow_off_main }}"
        : "startsWith(github.ref, 'refs/tags/v')",
    );
    assert.equal(early.if, recheck.if);
  }
  const policy = 'node tools/cli-package/native-release-admission.mjs';
  assert.equal(
    admission.steps.filter((step) => step.run === policy && step.if === undefined).length,
    1,
  );
  assert.ok(
    !admission.steps.some((step) =>
      /(?:native-fs\/(?:build|ci-build)|pnpm install|cli-package\/pack)/u.test(step.run ?? ''),
    ),
  );
  const source = pack.steps.findIndex(
    (step) => step.name === 'Recheck admitted source before packing',
  );
  const accepted = pack.steps.findIndex((step) => step.run === policy && step.if === undefined);
  const download = pack.steps.findIndex((step) =>
    step.uses?.startsWith('actions/download-artifact@'),
  );
  const assembly = pack.steps.findIndex((step) =>
    step.run?.startsWith('node tools/native-fs/assemble.mjs'),
  );
  const production = pack.steps.findIndex((step) =>
    step.run?.startsWith('node tools/cli-package/pack.mjs'),
  );
  assert.ok(
    source >= 0 &&
      accepted > source &&
      download > accepted &&
      assembly > download &&
      production > assembly,
  );
  assert.equal(
    pack.steps[source].env.ADMITTED_SOURCE,
    '${{ needs.native-admission.outputs.source }}',
  );
  assert.match(pack.steps[source].run, /execFileSync\('git', \['rev-parse', 'HEAD'\]/u);
  assert.match(
    pack.steps[source].run,
    /assert.equal\(process.env.ADMITTED_SOURCE, process.env.GITHUB_SHA\)/u,
  );
  assert.equal(pack.steps[download].with.pattern, 'native-fs-${{ github.run_id }}-*');
  assert.equal(pack.steps[download].with['merge-multiple'], false);
  const publish = value.jobs.publish;
  assert.equal(
    publish.if,
    "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}",
  );
  const guard = publish.steps.findIndex(
    (step) => step.run === 'node tools/cli-package/release-guard.mjs ./artifact',
  );
  const mutation = publish.steps.findIndex((step) => step.run?.startsWith('npm publish '));
  assert.ok(guard >= 0 && mutation > guard);
  assert.equal(publish.steps[guard].if, undefined);
}

test('release native builds follow early existing source/tag admission and policy guard, with pack rechecks and unchanged publication guard', () => {
  checkRelease(parse(read('.github/workflows/release.yml')));
});

test('release graph independently refuses native-before-admission, policy/source bypass and pack-before-validation', () => {
  for (const mutate of [
    (value) => {
      delete value.jobs['native-fs-assets'].needs;
    },
    (value) => {
      value.jobs['native-fs-assets'].if = '${{ always() }}';
    },
    (value) => {
      value.jobs['native-fs-assets'].secrets = 'inherit';
    },
    (value) => {
      value.jobs['native-admission'].outputs.source = '${{ github.ref }}';
    },
    (value) => {
      value.jobs['native-admission'].steps.find(
        (step) => step.run === 'node tools/cli-package/native-release-admission.mjs',
      ).if = '${{ false }}';
    },
    (value) => {
      value.jobs.pack.steps.find(
        (step) => step.run === 'node tools/cli-package/native-release-admission.mjs',
      ).run = 'true';
    },
    (value) => {
      value.jobs.pack.steps.find(
        (step) => step.name === 'Recheck admitted source before packing',
      ).env.ADMITTED_SOURCE = '${{ github.sha }}';
    },
    (value) => {
      const steps = value.jobs.pack.steps;
      const selected = steps.find((step) =>
        step.run?.startsWith('node tools/cli-package/pack.mjs'),
      );
      steps.splice(steps.indexOf(selected), 1);
      steps.unshift(selected);
    },
    (value) => {
      value.jobs['native-admission'].steps.find(
        (step) => step.name === 'Release ref is reachable from `main`',
      ).if = '${{ !inputs.allow_off_main }}';
    },
  ]) {
    const value = parse(read('.github/workflows/release.yml'));
    mutate(value);
    assert.throws(() => checkRelease(value));
  }
});

test('early native release policy rejects every pushed tag until ADR-0121 is accepted, while manual dry-runs stay manual', async () => {
  const { requireNativeReleasePolicy } =
    await import('../cli-package/native-release-admission.mjs');
  const proposed = '- **Status**: Proposed\n';
  const accepted = '- **Status**: Accepted\n';
  assert.throws(() =>
    requireNativeReleasePolicy(proposed, { eventName: 'push', ref: 'refs/tags/v0.2.0' }),
  );
  assert.doesNotThrow(() =>
    requireNativeReleasePolicy(accepted, { eventName: 'push', ref: 'refs/tags/v0.2.0' }),
  );
  for (const ref of ['refs/heads/development', 'refs/tags/v0.2.0'])
    assert.doesNotThrow(() =>
      requireNativeReleasePolicy(proposed, { eventName: 'workflow_dispatch', ref }),
    );
  assert.throws(() =>
    requireNativeReleasePolicy(accepted, { eventName: 'pull_request', ref: 'refs/tags/v0.2.0' }),
  );
  assert.throws(() =>
    requireNativeReleasePolicy(accepted, { eventName: 'push', ref: 'refs/heads/main' }),
  );
  assert.throws(() =>
    requireNativeReleasePolicy(accepted + proposed, { eventName: 'push', ref: 'refs/tags/v0.2.0' }),
  );
});

test('source and bundled host loader pins and path-selection define cannot drift from reviewed native assets', async () => {
  const { NATIVE_LOADER_SHA256 } = await import('./catalog.mjs');
  const integrity = read('apps/cli/src/engine/tool-host/fs-native-loader-integrity.ts');
  const pins = [
    ...integrity.matchAll(/export const FS_NATIVE_LOADER_SHA256\s*=\s*'([0-9a-f]{64})';/gu),
  ];
  assert.equal(pins.length, 1);
  assert.equal(pins[0][1], NATIVE_LOADER_SHA256);
  const helper = read('apps/cli/src/engine/tool-host/fs-native-metadata.ts');
  assert.match(helper, /typeof __RELAVIUM_CLI_NATIVE_PACKAGED__ !== 'undefined'/u);
  assert.match(
    helper,
    /new URL\(\s*packaged \? '\.\.\/native\/fs-metadata\/runtime\/' : '\.\.\/\.\.\/\.\.\/native\/fs-metadata\/runtime\/',\s*import\.meta\.url/u,
  );
  assert.match(
    helper,
    /new URL\(packaged \? '\.\/native-fs\/' : '\.\.\/\.\.\/\.\.\/dist\/native-fs\/', import\.meta\.url\)/u,
  );
  assert.match(
    helper,
    /nativeMetadataRuntimeRoot = packaged \? packagedRuntimeRoot : sourceRuntimeRoot/u,
  );
  assert.match(read('apps/cli/tsup.config.ts'), /__RELAVIUM_CLI_NATIVE_PACKAGED__: 'true'/u);
  assert.ok(
    NATIVE_BUILD_INPUTS.includes('apps/cli/src/engine/tool-host/fs-native-loader-integrity.ts'),
  );
  assert.ok(NATIVE_BUILD_INPUTS.includes('apps/cli/src/engine/tool-host/fs-native-metadata.ts'));
  for (const name of [
    'ci',
    'fs-mutations',
    'secrets-mutations',
    'wire-mutations',
    'usage-mutations',
    'floor-check',
    'coverage',
    'windows-concurrency',
  ]) {
    const ci = parse(read('.github/workflows/ci.yml'));
    assert.ok([ci.jobs[name].needs].flat().includes('native-fs-assets'));
    const target =
      name === 'windows-concurrency' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu';
    const download = ci.jobs[name].steps.findIndex(
      (step) => step.with?.pattern === 'native-fs-${{ github.run_id }}-*',
    );
    const select = ci.jobs[name].steps.findIndex(
      (step) =>
        step.run ===
        `node tools/native-fs/artifact.mjs select '\${{ runner.temp }}/native-fs-assets' ${target}`,
    );
    assert.ok(download >= 0 && select > download);
    assert.equal(ci.jobs[name].steps[download].with.path, '${{ runner.temp }}/native-fs-assets');
    assert.equal(ci.jobs[name].steps[download].with['merge-multiple'], false);
  }
  const cli = JSON.parse(read('apps/cli/turbo.json'));
  assert.equal(cli.tasks.build.cache, false);
  assert.ok(cli.tasks.build.outputs.includes('native/fs-metadata/runtime/**'));
  assert.ok(cli.tasks.test.dependsOn.includes('build'));
});

test('plain Node executes the actual bundled host helper through the staged named CJS export', async () => {
  const {
    mkdtempSync,
    rmSync,
    mkdirSync,
    readdirSync,
    linkSync,
    statSync,
    renameSync,
    symlinkSync,
    writeFileSync,
    readFileSync,
  } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve, relative, sep } = await import('node:path');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const { copyNativeAssets } = await import('./assets.mjs');
  const { build } = createRequire(require.resolve('tsup/package.json'))('esbuild');
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'relavium-plain-node-native-host-'));
  try {
    copyNativeAssets({ repository, destination: join(directory, 'native-fs') });
    const assetDirectory = join(directory, 'native-fs');
    const packageStore = join(directory, 'package-store');
    mkdirSync(packageStore);
    for (const name of readdirSync(assetDirectory)) {
      linkSync(join(assetDirectory, name), join(packageStore, name));
      assert.ok(statSync(join(assetDirectory, name)).nlink > 1);
    }
    const helper = resolve(repository, 'apps/cli/src/engine/tool-host/fs-native-metadata.ts');
    // These three runtime seams are the complete package imports of this fixture's source graph.
    // Package exports point at dist; acceptance-tool jobs intentionally run before workspace builds.
    const sourceAliases = {
      '@relavium/shared/relavium-error': 'packages/shared/src/relavium-error.ts',
      '@relavium/core/tool-dispatch-error': 'packages/core/src/tools/dispatch-error.ts',
      '@relavium/shared/fs-root-limits': 'packages/shared/src/fs-root-limits.ts',
    };
    const assertSourceInputs = (metafile) => {
      const inputs = Object.keys(metafile.inputs).map((path) =>
        relative(repository, resolve(repository, path)).split(sep).join('/'),
      );
      assert.deepEqual(
        inputs.filter((path) => /^(?:apps|packages)\/[^/]+\/dist\//u.test(path)),
        [],
        'NATIVE_HOST_FIXTURE_DIST_INPUT',
      );
      assert.deepEqual(
        inputs.filter((path) => path.startsWith('packages/')).sort(),
        Object.values(sourceAliases).sort(),
        'NATIVE_HOST_FIXTURE_SOURCE_INPUTS',
      );
    };
    const options = {
      entryPoints: [helper],
      absWorkingDir: repository,
      metafile: true,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: join(directory, 'host.mjs'),
      define: { __RELAVIUM_CLI_NATIVE_PACKAGED__: 'true' },
      plugins: [
        {
          name: 'fixed-native-host-test',
          setup(build) {
            build.onResolve(
              { filter: /^\.\.\/\.\.\/\.\.\/native\/fs-metadata\/runtime\/loader\.cjs$/ },
              (args) => {
                assert.equal(args.importer, helper);
                assert.equal(args.kind, 'dynamic-import');
                return { path: './native-fs/loader.cjs', external: true };
              },
            );
          },
        },
      ],
    };
    // Without these exact aliases, cold exports cannot resolve; a warm local dist must also refuse
    // the source-only invariant rather than concealing that cold-checkout dependency.
    let unaliased;
    try {
      unaliased = await build({ ...options, write: false, logLevel: 'silent' });
    } catch (error) {
      assert.ok(Array.isArray(error.errors) && error.errors.length > 0);
      for (const entry of error.errors) {
        const missing = /^Could not resolve "([^"]+)"$/u.exec(entry.text)?.[1];
        assert.ok(Object.hasOwn(sourceAliases, missing), 'Unexpected unaliased fixture failure');
      }
    }
    if (unaliased !== undefined)
      assert.throws(
        () => assertSourceInputs(unaliased.metafile),
        /NATIVE_HOST_FIXTURE_(?:DIST_INPUT|SOURCE_INPUTS)/u,
      );
    const resultGraph = await build({
      ...options,
      plugins: [
        ...options.plugins,
        {
          name: 'closed-native-host-source-seams',
          setup(build) {
            build.onResolve(
              {
                filter:
                  /^@relavium\/(?:shared\/(?:relavium-error|fs-root-limits)|core\/tool-dispatch-error)$/,
              },
              (args) => ({ path: resolve(repository, sourceAliases[args.path]) }),
            );
          },
        },
      ],
    });
    assertSourceInputs(resultGraph.metafile);
    const code = `const host = await import(${JSON.stringify(pathToFileURL(join(directory, 'host.mjs')).href)}); const adapter = await host.loadNativeMetadataWriteAdapter(); if (adapter.protocolVersion() !== 1) throw new Error('NATIVE_HOST_PROTOCOL'); process.stdout.write('native-host-edge-ok');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
      maxBuffer: 16 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'native-host-edge-ok');
    const loader = join(assetDirectory, 'loader.cjs');
    const held = join(directory, 'held-loader.cjs');
    renameSync(loader, held);
    symlinkSync(join(packageStore, 'loader.cjs'), loader, 'file');
    const symlink = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
    });
    assert.notEqual(symlink.status, 0);
    rmSync(loader);
    renameSync(held, loader);
    const bytes = readFileSync(loader);
    bytes[0] ^= 1;
    writeFileSync(loader, bytes);
    const changed = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
    });
    assert.notEqual(changed.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('plain Node namespace control reproduces the former shorthand-only export failure', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'relavium-native-namespace-control-'));
  try {
    const original = read('tools/native-fs/loader.cjs');
    const broken = original.replace(
      'exports.loadFsMetadataAddon = loadFsMetadataAddon;',
      'module.exports = Object.freeze({ loadFsMetadataAddon });',
    );
    assert.notEqual(broken, original);
    const path = join(directory, 'broken.cjs');
    writeFileSync(path, broken);
    const code = `const ns = await import(${JSON.stringify(pathToFileURL(path).href)}); if (typeof ns.loadFsMetadataAddon !== 'undefined' || typeof ns.default.loadFsMetadataAddon !== 'function') throw new Error('namespace-control');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      shell: false,
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function checkRetryConsumers(ci, release) {
  for (const [workflow, count] of [
    [ci, 10],
    [release, 1],
  ]) {
    const consumers = Object.entries(workflow.jobs).filter(([, job]) =>
      job.steps?.some((step) => step.with?.pattern?.startsWith('native-fs-')),
    );
    assert.equal(consumers.length, count);
    for (const [name, job] of consumers) {
      const download = job.steps.findIndex((step) => step.with?.pattern?.startsWith('native-fs-'));
      assert.equal(
        job.steps[download].uses,
        'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
      );
      // Default action custody is this workflow run: no token, repository or alternate run override.
      assert.deepEqual(job.steps[download].with, {
        pattern: 'native-fs-${{ github.run_id }}-*',
        path: '${{ runner.temp }}/native-fs-assets',
        'merge-multiple': false,
      });
      const next = job.steps[download + 1];
      if (['pack-cli', 'map-controls', 'pack'].includes(name))
        assert.equal(
          next.run,
          "node tools/native-fs/assemble.mjs '${{ runner.temp }}/native-fs-assets'",
        );
      else {
        const target =
          name === 'windows-concurrency' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu';
        assert.equal(
          next.run,
          `node tools/native-fs/artifact.mjs select '\${{ runner.temp }}/native-fs-assets' ${target}`,
        );
      }
    }
  }
}

test('all eleven native consumers keep own-run separated downloads and validate producer attempts before use', () => {
  const ci = parse(read('.github/workflows/ci.yml'));
  const release = parse(read('.github/workflows/release.yml'));
  checkRetryConsumers(ci, release);
  for (const mutation of [
    (step) => {
      step.with.pattern = 'native-fs-${{ github.run_id }}-${{ github.run_attempt }}-*';
    },
    (step) => {
      step.with['merge-multiple'] = true;
    },
    (step) => {
      step.with['run-id'] = '123';
    },
    (step) => {
      step.uses = 'actions/download-artifact@v4';
    },
  ]) {
    const altered = JSON.parse(JSON.stringify(ci));
    mutation(altered.jobs.ci.steps.find((step) => step.with?.pattern?.startsWith('native-fs-')));
    assert.throws(() => checkRetryConsumers(altered, release));
  }
  const altered = JSON.parse(JSON.stringify(ci));
  altered.jobs.ci.steps = altered.jobs.ci.steps.filter(
    (step) => !step.run?.includes('artifact.mjs select'),
  );
  assert.throws(() => checkRetryConsumers(altered, release));
});
