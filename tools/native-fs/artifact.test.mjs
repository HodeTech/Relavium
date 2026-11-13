import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  NativeArtifactError,
  selectNativeArtifacts,
  stageNativeArtifact,
  ARTIFACT_LIMITS,
} from './artifact.mjs';
import { checkNativeTarget } from './check-target.mjs';
import { inspectNativeAssets, nativeSourceBinding, writeNativeAssets } from './assets.mjs';
import { NATIVE_TARGETS } from './catalog.mjs';
import { syntheticNativeAssets } from './fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'relavium-native-artifacts-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const environment = (attempt = 2) => ({
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: String(attempt),
  GITHUB_SHA: 'c'.repeat(40),
});
function fixture() {
  const repository = join(scratch, `case-${counter++}`);
  mkdirSync(repository);
  const value = syntheticNativeAssets(repository);
  const inputs = join(repository, 'downloads');
  mkdirSync(inputs);
  const add = (target, attempt = 1) => {
    const manifest = {
      ...value.manifest,
      scope: 'development-current',
      assets: value.manifest.assets.filter((asset) => asset.target === target),
    };
    writeNativeAssets(
      value.directory,
      manifest,
      new Map(
        [...value.files].filter(([name]) => !name.endsWith('.node') || name === `${target}.node`),
      ),
    );
    const destination = join(inputs, `native-fs-12345-${attempt}-${target}`);
    stageNativeArtifact({ repository, destination, target, environment: environment(attempt) });
    return destination;
  };
  const select = (attempt = 2, targets = NATIVE_TARGETS) =>
    selectNativeArtifacts({ repository, inputs, environment: environment(attempt), targets });
  const assemble = (attempt = 2) =>
    spawnSync(process.execPath, [join(repository, 'tools/native-fs/assemble.mjs'), inputs], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, ...environment(attempt) },
    });
  return { repository, inputs, value, add, select, assemble };
}
function refuses(work, code) {
  assert.throws(work, (error) => error instanceof NativeArtifactError && error.code === code);
}
function editEnvelope(directory, mutate) {
  const path = join(directory, 'delivery.json');
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  mutate(envelope);
  writeFileSync(path, JSON.stringify(envelope));
}

test('failed consumer retry uses producer attempt one, including consumer attempts beyond the candidate-attempt quota', () => {
  const value = fixture();
  for (const target of NATIVE_TARGETS) value.add(target);
  assert.deepEqual(
    value.select(99).map((asset) => asset.attempt),
    NATIVE_TARGETS.map(() => '1'),
  );
  const complete = value.assemble(2);
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(
    inspectNativeAssets(value.value.directory, {
      complete: true,
      binding: nativeSourceBinding(value.repository),
    }).manifest.assets.length,
    8,
  );
});

test('partial matrix retry selects each latest successful own-source target and assembles a complete inventory', () => {
  const value = fixture();
  for (const target of NATIVE_TARGETS.slice(0, -1)) value.add(target);
  value.add(NATIVE_TARGETS.at(-1), 2);
  value.add(NATIVE_TARGETS[0], 2);
  assert.deepEqual(
    value.select().map((asset) => asset.attempt),
    ['2', '1', '1', '1', '1', '1', '1', '2'],
  );
  const complete = value.assemble();
  assert.equal(complete.status, 0, complete.stderr);
});

test('all-jobs retry keeps immutable older names and chooses the complete newer matrix', () => {
  const value = fixture();
  for (const attempt of [1, 2]) for (const target of NATIVE_TARGETS) value.add(target, attempt);
  assert.deepEqual(
    value.select().map((asset) => asset.attempt),
    NATIVE_TARGETS.map(() => '2'),
  );
  assert.equal(value.assemble().status, 0);
});

test('host selection requires its target and refuses a missing complete matrix', () => {
  const value = fixture();
  value.add(NATIVE_TARGETS[0]);
  assert.equal(value.select(2, [NATIVE_TARGETS[0]])[0].target, NATIVE_TARGETS[0]);
  refuses(() => value.select(), 'INCOMPLETE');
  refuses(() => value.select(2, [NATIVE_TARGETS[1]]), 'INCOMPLETE');
});

test('foreign run/source, future producer, mismatched target and ambiguous aliases refuse before selection', () => {
  for (const change of [
    (directory) =>
      editEnvelope(directory, (envelope) => {
        envelope.runId = '54321';
      }),
    (directory) =>
      editEnvelope(directory, (envelope) => {
        envelope.sourceSha = 'd'.repeat(40);
      }),
    (directory) =>
      editEnvelope(directory, (envelope) => {
        envelope.target = NATIVE_TARGETS[1];
      }),
    (directory) => renameSync(directory, directory.replace('12345-1-', '54321-1-')),
    (directory) => renameSync(directory, directory.replace('12345-1-', '12345-3-')),
  ]) {
    const value = fixture();
    change(value.add(NATIVE_TARGETS[0]));
    refuses(() => value.select(2, [NATIVE_TARGETS[0]]), 'IDENTITY');
  }
  const value = fixture();
  const directory = value.add(NATIVE_TARGETS[0]);
  cpSync(directory, `${directory}-duplicate`, { recursive: true });
  refuses(() => value.select(2, [NATIVE_TARGETS[0]]), 'NAME');
});

test('a newer valid candidate cannot hide corrupt older native evidence, or a changed recipe/source/lock', () => {
  for (const mutate of [
    (value, old) => writeFileSync(join(old, 'assets', `${NATIVE_TARGETS[0]}.node`), 'tampered'),
    (value, old) => {
      const path = join(old, 'assets/native-assets.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.assets[0].validation.nodeCases.pop();
      writeFileSync(path, JSON.stringify(manifest));
    },
    (value) =>
      writeFileSync(join(value.repository, 'tools/native-fs/artifact.mjs'), '// changed recipe'),
    (value) =>
      writeFileSync(
        join(value.repository, 'apps/cli/native/fs-metadata/src/lib.rs'),
        '// changed source',
      ),
    (value) =>
      writeFileSync(
        join(value.repository, 'apps/cli/native/fs-metadata/Cargo.lock'),
        '! synthetic lock',
      ),
  ]) {
    const value = fixture();
    const old = value.add(NATIVE_TARGETS[0]);
    value.add(NATIVE_TARGETS[0], 2);
    mutate(value, old);
    assert.throws(
      () => value.select(2, [NATIVE_TARGETS[0]]),
      (error) => ['BINARY_BINDING', 'PROFILE_EVIDENCE', 'SOURCE_BINDING'].includes(error.code),
    );
  }
});

test('artifact namespace and exact bounded wrapper refuse links, extra files and oversized/malformed envelopes', () => {
  for (const [mutate, code] of [
    [(directory) => writeFileSync(join(directory, 'extra'), ''), 'INVENTORY'],
    [
      (directory) =>
        writeFileSync(
          join(directory, 'delivery.json'),
          ' '.repeat(ARTIFACT_LIMITS.envelopeBytes + 1),
        ),
      'ENVELOPE',
    ],
    [(directory) => writeFileSync(join(directory, 'delivery.json'), '{'), 'ENVELOPE'],
    [(directory) => renameSync(directory, `${directory}${'x'.repeat(129)}`), 'NAME'],
    [
      (directory) => {
        const outside = `${directory}-outside`;
        renameSync(directory, outside);
        symlinkSync(outside, directory, 'junction');
      },
      'DIRECTORY',
    ],
  ]) {
    const value = fixture();
    mutate(value.add(NATIVE_TARGETS[0]));
    refuses(() => value.select(2, [NATIVE_TARGETS[0]]), code);
  }
});

test('candidate and distinct-producer-attempt quotas refuse boundedly without limiting consumer attempt', () => {
  const value = fixture();
  for (let index = 0; index <= ARTIFACT_LIMITS.candidates; index++)
    mkdirSync(join(value.inputs, String(index)));
  refuses(() => value.select(), 'CANDIDATE_BOUND');
  const attempts = fixture();
  for (let attempt = 1; attempt <= ARTIFACT_LIMITS.attempts + 1; attempt++)
    attempts.add(NATIVE_TARGETS[0], attempt);
  refuses(() => attempts.select(99, [NATIVE_TARGETS[0]]), 'ATTEMPT_BOUND');
});

test('check-target independently refuses a wrong requested target, runtime floor and libc baseline', () => {
  const value = fixture();
  const target = NATIVE_TARGETS.find((name) => name.endsWith('-gnu'));
  assert.throws(() => checkNativeTarget(value.repository, undefined), {
    message: 'NATIVE_FS_EXPECTED_TARGET',
  });
  assert.throws(() => checkNativeTarget(value.repository, target), {
    message: 'NATIVE_FS_EXECUTED_TARGET',
  });
  value.add(target);
  assert.equal(checkNativeTarget(value.repository, target).manifest.assets[0].target, target);
  for (const [mutate, code] of [
    [() => {}, 'NATIVE_FS_EXECUTED_TARGET'],
    [
      (manifest) => {
        manifest.assets[0].execution.node = 'v22.13.0';
      },
      'NATIVE_FS_EXECUTED_TARGET',
    ],
    [
      (manifest) => {
        manifest.assets[0].execution.libcVersion = '2.36';
      },
      'NATIVE_FS_EXECUTED_BASELINE',
    ],
  ]) {
    const manifest = JSON.parse(JSON.stringify(value.value.manifest));
    manifest.scope = 'development-current';
    manifest.assets = manifest.assets.filter((asset) => asset.target === target);
    mutate(manifest);
    writeNativeAssets(
      value.value.directory,
      manifest,
      new Map(
        [...value.value.files].filter(
          ([name]) => !name.endsWith('.node') || name === `${target}.node`,
        ),
      ),
    );
    const requested =
      code === 'NATIVE_FS_EXECUTED_TARGET' && manifest.assets[0].execution.node === 'v22.0.0'
        ? NATIVE_TARGETS[0]
        : target;
    assert.throws(() => checkNativeTarget(value.repository, requested), { message: code });
  }
});
