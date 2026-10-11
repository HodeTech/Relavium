/** Bounded source-copy cohorts for ADR-0104; the required smoke remains check.mjs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  replayRoots,
  readReplayArtifacts,
  prepareReplayEnvironment,
} from './replay-environment.mjs';
import { assertBaselineAvailable } from './baseline-provenance.mjs';
import { runReplayStage } from './worker-stage.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.ok(request.mode === 'ordinary-gate' || request.mode === 'session-roundtrip');
for (const key of ['sourceRoot', 'provenanceRoot', 'installedDependencyRoot', 'outputDir'])
  assert.equal(typeof request[key], 'string', key);
for (const key of ['directory', 'phase', 'mutationId', 'manifestPath'])
  assert.equal(typeof request.evaluation?.[key], 'string', `evaluation.${key}`);
assert.ok(['fixed', 'mutated', 'restored'].includes(request.evaluation.phase));
const roots = replayRoots({
  provenanceRoot: request.provenanceRoot,
  currentSourceRoot: request.sourceRoot,
  installedDependencyRoot: request.installedDependencyRoot,
});
assertBaselineAvailable(roots.provenanceRoot);
const output = request.outputDir;
if (!existsSync(output)) mkdirSync(output, { recursive: true });
assert.equal(realpathSync(output), output, 'Output must be a physical absolute directory');
assert.equal(readdirSync(output).length, 0, 'Output must be exclusively empty');
for (const root of Object.values(roots))
  assert.ok(
    !output.startsWith(`${root}${sep}`) && output !== root,
    'Evidence must be outside source/provenance/dependency roots',
  );
const owned = join(output, 'replay');
mkdirSync(owned);
for (const directory of [
  'tmp',
  'cache',
  'config',
  'logs',
  'results',
  'raw',
  'databases',
  'node_modules',
  'frozen',
  'producer',
])
  mkdirSync(join(owned, directory));
writeFileSync(join(owned, 'package.json'), '{"type":"module"}\n');
const environment = {
  ...process.env,
  TMPDIR: join(owned, 'tmp'),
  TMP: join(owned, 'tmp'),
  TEMP: join(owned, 'tmp'),
  XDG_CACHE_HOME: join(owned, 'cache'),
  XDG_CONFIG_HOME: join(owned, 'config'),
  NODE_COMPILE_CACHE: join(owned, 'cache/node-compile'),
  NODE_PATH: '',
  NODE_OPTIONS: '',
};
const tooling = join(roots.currentSourceRoot, 'tools/budget-replay-compat');
const processes = [];
const result = {
  version: 1,
  mode: request.mode,
  phase: request.evaluation.phase,
  mutationId: request.evaluation.mutationId,
  roots,
  owned,
  cases: [],
  processes,
  completed: false,
  qualifications: [
    'Actual source is checked against pinned Git objects for frozen source and the explicit physical variant manifest for current source.',
    'Portable predecessor dependency bytes are digest-local reviewed captures; lockfile graph correspondence is not registry tarball attestation.',
    'The copied installed native SQLite binary is the explicitly invocation-specific platform exception.',
    'Session downgrade preserves uncertainty after durable old writes; active downgrade budget safety and recovery of an unrecorded call are unsupported.',
  ],
};
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
let primary;
try {
  const artifacts = readReplayArtifacts(tooling);
  prepareReplayEnvironment({
    roots,
    tooling,
    owned,
    environment,
    artifacts,
    verifyGuards: false,
    evaluation: request.evaluation,
  });
  const stages =
    request.mode === 'ordinary-gate'
      ? [
          ['ordinary-gate-producer', 'producer', 'ordinary-gate-producer.mjs'],
          ['ordinary-gate-predecessor', 'frozen', 'ordinary-gate-predecessor.mjs'],
        ]
      : [
          ['session-new', 'producer', 'session-new.mjs'],
          ['session-old', 'frozen', 'session-old.mjs'],
          ['session-reopened', 'producer', 'session-reopened.mjs'],
        ];
  let stageFailure;
  for (const [stage, source, script] of stages) {
    try {
      await runReplayStage({ owned, stage, source, script, environment, processes });
    } catch (error) {
      stageFailure = error;
      break;
    }
  }
  const last = processes.at(-1);
  assert.equal(processes.length, stages.length, 'Every bounded stage must actually run');
  assert.ok(
    processes.every(
      (item) => item.workerClosed && !item.spawnFailed && !item.timedOut && item.signal === null,
    ),
    'Spawn/import/readiness failure is not causal evidence',
  );
  const expectedResult =
    request.mode === 'ordinary-gate' ? 'ordinary-gate-predecessor' : 'session-reopened';
  const evidence = json(join(owned, `results/${expectedResult}.json`));
  assert.equal(evidence.completed, true);
  const ids =
    request.mode === 'ordinary-gate'
      ? ['current-ordinary-gate-refusal', 'actual-ordinary-legacy-gate-positive-control']
      : [
          'zero-cost',
          'owner-update',
          'message-insert',
          'message-delete',
          'cost-delete',
          'reparent-from',
          'reparent-to',
          'old-insert',
        ];
  assert.deepEqual(
    evidence.cases.map((item) => item.id),
    ids,
  );
  result.cases = evidence.cases;
  const failed = result.cases.filter((item) => item.status === 'failed');
  const marker =
    request.mode === 'ordinary-gate'
      ? 'USAGE_OWNER_BASIS_REPLAY_NOT_REFUSED'
      : 'USAGE_SESSION_REVISION_TAINT_LOST';
  if (stageFailure) {
    assert.ok(failed.length > 0, 'Nonsemantic worker failure is not a mutation result');
    assert.ok(failed.every((item) => item.failure === marker));
    assert.equal(last.code, 1);
    assert.match(
      readFileSync(join(owned, `logs/${last.stage}.stderr.log`), 'utf8'),
      new RegExp(marker),
    );
  } else {
    assert.equal(failed.length, 0);
    assert.ok(processes.every((item) => item.code === 0));
  }
  const producerManifestPath = join(owned, 'producer-source-manifest.json');
  const frozenManifestPath = join(owned, 'frozen/source-manifest.json');
  const supplementManifestPath = join(owned, 'session-source-supplement.json');
  const dependencyManifestPath = join(owned, 'dependency-runtime.json');
  result.sourceManifests = [producerManifestPath, frozenManifestPath, supplementManifestPath].map(
    (path) => ({ path, sha256: digest(readFileSync(path)) }),
  );
  result.dependencyManifest = {
    path: dependencyManifestPath,
    sha256: digest(readFileSync(dependencyManifestPath)),
  };
  result.provenanceManifest = {
    path: join(owned, 'baseline-provenance.json'),
    sha256: digest(readFileSync(join(owned, 'baseline-provenance.json'))),
  };
  result.outerManifest = {
    path: request.evaluation.manifestPath,
    sha256: digest(readFileSync(request.evaluation.manifestPath)),
  };
  const producerFiles = new Map(
    json(producerManifestPath).files.map((file) => [join(owned, 'producer', file.path), file]),
  );
  const frozenRaw = json(frozenManifestPath);
  const frozenFiles = new Map(
    [...(frozenRaw.files ?? frozenRaw), ...json(supplementManifestPath).files].map((file) => [
      join(owned, 'frozen', file.path),
      file,
    ]),
  );
  const workerFiles = new Map(
    json(dependencyManifestPath)
      .files.filter((file) => file.workerTool)
      .map((file) => [join(owned, file.path), file]),
  );
  const outerFiles = new Map(
    json(request.evaluation.manifestPath).files.map((file) => [file.path, file]),
  );
  result.evaluationRecords = [];
  result.joins = [];
  for (const child of processes) {
    const path = join(request.evaluation.directory, `${child.pid}.ndjson`);
    const records = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(records.length > 0, 'Runtime evaluation is required');
    for (const record of records) {
      assert.equal(record.phase, 'module-body-entry');
      assert.equal(record.pid, child.pid);
      assert.equal(record.ppid, process.pid);
      assert.equal(
        record.threadId,
        0,
        'Loader-thread preparation cannot certify runtime evaluation',
      );
      assert.equal(record.executionPhase, request.evaluation.phase);
      assert.equal(record.mutationId, request.evaluation.mutationId);
      assert.equal(record.outerSourceManifestSha256, result.outerManifest.sha256);
      const files =
        record.sourceMode === 'worker-tool'
          ? workerFiles
          : child.source === 'producer'
            ? producerFiles
            : frozenFiles;
      assert.equal(
        record.sourceMode,
        record.sourceMode === 'worker-tool' ? 'worker-tool' : child.source,
      );
      const file = files.get(record.physicalPath);
      assert.ok(file, `Wrong-root/unowned runtime evaluation: ${record.physicalPath}`);
      assert.equal(record.rawSha256, file.sha256);
      assert.equal(record.bytes, file.bytes ?? file.size);
      assert.equal(digest(readFileSync(record.physicalPath)), record.rawSha256);
      if (record.sourceMode === 'producer') {
        const outerPath = relative(join(owned, 'producer'), record.physicalPath)
          .split(sep)
          .join('/');
        assert.equal(outerFiles.get(outerPath)?.sha256, record.rawSha256);
        result.joins.push({
          pid: child.pid,
          nestedPhysicalPath: record.physicalPath,
          sourcePath: join(roots.currentSourceRoot, outerPath),
          rawSha256: record.rawSha256,
        });
      }
    }
    const required =
      child.source === 'frozen'
        ? [
            'packages/db/src/client.ts',
            ...(request.mode === 'ordinary-gate'
              ? [
                  'packages/db/src/run-history-store.ts',
                  'packages/core/src/engine/engine.ts',
                  'apps/cli/src/engine/checkpointer.ts',
                ]
              : ['packages/db/src/session-store.ts']),
          ]
        : ['packages/db/src/index.ts', 'packages/db/src/session-usage-write.ts'];
    if (request.mode === 'ordinary-gate' && child.source === 'producer')
      required.splice(0, required.length, 'packages/core/src/engine/engine.ts');
    for (const expected of required)
      assert.ok(
        records.some(
          (record) => record.sourceMode === child.source && record.relativePath === expected,
        ),
        `Missing actual evaluated mechanism ${child.stage}/${expected}`,
      );
    assert.ok(
      records.some(
        (record) =>
          record.sourceMode === 'worker-tool' &&
          record.relativePath === stages.find((stage) => stage[0] === child.stage)[2],
      ),
      'Actual worker module-body witness required',
    );
    result.evaluationRecords.push({
      pid: child.pid,
      path,
      count: records.length,
      sha256: digest(readFileSync(path)),
    });
  }
  // Verify unchanged nested source and captured dependency bytes after every actual worker closes.
  for (const [path, file] of [...producerFiles, ...frozenFiles, ...workerFiles]) {
    const bytes = readFileSync(path);
    assert.equal(bytes.length, file.bytes ?? file.size);
    assert.equal(digest(bytes), file.sha256);
  }
  for (const file of json(dependencyManifestPath).files) {
    const bytes = readFileSync(join(owned, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(digest(bytes), file.sha256);
  }
  result.status = failed.length > 0 ? 'semantic-failure' : 'passed';
  result.completed = true;
  if (failed.length > 0) process.exitCode = 1;
} catch (error) {
  primary = error;
  result.status = 'harness-failure';
  result.failure = { name: error?.name, message: error?.message, stack: error?.stack };
  process.exitCode = 1;
} finally {
  writeFileSync(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(owned, 'worker-closure.json'), `${JSON.stringify({ processes }, null, 2)}\n`);
}
if (primary) throw primary;
console.log(
  JSON.stringify({
    completed: result.completed,
    status: result.status,
    cases: result.cases.map(({ id, status, failure }) => ({ id, status, failure })),
    result: join(output, 'result.json'),
  }),
);
