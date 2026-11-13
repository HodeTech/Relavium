import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertInstalledWorkflows } from './workflows.mjs';
import { REQUIRED_SMOKE_CASES } from './cases.mjs';
import { assertExit } from './process.mjs';
import { InstalledNativeControlError } from './native-process.mjs';
import {
  emitInstalledWorkerFailure,
  formatInstalledWorkerFailure,
  MAX_WORKER_FAILURE_BYTES,
  NATIVE_LOAD_DIAGNOSTIC_PREFIX,
  nativeAssetLinks,
  parseNativeLoadDiagnostic,
} from './failure-diagnostic.mjs';

function report() {
  return {
    source: 'a'.repeat(40),
    artifactSha256: 'b'.repeat(64),
    runtime: process.version,
    platform: process.platform,
    pid: 100,
    parentPid: 50,
    success: false,
    compiledUnchanged: true,
    ownedTempRemoved: true,
    cases: REQUIRED_SMOKE_CASES.map((id) => ({ id, passed: true })),
  };
}

test('successful worker stays silent on both formatter and failure-only emitter', () => {
  const success = { ...report(), success: true };
  assert.equal(formatInstalledWorkerFailure(success), undefined);
  let writes = 0;
  emitInstalledWorkerFailure(success, () => {
    writes++;
  });
  assert.equal(writes, 0);
});

test('failure identifies the exact artifact/runtime/canonical case and partial native cleanup facts', () => {
  const failed = report();
  const native = failed.cases.find((item) => item.id === 'actual-native-process-owner');
  native.passed = false;
  native.error =
    'AssertionError [ERR_ASSERTION]: synthetic helper close failed\nprivate stack omitted';
  native.evidence = {
    outcomes: [
      {
        mode: 'injected-error',
        gate: 'helper',
        passed: false,
        watchdogFired: false,
        observed: [{ operation: 'native-helper-actual-close', pid: 80, code: 1, signal: null }],
        cleanup: {
          releaseWritten: true,
          cliActualCloseObserved: true,
          native: [{ pid: 40, absenceObserved: true }],
          sentinel: { pid: 70, actualCloseObserved: true, watchdogFired: false },
          failures: ['Error: synthetic cleanup fault'],
        },
      },
    ],
  };
  const line = formatInstalledWorkerFailure(failed);
  assert.equal(line.split('\n').length, 2);
  const diagnostic = JSON.parse(line);
  assert.equal(diagnostic.source, failed.source);
  assert.equal(diagnostic.artifactSha256, failed.artifactSha256);
  assert.equal(diagnostic.runtime, process.version);
  assert.equal(diagnostic.workerPid, 100);
  assert.equal(diagnostic.parentPid, 50);
  assert.deepEqual(
    diagnostic.cases.map((item) => item.id),
    ['actual-native-process-owner'],
  );
  assert.equal(diagnostic.cases[0].error, 'Failure detail retained in private report.');
  assert.equal(diagnostic.cases[0].native[0].observed[0].code, 1);
  assert.equal(diagnostic.cases[0].native[0].cleanup.sentinel.actualCloseObserved, true);
});

test('strict projection excludes paths, env, argv, transcripts, unknown IDs and raw child output', () => {
  const failed = report();
  const secret = 'UNEXPECTED_PRIVATE_PAYLOAD';
  failed.cases = REQUIRED_SMOKE_CASES.map((id) => ({
    id,
    passed: id !== 'actual-native-process-owner',
    error: 'Error: EACCES opening C:\\private\\fixture.exe',
    env: { secret },
    argv: [secret],
    transcript: secret,
    evidence: {
      outcomes: [
        {
          mode: 'injected-error',
          cli: { code: 1, signal: null, stdout: secret, stderr: secret },
          observed: [
            {
              operation: 'native-target-actual-close',
              pid: 40,
              code: 1,
              signal: null,
              executable: '/private/fixture',
              args: [secret],
              stdout: secret,
              stderr: secret,
            },
            { operation: secret, pid: 41 },
          ],
          cleanup: { cliActualCloseObserved: true, failures: ["Error: unlink '../private/file'"] },
        },
      ],
    },
  }));
  failed.cases.push({ id: secret, passed: false, error: secret });
  failed.error = 'Error: failed at /private/path';
  failed.packageRoot = '/private/package';
  const line = formatInstalledWorkerFailure(failed);
  for (const excluded of [
    secret,
    '/private',
    'C:\\private',
    'transcript',
    'executable',
    'argv',
    'stdout',
    'stderr',
  ])
    assert.equal(line.includes(excluded), false);
  const diagnostic = JSON.parse(line);
  assert.equal(diagnostic.cases.length, 1);
  assert.equal(diagnostic.error, 'Failure detail retained in private report.');
  assert.equal(diagnostic.cases[0].error, 'Failure detail retained in private report.');
  assert.equal(diagnostic.cases[0].native[0].observed.length, 1);
});

test('worker-level cleanup and immutability failures remain visible when all cases passed', () => {
  const failed = {
    ...report(),
    compiledUnchanged: false,
    ownedTempRemoved: false,
    cleanupError: 'Error: synthetic cleanup refusal',
    immutabilityError: 'Error: synthetic compiled drift',
  };
  const diagnostic = JSON.parse(formatInstalledWorkerFailure(failed));
  assert.deepEqual(diagnostic.cases, []);
  assert.equal(diagnostic.compiledUnchanged, false);
  assert.equal(diagnostic.ownedTempRemoved, false);
  assert.equal(diagnostic.cleanupError, 'Failure detail retained in private report.');
  assert.equal(diagnostic.immutabilityError, 'Failure detail retained in private report.');
});

test('oversized Unicode/errors/native observations produce one valid line within eight KiB', () => {
  const failed = report();
  failed.error = 'Error: ' + '超'.repeat(100000);
  failed.cases = REQUIRED_SMOKE_CASES.map((id) => ({
    id,
    passed: false,
    error: 'AssertionError: ' + 'x'.repeat(100000),
    evidence: {
      diagnostic: {
        stage: 'native-journal',
        loaderOutcome: 'refusal',
        assets: {
          loader: 'multiple',
          manifest: 'multiple',
          notices: 'multiple',
          darwinArm64: 'multiple',
          darwinX64: 'multiple',
          windowsArm64: 'multiple',
          windowsX64: 'multiple',
          linuxArm64Gnu: 'multiple',
          linuxX64Gnu: 'multiple',
          linuxArm64Musl: 'multiple',
          linuxX64Musl: 'multiple',
        },
      },
      outcomes: Array.from({ length: 100 }, () => ({
        mode: 'injected-error',
        gate: 'helper',
        passed: false,
        observed: Array.from({ length: 100 }, () => ({
          operation: 'native-helper-actual-close',
          pid: 80,
          parentPid: 40,
          code: 0xc0000135,
          signal: null,
          detached: false,
          shell: false,
          reason: 'Error: ' + 'x'.repeat(1000),
        })),
        cleanup: { failures: Array(100).fill('Error: ' + 'x'.repeat(1000)) },
      })),
    },
  }));
  const line = formatInstalledWorkerFailure(failed);
  assert.ok(Buffer.byteLength(line) <= MAX_WORKER_FAILURE_BYTES);
  assert.equal(line.split('\n').length, 2);
  const diagnostic = JSON.parse(line);
  assert.equal(diagnostic.truncated, true);
  assert.equal(diagnostic.cases.length, REQUIRED_SMOKE_CASES.length);
  assert.equal(diagnostic.cases.at(-1).native[0].observed[0].code, 0xc0000135);
});

test('invalid identities and missing cases cannot introduce arbitrary diagnostic fields or case IDs', () => {
  const failed = {
    ...report(),
    source: '/private/source',
    artifactSha256: 'invalid',
    runtime: 'untrusted runtime',
    platform: 'untrusted platform',
    cases: [{ id: 'unknown-case', passed: false }],
  };
  const diagnostic = JSON.parse(formatInstalledWorkerFailure(failed));
  for (const key of ['source', 'artifactSha256', 'runtime', 'platform'])
    assert.equal(diagnostic[key], 'unavailable');
  assert.deepEqual(
    diagnostic.cases.map((item) => item.id),
    REQUIRED_SMOKE_CASES,
  );
  assert.ok(diagnostic.cases.every((item) => item.status === 'missing'));
  assert.equal(
    JSON.parse(formatInstalledWorkerFailure({ ...report(), runtime: `v${'1'.repeat(10000)}.0.0` }))
      .runtime,
    'unavailable',
  );
});

test('stderr refusal is secondary and never invokes another sink or changes the failed report', () => {
  const failed = report();
  let attempted = 0;
  assert.doesNotThrow(() =>
    emitInstalledWorkerFailure(failed, () => {
      attempted++;
      throw new Error('synthetic stderr refusal');
    }),
  );
  assert.equal(attempted, 1);
  assert.equal(failed.success, false);
});

// Use the actual assertion and wrapper: the installed control supplies child
// stderr as its assertion message, which Node places in the first stack line.
test('actual child-stderr assertion chain stays private through worker failure projection', () => {
  const canary = 'PRIVATE_ASSERTION_CHILD_STDERR_SENTINEL';
  let primary;
  try {
    assertExit({ signal: null, code: 134, stderr: canary }, 9);
  } catch (cause) {
    primary = cause;
  }
  assert.ok(primary instanceof assert.AssertionError);
  const native = new InstalledNativeControlError(primary, { outcomes: [] });
  assert.ok(native.primaryFailure.includes(canary), 'Private primary evidence must be preserved');
  const failed = report();
  const item = failed.cases.find((value) => value.id === 'actual-native-bootstrap-lifecycle');
  item.passed = false;
  // The actual worker retains this exact primaryFailure branch in its private report.
  item.error = native.primaryFailure;
  item.evidence = native.evidence;
  const line = formatInstalledWorkerFailure(failed);
  assert.equal(line.includes(canary), false, 'Public diagnostic copied raw child stderr');
  const diagnostic = JSON.parse(line);
  assert.equal(diagnostic.cases[0].id, 'actual-native-bootstrap-lifecycle');
  assert.equal(diagnostic.cases[0].error, 'Failure detail retained in private report.');
  assert.equal(item.error, native.primaryFailure, 'Projection must not mutate the private report');
});

test('every root, case, native reason and cleanup failure keeps arbitrary first-line text private', () => {
  for (const canary of [
    'PRIVATE_PLAIN_TEXT_FROM_CHILD',
    'Error: child credential token=PRIVATE_CREDENTIAL_VALUE',
    'AssertionError [ERR_ASSERTION]: child argv --secret PRIVATE_ARGUMENT_VALUE',
    'EACCES PRIVATE_NATIVE_DETAIL_WITHOUT_A_PATH',
  ]) {
    const failed = report();
    failed.error = canary;
    failed.cleanupError = canary;
    failed.immutabilityError = canary;
    const item = failed.cases.find((value) => value.id === 'actual-native-process-owner');
    item.passed = false;
    item.error = canary;
    item.evidence = {
      outcomes: [
        {
          mode: 'injected-error',
          passed: false,
          observed: [
            {
              operation: 'native-signal-observed',
              pid: 80,
              owned: true,
              target: -40,
              signal: 'SIGKILL',
              outcome: 'threw',
              nativeCode: 'EPERM',
              errno: -1,
              milliseconds: 2,
              reason: canary,
            },
          ],
          cleanup: { cliActualCloseObserved: true, failures: [canary] },
        },
      ],
    };
    const line = formatInstalledWorkerFailure(failed);
    assert.equal(line.includes(canary), false, 'Arbitrary failure text entered a public field');
    const diagnostic = JSON.parse(line);
    for (const key of ['error', 'cleanupError', 'immutabilityError'])
      assert.equal(diagnostic[key], 'Failure detail retained in private report.');
    const mode = diagnostic.cases[0].native[0];
    assert.equal(mode.observed[0].error, 'Failure detail retained in private report.');
    assert.equal(mode.cleanup.failures[0], 'Failure detail retained in private report.');
    assert.equal(mode.observed[0].nativeCode, 'EPERM');
    assert.equal(mode.observed[0].errno, -1);
    assert.equal(mode.observed[0].target, -40);
    assert.equal(mode.cleanup.cliActualCloseObserved, true);
  }
});

test('case-specific diagnostics project only fixed enums and never cross case fences', () => {
  const failed = report();
  const secret = 'PRIVATE_DIAGNOSTIC_PAYLOAD';
  for (const id of [
    'native-addon-load-only',
    'workflow-gate-budget-effects',
    'installed-version',
  ]) {
    const item = failed.cases.find((value) => value.id === id);
    item.passed = false;
    item.error = secret;
    item.evidence = {
      diagnostic: {
        stage: id === 'workflow-gate-budget-effects' ? 'native-journal' : 'metadata-load',
        loaderOutcome: 'refusal',
        assets: { loader: 'multiple', manifest: 'one', notices: secret, extra: secret },
        path: secret,
        raw: secret,
      },
    };
  }
  const line = formatInstalledWorkerFailure(failed);
  assert.ok(Buffer.byteLength(line) <= MAX_WORKER_FAILURE_BYTES);
  assert.equal(line.split('\n').length, 2);
  assert.equal(line.includes(secret), false);
  const output = JSON.parse(line).cases;
  const native = output.find((item) => item.id === 'native-addon-load-only');
  assert.equal(native.nativeLoad.stage, 'metadata-load');
  assert.equal(native.nativeLoad.loaderOutcome, 'refusal');
  assert.equal(native.nativeLoad.assets.loader, 'multiple');
  assert.equal(native.nativeLoad.assets.manifest, 'one');
  assert.equal(native.nativeLoad.assets.notices, 'unavailable');
  assert.equal('extra' in native.nativeLoad.assets, false);
  assert.deepEqual(output.find((item) => item.id === 'workflow-gate-budget-effects').workflow, {
    stage: 'native-journal',
  });
  assert.equal('nativeLoad' in output.find((item) => item.id === 'installed-version'), false);
  assert.equal('workflow' in output.find((item) => item.id === 'native-addon-load-only'), false);
});

test('native-load receipt parser bounds multiplicity and scrubs untrusted fields', () => {
  const secret = 'PRIVATE_CHILD_RECEIPT';
  const marker =
    NATIVE_LOAD_DIAGNOSTIC_PREFIX +
    JSON.stringify({
      stage: 'metadata-load',
      loaderOutcome: 'refusal',
      assets: { loader: 'multiple', manifest: secret },
      secret,
    });
  const parsed = parseNativeLoadDiagnostic('untrusted before\n' + marker + '\nraw private stack');
  assert.equal(parsed.stage, 'metadata-load');
  assert.equal(parsed.loaderOutcome, 'refusal');
  assert.equal(parsed.assets.loader, 'multiple');
  assert.equal(parsed.assets.manifest, 'unavailable');
  assert.equal(JSON.stringify(parsed).includes(secret), false);
  assert.equal(parseNativeLoadDiagnostic(marker + '\n' + marker), undefined);
  assert.equal(
    parseNativeLoadDiagnostic(NATIVE_LOAD_DIAGNOSTIC_PREFIX + 'x'.repeat(2049)),
    undefined,
  );
  assert.equal(parseNativeLoadDiagnostic(secret.repeat(600000)), undefined);
  const poisoned = parseNativeLoadDiagnostic(
    NATIVE_LOAD_DIAGNOSTIC_PREFIX +
      JSON.stringify({ stage: secret, loaderOutcome: secret, assets: { loader: secret } }),
  );
  assert.equal(poisoned.stage, 'unavailable');
  assert.equal(poisoned.loaderOutcome, 'unavailable');
  assert.equal(poisoned.assets.loader, 'unavailable');
});

test('fixed native asset inventory classifies real hardlinks without exposing paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-native-diag-'));
  try {
    const dir = join(root, 'dist', 'native-fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'loader.cjs'), 'fixture');
    linkSync(join(dir, 'loader.cjs'), join(root, 'alias'));
    writeFileSync(join(dir, 'native-assets.json'), '{}');
    const assets = nativeAssetLinks(root);
    assert.equal(assets.loader, 'multiple');
    assert.equal(assets.manifest, 'one');
    assert.equal(assets.notices, 'unavailable');
    assert.equal(JSON.stringify(assets).includes(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real native-load child emits only fixed receipt on missing keyring failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-native-child-diag-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"isolated-fixture"}');
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./native-load.mjs', import.meta.url)), root],
      {
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '' },
        timeout: 10000,
      },
    );
    assert.notEqual(child.status, 0);
    assert.equal(child.stdout, '');
    const evidence = parseNativeLoadDiagnostic(child.stderr);
    assert.equal(evidence.stage, 'keyring-load');
    assert.equal(evidence.loaderOutcome, 'not-attempted');
    assert.equal(JSON.stringify(evidence).includes(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('oversized case-specific fields remain bounded and unavailable', () => {
  const failed = report();
  const poison = 'PRIVATE_CASE_FIELD'.repeat(100000);
  for (const id of ['native-addon-load-only', 'workflow-gate-budget-effects']) {
    const item = failed.cases.find((value) => value.id === id);
    item.passed = false;
    item.evidence = {
      diagnostic: { stage: poison, loaderOutcome: poison, assets: { loader: poison } },
    };
  }
  const line = formatInstalledWorkerFailure(failed);
  assert.ok(Buffer.byteLength(line) <= MAX_WORKER_FAILURE_BYTES);
  assert.equal(line.includes('PRIVATE_CASE_FIELD'), false);
  const output = JSON.parse(line).cases;
  assert.equal(
    output.find((item) => item.id === 'native-addon-load-only').nativeLoad.stage,
    'unavailable',
  );
  assert.equal(
    output.find((item) => item.id === 'workflow-gate-budget-effects').workflow.stage,
    'unavailable',
  );
});

test('real workflow failure retains the last fixed checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-workflow-diag-'));
  let stage = 'unavailable';
  try {
    await assert.rejects(
      assertInstalledWorkflows({
        root,
        Database: undefined,
        cli: () => ['-e', 'process.exit(7)'],
        environment: () => ({ ...process.env, NODE_PATH: '' }),
        calls: () => [],
        workflowCheckpoint: (value) => {
          stage = value;
        },
      }),
    );
    assert.equal(stage, 'sequential');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real native-load child identifies a fixed metadata loader refusal', () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-native-refusal-diag-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"isolated-fixture"}');
    const keyring = join(root, 'node_modules', '@napi-rs', 'keyring');
    const sqlite = join(root, 'node_modules', 'better-sqlite3');
    const native = join(root, 'dist', 'native-fs');
    for (const dir of [keyring, sqlite, native]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(keyring, 'index.js'), 'module.exports = { Entry: class Entry {} };');
    writeFileSync(join(sqlite, 'index.js'), 'module.exports = class Database {};');
    writeFileSync(
      join(native, 'loader.cjs'),
      "exports.loadFsMetadataAddon = () => { throw new Error('NATIVE_FS_ASSET_UNAVAILABLE'); };",
    );
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./native-load.mjs', import.meta.url)), root],
      { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, timeout: 10000 },
    );
    assert.notEqual(child.status, 0);
    assert.equal(child.stdout, '');
    const evidence = parseNativeLoadDiagnostic(child.stderr);
    assert.equal(evidence.stage, 'metadata-load');
    assert.equal(evidence.loaderOutcome, 'refusal');
    assert.equal(evidence.assets.loader, 'one');
    assert.equal(JSON.stringify(evidence).includes(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
