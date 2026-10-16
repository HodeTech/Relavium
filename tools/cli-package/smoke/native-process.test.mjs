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
  copyFixtureNode,
  copyFixtureRuntimeSupport,
  createFixtureSentinel,
  InstalledNativeControlError,
  pendingNativeFixturePids,
} from './native-process.mjs';
import { explicitEnvironment, ndjson, poll } from './process.mjs';

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
