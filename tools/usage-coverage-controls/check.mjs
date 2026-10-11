/** ADR-0104 causal controls: isolated physical sources, whole inventories, exact restoration. */
import assert from 'node:assert/strict';
import { clearTimeout, setTimeout } from 'node:timers';
import { spawn } from 'node:child_process';
import {
  cpSync,
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
import { dirname, join, relative } from 'node:path';
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
} from './source-graph.mjs';
import { mutations, permanentFiles } from './mutations.mjs';
import { exportAcceptanceEvidence } from '../acceptance-evidence/export.mjs';
import { causalWitnesses } from './causal-witnesses.mjs';
import { checkOutcome } from './outcome.mjs';
import {
  assertPermanentWorkload,
  ordinaryPhaseTimeoutMs,
  permanentPhaseTimeoutMs,
} from './workload.mjs';

const repository = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-usage-controls-')));
const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const source = captureSource(repository, join(scratch, 'seed'));
const dependencyManifest = captureDependencies(repository);
const dependencyManifestPath = join(scratch, 'installed-dependencies.json');
json(dependencyManifestPath, dependencyManifest);
json(join(scratch, 'developer-source.json'), source);
const summary = {
  version: 1,
  scratch,
  sourceHead: source.head,
  sourceFiles: source.files.length,
  dependencyPackages: dependencyManifest.packages.length,
  node: process.version,
  mechanisms: [],
  permanent: undefined,
  complete: false,
};
const requested = process.argv.slice(2);
assert.ok(
  requested.length === 0 || (requested.length === 2 && requested[0] === '--mechanism'),
  'Usage: node tools/usage-coverage-controls/check.mjs [--mechanism declared-id]',
);
assert.deepEqual(
  mutations.map((entry) => entry.id).sort(),
  Object.keys(causalWitnesses).sort(),
  'Declared mechanism/witness inventory drift',
);
const selected =
  requested.length === 0 ? mutations : mutations.filter((m) => m.id === requested[1]);
assert.ok(selected.length > 0, 'Unknown declared mechanism');
console.log(`Usage control evidence: ${scratch}`);

function spawnJoined(command, args, options, path, timeoutMs = ordinaryPhaseTimeoutMs) {
  return new Promise((resolve) => {
    // Match the existing tool-host convention: POSIX descendants inherit this owned group.
    // Windows has no POSIX groups; timeout cleanup there is explicitly single-child best effort.
    const ownedProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, {
      ...options,
      detached: ownedProcessGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      spawnError,
      timedOut = false;
    const killOwned = () => {
      if (ownedProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch (error) {
          if (error.code !== 'ESRCH') spawnError ??= { name: error.name, message: error.message };
        }
      }
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killOwned();
    }, timeoutMs);
    child.once('error', (error) => {
      spawnError = { name: error.name, message: error.message };
    });
    child.stdout.setEncoding('utf8').on('data', (text) => {
      stdout += text;
    });
    child.stderr.setEncoding('utf8').on('data', (text) => {
      stderr += text;
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      killOwned();
      writeFileSync(`${path}.stdout.log`, stdout);
      writeFileSync(`${path}.stderr.log`, stderr);
      const result = {
        command,
        args,
        cwd: options.cwd,
        pid: child.pid,
        code,
        signal,
        spawnError,
        timedOut,
        timeoutMs,
        ownedProcessGroup,
        joined: true,
      };
      json(`${path}.process.json`, result);
      resolve(result);
    });
  });
}
function readLines(path) {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
function assertStable(graph, manifest) {
  assert.deepEqual(
    sourceState(repository),
    source,
    'Developer sources/HEAD/index changed during control invocation',
  );
  verifyFiles(graph, manifest.files);
}
function currentManifest(graph) {
  return {
    version: 1,
    sourceRoot: graph,
    files: source.files.map((file) => {
      const bytes = readFileSync(join(graph, file.path));
      return { path: file.path, bytes: bytes.length, sha256: digest(bytes) };
    }),
  };
}
function sourceVariant(mechanism) {
  const graph = join(scratch, mechanism.id, 'graph');
  cpSync(join(scratch, 'seed'), graph, { recursive: true });
  linkDependencies(repository, graph);
  return graph;
}
function phaseEnvironment(controlPath, graph, nativeEvents) {
  const env = {};
  for (const name of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LANG',
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return {
    ...env,
    CI: 'true',
    NO_COLOR: '1',
    RELAVIUM_USAGE_RUNTIME: controlPath,
    NODE_OPTIONS: `--import=${toUrl(join(graph, 'tools/usage-coverage-controls/register.mjs'))}`,
    RELAVIUM_USAGE_NATIVE_EVENTS: nativeEvents,
    RELAVIUM_USAGE_TEST_SOURCE_ENTRY: toUrl(join(graph, 'packages/db/src/index.ts')),
  };
}
function auditRuntime(directory, graph, manifest, manifestSha256, mechanism, phase, nativeEvents) {
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const evaluations = [],
    preparations = [],
    dependencies = [];
  for (const name of readdirSync(directory)) {
    const records = readLines(join(directory, name));
    if (name.endsWith('.dependencies.jsonl')) dependencies.push(...records);
    else if (name.endsWith('.loader-preparation.jsonl')) preparations.push(...records);
    else evaluations.push(...records);
  }
  assert.ok(evaluations.length > 0, 'No actual module-body evaluation witnesses');
  for (const record of [...evaluations, ...preparations]) {
    const file = expected.get(record.relativePath);
    assert.ok(file, 'Unowned evaluated source');
    if (record.threadId !== 0) {
      assert.equal(record.relativePath, 'apps/cli/src/engine/fixtures/ts-resolve-hook.mjs');
      assert.equal(record.stage, 'loader-helper-body-entry');
      assert.ok(preparations.includes(record), 'Loader helper must have a separate raw journal');
    } else {
      assert.equal(record.stage, 'module-body-entry');
      assert.ok(evaluations.includes(record));
    }
    assert.equal(record.sourceMode, 'current');
    assert.equal(record.physicalPath, realpathSync(join(graph, record.relativePath)));
    assert.equal(record.rawSha256, file.sha256);
    assert.equal(record.bytes, file.bytes);
    assert.equal(record.mutationId, mechanism.id);
    assert.equal(record.phase, phase);
    assert.equal(record.manifestSha256, manifestSha256);
    assert.ok(Number.isInteger(record.pid) && record.pid > 0);
    assert.ok(Number.isInteger(record.threadId) && record.threadId >= 0);
  }
  assert.ok(
    evaluations.every((record) => record.threadId === 0),
    'Unexpected loader-thread body cannot count as product runtime',
  );
  if (mechanism.path)
    assert.ok(
      evaluations.some((r) => r.relativePath === mechanism.path),
      'Changed source module has no runtime body-entry witness',
    );
  for (const record of dependencies) {
    const bytes = readFileSync(record.path);
    assert.equal(bytes.length, record.bytes);
    assert.equal(digest(bytes), record.sha256, `Installed dependency changed: ${record.path}`);
  }
  const children = readLines(nativeEvents);
  const native = children.filter((r) => r.stage === 'spawn');
  if (mechanism.nativeChildren)
    assert.equal(native.length, 4, 'Expected four actual invoked crash children');
  for (const child of native) {
    assert.ok(
      children.some((r) => r.pid === child.pid && r.stage === 'barrier'),
      'Native child did not reach real barrier',
    );
    assert.ok(
      children.some((r) => r.pid === child.pid && r.stage === 'close'),
      'Native child close was not joined',
    );
    const witness = evaluations.filter((r) => r.pid === child.pid);
    assert.ok(
      witness.some((r) => r.relativePath === 'packages/db/src/index.ts'),
      'Native child borrowed/missed DB source',
    );
    const worker =
      child.mode === undefined
        ? 'apps/cli/src/engine/fixtures/usage-coverage-crash-worker.ts'
        : 'packages/db/src/fixtures/session-usage-worker.mjs';
    assert.ok(
      witness.some((r) => r.relativePath === worker),
      'Native worker body was not evaluated',
    );
    if (mechanism.nativeChildren) {
      assert.ok(
        witness.some((r) => r.relativePath === mechanism.path),
        'Native child has no target module body-entry witness',
      );
      assert.ok(
        children.some(
          (r) =>
            r.pid === child.pid && r.stage === 'barrier' && r.kind === 'CUT' && r.invocations === 1,
        ),
        'Expected actual invocation CUT',
      );
      assert.ok(
        children.some((r) => r.pid === child.pid && r.stage === 'close' && r.signal === 'SIGKILL'),
        'Expected actual SIGKILL',
      );
    }
  }
  return {
    evaluations: evaluations.length,
    loaderPreparations: preparations.length,
    runtimePids: [...new Set(evaluations.map((r) => r.pid))],
    dependencyFiles: new Set(dependencies.map((r) => r.path)).size,
    nativeChildren: native.length,
  };
}
function inventory(data, graph) {
  assert.equal(data.numPendingTests, 0, 'Skipped causal case');
  assert.equal(data.numTodoTests, 0, 'Unfinished causal case');
  const tests = data.testResults.flatMap((file) =>
    file.assertionResults.map((test) => ({
      file: relative(graph, file.name),
      id: test.fullName,
      status: test.status,
      failures: test.failureMessages,
    })),
  );
  assert.equal(tests.length, data.numTotalTests, 'Incomplete test inventory');
  assert.ok(tests.length > 0, 'No tests collected');
  assert.ok(
    tests.every((t) => t.status === 'passed' || t.status === 'failed'),
    'Non-complete case status',
  );
  return tests;
}
async function runPhase(mechanism, graph, phase) {
  const output = join(scratch, mechanism.id, phase);
  mkdirSync(output, { recursive: true });
  const manifest = currentManifest(graph);
  const manifestPath = join(output, 'source-manifest.json');
  json(manifestPath, manifest);
  assertStable(graph, manifest);
  const evaluationDirectory = join(output, 'evaluation');
  mkdirSync(evaluationDirectory);
  const nativeEvents = join(output, 'native-events.jsonl');
  const config = join(output, 'vitest.config.mjs');
  writeFileSync(
    config,
    `import { sourcePlugin } from ${JSON.stringify(toUrl(join(graph, 'tools/usage-coverage-controls/source-graph.mjs')))};\nexport default { root: ${JSON.stringify(graph)}, cacheDir: ${JSON.stringify(join(output, 'cache'))}, plugins:[sourcePlugin()], test:{environment:'node',cache:false,pool:'forks',maxWorkers:1,fileParallelism:false,include:${JSON.stringify(mechanism.files ?? [])},passWithNoTests:false,testTimeout:20000,hookTimeout:20000} };\n`,
  );
  const configBytes = readFileSync(config);
  const controlPath = join(output, 'runtime.json');
  json(controlPath, {
    manifestPath,
    manifestSha256: digest(readFileSync(manifestPath)),
    dependencyManifestPath,
    dependencyManifestSha256: digest(readFileSync(dependencyManifestPath)),
    evaluationDirectory,
    evaluationHelper: toUrl(join(graph, 'tools/usage-coverage-controls/evaluation.mjs')),
    phase,
    mutationId: mechanism.id,
    infrastructure: [{ path: config, bytes: configBytes.length, sha256: digest(configBytes) }],
  });
  let result;
  if (mechanism.mode) {
    const request = join(output, 'request.json');
    json(request, {
      mode: mechanism.mode,
      sourceRoot: graph,
      provenanceRoot: repository,
      installedDependencyRoot: repository,
      outputDir: join(output, 'replay'),
      evaluation: { directory: evaluationDirectory, phase, mutationId: mechanism.id, manifestPath },
    });
    // B owns a separate verified loader for nested current/frozen captures and immutable dependency bytes.
    const processResult = await spawnJoined(
      process.execPath,
      [join(graph, 'tools/budget-replay-compat/causal-driver.mjs'), request],
      {
        cwd: graph,
        env: { ...phaseEnvironment(controlPath, graph, nativeEvents), NODE_OPTIONS: '' },
      },
      join(output, 'command'),
    );
    const replay = JSON.parse(readFileSync(join(output, 'replay/result.json'), 'utf8'));
    assert.equal(replay.completed, true, 'Frozen driver did not complete its semantic cohort');
    assert.equal(replay.status, phase === 'mutated' ? 'semantic-failure' : 'passed');
    assert.equal(replay.cases.length, mechanism.mode === 'ordinary-gate' ? 2 : 8);
    const tests = replay.cases.map((item) => ({
      file: mechanism.mode,
      id: item.id,
      status: item.status,
      failures:
        item.failure === undefined
          ? []
          : [typeof item.failure === 'string' ? item.failure : JSON.stringify(item.failure)],
    }));
    checkOutcome(tests, processResult, phase, mechanism, causalWitnesses[mechanism.id]);
    assert.ok(
      Array.isArray(replay.evaluationRecords) && replay.evaluationRecords.length > 0,
      'Frozen driver lacks runtime body witnesses',
    );
    for (const record of replay.evaluationRecords) {
      const bytes = readFileSync(record.path);
      assert.equal(digest(bytes), record.sha256, 'Frozen runtime witness changed');
      const entries = bytes
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, record.count);
      assert.ok(
        entries.every(
          (entry) =>
            entry.pid === record.pid &&
            entry.threadId === 0 &&
            entry.phase === 'module-body-entry' &&
            entry.executionPhase === phase &&
            entry.mutationId === mechanism.id,
        ),
        'Frozen witness is not actual module-body evaluation',
      );
    }
    const target = manifest.files.find((file) => file.path === mechanism.path);
    assert.ok(
      replay.joins.some(
        (entry) =>
          entry.sourcePath === join(graph, mechanism.path) && entry.rawSha256 === target.sha256,
      ),
      'Replay has no copied target module body-entry witness',
    );
    assert.ok(
      replay.processes.every(
        (child) =>
          child.workerClosed === true &&
          child.timedOut !== true &&
          child.spawnFailed !== true &&
          child.signal === null,
      ),
      'Replay worker did not close normally',
    );
    if (mechanism.mode === 'ordinary-gate')
      assert.equal(
        tests.find((item) => item.id === 'actual-ordinary-legacy-gate-positive-control')?.status,
        'passed',
      );
    result = { process: processResult, tests, replay: join(output, 'replay/result.json') };
  } else {
    const report = join(output, 'vitest.json');
    const processResult = await spawnJoined(
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
      { cwd: graph, env: phaseEnvironment(controlPath, graph, nativeEvents) },
      join(output, 'command'),
      mechanism.id === 'permanent-native-and-scale'
        ? permanentPhaseTimeoutMs
        : ordinaryPhaseTimeoutMs,
    );
    assert.ok(existsSync(report), `No complete Vitest report; inspect ${output}`);
    const data = JSON.parse(readFileSync(report, 'utf8'));
    const tests = inventory(data, graph);
    const listed = [...new Set(tests.map((t) => t.file))].sort();
    assert.deepEqual(listed, [...mechanism.files].sort(), 'Whole-file inventory differs');
    json(join(output, 'cases.json'), tests);
    checkOutcome(tests, processResult, phase, mechanism, causalWitnesses[mechanism.id]);
    const runtime = auditRuntime(
      evaluationDirectory,
      graph,
      manifest,
      digest(readFileSync(manifestPath)),
      mechanism,
      phase,
      nativeEvents,
    );
    result = { process: processResult, tests, runtime };
  }
  assertStable(graph, manifest);
  json(join(output, 'result.json'), result);
  console.log(
    `${mechanism.id} ${phase}: ${result.tests.filter((t) => t.status === 'passed').length} passed, ${result.tests.filter((t) => t.status === 'failed').length} semantic failures`,
  );
  return result;
}
let primaryFailure;
try {
  for (const mechanism of selected) {
    const graph = sourceVariant(mechanism);
    const original = readFileSync(join(graph, mechanism.path));
    const text = original.toString('utf8');
    assert.equal(text.split(mechanism.before).length, 2, `Mechanism anchor drift: ${mechanism.id}`);
    const fixed = await runPhase(mechanism, graph, 'fixed');
    const mutatedBytes = text.replace(mechanism.before, mechanism.after);
    let mutated;
    try {
      writeFileSync(join(graph, mechanism.path), mutatedBytes);
      writeFileSync(join(scratch, mechanism.id, 'mutated-source.txt'), mutatedBytes);
      mutated = await runPhase(mechanism, graph, 'mutated');
    } finally {
      writeFileSync(join(graph, mechanism.path), original);
      assert.deepEqual(
        readFileSync(join(graph, mechanism.path)),
        original,
        'Restoration differs from original bytes',
      );
    }
    const restored = await runPhase(mechanism, graph, 'restored');
    const ids = (run) => run.tests.map((t) => `${t.file}:${t.id}`).sort();
    assert.deepEqual(ids(mutated), ids(fixed), 'Mutant lost/added cases');
    assert.deepEqual(ids(restored), ids(fixed), 'Restored inventory changed');
    summary.mechanisms.push({
      id: mechanism.id,
      group: mechanism.group,
      path: mechanism.path,
      fixedSha256: digest(original),
      mutatedSha256: digest(mutatedBytes),
      restoredSha256: digest(readFileSync(join(graph, mechanism.path))),
      fixed,
      mutated,
      restored,
    });
    json(join(scratch, 'summary.json'), summary);
  }
  if (requested.length === 0) {
    const permanent = { id: 'permanent-native-and-scale', files: permanentFiles };
    summary.permanent = await runPhase(permanent, sourceVariant(permanent), 'fixed');
    assertPermanentWorkload(summary.permanent);
    assert.deepEqual(
      [...new Set(summary.mechanisms.map((m) => m.group))].sort(),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
  }
  assert.deepEqual(
    captureDependencies(repository),
    dependencyManifest,
    'Installed dependency identities changed',
  );
  assert.deepEqual(sourceState(repository), source, 'Developer source changed');
  summary.complete = true;
  json(join(scratch, 'summary.json'), summary);
  console.log(
    `Completed ${summary.mechanisms.length} declared mechanism controls. Evidence: ${scratch}`,
  );
} catch (error) {
  primaryFailure = { error };
  summary.failure = { name: error.name, message: error.message, stack: error.stack };
  json(join(scratch, 'summary.json'), summary);
  console.error(`Control invocation incomplete; diagnostic evidence retained: ${scratch}`);
}
try {
  exportAcceptanceEvidence({ repository, scratch, kind: 'usage', report: summary });
} catch (error) {
  if (primaryFailure === undefined) primaryFailure = { error };
  else console.error('Acceptance evidence export failed after the primary usage-control failure.');
}
if (primaryFailure !== undefined) throw primaryFailure.error;
