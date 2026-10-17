import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { REQUIRED_SMOKE_CASES } from './cases.mjs';
import { assertExit } from './process.mjs';
import { InstalledNativeControlError } from './native-process.mjs';
import {
  emitInstalledWorkerFailure,
  formatInstalledWorkerFailure,
  MAX_WORKER_FAILURE_BYTES,
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
