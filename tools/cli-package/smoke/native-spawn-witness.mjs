import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { appendFileSync, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { clearInterval, setImmediate, setInterval } from 'node:timers';

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
    ['injected-error', 'leader-exit', 'exit-fallback', 'facility-refusal'].includes(config.mode),
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
  let pending = [];
  let gateTimer;
  let gateTicks = 0;
  const afterDelivery = () => {
    setImmediate(() => {
      if (exitReaper !== undefined && !process.listeners('exit').includes(exitReaper))
        record({ operation: 'native-exit-listener-released' });
    });
  };
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
          afterDelivery();
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
            if (config.mode === 'injected-error') {
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
