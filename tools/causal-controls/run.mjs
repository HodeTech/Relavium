/** Shared physical fixed/removal/restored coordinator for the finite causal families. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  captureDependencies,
  captureSource,
  digest,
  json,
  linkDependencies,
  sourceState,
  toUrl,
  verifyFiles,
} from '../usage-coverage-controls/source-graph.mjs';
import { spawnJoined } from './process.mjs';
import { assertPhaseOutcome } from './outcome.mjs';
import { assertDeclaredHookTimeouts } from './timeout-policy.mjs';
import {
  captureOwnedTools,
  verifyOwnedTools,
  mergeFiles,
  assertEvaluations,
  selectControls,
  phaseEnvironment,
  exactReplacement,
  assertSelectedAnchors,
  assertInventories,
} from './provenance.mjs';
import { encodePhaseStdio, finish } from './retention.mjs';

export async function runControls({ repository, evidenceKind, mutations, toolRoots }) {
  assert.ok(['filesystem', 'secrets'].includes(evidenceKind), 'Unknown evidence family');
  assert.deepEqual(toolRoots, [
    'tools/causal-controls',
    evidenceKind === 'filesystem' ? 'tools/fs-policy-controls' : 'tools/secrets-controls',
  ]);
  const require = createRequire(import.meta.url);
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const requested = process.argv.slice(2);
  const selected = selectControls(mutations, requested);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `relavium-${evidenceKind}-controls-`)));
  const graph = join(scratch, 'graph');
  const summary = {
    version: 1,
    complete: false,
    node: process.version,
    mechanisms: [],
    restorations: [],
  };
  let primaryFailure;
  let source, dependencies, manifest, ownFiles;
  async function phase(control, name) {
    const output = join(scratch, control.id, name);
    mkdirSync(output, { recursive: true });
    const current = {
      sourceRoot: graph,
      files: manifest.files.map((entry) => {
        const bytes = readFileSync(join(graph, entry.path));
        return { path: entry.path, bytes: bytes.length, sha256: digest(bytes) };
      }),
    };
    const manifestPath = join(output, 'source-manifest.json');
    // Preserve every pin while keeping repeated phase manifests inside the fixed evidence cap.
    writeFileSync(manifestPath, `${JSON.stringify(current)}\n`, { flag: 'wx' });
    const evaluationDirectory = join(output, 'evaluation');
    mkdirSync(evaluationDirectory);
    const config = join(output, 'vitest.config.mjs');
    writeFileSync(
      config,
      `import { sourcePlugin } from ${JSON.stringify(toUrl(join(graph, 'tools/usage-coverage-controls/source-graph.mjs')))};\nexport default { root:${JSON.stringify(graph)}, cacheDir:${JSON.stringify(join(output, 'cache'))}, plugins:[sourcePlugin()], test:{ environment:'node', cache:false, pool:'forks', maxWorkers:1, fileParallelism:false, include:${JSON.stringify(control.files)}, setupFiles:[${JSON.stringify(join(graph, 'tools/causal-controls/timeout-setup.mjs'))}], passWithNoTests:false, testTimeout:15000, hookTimeout:15000 } };\n`,
    );
    const runtime = join(output, 'runtime.json');
    json(runtime, {
      manifestPath,
      manifestSha256: digest(readFileSync(manifestPath)),
      dependencyManifestPath: join(scratch, 'installed-dependencies.json'),
      dependencyManifestSha256: digest(readFileSync(join(scratch, 'installed-dependencies.json'))),
      evaluationDirectory,
      evaluationHelper: toUrl(join(graph, 'tools/usage-coverage-controls/evaluation.mjs')),
      phase: name,
      mutationId: control.id,
      infrastructure: [
        { path: config, bytes: readFileSync(config).length, sha256: digest(readFileSync(config)) },
      ],
    });
    const infrastructure = [
      manifestPath,
      runtime,
      config,
      join(scratch, 'installed-dependencies.json'),
    ].map((path) => ({ path, sha256: digest(readFileSync(path)) }));
    const report = join(output, 'vitest.json');
    const child = await spawnJoined(
      process.execPath,
      [
        vitest,
        'run',
        '--config',
        config,
        '--configLoader',
        'native',
        '--reporter=json',
        '--outputFile',
        report,
      ],
      {
        cwd: graph,
        env: phaseEnvironment(evidenceKind, runtime, scratch),
      },
    );
    const stdio = encodePhaseStdio(child.stdout ?? '', child.stderr ?? '');
    writeFileSync(join(output, 'stdio.bin'), stdio.bytes, { flag: 'wx' });
    json(join(output, 'process.json'), {
      ...child,
      stdout: undefined,
      stderr: undefined,
      stdio: stdio.index,
    });
    assert.ok(existsSync(report), `${control.id}/${name}: missing completed report`);
    for (const entry of infrastructure)
      assert.equal(digest(readFileSync(entry.path)), entry.sha256, 'Phase metadata changed');
    const data = JSON.parse(readFileSync(report, 'utf8'));
    const { tests, failed } = assertPhaseOutcome(data, child, control, name, graph);
    const evaluationFiles = readdirSync(evaluationDirectory);
    const records = evaluationFiles
      .filter((file) => !file.endsWith('.dependencies.jsonl'))
      .flatMap((file) =>
        readFileSync(join(evaluationDirectory, file), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    const dependencyRecords = evaluationFiles
      .filter((file) => file.endsWith('.dependencies.jsonl'))
      .flatMap((file) =>
        readFileSync(join(evaluationDirectory, file), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    assertEvaluations(
      records,
      current,
      control.path,
      graph,
      control.nativeChild === undefined
        ? undefined
        : { ...control.nativeChild, dependencyRecords, dependencies },
    );
    verifyFiles(graph, current.files);
    console.log(
      `${control.id}/${name}: ${tests.length - failed.length} passed; ${failed.length} failed cases`,
    );
    return {
      tests: tests.length,
      failed: failed.map((t) => t.id),
      inventory: tests.map((t) => `${t.file}:${t.id}`).sort(),
      targetEvaluations: records.filter((r) => r.relativePath === control.path).length,
    };
  }
  try {
    source = captureSource(repository, graph);
    summary.sourceHead = source.head;
    for (const file of source.files)
      assert.equal(
        realpathSync(join(repository, file.path)),
        resolve(repository, file.path),
        'Owned source path redirected',
      );
    ownFiles = captureOwnedTools(repository, graph, toolRoots);
    manifest = { ...source, files: mergeFiles(source.files, ownFiles) };
    assertSelectedAnchors(selected, graph, manifest.files);
    dependencies = captureDependencies(repository);
    linkDependencies(repository, graph);
    assertDeclaredHookTimeouts(
      graph,
      selected.flatMap((control) => control.files),
    );
    json(join(scratch, 'developer-source.json'), manifest);
    json(join(scratch, 'installed-dependencies.json'), dependencies);
    summary.sourceHead = source.head;
    summary.sourceFiles = manifest.files.length;
    summary.dependencyPackages = dependencies.packages.length;
    console.log(`Captured isolated source graph: ${manifest.files.length} files at ${source.head}`);
    for (const control of selected) {
      const path = join(graph, control.path),
        original = readFileSync(path);
      const replacement = exactReplacement(original, control);
      const fixed = await phase(control, 'fixed');
      let mutated, removalFailure;
      try {
        writeFileSync(path, replacement);
        mutated = await phase(control, 'mutated');
      } catch (error) {
        removalFailure = error;
      } finally {
        try {
          writeFileSync(path, original);
          assert.deepEqual(readFileSync(path), original);
          summary.restorations.push({
            id: control.id,
            path: control.path,
            fixedSha256: digest(original),
            restoredSha256: digest(readFileSync(path)),
          });
        } catch (error) {
          removalFailure ??= error;
        }
      }
      if (removalFailure) throw removalFailure;
      const restored = await phase(control, 'restored');
      assertInventories(fixed, mutated, restored);
      summary.mechanisms.push({
        id: control.id,
        path: control.path,
        fixedSha256: digest(original),
        mutatedSha256: digest(replacement),
        restoredSha256: digest(readFileSync(path)),
        fixed,
        mutated,
        restored,
      });
      json(join(scratch, 'summary.json'), summary);
    }
    assert.deepEqual(
      sourceState(repository),
      source,
      'Developer bytes/HEAD/index changed during control',
    );
    verifyOwnedTools(repository, toolRoots, ownFiles);
    verifyOwnedTools(graph, toolRoots, ownFiles);
    verifyFiles(graph, manifest.files);
    assert.deepEqual(captureDependencies(repository), dependencies, 'Dependency bytes changed');
    summary.complete = requested.length === 0;
    summary.isolated = true;
    summary.developerSourcesUnchanged = true;
  } catch (error) {
    primaryFailure = error;
    summary.failure = { name: error.name, message: error.message };
  } finally {
    primaryFailure = finish({
      scratch,
      summary,
      primaryFailure,
      repository,
      evidenceKind,
      directory: process.env.RELAVIUM_ACCEPTANCE_EVIDENCE,
    });
  }

  console.log(JSON.stringify(summary, null, 2));
  if (primaryFailure) throw primaryFailure;

  return summary;
}
