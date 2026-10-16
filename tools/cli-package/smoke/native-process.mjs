import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { readOrdinaryFile, sha256 } from '../files.mjs';
import { ndjson, poll, startOwned } from './process.mjs';
import { projectRuntimeStderr } from './runtime-stderr.mjs';

const fixture = (name) => fileURLToPath(new URL(name, import.meta.url));
const positivePid = (pid) => Number.isSafeInteger(pid) && pid > 0;
const completeEvents = (text) => ndjson(text.slice(0, text.lastIndexOf('\n') + 1));
/** One owned runtime support file may serve both copied executables; reuse requires exact ordinary bytes. */
export function copyFixtureRuntimeSupport(source, destination) {
  const canonical = realpathSync(source);
  const maximum = 256 * 1024 * 1024;
  const expected = sha256(readOrdinaryFile(canonical, maximum));
  if (!existsSync(destination)) copyFileSync(canonical, destination, constants.COPYFILE_EXCL);
  assert.equal(
    sha256(readOrdinaryFile(destination, maximum)),
    expected,
    'Copied fixture runtime support bytes differ',
  );
}
/** Relocatable official Node needs only its executable; Homebrew macOS also needs its adjacent ABI dylib. */
export function copyFixtureNode(executable) {
  const runtime = realpathSync(process.execPath);
  copyFileSync(runtime, executable);
  chmodSync(executable, 0o700);
  const libraries = [];
  if (process.platform === 'darwin') {
    const library = join(dirname(runtime), '../lib', `libnode.${process.versions.modules}.dylib`);
    if (existsSync(library)) {
      assert.ok(statSync(library).isFile() && statSync(library).size <= 256 * 1024 * 1024);
      const name = basename(library);
      copyFixtureRuntimeSupport(library, join(dirname(executable), name));
      libraries.push(name);
    }
  }
  return libraries;
}

export class InstalledNativeControlError extends Error {
  constructor(primary, evidence) {
    super('Installed native ownership control failed.', { cause: primary });
    this.name = 'InstalledNativeControlError';
    this.primaryFailure = String(
      primary instanceof Error ? (primary.stack ?? primary.message) : primary,
    ).slice(0, 16384);
    this.evidence = evidence;
  }
}
export function nativePidGone(pid) {
  assert.ok(positivePid(pid), 'Only this fixture creation may supply a PID');
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}
function records(path) {
  if (!existsSync(path)) return [];
  assert.ok(statSync(path).isFile() && statSync(path).size <= 65536);
  return ndjson(readFileSync(path, 'utf8'));
}
/** Actual close releases PID authority, even if a later liveness sample would see that number reused. */
export function pendingNativeFixturePids(log) {
  const observed = records(log);
  const closed = new Set(
    observed
      .filter((item) =>
        ['native-target-actual-close', 'native-helper-actual-close'].includes(item.operation),
      )
      .map((item) => item.pid),
  );
  return [
    ...new Set(
      observed
        .filter((item) =>
          ['native-target-spawn', 'native-fixture-descendant', 'native-helper-spawn'].includes(
            item.operation,
          ),
        )
        .map((item) => item.pid),
    ),
  ].filter((pid) => positivePid(pid) && !closed.has(pid));
}
function killOwned(pid) {
  if (nativePidGone(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

/** Actual sibling outside the target's detached group/tree. Its own owner always joins close. */
export async function createFixtureSentinel(cwd, env, timeoutMs = 25000) {
  const child = spawn(
    process.execPath,
    ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
    {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  let closed = false;
  let expired = false;
  const joined = new Promise((resolve) =>
    child.once('close', () => {
      closed = true;
      resolve();
    }),
  );
  const ready = new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
  });
  const timer = setTimeout(() => {
    expired = true;
    if (!closed) child.kill('SIGKILL');
  }, timeoutMs);
  try {
    await Promise.race([
      ready,
      joined.then(() => {
        throw new Error('Owned sentinel closed before readiness');
      }),
    ]);
  } catch (error) {
    if (!closed) child.kill('SIGKILL');
    await joined;
    clearTimeout(timer);
    throw error;
  }
  return {
    assertAlive() {
      assert.equal(expired, false, 'Owned sentinel external watchdog expired');
      assert.equal(closed, false, 'An unrelated owned sibling was killed');
      assert.equal(nativePidGone(child.pid), false);
    },
    async close() {
      if (!closed) child.kill('SIGKILL');
      await joined;
      clearTimeout(timer);
      assert.equal(expired, false, 'Owned sentinel external watchdog supplied cleanup');
    },
    state: () => ({ pid: child.pid, actualCloseObserved: closed, watchdogFired: expired }),
  };
}

function cassette() {
  const usage = { kind: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
  return {
    schema_version: '2.0',
    provider: 'openai',
    model: 'gpt-4o-mini',
    calls: [
      [
        { type: 'tool_call_start', id: 'native-status', name: 'git_status' },
        { type: 'tool_call_delta', id: 'native-status', argsJsonDelta: '{}' },
        { type: 'tool_call_end', id: 'native-status' },
        { type: 'stop', stopReason: 'tool_use', usage },
      ],
      [
        { type: 'text_delta', text: 'native control complete' },
        { type: 'stop', stopReason: 'stop', usage },
      ],
    ],
  };
}

/** Public offline route; all native mechanism/controller/registry bytes are from the selected installation. */
export async function assertInstalledNativeProcesses(context, { bootstrap = false } = {}) {
  const { root, cli, environment, calls } = context;
  const home = join(root, bootstrap ? 'bootstrap-home' : 'native-home');
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const executable = join(bin, process.platform === 'win32' ? 'git.exe' : 'git');
  const copiedRuntimeLibraries = copyFixtureNode(executable);
  const shim = join(bin, process.platform === 'win32' ? 'taskkill.exe' : 'taskkill');
  copyFixtureNode(shim);
  const systemTaskkill =
    process.platform === 'win32'
      ? realpathSync(join(process.env.SystemRoot, 'System32', 'taskkill.exe'))
      : null;
  const before = calls().length;
  const outcomes = [];
  let caseFailure;
  let sibling;
  const modes = bootstrap
    ? ['bootstrap-fatal', 'bootstrap-background', 'bootstrap-output']
    : [
        'injected-error',
        'exit-fallback',
        ...(process.platform === 'win32' ? ['facility-refusal'] : ['leader-exit']),
      ];
  try {
    for (const mode of modes) {
      const cwd = join(home, mode);
      mkdirSync(cwd, { mode: 0o700 });
      const log = join(cwd, 'native.ndjson');
      const release = join(cwd, 'release-close');
      const configuration = join(cwd, 'witness.json');
      const gate =
        mode === 'facility-refusal'
          ? 'none'
          : process.platform === 'win32' &&
              ['injected-error', 'bootstrap-fatal', 'bootstrap-output'].includes(mode)
            ? 'helper'
            : 'target';
      const outcome = {
        mode,
        gate,
        passed: false,
        observed: [],
        cleanup: { native: [], failures: [] },
      };
      outcomes.push(outcome);
      copyFileSync(fixture('native-status.cjs'), join(cwd, 'status'));
      writeFileSync(
        join(cwd, 'native-fixture.json'),
        JSON.stringify({
          mode,
          log,
          node: process.execPath,
          descendant: fixture('native-descendant.cjs'),
          ...(bootstrap ? { release } : {}),
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        configuration,
        JSON.stringify({ cwd, executable, log, mode, gate, release, taskkill: systemTaskkill }),
        { mode: 0o600 },
      );
      const agent = join(cwd, 'native.agent.yaml');
      const recorded = join(cwd, 'native.cassette.json');
      writeFileSync(
        agent,
        'id: packaged-native-owner\nprovider: openai\nmodel: gpt-4o-mini\nsystem_prompt: Offline native ownership control.\ntools: [git_status]\nmax_tokens: 64\n',
      );
      writeFileSync(recorded, JSON.stringify(cassette()));
      const env = environment(home, {
        PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
        ...(process.platform === 'win32' ? { PATHEXT: '.exe;.cmd;.bat;.com' } : {}),
        RELAVIUM_PACKAGE_SMOKE_NATIVE: configuration,
      });
      // Each independently bounded mode owns a fresh sibling and its full finite lifetime.
      sibling = await createFixtureSentinel(cwd, environment(home));
      const owned = startOwned(cli(['agent', 'run', agent, '--fixture', recorded, '--json']), {
        cwd,
        env,
        timeout: 20000,
      });
      owned.child.stdin.end('exercise the exact native fixture\n');
      let watchdogFired = false;
      const observedAbsent = new Set();
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        try {
          for (const pid of pendingNativeFixturePids(log).filter(
            (pid) => !observedAbsent.has(pid),
          )) {
            try {
              killOwned(pid);
            } catch {
              /* cleanup below retains failures */
            }
          }
        } catch {
          // A broken private journal cannot skip the independently owned CLI handle.
        }
        owned.child.kill('SIGKILL');
      }, 15000);
      let primary;
      try {
        if (bootstrap) {
          await poll(
            () => records(log).some((item) => item.operation === 'native-fixture-descendant-ready'),
            10000,
            'Actual bootstrap descendant never became ready',
          );
          if (mode === 'bootstrap-background') {
            await poll(
              () => owned.output().stderr.includes('A background operation failed.'),
              5000,
              'Installed entry did not observe actual background rejection',
            );
            assert.equal(
              owned.isSettled(),
              false,
              'Background observer unexpectedly killed entered work',
            );
            const live = records(log).find((item) => item.operation === 'native-target-spawn');
            assert.equal(
              nativePidGone(live.pid),
              false,
              'Background observer reaped the actual live target',
            );
            const atNotice = records(log);
            const descendant = atNotice.find(
              (item) =>
                item.operation === 'native-fixture-descendant' && item.parentPid === live.pid,
            );
            assert.ok(descendant);
            assert.equal(
              nativePidGone(descendant.pid),
              false,
              'Background observer reaped the descendant',
            );
            assert.equal(
              atNotice.some((item) =>
                ['native-target-actual-close', 'native-helper-spawn'].includes(item.operation),
              ),
              false,
            );
            assert.equal(
              completeEvents(owned.output().stdout).some(
                (event) => event.type === 'session:turn_completed',
              ),
              false,
            );
            sibling.assertAlive();
            writeFileSync(release + '.target-exit', 'finish the exact fixture normally\n', {
              mode: 0o600,
            });
          } else if (mode === 'bootstrap-output') {
            owned.child.stdout.destroy(); // Real parent read-end close, then one native child pipe write.
            writeFileSync(release + '.pipe-closed', 'parent closed the exact stdout pipe\n', {
              mode: 0o600,
            });
          }
        }
        if (mode !== 'facility-refusal') {
          await poll(
            () =>
              records(log).some((item) => item.operation === 'native-target-actual-close') &&
              (gate !== 'helper' ||
                records(log).some((item) => item.operation === 'native-helper-actual-close')),
            10000,
            'Real owned target/helper did not close',
          );
          assert.equal(
            owned.isSettled(),
            false,
            'Caller departed while a delivered-close obligation was held',
          );
          assert.equal(
            completeEvents(owned.output().stdout).some(
              (event) => event.type === 'session:turn_completed',
            ),
            false,
            'A request/error supplied a premature close acknowledgement',
          );
          if (bootstrap && mode !== 'bootstrap-background') {
            assert.equal(
              projectRuntimeStderr(owned.output().stderr, {
                runtime: process.version,
                pid: owned.child.pid,
              }).diagnostics,
              '',
              'Fatal diagnostic preceded actual native close delivery',
            );
          }
          const atClose = records(log);
          const descendant = atClose.find((item) => item.operation === 'native-fixture-descendant');
          const started = atClose.find((item) => item.operation === 'native-target-spawn');
          if (mode !== 'exit-fallback') {
            assert.ok(
              descendant && positivePid(descendant.pid),
              'Exact created descendant identity missing',
            );
            assert.equal(descendant.parentPid, started.pid);
            assert.ok(
              atClose.some(
                (item) =>
                  item.operation === 'native-fixture-descendant-ready' &&
                  item.pid === descendant.pid &&
                  item.parentPid === started.pid,
              ),
              'The actual descendant never acknowledged readiness',
            );
            await poll(
              () => nativePidGone(descendant.pid),
              5000,
              'Owned descendant survived native cleanup',
            );
            observedAbsent.add(descendant.pid);
          }
          sibling.assertAlive();
          writeFileSync(release, 'release the delayed real close delivery\n', { mode: 0o600 });
        }
        const result = await owned.result();
        assert.equal(result.signal, null, result.stderr);
        if (bootstrap) assert.equal(result.code, 9, result.stderr);
        else assert.ok([0, 1].includes(result.code), result.stderr);
        assert.equal(
          ndjson(result.stdout).filter((event) => event.type === 'session:turn_completed').length,
          bootstrap && mode !== 'bootstrap-background' ? 0 : 1,
          'The public offline turn completion differs from its actual lifetime',
        );
        const observed = records(log);
        if (bootstrap) {
          assert.ok(
            observed.some((item) => item.operation === `native-${gate}-close-delivered`),
            'Actual gated close was not delivered before product completion',
          );
          const projected = projectRuntimeStderr(result.stderr, {
            runtime: process.version,
            pid: owned.child.pid,
          });
          outcome.runtimeWarnings = projected.runtimeWarnings;
          const diagnostics = ndjson(projected.diagnostics);
          assert.equal(diagnostics.length, 1, 'Exactly one native diagnostic is owed');
          assert.equal(
            diagnostics[0].code,
            mode === 'bootstrap-output' ? 'output_unavailable' : 'cli_internal',
          );
          if (mode === 'bootstrap-background') {
            assert.match(diagnostics[0].message, /^A background operation failed\./);
            assert.equal(
              observed.find((item) => item.operation === 'native-target-actual-close').code,
              0,
            );
            const completed = ndjson(result.stdout).find(
              (event) => event.type === 'session:turn_completed',
            );
            assert.equal(
              completed.error,
              undefined,
              'Background-only observation changed a successful turn',
            );
          }
          assert.doesNotMatch(result.stderr, /PRIVATE_INSTALLED_|\n\s+at |file:\/\//);
        }
        assert.equal(watchdogFired, false, 'External fixture watchdog supplied native cleanup');
        assert.equal(
          observed.some((item) => item.operation === 'native-witness-gate-timeout'),
          false,
        );
        sibling.assertAlive();
        if (mode === 'facility-refusal') {
          assert.deepEqual(
            observed,
            [{ operation: 'native-facility-access-refused', synthetic: true }],
            'One synthetic facility access refusal must precede any target/helper entry',
          );
          assert.ok(
            (result.stdout + result.stderr).includes('Windows subprocess teardown is unavailable'),
            'Fixed Windows facility refusal missing',
          );
          assert.equal(result.code, 1);
        } else {
          const started = observed.filter((item) => item.operation === 'native-target-spawn');
          assert.equal(started.length, 1);
          assert.equal(started[0].exitCallbacksBeforeEntry, 1);
          assert.equal(started[0].detached, process.platform !== 'win32');
          assert.ok(
            observed.some((item) => item.operation === 'native-exit-listener-released'),
            'Creation-owned exit closure retained after real retirement',
          );
          const closed = observed.find((item) => item.operation === 'native-target-actual-close');
          assert.ok(closed);
          assert.equal(nativePidGone(started[0].pid), true);
          if (mode === 'leader-exit')
            assert.equal(
              closed.code,
              0,
              'The owned leader must exit naturally before the group final reap',
            );
          if (mode === 'exit-fallback')
            assert.equal(
              observed.filter((item) => item.operation === 'native-captured-exit-reap-invoked')
                .length,
              1,
            );
          const helpers = observed.filter((item) => item.operation === 'native-helper-spawn');
          assert.equal(
            observed.filter((item) => item.operation === 'native-synthetic-error-injected').length,
            mode === 'injected-error' ? 1 : 0,
          );
          if (
            process.platform === 'win32' &&
            ['injected-error', 'bootstrap-fatal', 'bootstrap-output'].includes(mode)
          ) {
            assert.equal(helpers.length, 1);
            assert.equal(helpers[0].executable, systemTaskkill);
            assert.notEqual(
              helpers[0].executable.toLowerCase(),
              shim.toLowerCase(),
              'Hostile PATH taskkill shim selected',
            );
            assert.deepEqual(helpers[0].args, ['/PID', String(started[0].pid), '/T', '/F']);
            assert.equal(helpers[0].shell, false);
            assert.equal(
              observed.filter((item) => item.operation === 'native-helper-actual-close').length,
              1,
            );
            assert.equal(
              observed.find((item) => item.operation === 'native-helper-actual-close').code,
              0,
              'The actual verified taskkill request failed',
            );
            assert.equal(nativePidGone(helpers[0].pid), true);
          } else assert.equal(helpers.length, 0, 'Finite exit cleanup must not start a helper');
        }
        Object.assign(outcome, {
          actualNativeClose: mode !== 'facility-refusal',
          syntheticNativeError: mode === 'injected-error',
          syntheticFacilityAccessRefusal: mode === 'facility-refusal',
          ownedDescendantClosed: bootstrap || mode === 'injected-error' || mode === 'leader-exit',
          siblingSurvived: true,
          observed,
        });
      } catch (error) {
        primary = error;
      } finally {
        try {
          writeFileSync(release, 'release fixture cleanup\n', { mode: 0o600 });
          outcome.cleanup.releaseWritten = true;
        } catch (error) {
          primary ??= error;
          outcome.cleanup.failures.push(String(error));
        }
        let pids = [];
        try {
          pids = pendingNativeFixturePids(log).filter((pid) => !observedAbsent.has(pid));
        } catch (error) {
          primary ??= error;
          outcome.cleanup.failures.push(String(error));
        }
        const cleanup = await Promise.allSettled(
          pids.map(async (pid) => {
            killOwned(pid);
            await poll(
              () => nativePidGone(pid),
              5000,
              'Exact owned fixture PID remained live after cleanup',
            );
            outcome.cleanup.native.push({ pid, absenceObserved: true });
          }),
        );
        await owned.close().catch((error) => {
          primary ??= error;
          outcome.cleanup.failures.push(String(error));
        });
        clearTimeout(watchdog);
        for (const result of cleanup)
          if (result.status === 'rejected') {
            primary ??= result.reason;
            outcome.cleanup.failures.push(String(result.reason));
          }
        outcome.cleanup.cliActualCloseObserved = owned.isSettled();
        await sibling.close().catch((error) => {
          primary ??= error;
          outcome.cleanup.failures.push(String(error));
        });
        outcome.cleanup.sentinel = sibling.state();
        sibling = undefined;
        outcome.watchdogFired = watchdogFired;
        outcome.cli = {
          code: owned.child.exitCode,
          signal: owned.child.signalCode,
          stdout: owned.output().stdout.slice(0, 16384),
          stderr: owned.output().stderr.slice(0, 16384),
        };
        try {
          outcome.observed = records(log);
        } catch (error) {
          primary ??= error;
          outcome.cleanup.failures.push(String(error));
        }
        outcome.passed = primary === undefined;
      }
      if (primary !== undefined) throw primary;
    }
    const observed = calls().slice(before);
    assert.equal(
      observed.filter(
        (call) =>
          call.denied || call.operation === 'keyring.Entry' || call.operation === 'sdk-fetch',
      ).length,
      0,
      'Native offline control attempted a provider/keychain/forbidden service',
    );
    // Windows fatal/output modes each own a target plus a real helper; background owns only its target.
    const expectedSpawns = bootstrap && process.platform === 'win32' ? 5 : 3;
    assert.equal(
      observed.filter((call) => call.operation === 'native-owned-spawn').length,
      expectedSpawns,
    );
    return {
      platform: process.platform,
      runtime: process.version,
      publicOfflineAgentRoute: true,
      capturedPackagedCreationExitClosure: true,
      originalBootstrapIdentity: bootstrap
        ? 'untouched installed entry owns global hooks'
        : 'separately checked by source forwarding controls',
      fatalCoordinatorActivated: bootstrap,
      ...(bootstrap
        ? {
            scope:
              'plain installed one-shot hooks and owned native ACK ordering; interactive restoration and deadline nonrenewal remain separately attributed source controls',
          }
        : {}),
      copiedRuntimeLibraries,
      outcomes,
    };
  } catch (error) {
    caseFailure = error;
    throw new InstalledNativeControlError(error, {
      platform: process.platform,
      runtime: process.version,
      copiedRuntimeLibraries,
      outcomes,
    });
  } finally {
    if (sibling !== undefined) {
      await sibling.close().catch((error) => {
        outcomes.at(-1)?.cleanup.failures.push(String(error));
        if (caseFailure === undefined) throw error;
      });
      const last = outcomes.at(-1);
      if (last !== undefined) last.cleanup.sentinel = sibling.state();
    }
  }
}
