/** ADR-0100: actual current engine writes, actual frozen predecessor refuses. Offline only. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBaselineAvailable } from './baseline-provenance.mjs';
import {
  replayRoots,
  readReplayArtifacts,
  prepareReplayEnvironment,
} from './replay-environment.mjs';
import {
  allocateEvidence,
  finishEvidence,
  captureEvidenceFinalization,
  warnEvidenceFailure,
} from './evidence-retention.mjs';
import { checkRetentionGuards } from './evidence-retention-smoke.mjs';
import { runReplayStage } from './worker-stage.mjs';
import { checkLifecycleGuards } from './lifecycle-smoke.mjs';
import { verifyReplayInventory, checkReplayInventoryGuards } from './replay-inventory.mjs';
import { auditRequiredEvaluations } from './evaluation-audit.mjs';

const tooling = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
const repository = realpathSync(join(tooling, '../..'));
assertBaselineAvailable(repository);
const roots = replayRoots({
  provenanceRoot: repository,
  currentSourceRoot: repository,
  installedDependencyRoot: repository,
});
const artifacts = readReplayArtifacts(tooling);
// Keep the newest three completed invocations; active and foreign evidence is never pruned.
const allocation = allocateEvidence(repository, tmpdir());
const owned = allocation.owned;
let completion = 'failure';
let primaryFailure = false;
let finalization = { failed: false };
try {
  writeFileSync(
    join(owned, 'OWNER'),
    `ADR-0100 replay; parent PID ${process.pid}; source ${repository}\n`,
  );
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
  writeFileSync(join(owned, 'package.json'), '{"type":"module"}\n');
  await checkRetentionGuards(owned, environment);
  await checkLifecycleGuards(owned, environment);
  prepareReplayEnvironment({ roots, tooling, owned, environment, artifacts });
  const processes = [];
  let workerFailure = false;
  let workerFinalization = { failed: false };
  try {
    for (const [stage, mode, script] of [
      ['session-new', 'producer', 'session-new.mjs'],
      ['session-old', 'frozen', 'session-old.mjs'],
      ['session-reopened', 'producer', 'session-reopened.mjs'],
      ['legacy', 'frozen', 'legacy-producer.mjs'],
      ['producer', 'producer', 'producer.mjs'],
      ['predecessor', 'frozen', 'predecessor.mjs'],
    ]) {
      await runReplayStage({ owned, stage, source: mode, script, environment, processes });
    }
  } catch (error) {
    workerFailure = true;
    throw error;
  } finally {
    workerFinalization = captureEvidenceFinalization(
      () =>
        writeFileSync(
          join(owned, 'worker-closure.json'),
          `${JSON.stringify({ processes }, null, 2)}\n`,
        ),
      workerFailure,
      () =>
        warnEvidenceFailure(
          `Replay worker evidence finalization failed; primary worker failure retained. Evidence: ${owned}\n`,
        ),
    );
  }
  if (workerFinalization.failed) throw workerFinalization.error;
  const producerEvidence = JSON.parse(
    readFileSync(join(owned, 'results/producer-cases.json'), 'utf8'),
  );
  const predecessorEvidence = JSON.parse(
    readFileSync(join(owned, 'results/predecessor-evidence.json'), 'utf8'),
  );
  const inventory = verifyReplayInventory(producerEvidence, predecessorEvidence);
  writeFileSync(join(owned, 'replay-inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
  checkReplayInventoryGuards(producerEvidence, predecessorEvidence, owned);
  const sessionOperations = [
    'zero-cost',
    'owner-update',
    'message-insert',
    'message-delete',
    'cost-delete',
    'reparent-from',
    'reparent-to',
    'old-insert',
  ];
  for (const stage of ['session-new', 'session-old', 'session-reopened']) {
    const evidence = JSON.parse(readFileSync(join(owned, `results/${stage}.json`), 'utf8'));
    assert.equal(evidence.completed, true);
    assert.equal(evidence.databaseClosed, true);
    assert.deepEqual(
      evidence.operations,
      stage === 'session-new' ? sessionOperations.slice(0, -1) : sessionOperations,
    );
    if (stage === 'session-old')
      assert.equal(evidence.sourceBlob, '9b4c5a1b5235dc44b110e41d7cc71cad5d071162');
    if (stage === 'session-reopened') {
      assert.equal(evidence.stickyOwners, 8);
      assert.equal(evidence.zeroCostPreserved, true);
      assert.equal(evidence.oldCallCountPreserved, true);
    }
  }
  auditRequiredEvaluations(owned, processes);
  completion = 'success';
} catch (error) {
  primaryFailure = true;
  throw error;
} finally {
  finalization = captureEvidenceFinalization(
    () => finishEvidence(allocation, completion),
    primaryFailure,
    () =>
      warnEvidenceFailure(
        `Replay evidence finalization failed; primary check failure retained. Evidence: ${owned}\n`,
      ),
  );
}
if (finalization.failed) throw finalization.error;
