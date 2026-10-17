import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  constants,
  existsSync,
  mkdtempSync,
  promises as fsPromisesViaFs,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import fsPromises, { access as nativeAccess } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertNativeFixtureReady, createNativeSpawnWitness } from './native-spawn-witness.mjs';
import { formatInstalledWorkerFailure } from './failure-diagnostic.mjs';
import {
  assertNativeSignalDiagnosticComplete,
  createNativeSignalDiagnostic,
} from './native-signal-diagnostic.mjs';

test('signal evidence preserves exact receiver, arguments, result and throwable without reading error text', () => {
  const rows = [];
  const d = createNativeSignalDiagnostic({
    record: (row) => rows.push(row),
    owns: (pid) => pid === -40,
    now: () => 12,
  });
  const receiver = {};
  const result = {};
  const native = function (...args) {
    assert.equal(this, receiver);
    assert.deepEqual(args, [-40, 'SIGKILL']);
    return result;
  };
  assert.equal(d.wrap(native).call(receiver, -40, 'SIGKILL'), result);
  const error = Object.assign(new Error('PRIVATE_NATIVE_MESSAGE'), { code: 'EPERM', errno: -1 });
  Object.defineProperty(error, 'message', {
    get: () => {
      throw new Error('Text must never be inspected');
    },
  });
  assert.throws(
    () =>
      d.wrap(() => {
        throw error;
      })(-40, 0),
    (cause) => cause === error,
  );
  assert.equal(d.wrap(() => false)(99, 'SIGKILL'), false);
  d.finish();
  assertNativeSignalDiagnosticComplete(rows);
  assert.equal(rows[1].nativeCode, 'EPERM');
  assert.equal(rows[1].errno, -1);
  assert.equal(rows[2].owned, false);
  assert.equal(rows[2].target, undefined);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_|message|stack/);
});

test('observation failure never replaces native success or failure and refuses complete evidence', () => {
  for (const mode of ['journal', 'clock', 'descriptor']) {
    const rows = [];
    const d = createNativeSignalDiagnostic({
      record: (row) => {
        if (mode === 'journal' && row.operation !== 'native-signal-diagnostics-complete')
          throw new Error('Synthetic journal refusal');
        rows.push(row);
      },
      owns: () => true,
      now: () => (mode === 'clock' ? NaN : 1),
    });
    const error =
      mode === 'descriptor'
        ? new Proxy(
            {},
            {
              getOwnPropertyDescriptor() {
                throw new Error('Synthetic descriptor refusal');
              },
            },
          )
        : new Error('Synthetic native fault');
    assert.equal(d.wrap(() => true)(-40, 'SIGKILL'), true);
    assert.throws(
      () =>
        d.wrap(() => {
          throw error;
        })(-40, 'SIGKILL'),
      (cause) => cause === error,
    );
    d.finish();
    assert.throws(() => assertNativeSignalDiagnosticComplete(rows), /incomplete/);
  }
});

test('signal evidence rejects missing, duplicate, over-bound and post-marker observations', () => {
  const make = () => {
    const rows = [];
    return {
      rows,
      d: createNativeSignalDiagnostic({
        record: (row) => rows.push(row),
        owns: () => true,
        now: () => 1,
      }),
    };
  };
  assert.throws(() => assertNativeSignalDiagnosticComplete([]), /incomplete/);
  const normal = make();
  normal.d.uncaught();
  normal.d.finish();
  assertNativeSignalDiagnosticComplete(normal.rows);
  assert.throws(
    () => assertNativeSignalDiagnosticComplete([...normal.rows, normal.rows.at(-1)]),
    /incomplete/,
  );
  normal.d.wrap(() => true)(40, 0);
  assert.throws(() => assertNativeSignalDiagnosticComplete(normal.rows), /incomplete/);
  const bounded = make();
  const signal = bounded.d.wrap(() => true);
  for (let i = 0; i < 65; i++) assert.equal(signal(40, 0), true);
  bounded.d.finish();
  assert.equal(bounded.rows.length, 65);
  assert.throws(() => assertNativeSignalDiagnosticComplete(bounded.rows), /incomplete/);
});

test('worker failure retains bounded native errno and observation completeness without opaque properties', () => {
  const row = {
    operation: 'native-signal-observed',
    owned: true,
    target: -40,
    signal: 'SIGKILL',
    outcome: 'threw',
    nativeCode: 'EPERM',
    errno: -1,
    milliseconds: 2,
    message: 'PRIVATE_NATIVE_MESSAGE',
    cause: 'PRIVATE_CAUSE',
  };
  const diagnostic = JSON.parse(
    formatInstalledWorkerFailure({
      cases: [
        {
          id: 'actual-native-process-owner',
          passed: false,
          evidence: {
            outcomes: [
              {
                mode: 'injected-error',
                observed: [
                  row,
                  {
                    operation: 'native-signal-diagnostics-complete',
                    complete: true,
                    observations: 1,
                  },
                ],
              },
            ],
          },
        },
      ],
    }),
  );
  const observed = diagnostic.cases.find((item) => item.id === 'actual-native-process-owner')
    .native[0].observed;
  assert.equal(observed[0].nativeCode, 'EPERM');
  assert.equal(observed[0].target, -40);
  assert.equal(observed[0].errno, -1);
  assert.equal(observed[1].complete, true);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_/);
});

/** Explicit simulated event/port tests. These execute neither product code nor Windows taskkill. */
function harness(mode = 'injected-error', gate = 'none') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-native-witness-test-')));
  const config = {
    cwd: root,
    executable: join(root, 'git'),
    log: join(root, 'native.ndjson'),
    mode,
    gate,
    release: join(root, 'release'),
    taskkill: join(root, 'system-taskkill.exe'),
  };
  const configuration = join(root, 'witness.json');
  writeFileSync(configuration, JSON.stringify(config));
  const calls = [];
  const target = Object.assign(new EventEmitter(), {
    pid: 40,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
  });
  const helper = Object.assign(new EventEmitter(), { pid: 80, exitCode: null, signalCode: null });
  const spawn = (...args) => {
    calls.push(args);
    return calls.length === 1 ? target : helper;
  };
  const witness = createNativeSpawnWitness(configuration, spawn);
  const options = { cwd: root, shell: false, detached: process.platform !== 'win32' };
  let reaped = 0;
  const exit = () => {
    reaped++;
  };
  const log = () =>
    existsSync(config.log)
      ? readFileSync(config.log, 'utf8').trim().split('\n').map(JSON.parse)
      : [];
  const acknowledgeReady = () => {
    const rows = [
      { operation: 'native-fixture-root', pid: 40 },
      ...(mode === 'exit-fallback'
        ? []
        : [
            { operation: 'native-fixture-descendant', pid: 60, parentPid: 40 },
            { operation: 'native-fixture-descendant-ready', pid: 60, parentPid: 40 },
          ]),
    ];
    appendFileSync(config.log, rows.map((row) => JSON.stringify(row) + '\n').join(''));
  };
  return {
    config,
    configuration,
    calls,
    target,
    helper,
    witness,
    options,
    exit,
    reaped: () => reaped,
    log,
    acknowledgeReady,
    async close() {
      process.off('exit', exit);
      writeFileSync(config.release, 'release');
      await sleep(60);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('native witness refuses omitted/duplicate creation exit callbacks before native entry', async () => {
  const h = harness();
  const duplicate = () => undefined;
  try {
    assert.throws(
      () => h.witness.trySpawn(h.config.executable, ['status'], h.options),
      /exit callback/,
    );
    process.on('exit', h.exit);
    process.on('exit', duplicate);
    assert.throws(
      () => h.witness.trySpawn(h.config.executable, ['status'], h.options),
      /exit callback/,
    );
    assert.equal(h.calls.length, 0);
  } finally {
    process.off('exit', duplicate);
    await h.close();
  }
});

test('native witness admits one exact target and refuses executable/argv/cwd/shell/group widening', async () => {
  const h = harness();
  try {
    process.on('exit', h.exit);
    assert.equal(h.witness.trySpawn(join(h.config.cwd, 'other'), ['status'], h.options), undefined);
    for (const [args, options] of [
      [['status', '--extra'], h.options],
      [['status'], { ...h.options, shell: true }],
      [['status'], { ...h.options, cwd: tmpdir() }],
      [['status'], { ...h.options, detached: !h.options.detached }],
    ])
      assert.throws(() => h.witness.trySpawn(h.config.executable, args, options));
    assert.equal(h.calls.length, 0);
    assert.equal(h.witness.trySpawn(h.config.executable, ['status'], h.options), h.target);
    assert.throws(() => h.witness.trySpawn(h.config.executable, ['status'], h.options), /Only one/);
    assert.equal(h.calls.length, 1);
  } finally {
    await h.close();
  }
});

test('callback capture uses the exact pre-entry function and releases only after close', async () => {
  const h = harness('exit-fallback');
  try {
    process.on('exit', h.exit);
    h.witness.trySpawn(h.config.executable, ['status'], h.options);
    h.acknowledgeReady();
    h.target.stdout.emit('data', Buffer.from('RELAVIUM_NATIVE_FIXTURE_READY\n'));
    await new Promise(setImmediate);
    assert.equal(h.reaped(), 1);
    assert.equal(
      h.log().filter((item) => item.operation === 'native-captured-exit-reap-invoked').length,
      1,
    );
    assert.equal(
      h.log().some((item) => item.operation === 'native-exit-listener-released'),
      false,
    );
    h.target.on('close', () => process.off('exit', h.exit));
    h.target.emit('close', null, 'SIGKILL');
    assert.equal(
      h.log().filter((item) => item.operation === 'native-exit-listener-released').length,
      1,
    );
  } finally {
    await h.close();
  }
});

test('synthetic native error is explicit and delayed real-close delivery cannot acknowledge early', async () => {
  const h = harness('injected-error', 'target');
  try {
    process.on('exit', h.exit);
    h.witness.trySpawn(h.config.executable, ['status'], h.options);
    let errors = 0,
      deliveries = 0;
    h.target.on('error', (error) => {
      assert.match(error.message, /Synthetic installed/);
      errors++;
    });
    h.target.on('close', () => {
      deliveries++;
      process.off('exit', h.exit);
    });
    h.acknowledgeReady();
    h.target.stdout.emit('data', Buffer.from('RELAVIUM_NATIVE_FIXTURE_READY\n'));
    await new Promise(setImmediate);
    assert.equal(errors, 1);
    h.target.emit('close', null, 'SIGKILL');
    assert.equal(deliveries, 0);
    assert.equal(
      h.log().filter((item) => item.operation === 'native-target-actual-close').length,
      1,
    );
    writeFileSync(h.config.release, 'release');
    await sleep(60);
    assert.equal(deliveries, 1);
    assert.equal(
      h.log().some((item) => item.operation === 'native-witness-gate-timeout'),
      false,
    );
  } finally {
    await h.close();
  }
});

test('readiness refuses root-only, foreign, missing or mismatched descendant acknowledgements', () => {
  const root = { operation: 'native-fixture-root', pid: 40 };
  const child = { operation: 'native-fixture-descendant', pid: 60, parentPid: 40 };
  const ready = { operation: 'native-fixture-descendant-ready', pid: 60, parentPid: 40 };
  for (const observed of [
    [root],
    [root, child],
    [root, { ...child, parentPid: 41 }, ready],
    [root, child, { ...ready, pid: 61 }],
    [root, child, { ...ready, parentPid: 41 }],
  ])
    assert.throws(() => assertNativeFixtureReady(observed, 40, 'injected-error'));
  assert.doesNotThrow(() => assertNativeFixtureReady([root, child, ready], 40, 'injected-error'));
  assert.doesNotThrow(() => assertNativeFixtureReady([root], 40, 'exit-fallback'));
});

test('invalid Windows facility mode refuses target entry rather than manufacturing a native witness', async () => {
  const h = harness('facility-refusal');
  try {
    process.on('exit', h.exit);
    assert.throws(
      () => h.witness.trySpawn(h.config.executable, ['status'], h.options),
      /Invalid facility/,
    );
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.log(), []);
  } finally {
    await h.close();
  }
});

test('healthy native modes preserve the original facility access function identity', async () => {
  for (const mode of ['injected-error', 'exit-fallback', 'leader-exit']) {
    const h = harness(mode);
    try {
      writeFileSync(h.config.taskkill, 'owned ordinary access fixture', { mode: 0o700 });
      const access = h.witness.wrapFacilityAccess(fsPromises.access);
      assert.equal(access, fsPromises.access);
      await access(h.config.taskkill, constants.X_OK);
      assert.deepEqual(h.log(), []);
      assert.equal(h.calls.length, 0);
    } finally {
      await h.close();
    }
  }
});

test('synthetic facility refusal reaches real fs promises ESM access and preserves foreign native access', async () => {
  const h = harness('facility-refusal');
  const original = fsPromises.access;
  const foreign = join(h.config.cwd, 'unrelated-ordinary-file');
  try {
    writeFileSync(h.config.taskkill, 'owned ordinary access fixture', { mode: 0o700 });
    writeFileSync(foreign, 'unrelated ordinary access fixture', { mode: 0o700 });
    assert.equal(nativeAccess, original);
    assert.equal(fsPromisesViaFs.access, original);
    await nativeAccess(h.config.taskkill, constants.X_OK);
    await nativeAccess(foreign, constants.X_OK);

    const wrapped = h.witness.wrapFacilityAccess(original);
    fsPromises.access = wrapped;
    syncBuiltinESMExports();
    assert.equal(nativeAccess, wrapped);
    assert.equal(fsPromisesViaFs.access, wrapped);
    for (let attempt = 0; attempt < 2; attempt++)
      await assert.rejects(nativeAccess(h.config.taskkill, constants.X_OK), (error) => {
        assert.equal(error.code, 'EACCES');
        assert.equal(error.message, 'Synthetic taskkill facility access refusal');
        return true;
      });
    // Call the actual native API on other paths/forms, not a successful replacement port.
    await nativeAccess(foreign, constants.X_OK);
    await nativeAccess(Buffer.from(h.config.taskkill), constants.X_OK);
    await original(h.config.taskkill, constants.X_OK);
    await assert.rejects(nativeAccess(join(h.config.cwd, 'absent-file')), { code: 'ENOENT' });
    assert.throws(
      () => h.witness.trySpawn(h.config.executable, ['status'], h.options),
      /Invalid facility/,
    );
    assert.equal(h.calls.length, 0);
    const observed = [{ operation: 'native-facility-access-refused', synthetic: true }];
    assert.deepEqual(h.log(), observed);
    const diagnostic = JSON.parse(
      formatInstalledWorkerFailure({
        cases: [
          {
            id: 'actual-native-process-owner',
            passed: false,
            evidence: { outcomes: [{ mode: 'facility-refusal', observed: h.log() }] },
          },
        ],
      }),
    );
    assert.deepEqual(
      diagnostic.cases.find((item) => item.id === 'actual-native-process-owner').native[0].observed,
      observed,
    );
  } finally {
    fsPromises.access = original;
    syncBuiltinESMExports();
    try {
      assert.equal(nativeAccess, original);
      assert.equal(fsPromisesViaFs.access, original);
      await nativeAccess(h.config.taskkill, constants.X_OK);
    } finally {
      await h.close();
    }
  }
});

test('simulated Windows guard requires verified absolute helper, current root and fixed argv/options', async () => {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const h = harness('injected-error', 'helper');
  try {
    process.on('exit', h.exit);
    const helperOptions = { shell: false, windowsHide: true, stdio: 'ignore' };
    assert.equal(
      h.witness.trySpawn(
        join(h.config.cwd, 'taskkill.exe'),
        ['/PID', '40', '/T', '/F'],
        helperOptions,
      ),
      undefined,
    );
    assert.throws(() =>
      h.witness.trySpawn(h.config.taskkill, ['/PID', '40', '/T', '/F'], helperOptions),
    );
    h.witness.trySpawn(h.config.executable, ['status'], h.options);
    for (const [args, options] of [
      [['/PID', '41', '/T', '/F'], helperOptions],
      [['/PID', '40', '/IM', '*'], helperOptions],
      [['/PID', '40', '/T', '/F'], { ...helperOptions, shell: true }],
    ])
      assert.throws(() => h.witness.trySpawn(h.config.taskkill, args, options));
    assert.equal(
      h.witness.trySpawn(h.config.taskkill, ['/PID', '40', '/T', '/F'], helperOptions),
      h.helper,
    );
    assert.throws(
      () => h.witness.trySpawn(h.config.taskkill, ['/PID', '40', '/T', '/F'], helperOptions),
      /Only one/,
    );
    assert.equal(h.calls.length, 2);
    h.target.emit('close', null, 'SIGKILL');
    let delivered = false;
    h.helper.on('close', () => {
      delivered = true;
    });
    h.helper.emit('close', 0, null);
    assert.equal(delivered, false);
    assert.equal(
      h.log().some((item) => item.operation === 'native-helper-actual-close'),
      true,
    );
    writeFileSync(h.config.release, 'release');
    await sleep(60);
    assert.equal(delivered, true);
  } finally {
    await h.close();
    Object.defineProperty(process, 'platform', saved);
  }
});
