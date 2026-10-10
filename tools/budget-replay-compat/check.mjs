/** ADR-0100: actual current engine writes, actual frozen predecessor refuses. Offline only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { snapshotDependencyClosure } from './dependency-closure.mjs';
import { checkClosureGuards } from './closure-smoke.mjs';
import { systemTool } from './system-tools.mjs';
import {
  assertBaselineAvailable,
  verifyBaselineProvenance,
  checkBaselineProvenanceGuards,
} from './baseline-provenance.mjs';
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

const tooling = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
const repository = realpathSync(join(tooling, '../..'));
assertBaselineAvailable(repository);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const archive = readFileSync(join(tooling, 'frozen/pre-w7-source.tar.gz'));
assert.equal(archive.length, 843319);
assert.equal(digest(archive), 'cf980edd6d4d8a8652fa236c1c0d46055249fe59944ec284a120aea19c6b10bb');
const dependencyBytes = readFileSync(join(tooling, 'frozen/dependencies.json.gz'));
assert.equal(
  digest(dependencyBytes),
  '7cce53b58c5eade131f59dcce426519980b9cdc27644d9fbade5087b625bd529',
);
const pins = JSON.parse(gunzipSync(dependencyBytes).toString('utf8'));
const portableArchive = readFileSync(join(tooling, 'frozen/dependency-bytes.bin.gz'));
assert.equal(portableArchive.length, 20143535);
assert.equal(
  digest(portableArchive),
  '807644e6f71d153f7bfa4e0f47a3304f851391ee40ad18635ded1468a8fc5c49',
);
const portableBytes = gunzipSync(portableArchive, { maxOutputLength: 112929573 });
assert.equal(portableBytes.length, 112929573);
assert.equal(
  digest(portableBytes),
  'e37029d0ea9fdfbae33a97e2fce68a260bb2ad1af2ce867d6b28f2f9abcedd53',
);

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
  };
  writeFileSync(join(owned, 'package.json'), '{"type":"module"}\n');
  await checkRetentionGuards(owned, environment);
  await checkLifecycleGuards(owned, environment);
  writeFileSync(join(owned, 'frozen-pre-w7-source.tar.gz'), archive);
  execFileSync(
    systemTool('tar'),
    ['-xzf', join(owned, 'frozen-pre-w7-source.tar.gz'), '-C', join(owned, 'frozen')],
    { cwd: owned, env: environment },
  );
  const frozenManifestBytes = readFileSync(join(owned, 'frozen/source-manifest.json'));
  assert.equal(
    digest(frozenManifestBytes),
    'cb3361e5c0f75d427ee936ba43beba871acacbc117729df7820dbb7aa5ec229b',
  );
  const frozenManifest = JSON.parse(frozenManifestBytes.toString('utf8'));
  for (const file of frozenManifest.files ?? frozenManifest) {
    const bytes = readFileSync(join(owned, 'frozen', file.path));
    assert.equal(bytes.length, file.bytes ?? file.size, file.path);
    assert.equal(digest(bytes), file.sha256, file.path);
  }
  assert.equal(digest(readFileSync(join(owned, 'frozen/pnpm-lock.yaml'))), pins.baselineLockSha256);
  writeFileSync(
    join(owned, 'baseline-provenance.json'),
    `${JSON.stringify(verifyBaselineProvenance(repository, join(owned, 'frozen'), frozenManifest), null, 2)}\n`,
  );
  checkBaselineProvenanceGuards(repository, join(owned, 'frozen'), frozenManifest, owned);

  const producerFiles = [];
  function snapshot(path) {
    const full = join(repository, path);
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) snapshot(child);
      else if (
        entry.isFile() &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.test.tsx')
      )
        copySource(child);
    }
  }
  function copySource(path) {
    const bytes = readFileSync(join(repository, path));
    const target = join(owned, 'producer', path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    producerFiles.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  for (const name of ['shared', 'llm', 'core', 'db']) {
    snapshot(`packages/${name}/src`);
    copySource(`packages/${name}/package.json`);
  }
  snapshot('packages/db/drizzle');
  for (const path of ['pnpm-lock.yaml', 'package.json', 'apps/cli/src/engine/checkpointer.ts'])
    copySource(path);
  producerFiles.sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(
    join(owned, 'producer-source-manifest.json'),
    `${JSON.stringify({ files: producerFiles }, null, 2)}\n`,
  );
  writeFileSync(
    join(owned, 'producer-version.json'),
    `${JSON.stringify(
      {
        head: execFileSync(systemTool('git'), ['rev-parse', 'HEAD'], {
          cwd: repository,
          encoding: 'utf8',
        }).trim(),
        status: execFileSync(systemTool('git'), ['status', '--porcelain'], {
          cwd: repository,
          encoding: 'utf8',
        }),
        sourceManifestSha256: digest(readFileSync(join(owned, 'producer-source-manifest.json'))),
      },
      null,
      2,
    )}\n`,
  );
  const workerFiles = [
    'loader.mjs',
    'register.mjs',
    'dependency-runtime.mjs',
    'producer-common.mjs',
    'legacy-producer.mjs',
    'producer.mjs',
    'predecessor.mjs',
  ];
  for (const file of workerFiles) cpSync(join(tooling, file), join(owned, file));

  writeSync(1, `Budget replay evidence: ${owned}\n`);
  const dependencyRuntime = snapshotDependencyClosure(repository, owned, pins, portableBytes);
  for (const file of workerFiles) {
    const bytes = readFileSync(join(owned, file));
    dependencyRuntime.files.push({
      path: file,
      bytes: bytes.length,
      sha256: digest(bytes),
      workerTool: true,
    });
  }
  writeFileSync(
    join(owned, 'dependency-runtime.json'),
    `${JSON.stringify(dependencyRuntime, null, 2)}\n`,
  );
  const requireOwned = createRequire(join(owned, 'package.json'));
  const baselineLock = requireOwned('yaml').parse(
    readFileSync(join(owned, 'frozen/pnpm-lock.yaml'), 'utf8'),
  );
  for (const pin of pins.packages)
    assert.ok(Object.hasOwn(baselineLock.packages, pin.baselineLockPackageKey), pin.name);
  checkClosureGuards(owned, tooling, environment);
  const processes = [];
  let workerFailure = false;
  let workerFinalization = { failed: false };
  try {
    for (const [stage, mode, script] of [
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
