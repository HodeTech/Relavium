import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import {
  assertObservedGroupRefusal,
  assertNativeBootstrapDiagnostic,
  copyFixtureNode,
  copyFixtureRuntimeSupport,
  createFixtureSentinel,
  InstalledNativeControlError,
  pendingNativeFixturePids,
} from './native-process.mjs';
import { explicitEnvironment, ndjson, poll } from './process.mjs';

function observedGroupRefusal() {
  return {
    platform: 'darwin',
    mode: 'injected-error',
    runtime: process.version,
    cliPid: 60,
    result: {
      code: 9,
      signal: null,
      stdout: '{"type":"session:cancelled"}\n',
      stderr:
        '{"type":"error","code":"cli_internal","message":"An unexpected CLI failure occurred. Inspect existing work before repeating paid or effectful operations."}\n',
    },
    observed: [
      { operation: 'native-target-spawn', pid: 40, detached: true, exitCallbacksBeforeEntry: 1 },
      {
        operation: 'native-signal-observed',
        target: -40,
        owned: true,
        signal: 'SIGKILL',
        outcome: 'returned',
        returned: true,
        milliseconds: 1,
      },
      {
        operation: 'native-signal-observed',
        target: -40,
        owned: true,
        signal: 'SIGKILL',
        outcome: 'threw',
        nativeCode: 'EPERM',
        errno: -1,
        milliseconds: 2,
      },
      { operation: 'native-target-actual-close', pid: 40, code: null, signal: 'SIGKILL' },
      {
        operation: 'native-signal-observed',
        target: -40,
        owned: true,
        signal: 'SIGKILL',
        outcome: 'threw',
        nativeCode: 'ESRCH',
        errno: -3,
        milliseconds: 3,
      },
      { operation: 'native-target-close-delivered', pid: 40 },
      { operation: 'native-target-close-delivered', pid: 40 },
      { operation: 'native-signal-diagnostics-complete', complete: true, observations: 3 },
    ],
  };
}

test('observed owned-group refusal requires sticky infrastructure 9 and no ordinary completion', () => {
  assert.deepEqual(assertObservedGroupRefusal(observedGroupRefusal()), []);
});

for (const [name, mutate] of [
  ['a different platform', (v) => (v.platform = 'linux')],
  ['a different native mode', (v) => (v.mode = 'leader-exit')],
  ['a swallowed fault', (v) => (v.result.code = 0)],
  ['a signal exit', (v) => (v.result.signal = 'SIGTERM')],
  ['a false completed turn', (v) => (v.result.stdout += '{"type":"session:turn_completed"}\n')],
  ['a different diagnostic', (v) => (v.result.stderr = '{"code":"output_unavailable"}\n')],
  ['private diagnostic text', (v) => (v.result.stderr += 'PRIVATE_NATIVE_CANARY\n')],
  ['an extra diagnostic', (v) => (v.result.stderr += v.result.stderr)],
  ['missing complete evidence', (v) => v.observed.pop()],
  ['truncated evidence', (v) => (v.observed.at(-1).complete = false)],
  ['a wrong observation count', (v) => (v.observed.at(-1).observations = 2)],
  ['a second creation', (v) => v.observed.unshift({ ...v.observed[0], pid: 41 })],
  ['missing group authority', (v) => (v.observed[0].detached = false)],
  ['missing creation registration', (v) => (v.observed[0].exitCallbacksBeforeEntry = 0)],
  ['foreign signal ownership', (v) => (v.observed[2].owned = false)],
  ['a different group', (v) => (v.observed[2].target = -41)],
  ['a positive PID', (v) => (v.observed[2].target = 40)],
  ['an unrelated signal', (v) => (v.observed[2].signal = 0)],
  ['an unproved first request', (v) => (v.observed[1].returned = false)],
  ['a different refusal', (v) => (v.observed[2].nativeCode = 'EACCES')],
  ['missing native errno', (v) => delete v.observed[2].errno],
  ['a nonfinite clock', (v) => (v.observed[2].milliseconds = NaN)],
  ['a reversed clock', (v) => (v.observed[2].milliseconds = 4)],
  ['missing later absence', (v) => (v.observed[4].nativeCode = 'EPERM')],
  ['a foreign target close', (v) => (v.observed[3].pid = 41)],
  ['a wrong native close', (v) => (v.observed[3].signal = 'SIGTERM')],
  ['an absent close delivery', (v) => v.observed.splice(5, 1)],
  ['a foreign close delivery', (v) => (v.observed[5].pid = 41)],
  ['premature close delivery', (v) => v.observed.splice(1, 0, v.observed.splice(5, 1)[0])],
  [
    'an uncaught native error',
    (v) => {
      v.observed.splice(-1, 0, {
        operation: 'native-uncaught-exception-observed',
        milliseconds: 4,
      });
      v.observed.at(-1).observations++;
    },
  ],
]) {
  test(`observed group refusal rejects ${name}`, () => {
    const vector = observedGroupRefusal();
    mutate(vector);
    assert.throws(() => assertObservedGroupRefusal(vector));
  });
}

test('each fixture sentinel owns a separate bounded lifetime and joins native close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-native-sentinel-test-'));
  try {
    for (let mode = 0; mode < 3; mode++) {
      const sibling = await createFixtureSentinel(root, explicitEnvironment(root, root), 5000);
      try {
        sibling.assertAlive();
      } finally {
        await sibling.close();
      }
      assert.equal(sibling.state().actualCloseObserved, true);
      assert.equal(sibling.state().watchdogFired, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sentinel watchdog cleanup is joined but remains failure evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-native-sentinel-timeout-'));
  let sibling;
  try {
    sibling = await createFixtureSentinel(root, explicitEnvironment(root, root), 1000);
    await poll(() => sibling.state().watchdogFired, 3000, 'Sentinel watchdog did not fire');
    assert.throws(() => sibling.assertAlive(), /watchdog/);
    await assert.rejects(sibling.close(), /watchdog/);
    assert.equal(sibling.state().actualCloseObserved, true);
  } finally {
    await sibling?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test('native control failure preserves its exact primary and partial mode/cleanup evidence', () => {
  const primary = new Error('fixture startup failed');
  const evidence = {
    outcomes: [
      {
        mode: 'injected-error',
        passed: false,
        observed: [
          { operation: 'native-target-actual-close', stderr: 'bounded dyld startup failure' },
        ],
        cleanup: { cliActualCloseObserved: true, failures: [] },
      },
    ],
  };
  const failure = new InstalledNativeControlError(primary, evidence);
  assert.equal(failure.cause, primary);
  assert.equal(failure.primaryFailure, primary.stack);
  assert.equal(failure.evidence, evidence);
  assert.equal(failure.evidence.outcomes[0].passed, false);
});

test(
  'two same-directory copied Nodes share verified runtime support and acknowledge the actual descendant',
  { timeout: 10000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'relavium-status-fixture-test-'));
    const executable = join(root, process.platform === 'win32' ? 'git.exe' : 'git');
    const descendantNode = join(root, process.platform === 'win32' ? 'taskkill.exe' : 'taskkill');
    const log = join(root, 'native.ndjson');
    const libraries = copyFixtureNode(executable);
    for (const name of libraries) chmodSync(join(root, name), 0o444);
    assert.deepEqual(copyFixtureNode(descendantNode), libraries);
    copyFileSync(
      fileURLToPath(new URL('./native-status.cjs', import.meta.url)),
      join(root, 'status'),
    );
    writeFileSync(
      join(root, 'native-fixture.json'),
      JSON.stringify({
        mode: 'injected-error',
        log,
        node: descendantNode,
        descendant: fileURLToPath(new URL('./native-descendant.cjs', import.meta.url)),
      }),
    );
    const child = spawn(executable, ['status'], {
      cwd: root,
      env: explicitEnvironment(root, root),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      closed = false,
      descendant;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const joined = new Promise((resolve) =>
      child.once('close', () => {
        closed = true;
        resolve();
      }),
    );
    const rows = () => (existsSync(log) ? ndjson(readFileSync(log, 'utf8')) : []);
    const killDescendant = () => {
      descendant ??= rows().find(
        (item) => item.operation === 'native-fixture-descendant' && item.parentPid === child.pid,
      )?.pid;
      if (descendant !== undefined) {
        try {
          process.kill(descendant, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    };
    const stopTarget = () => {
      if (closed) return;
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      child.kill('SIGKILL');
    };
    let expired = false;
    const watchdog = setTimeout(() => {
      expired = true;
      try {
        killDescendant();
      } finally {
        stopTarget();
      }
    }, 5000);
    try {
      await poll(
        () => {
          assert.equal(closed, false, stderr);
          return stdout.includes('RELAVIUM_NATIVE_FIXTURE_READY\n');
        },
        4000,
        'Fixture descendant readiness missing',
      );
      const observed = rows();
      descendant = observed.find((item) => item.operation === 'native-fixture-descendant')?.pid;
      assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
      assert.ok(
        observed.some(
          (item) =>
            item.operation === 'native-fixture-descendant-ready' &&
            item.pid === descendant &&
            item.parentPid === child.pid,
        ),
      );
      assert.equal(expired, false);
    } finally {
      try {
        killDescendant();
      } finally {
        stopTarget();
      }
      await joined;
      if (descendant !== undefined)
        await poll(
          () => {
            try {
              process.kill(descendant, 0);
              return false;
            } catch (error) {
              if (error.code === 'ESRCH') return true;
              throw error;
            }
          },
          2000,
          'Fixture-only regression did not join descendant absence',
        );
      clearTimeout(watchdog);
      rmSync(root, { recursive: true, force: true });
    }
    assert.equal(expired, false, 'External fixture watchdog supplied regression cleanup');
  },
);

test('shared fixture runtime support reuses read-only identical bytes and refuses replacement content or links', () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-shared-runtime-test-'));
  const source = join(root, 'source.dylib');
  const destination = join(root, 'owned.dylib');
  writeFileSync(source, 'exact current runtime support');
  try {
    copyFixtureRuntimeSupport(source, destination);
    chmodSync(destination, 0o444);
    copyFixtureRuntimeSupport(source, destination);
    assert.equal(readFileSync(destination, 'utf8'), 'exact current runtime support');
    chmodSync(destination, 0o600);
    writeFileSync(destination, 'different runtime support');
    assert.throws(() => copyFixtureRuntimeSupport(source, destination), /bytes differ/);
    if (process.platform !== 'win32') {
      rmSync(destination);
      symlinkSync(source, destination);
      assert.throws(() => copyFixtureRuntimeSupport(source, destination), /FILE_KIND/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture watchdog never reacquires a root/helper PID after actual native close', () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-fixture-pid-test-'));
  const log = join(root, 'native.ndjson');
  const write = (rows) =>
    writeFileSync(log, rows.map((row) => JSON.stringify(row) + '\n').join(''));
  try {
    const created = [
      { operation: 'native-target-spawn', pid: 40 },
      { operation: 'native-fixture-descendant', pid: 60, parentPid: 40 },
      { operation: 'native-helper-spawn', pid: 80 },
    ];
    write(created);
    assert.deepEqual(pendingNativeFixturePids(log), [40, 60, 80]);
    write([...created, { operation: 'native-target-actual-close', pid: 40 }]);
    assert.deepEqual(pendingNativeFixturePids(log), [60, 80]);
    write([
      ...created,
      { operation: 'native-target-actual-close', pid: 40 },
      { operation: 'native-helper-actual-close', pid: 80 },
    ]);
    assert.deepEqual(pendingNativeFixturePids(log), [60]);
    // Readiness is observation only, not native close; unrelated/invalid records grant no authority.
    write([
      ...created,
      { operation: 'native-fixture-descendant-ready', pid: 100 },
      { operation: 'unrelated', pid: 120 },
      { operation: 'native-target-spawn', pid: -1 },
    ]);
    assert.deepEqual(pendingNativeFixturePids(log), [40, 60, 80]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [mode, code, message] of [
  [
    'bootstrap-fatal',
    'cli_internal',
    'An unexpected CLI failure occurred. Inspect existing work before repeating paid or effectful operations.',
  ],
  [
    'bootstrap-output',
    'output_unavailable',
    'CLI output could not be delivered. Inspect existing work before repeating paid or effectful operations.',
  ],
  [
    'bootstrap-background',
    'cli_internal',
    'A background operation failed. Inspect existing work before repeating paid or effectful operations.',
  ],
]) {
  test(`${mode} requires its complete fixed diagnostic without private or extra fields`, () => {
    const exact = { type: 'error', code, message };
    assertNativeBootstrapDiagnostic([exact], mode);
    for (const diagnostics of [
      [],
      [exact, exact],
      [{ ...exact, message: '' }],
      [{ ...exact, message: message + ' PRIVATE_NATIVE_CANARY' }],
      [{ ...exact, code: 'different' }],
      [{ ...exact, type: 'different' }],
      [{ ...exact, stack: 'private native stack' }],
      [{ code, message }],
    ])
      assert.throws(() => assertNativeBootstrapDiagnostic(diagnostics, mode));
  });
}
test('unknown native bootstrap diagnostic mode grants no acceptance', () => {
  assert.throws(() => assertNativeBootstrapDiagnostic([undefined], 'unknown'));
});
