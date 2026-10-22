import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// The local check runs from a copied tooling tree whose pack.mjs and consume.mjs are stand-ins, so no
// case can build, pack or install the real CLI even if the orchestration regresses.
const tooling = fileURLToPath(new URL('../', import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-local-check-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;

const COPIED = Object.freeze([
  'cli-bootstrap/child.mjs',
  'cli-bootstrap/policy.mjs',
  'cli-bootstrap/process.mjs',
  'cli-package/smoke/index.mjs',
  'cli-package/check.mjs',
  'cli-package/candidate.mjs',
  'cli-package/consumer-lifetime.mjs',
  'cli-package/files.mjs',
  'cli-package/finalize.mjs',
  'cli-package/paths.mjs',
  'cli-package/process.mjs',
  'bundle-closure/closure.mjs',
  'bundle-closure/inventory.mjs',
]);

/**
 * A long-lived process that records its pid, then tries to write a file into `directory` every 5 ms;
 * it outlives the directory's removal unless it is killed.
 */
function writer(directory, pidFile) {
  return (
    `const { writeFileSync } = require('node:fs');` +
    `const { join } = require('node:path');` +
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
    `let n = 0; setInterval(() => { try { writeFileSync(join(${JSON.stringify(directory)}, 'f' + n++), 'x'); } catch {} }, 5);`
  );
}

/** The consumer stand-in: the real consumer lifetime around a `pnpm add`-like writer in its home. */
const CONSUMER = (markers) => `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeConsumer } from './consumer-lifetime.mjs';
import { isolatedEnvironment, runCommand } from './process.mjs';
writeFileSync(${JSON.stringify(join(markers, 'consume-started'))}, String(process.pid));
const reports = process.argv[3];
mkdirSync(reports, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'relavium-package-consumer-'));
const writer = (${writer.toString()})(home, ${JSON.stringify(join(markers, 'writer.pid'))});
await completeConsumer({
  exercise: () =>
    runCommand(process.execPath, ['-e', writer], {
      env: isolatedEnvironment(home),
      timeoutMs: 60_000,
    }),
  supportRoot: reports,
  cleanup: () => rmSync(home, { recursive: true, force: true, maxRetries: 3 }),
  cleanupFailed: () => {},
  publish: () => {},
});
`;

/** A consumer stand-in that publishes the record `pnpm smoke:cli-package` summarizes. */
const PUBLISHING_CONSUMER = (leg) => (markers) => `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(${JSON.stringify(join(markers, 'consume-started'))}, String(process.pid));
const reports = process.argv[3];
mkdirSync(reports, { recursive: true });
writeFileSync(join(reports, 'installed-consumer.json'), ${JSON.stringify(
  JSON.stringify({
    leg,
    source: 'c'.repeat(40),
    tarballSha256: 'd'.repeat(64),
    node: 'v22.0.0',
    platform: 'synthetic',
    bootstrap: { controls: 7 },
    smoke: { cases: [{ id: 'one', passed: true }] },
  }),
)});
`;

/** A producer stand-in that records the store and excludes variables it received, then succeeds. */
const RECORDING_PRODUCER = (markers) => `
import { mkdirSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(markers, 'pack-environment'))}, JSON.stringify({
  store: process.env.RELAVIUM_PACKAGE_STORE_DIR ?? null,
  excludes: process.env.RELAVIUM_GIT_EXCLUDES_FILE ?? null,
}));
mkdirSync(process.argv[2]);
`;

/**
 * Start the copied check with stand-ins for its producer and consumer. The store is named
 * explicitly, so the check runs no pnpm; so is the excludes file unless `excludes` is false, when
 * the check's Git lookup sees an empty home and no global or system configuration.
 */
function check({ pack, consume = CONSUMER, excludes: named = true }) {
  count += 1;
  const root = join(scratch, `repository-${count}`);
  for (const path of COPIED) {
    mkdirSync(dirname(join(root, 'tools', path)), { recursive: true });
    copyFileSync(join(tooling, path), join(root, 'tools', path));
  }
  symlinkSync(
    fileURLToPath(new URL('../../node_modules', import.meta.url)),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const markers = join(root, 'markers');
  const temporary = join(root, 'tmp');
  const store = join(root, 'store');
  for (const directory of [markers, temporary, store]) mkdirSync(directory);
  const excludes = join(root, 'ignore');
  writeFileSync(excludes, '');
  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(join(root, 'tools', 'cli-package', 'pack.mjs'), pack(markers));
  writeFileSync(join(root, 'tools', 'cli-package', 'consume.mjs'), consume(markers));
  const child = spawn(process.execPath, [join(root, 'tools', 'cli-package', 'check.mjs')], {
    env: {
      PATH: process.env.PATH,
      TMPDIR: temporary,
      RELAVIUM_PACKAGE_STORE_DIR: store,
      ...(named
        ? { RELAVIUM_GIT_EXCLUDES_FILE: excludes }
        : { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal, stdout })),
  );
  return { child, exited, markers, temporary, store, excludes };
}

async function waitForFile(file) {
  for (let waited = 0; !existsSync(file) || readFileSync(file, 'utf8') === ''; waited += 25) {
    assert.ok(waited < 20_000, `${file} never appeared`);
    await delay(25);
  }
  return readFileSync(file, 'utf8');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop the check and every stand-in a regressed check could leave behind: the stand-ins run in their
 * own process groups, so they would outlive a check that died without forwarding its interrupt.
 */
function stopAll(run) {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
  for (const name of ['pack.pid', 'consume-started', 'writer.pid']) {
    const file = join(run.markers, name);
    const pid = existsSync(file) ? Number(readFileSync(file, 'utf8')) : NaN;
    if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
  }
}

const checkRoots = (temporary) =>
  readdirSync(temporary).filter((name) => name.startsWith('relavium-local-package-check-'));

test(
  'an interrupt during the consumer stops its children, removes the check root and exits',
  { skip: process.platform === 'win32' },
  async () => {
    const run = check({
      pack: () => `import { mkdirSync } from 'node:fs';\nmkdirSync(process.argv[2]);\n`,
    });
    let pid;
    try {
      pid = Number(await waitForFile(join(run.markers, 'writer.pid')));
      assert.equal(checkRoots(run.temporary).length, 1);
      run.child.kill('SIGINT');
      const outcome = await run.exited;
      assert.equal(outcome.signal, null);
      assert.equal(outcome.code, 130);
      assert.equal(outcome.stdout, '');
      // The consumer received the forwarded interrupt and stopped its writer before its home went.
      assert.equal(alive(pid), false);
      assert.deepEqual(checkRoots(run.temporary), []);
    } finally {
      stopAll(run);
    }
  },
);

test(
  'an interrupt during the producer reaches it, and the consumer never starts',
  { skip: process.platform === 'win32' },
  async () => {
    const run = check({
      pack: (markers) => `
import { writeFileSync } from 'node:fs';
process.on('SIGINT', () => {
  writeFileSync(${JSON.stringify(join(markers, 'pack-interrupted'))}, 'SIGINT');
  process.exit(130);
});
writeFileSync(${JSON.stringify(join(markers, 'pack.pid'))}, String(process.pid));
setInterval(() => {}, 1000);
`,
    });
    try {
      await waitForFile(join(run.markers, 'pack.pid'));
      run.child.kill('SIGINT');
      const outcome = await run.exited;
      assert.equal(outcome.signal, null);
      assert.equal(outcome.code, 130);
      assert.equal(readFileSync(join(run.markers, 'pack-interrupted'), 'utf8'), 'SIGINT');
      assert.equal(existsSync(join(run.markers, 'consume-started')), false);
      assert.deepEqual(checkRoots(run.temporary), []);
    } finally {
      stopAll(run);
    }
  },
);

test(
  'an interrupt the producer outlives still stops the check before the consumer',
  { skip: process.platform === 'win32' },
  async () => {
    // The producer signals the check, ignores the interrupt forwarded back to it and finishes.
    const run = check({
      pack: (markers) => `
import { mkdirSync, writeFileSync } from 'node:fs';
process.on('SIGINT', () => writeFileSync(${JSON.stringify(join(markers, 'pack-forwarded'))}, 'SIGINT'));
mkdirSync(process.argv[2]);
process.kill(process.ppid, 'SIGINT');
setTimeout(() => process.exit(0), 500);
`,
    });
    try {
      const outcome = await run.exited;
      assert.equal(outcome.signal, null);
      assert.equal(outcome.code, 130);
      assert.equal(readFileSync(join(run.markers, 'pack-forwarded'), 'utf8'), 'SIGINT');
      assert.equal(existsSync(join(run.markers, 'consume-started')), false);
      assert.deepEqual(checkRoots(run.temporary), []);
    } finally {
      stopAll(run);
    }
  },
);

test('a successful producer and consumer give the summary and leave no check root', async () => {
  const run = check({ pack: RECORDING_PRODUCER, consume: PUBLISHING_CONSUMER('local') });
  try {
    const outcome = await run.exited;
    assert.equal(outcome.signal, null);
    assert.equal(outcome.code, 0);
    assert.deepEqual(JSON.parse(outcome.stdout), {
      scope: 'actual local host only; required CI owns four platform legs',
      source: 'c'.repeat(40),
      sha256: 'd'.repeat(64),
      node: 'v22.0.0',
      platform: 'synthetic',
      controls: 7,
      smokeCases: 1,
    });
    // The isolated producer receives the store and the excludes file the check found.
    assert.deepEqual(JSON.parse(readFileSync(join(run.markers, 'pack-environment'), 'utf8')), {
      store: run.store,
      excludes: run.excludes,
    });
    assert.deepEqual(checkRoots(run.temporary), []);
  } finally {
    stopAll(run);
  }
});

test('without a global excludes file the producer receives none', async () => {
  const run = check({
    pack: RECORDING_PRODUCER,
    consume: PUBLISHING_CONSUMER('local'),
    excludes: false,
  });
  try {
    assert.equal((await run.exited).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(run.markers, 'pack-environment'), 'utf8')), {
      store: run.store,
      excludes: null,
    });
  } finally {
    stopAll(run);
  }
});

for (const [label, options] of [
  ['a failed producer', { pack: () => 'process.exit(3);\n' }],
  ['a failed consumer', { pack: RECORDING_PRODUCER, consume: () => 'process.exit(4);\n' }],
  [
    'a record from another leg',
    { pack: RECORDING_PRODUCER, consume: PUBLISHING_CONSUMER('linux') },
  ],
])
  test(`${label} fails the check without a summary and leaves no check root`, async () => {
    const run = check(options);
    try {
      const outcome = await run.exited;
      assert.equal(outcome.signal, null);
      assert.equal(outcome.code, 1);
      assert.equal(outcome.stdout, '');
      if (label === 'a failed producer')
        assert.equal(existsSync(join(run.markers, 'consume-started')), false);
      assert.deepEqual(checkRoots(run.temporary), []);
    } finally {
      stopAll(run);
    }
  });
