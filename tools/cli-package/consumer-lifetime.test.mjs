import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { completeConsumer } from './consumer-lifetime.mjs';
import { REQUIRED_SMOKE_CASES } from './smoke/cases.mjs';

async function fixture(
  t,
  { wrongPid = false, exitCode = 0, nativeFailure = false, diagnosticSinkFailure = false } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-consumer-lifetime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const smoke = join(root, 'smoke'),
    installation = join(root, 'installation'),
    support = join(root, 'support');
  for (const directory of [smoke, installation, support]) mkdirSync(directory);
  for (const name of ['process.mjs', 'files.mjs'])
    copyFileSync(new URL(name, import.meta.url), join(root, name));
  copyFileSync(new URL('smoke/index.mjs', import.meta.url), join(smoke, 'index.mjs'));
  for (const name of ['failure-diagnostic.mjs', 'native-signal-diagnostic.mjs', 'cases.mjs'])
    copyFileSync(new URL(`smoke/${name}`, import.meta.url), join(smoke, name));
  const require = createRequire(new URL('../../packages/db/package.json', import.meta.url));
  const binary = join(
    dirname(require.resolve('better-sqlite3/package.json')),
    'build/Release/better_sqlite3.node',
  );
  copyFileSync(binary, join(installation, 'native.node'));
  // The real launcher/process/file boundaries are unchanged. Only the owned worker
  // body is synthetic: it loads a real copied addon and remains live after reporting.
  writeFileSync(
    join(smoke, 'worker.mjs'),
    `
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitInstalledWorkerFailure } from './failure-diagnostic.mjs';
const [, , packageRoot, supportRoot, artifactSha256, source] = process.argv;
const addon = createRequire(import.meta.url)(join(packageRoot, 'native.node'));
assert.equal(typeof addon.Database, 'function');
const report = {
  source, artifactSha256, pid: ${wrongPid ? '0' : 'process.pid'}, parentPid: process.ppid,
  runtime: process.version, platform: process.platform, success: ${!nativeFailure}, nativeLoaded: true,
  compiledUnchanged: true, ownedTempRemoved: true,
  cases: ${JSON.stringify(REQUIRED_SMOKE_CASES.map((id) => ({ id, passed: true })))},
};
if (${nativeFailure}) {
  const failed = report.cases.find((item) => item.id === 'actual-native-process-owner');
  failed.passed = false;
  failed.error = 'AssertionError [ERR_ASSERTION]: synthetic helper-close failure';
  failed.evidence = { outcomes: [{ mode: 'injected-error', gate: 'helper', passed: false,
    observed: [{ operation: 'native-helper-actual-close', pid: 4242, code: 1, signal: null }],
    cleanup: { cliActualCloseObserved: true, sentinel: { actualCloseObserved: true, watchdogFired: false } }
  }] };
}
writeFileSync(join(supportRoot, 'installed-smoke.json'), JSON.stringify(report));
process.on('exit', () => writeFileSync(join(supportRoot, 'worker-exit'), 'observed'));
if (${nativeFailure}) {
  if (${diagnosticSinkFailure}) closeSync(2);
  emitInstalledWorkerFailure(report);
}
setTimeout(() => { process.exitCode = ${exitCode}; }, 50);
`,
  );
  // eslint-disable-next-line no-restricted-syntax -- Exact copied launcher in this test-owned directory; no product/source alias.
  const { runInstalledSmoke } = await import(pathToFileURL(join(smoke, 'index.mjs')).href);
  return {
    root,
    installation,
    support,
    run: () =>
      runInstalledSmoke({
        packageRoot: installation,
        supportRoot: support,
        artifactSha256: 'a'.repeat(64),
        source: 'b'.repeat(40),
      }),
  };
}

test('real addon worker closes before installation removal and success publication without loading the cleanup owner', async (t) => {
  const own = await fixture(t);
  const original = process.dlopen;
  let parentLoads = 0;
  process.dlopen = () => {
    parentLoads += 1;
    throw new Error('cleanup owner must not load native addons');
  };
  try {
    await completeConsumer({
      exercise: own.run,
      cleanup: () => {
        assert.equal(readFileSync(join(own.support, 'worker-exit'), 'utf8'), 'observed');
        // On Windows an in-process or still-running addon owner keeps this copy locked.
        rmSync(own.installation, { recursive: true, force: true });
      },
      abandon: () => {},
      cleanupFailed: () => assert.fail('unexpected secondary cleanup failure'),
      publish: (report) => {
        assert.equal(existsSync(own.installation), false);
        assert.equal(report.nativeLoaded, true);
        assert.notEqual(report.pid, process.pid);
        writeFileSync(join(own.support, 'success'), 'published after removal');
      },
    });
    assert.equal(parentLoads, 0);
    assert.equal(readFileSync(join(own.support, 'success'), 'utf8'), 'published after removal');
  } finally {
    process.dlopen = original;
  }
});

for (const diagnosticSinkFailure of [false, true])
  test(`synthetic native-case failure in a real addon worker is joined, diagnosed and unpublished (stderr refusal: ${diagnosticSinkFailure})`, async (t) => {
    const own = await fixture(t, { exitCode: 1, nativeFailure: true, diagnosticSinkFailure });
    let primary,
      published = false;
    await assert.rejects(
      completeConsumer({
        exercise: async () => {
          try {
            return await own.run();
          } catch (error) {
            primary = error;
            throw error;
          }
        },
        cleanup: () => {
          assert.equal(readFileSync(join(own.support, 'worker-exit'), 'utf8'), 'observed');
          rmSync(own.installation, { recursive: true, force: true });
        },
        abandon: () => {},
        cleanupFailed: () => assert.fail('unexpected secondary cleanup failure'),
        publish: () => {
          published = true;
        },
      }),
      (error) => {
        assert.equal(error, primary);
        assert.equal(error.result.code, 1);
        assert.equal(error.result.signal, null);
        assert.equal(error.result.stdout, '');
        if (diagnosticSinkFailure) assert.equal(error.result.stderr, '');
        else {
          assert.ok(Buffer.byteLength(error.result.stderr) <= 8192);
          const diagnostic = JSON.parse(error.result.stderr);
          assert.equal(diagnostic.type, 'installed-cli-worker-failure');
          assert.equal(diagnostic.source, 'b'.repeat(40));
          assert.equal(diagnostic.artifactSha256, 'a'.repeat(64));
          assert.equal(diagnostic.runtime, process.version);
          assert.equal(diagnostic.workerPid, error.result.pid);
          assert.equal(diagnostic.parentPid, process.pid);
          assert.equal(diagnostic.cases.length, 1);
          assert.equal(diagnostic.cases[0].id, 'actual-native-process-owner');
          assert.equal(diagnostic.cases[0].error, 'Failure detail retained in private report.');
          assert.equal(diagnostic.cases[0].native[0].observed[0].code, 1);
          assert.equal(diagnostic.cases[0].native[0].cleanup.cliActualCloseObserved, true);
        }
        return true;
      },
    );
    assert.equal(published, false);
    assert.equal(existsSync(own.installation), false);
    assert.equal(existsSync(join(own.support, 'installed-consumer.json')), false);
  });

for (const [name, options, expected] of [
  ['foreign PID', { wrongPid: true }, /not from the joined worker/],
  ['nonzero worker after an early success file', { exitCode: 12 }, /CHILD_FAILED/],
])
  test(`${name} refuses publication and still removes the owned installation`, async (t) => {
    const own = await fixture(t, options);
    let published = false;
    await assert.rejects(
      completeConsumer({
        exercise: own.run,
        cleanup: () => rmSync(own.installation, { recursive: true, force: true }),
        abandon: () => {},
        cleanupFailed: () => assert.fail('unexpected secondary cleanup failure'),
        publish: () => {
          published = true;
        },
      }),
      expected,
    );
    assert.equal(published, false);
    assert.equal(existsSync(own.installation), false);
    assert.equal(existsSync(join(own.support, 'worker-exit')), true);
  });

test('failed required cleanup prevents publication of a successful exercise', async () => {
  const cleanupFailure = new Error('synthetic owned cleanup refusal');
  let published = false;
  await assert.rejects(
    completeConsumer({
      exercise: async () => ({ success: true }),
      cleanup: () => {
        throw cleanupFailure;
      },
      abandon: () => {},
      cleanupFailed: () => assert.fail('cleanup is primary here'),
      publish: () => {
        published = true;
      },
    }),
    (error) => error === cleanupFailure,
  );
  assert.equal(published, false);
});

for (const primary of [new Error('synthetic worker refusal'), undefined, null])
  test(`exercise failure retains exact primary through cleanup and failed secondary diagnostic: ${String(primary)}`, async () => {
    let cleaned = false,
      published = false,
      diagnosed = false;
    await assert.rejects(
      completeConsumer({
        exercise: async () => {
          throw primary;
        },
        cleanup: () => {
          cleaned = true;
          throw new Error('synthetic secondary cleanup refusal');
        },
        abandon: () => {},
        cleanupFailed: () => {
          diagnosed = true;
          throw new Error('synthetic failed diagnostic sink');
        },
        publish: () => {
          published = true;
        },
      }),
      (error) => error === primary,
    );
    assert.equal(cleaned, true);
    assert.equal(diagnosed, true);
    assert.equal(published, false);
  });

test('a consumer without an interrupt cleanup for the children runCommand does not own refuses', async () => {
  let exercised = false;
  await assert.rejects(
    completeConsumer({
      exercise: async () => {
        exercised = true;
      },
      cleanup: () => {},
      cleanupFailed: () => {},
      publish: () => {},
    }),
    /PACKED_CLI_CONSUMER_ABANDON/u,
  );
  assert.equal(exercised, false);
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A consumer process whose exercise is a long-lived `runCommand` child that keeps writing into the
 * owned installation, as `pnpm add` does, and outlives the installation's removal unless it is killed;
 * the test interrupts the consumer once the child is running.
 */
async function interruptedConsumer(t, { cleanupFails = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-consumer-interrupt-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installation = join(root, 'installation');
  mkdirSync(installation);
  const log = join(root, 'events');
  const pidFile = join(root, 'child.pid');
  const url = (name) => JSON.stringify(new URL(name, import.meta.url).href);
  const writer =
    `const { writeFileSync } = require('node:fs');` +
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
    `let n = 0; setInterval(() => { try { writeFileSync(require('node:path').join(${JSON.stringify(installation)}, 'f' + n++), 'x'); } catch {} }, 5);`;
  const script = `
import { appendFileSync, rmSync } from 'node:fs';
import { completeConsumer } from ${url('./consumer-lifetime.mjs')};
import { isolatedEnvironment, runCommand } from ${url('./process.mjs')};
const record = (event) => appendFileSync(${JSON.stringify(log)}, event + '\\n');
await completeConsumer({
  exercise: () => runCommand(process.execPath, ['-e', ${JSON.stringify(writer)}], {
    env: isolatedEnvironment(${JSON.stringify(root)}),
    timeoutMs: 60_000,
  }),
  abandon: () => record('abandon'),
  cleanup: () => {
    record('cleanup');
    if (${cleanupFails}) throw new Error('synthetic cleanup refusal');
    rmSync(${JSON.stringify(installation)}, { recursive: true, force: true, maxRetries: 3 });
  },
  cleanupFailed: () => record('cleanupFailed'),
  publish: () => record('publish'),
});
`;
  const consumer = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let child;
  try {
    for (
      let waited = 0;
      !existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '';
      waited += 25
    ) {
      assert.ok(waited < 20_000, 'the exercise never started');
      await delay(25);
    }
    child = Number(readFileSync(pidFile, 'utf8'));
    const exited = new Promise((resolve) =>
      consumer.once('exit', (code, signal) => resolve([code, signal])),
    );
    consumer.kill('SIGINT');
    const [code, signal] = await exited;
    return { code, signal, child, installation, events: readFileSync(log, 'utf8') };
  } finally {
    if (consumer.exitCode === null && consumer.signalCode === null) consumer.kill('SIGKILL');
    if (child !== undefined && alive(child)) process.kill(child, 'SIGKILL');
  }
}

test(
  'an interrupted consumer stops its children, abandons the rest, removes its installation and exits',
  { skip: process.platform === 'win32' },
  async (t) => {
    const outcome = await interruptedConsumer(t);
    assert.equal(outcome.signal, null);
    assert.equal(outcome.code, 130);
    // The writer was stopped before the removal, which therefore leaves nothing behind.
    assert.equal(alive(outcome.child), false);
    assert.equal(existsSync(outcome.installation), false);
    assert.equal(outcome.events, 'abandon\ncleanup\n');
  },
);

test(
  'a failed removal after an interrupt is only the secondary diagnostic',
  { skip: process.platform === 'win32' },
  async (t) => {
    const outcome = await interruptedConsumer(t, { cleanupFails: true });
    assert.equal(outcome.signal, null);
    assert.equal(outcome.code, 130);
    assert.equal(outcome.events, 'abandon\ncleanup\ncleanupFailed\n');
  },
);
