/** ADR-0105 mechanism removals on physical isolated byte copies with actual source entry aliases. */
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { mutations } from './mutations.mjs';
import { spawnJoined } from './process.mjs';
import { assertPhaseOutcome } from './outcome.mjs';
const repository = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const requested = process.argv.slice(2);
assert.ok(
  requested.length === 0 || (requested.length === 2 && requested[0] === '--mechanism'),
  'Usage: check.mjs [--mechanism declared-id]',
);
const selected = requested.length ? mutations.filter((m) => m.id === requested[1]) : mutations;
assert.ok(selected.length, 'Unknown mechanism');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-fs-controls-')));
const graph = join(scratch, 'graph');
const summary = { version: 1, complete: false, node: process.version, mechanisms: [] };
let primaryFailure;
let source, dependencies, manifest;
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
  json(manifestPath, current);
  const evaluationDirectory = join(output, 'evaluation');
  mkdirSync(evaluationDirectory);
  const config = join(output, 'vitest.config.mjs');
  writeFileSync(
    config,
    `import { sourcePlugin } from ${JSON.stringify(toUrl(join(graph, 'tools/usage-coverage-controls/source-graph.mjs')))};\nexport default { root:${JSON.stringify(graph)}, cacheDir:${JSON.stringify(join(output, 'cache'))}, plugins:[sourcePlugin()], test:{ environment:'node', cache:false, pool:'forks', maxWorkers:1, fileParallelism:false, include:${JSON.stringify(control.files)}, passWithNoTests:false, testTimeout:15000, hookTimeout:15000 } };\n`,
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
      env: { ...process.env, CI: 'true', NO_COLOR: '1', RELAVIUM_USAGE_RUNTIME: runtime },
    },
  );
  writeFileSync(join(output, 'stdout.log'), child.stdout ?? '');
  writeFileSync(join(output, 'stderr.log'), child.stderr ?? '');
  json(join(output, 'process.json'), { ...child, stdout: undefined, stderr: undefined });
  assert.ok(existsSync(report), `${control.id}/${name}: missing completed report`);
  const data = JSON.parse(readFileSync(report, 'utf8'));
  const { tests, failed } = assertPhaseOutcome(data, child, control, name, graph);
  const records = readdirSync(evaluationDirectory)
    .filter((file) => !file.endsWith('.dependencies.jsonl'))
    .flatMap((file) =>
      readFileSync(join(evaluationDirectory, file), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  const target = current.files.find((f) => f.path === control.path);
  assert.ok(
    records.some(
      (r) =>
        r.relativePath === control.path &&
        r.rawSha256 === target.sha256 &&
        r.stage === 'module-body-entry' &&
        r.threadId === 0,
    ),
    'Copied target source has no body evaluation witness',
  );
  for (const r of records) {
    const f = current.files.find((f) => f.path === r.relativePath);
    assert.ok(f);
    assert.equal(r.rawSha256, f.sha256);
    assert.equal(r.physicalPath, realpathSync(join(graph, f.path)));
  }
  verifyFiles(graph, current.files);
  json(join(output, 'cases.json'), tests);
  console.log(
    `${control.id}/${name}: ${tests.length - failed.length} passed; ${failed.length} named semantic failures`,
  );
  return {
    tests: tests.length,
    failed: failed.map((t) => t.id),
    inventory: tests.map((t) => `${t.file}:${t.id}`).sort(),
    targetEvaluations: records.filter((r) => r.relativePath === control.path).length,
  };
}
function exportMetadata() {
  const directory = process.env.RELAVIUM_ACCEPTANCE_EVIDENCE;
  if (directory === undefined) return;
  let ancestor = resolve(directory);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const destination = resolve(
    realpathSync(ancestor),
    relative(ancestor, resolve(directory)),
    'filesystem',
  );
  const delta = relative(repository, destination);
  assert.ok(
    delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta),
    'Evidence must be outside repository',
  );
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(destination);
  let files = 0,
    bytes = 0;
  function copy(dir, rel = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'graph' || entry.name === 'cache') continue;
      const source = join(dir, entry.name),
        path = join(rel, entry.name);
      if (entry.isDirectory()) copy(source, path);
      else if (entry.isFile() && /\.(json|jsonl|log)$/.test(entry.name)) {
        const content = readFileSync(source);
        files++;
        bytes += content.length;
        assert.ok(files <= 2000 && bytes <= 64 * 1024 * 1024, 'Metadata export bound');
        mkdirSync(dirname(join(destination, path)), { recursive: true });
        writeFileSync(join(destination, path), content, { flag: 'wx' });
      }
    }
  }
  copy(scratch);
  json(join(destination, 'export.json'), { version: 1, files, bytes, report: summary });
}
try {
  source = captureSource(repository, graph);
  dependencies = captureDependencies(repository);
  linkDependencies(repository, graph);
  const ownFiles = readdirSync(join(repository, 'tools/fs-policy-controls')).map((name) => {
    const path = join('tools/fs-policy-controls', name),
      bytes = readFileSync(join(repository, path));
    mkdirSync(dirname(join(graph, path)), { recursive: true });
    cpSync(join(repository, path), join(graph, path));
    return { path, bytes: bytes.length, sha256: digest(bytes) };
  });
  manifest = { ...source, files: [...source.files, ...ownFiles] };
  json(join(scratch, 'developer-source.json'), manifest);
  json(join(scratch, 'installed-dependencies.json'), dependencies);
  summary.sourceHead = source.head;
  summary.sourceFiles = manifest.files.length;
  summary.dependencyPackages = dependencies.packages.length;
  console.log(`Captured isolated source graph: ${manifest.files.length} files at ${source.head}`);
  for (const control of selected) {
    const path = join(graph, control.path),
      original = readFileSync(path),
      text = original.toString('utf8');
    assert.equal(text.split(control.before).length, 2, `${control.id}: exact source anchor drift`);
    const fixed = await phase(control, 'fixed');
    let mutated;
    try {
      writeFileSync(path, text.replace(control.before, control.after));
      mutated = await phase(control, 'mutated');
    } finally {
      writeFileSync(path, original);
      assert.deepEqual(readFileSync(path), original);
    }
    const restored = await phase(control, 'restored');
    assert.deepEqual(mutated.inventory, fixed.inventory);
    assert.deepEqual(restored.inventory, fixed.inventory);
    summary.mechanisms.push({
      id: control.id,
      path: control.path,
      fixedSha256: digest(original),
      mutatedSha256: digest(text.replace(control.before, control.after)),
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
  for (const entry of ownFiles)
    assert.equal(
      digest(readFileSync(join(repository, entry.path))),
      entry.sha256,
      'Developer tooling bytes changed',
    );
  assert.deepEqual(captureDependencies(repository), dependencies, 'Dependency bytes changed');
  summary.complete = requested.length === 0;
  summary.isolated = true;
  summary.developerSourcesUnchanged = true;
} catch (error) {
  primaryFailure = error;
  summary.failure = { name: error.name, message: error.message };
} finally {
  json(join(scratch, 'summary.json'), summary);
  try {
    exportMetadata();
  } catch (error) {
    primaryFailure ??= error;
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch (error) {
    primaryFailure ??= error;
  }
}
console.log(JSON.stringify(summary, null, 2));
if (primaryFailure) throw primaryFailure;
