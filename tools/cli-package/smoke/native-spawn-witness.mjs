import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { appendFileSync, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { clearInterval, setImmediate, setInterval } from 'node:timers';
import { createNativeSignalDiagnostic } from './native-signal-diagnostic.mjs';

/** A stdout marker alone is insufficient: match the actual root, its created child and that child's ACK. */
export function assertNativeFixtureReady(observed, pid, mode) {
  assert.ok(
    observed.some((item) => item.operation === 'native-fixture-root' && item.pid === pid),
    'Exact fixture root readiness missing',
  );
  if (mode === 'exit-fallback') return;
  const descendant = observed.find(
    (item) => item.operation === 'native-fixture-descendant' && item.parentPid === pid,
  );
  assert.ok(
    descendant &&
      Number.isSafeInteger(descendant.pid) &&
      descendant.pid > 0 &&
      descendant.pid !== pid,
    'Exact created descendant identity missing',
  );
  assert.ok(
    observed.some(
      (item) =>
        item.operation === 'native-fixture-descendant-ready' &&
        item.pid === descendant.pid &&
        item.parentPid === pid,
    ),
    'Actual created descendant readiness missing',
  );
}

/** Tool-only native-edge witness. No product export, source alias or replacement controller. */
export function createNativeSpawnWitness(configuration, spawn) {
  assert.ok(isAbsolute(configuration));
  assert.ok(lstatSync(configuration).isFile());
  assert.ok(statSync(configuration).size <= 16384);
  const config = JSON.parse(readFileSync(configuration, 'utf8'));
  assert.deepEqual(
    Object.keys(config).sort(),
    ['cwd', 'executable', 'gate', 'log', 'mode', 'release', 'taskkill'].sort(),
  );
  for (const key of ['cwd', 'executable', 'log', 'release']) assert.ok(isAbsolute(config[key]));
  assert.ok(
    [
      'injected-error',
      'leader-exit',
      'exit-fallback',
      'facility-refusal',
      'bootstrap-fatal',
      'bootstrap-background',
      'bootstrap-output',
    ].includes(config.mode),
  );
  assert.ok(['target', 'helper', 'none'].includes(config.gate));
  assert.ok(config.taskkill === null || isAbsolute(config.taskkill));
  const initialExit = new Set(process.listeners('exit'));
  const record = (value) => {
    const line = JSON.stringify(value) + '\n';
    assert.ok(Buffer.byteLength(line) <= 16384);
    assert.ok(
      !existsSync(config.log) || statSync(config.log).size + Buffer.byteLength(line) <= 65536,
    );
    appendFileSync(config.log, line, { mode: 0o600 });
  };
  let target;
  let targetClosed = false;
  let helperEntered = false;
  let exitReaper;
  let triggered = false;
  let facilityAccessRefused = false;
  let pending = [];
  let gateTimer;
  let gateTicks = 0;
  const ownedSignalTargets = new Set();
  const signalDiagnostic = createNativeSignalDiagnostic({
    record,
    owns: (target) => ownedSignalTargets.has(target),
  });
  // Observe the actual synchronous removal. A later setImmediate would be skipped by a
  // legitimate fatal process exit even after the creation owner had already retired.
  const onExitRemoved = (event, listener) => {
    if (event !== 'exit' || listener !== exitReaper) return;
    process.off('removeListener', onExitRemoved);
    record({ operation: 'native-exit-listener-released' });
  };
  process.on('removeListener', onExitRemoved);
  function holdClose(child, kind) {
    const on = child.on;
    const output = { stdout: '', stderr: '' };
    for (const sink of ['stdout', 'stderr'])
      child[sink]?.on('data', (chunk) => {
        output[sink] = (output[sink] + chunk.toString()).slice(0, 1024);
      });
    on.call(child, 'error', () => record({ operation: `native-${kind}-error` }));
    on.call(child, 'close', (code, signal) => {
      if (kind === 'target') targetClosed = true;
      record({ operation: `native-${kind}-actual-close`, pid: child.pid, code, signal, ...output });
    });
    child.on = function (event, listener) {
      if (event !== 'close') return on.call(this, event, listener);
      return on.call(this, event, (...args) => {
        const deliver = () => {
          listener.apply(this, args);
          record({ operation: `native-${kind}-close-delivered`, pid: child.pid });
        };
        if (config.gate !== kind || existsSync(config.release)) return deliver();
        pending.push(deliver);
        if (gateTimer !== undefined) return;
        gateTimer = setInterval(() => {
          if (!existsSync(config.release) && ++gateTicks < 400) return;
          if (!existsSync(config.release)) record({ operation: 'native-witness-gate-timeout' });
          clearInterval(gateTimer);
          gateTimer = undefined;
          const deliveries = pending;
          pending = [];
          for (const delivery of deliveries) delivery();
        }, 25);
      });
    };
  }
  return Object.freeze({
    installSignalDiagnostics() {
      const finish = () => signalDiagnostic.finish();
      process.on('exit', finish);
      // This fixture observer is baseline, never an extra product creation-owner callback.
      initialExit.add(finish);
      process.on('uncaughtExceptionMonitor', () => signalDiagnostic.uncaught());
      process.kill = signalDiagnostic.wrap(process.kill);
    },
    /** Synthetic verifier-boundary refusal; healthy modes retain the original native function. */
    wrapFacilityAccess(access) {
      if (config.mode !== 'facility-refusal') return access;
      assert.notEqual(config.taskkill, null);
      return async function (path, ...args) {
        if (path !== config.taskkill) return Reflect.apply(access, this, [path, ...args]);
        if (!facilityAccessRefused) {
          facilityAccessRefused = true;
          record({ operation: 'native-facility-access-refused', synthetic: true });
        }
        throw Object.assign(new Error('Synthetic taskkill facility access refusal'), {
          code: 'EACCES',
        });
      };
    },
    /** Undefined means refusal: the surrounding existing preload keeps its deny-all spawn rule. */
    trySpawn(executable, args, options) {
      if (executable === config.executable) {
        assert.equal(target, undefined, 'Only one exact fixture target may enter');
        assert.notEqual(
          config.mode,
          'facility-refusal',
          'Invalid facility admitted a native target',
        );
        assert.deepEqual(args, ['status']);
        assert.equal(options?.cwd, config.cwd);
        assert.equal(options?.shell, false);
        assert.equal(options?.detached, process.platform !== 'win32');
        const additions = process
          .listeners('exit')
          .filter((listener) => !initialExit.has(listener));
        assert.equal(
          additions.length,
          1,
          'One shipped creation-registry exit callback must precede spawn',
        );
        exitReaper = additions[0];
        target = spawn(executable, args, options);
        assert.ok(Number.isSafeInteger(target.pid) && target.pid > 0);
        ownedSignalTargets.add(target.pid);
        if (options.detached) ownedSignalTargets.add(-target.pid);
        record({
          operation: 'native-target-spawn',
          pid: target.pid,
          executable,
          args,
          detached: options.detached,
          exitCallbacksBeforeEntry: additions.length,
        });
        holdClose(target, 'target');
        let output = '';
        target.stdout.on('data', (chunk) => {
          output += chunk.toString();
          assert.ok(Buffer.byteLength(output) <= 4096);
          if (triggered || !output.includes('RELAVIUM_NATIVE_FIXTURE_READY\n')) return;
          triggered = true;
          setImmediate(() => {
            try {
              assertNativeFixtureReady(
                readFileSync(config.log, 'utf8').trim().split('\n').map(JSON.parse),
                target.pid,
                config.mode,
              );
            } catch (error) {
              record({
                operation: 'native-witness-readiness-refused',
                reason: String(error.message).slice(0, 1024),
              });
              return;
            }
            if (config.mode === 'bootstrap-fatal') {
              record({ operation: 'native-bootstrap-fatal-injected', pid: target.pid });
              // Real uncaught callback, observed by the untouched installed entry's native hook.
              setImmediate(() => {
                throw new Error('PRIVATE_INSTALLED_FATAL_CANARY');
              });
            } else if (config.mode === 'bootstrap-background') {
              record({ operation: 'native-bootstrap-background-injected', pid: target.pid });
              // No listener/process.emit replacement: Node supplies the actual unhandled-rejection event.
              void Promise.reject(new Error('PRIVATE_INSTALLED_BACKGROUND_CANARY'));
            } else if (config.mode === 'bootstrap-output') {
              let ticks = 0;
              const pipe = setInterval(() => {
                if (!existsSync(config.release + '.pipe-closed') && ++ticks < 400) return;
                clearInterval(pipe);
                if (!existsSync(config.release + '.pipe-closed')) {
                  record({ operation: 'native-witness-gate-timeout' });
                  return;
                }
                record({ operation: 'native-bootstrap-output-injected', pid: target.pid });
                process.stdout.write('SYNTHETIC_CLOSED_PIPE_WRITE\n');
              }, 25);
            } else if (config.mode === 'injected-error') {
              record({ operation: 'native-synthetic-error-injected', pid: target.pid });
              target.emit('error', new Error('Synthetic installed native lifetime control'));
            } else if (config.mode === 'exit-fallback') {
              assert.ok(process.listeners('exit').includes(exitReaper));
              record({ operation: 'native-captured-exit-reap-invoked' });
              exitReaper();
            }
          });
        });
        return target;
      }
      if (process.platform === 'win32' && executable === config.taskkill) {
        assert.ok(target !== undefined && !targetClosed);
        assert.equal(target.exitCode, null);
        assert.equal(target.signalCode, null);
        assert.equal(helperEntered, false, 'Only one taskkill helper may enter');
        assert.deepEqual(args, ['/PID', String(target.pid), '/T', '/F']);
        assert.deepEqual(options, { shell: false, windowsHide: true, stdio: 'ignore' });
        helperEntered = true;
        const helper = spawn(executable, args, options);
        if (Number.isSafeInteger(helper.pid) && helper.pid > 0) ownedSignalTargets.add(helper.pid);
        record({
          operation: 'native-helper-spawn',
          pid: helper.pid,
          executable,
          args,
          shell: options.shell,
        });
        holdClose(helper, 'helper');
        return helper;
      }
      return undefined;
    },
  });
}
