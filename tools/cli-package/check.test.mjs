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
import { basename, delimiter, dirname, join } from 'node:path';
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
  'cli-package/source-map.mjs',
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
 * explicitly, so the check runs no pnpm, unless a `pnpm` stand-in is given for its store discovery;
 * so is the excludes file unless `excludes` is false, when the check's Git lookup sees an empty home
 * and no global or system configuration.
 */
function check({ pack, consume = CONSUMER, excludes: named = true, git, pnpm, env: extra = {} }) {
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
  // Optional `git` and `pnpm` stand-ins, first on PATH, for the check's own excludes lookup and
  // store discovery.
  const bin = join(root, 'bin');
  mkdirSync(bin);
  if (git !== undefined) writeFileSync(join(bin, 'git'), git, { mode: 0o755 });
  if (pnpm !== undefined) writeFileSync(join(bin, 'pnpm'), pnpm(markers, store), { mode: 0o755 });
  writeFileSync(join(root, 'tools', 'cli-package', 'pack.mjs'), pack(markers));
  writeFileSync(join(root, 'tools', 'cli-package', 'consume.mjs'), consume(markers));
  const child = spawn(process.execPath, [join(root, 'tools', 'cli-package', 'check.mjs')], {
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      TMPDIR: temporary,
      ...(pnpm === undefined ? { RELAVIUM_PACKAGE_STORE_DIR: store } : {}),
      ...(named
        ? { RELAVIUM_GIT_EXCLUDES_FILE: excludes }
        : { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull }),
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr })),
  );
  return { child, exited, root, markers, temporary, store, excludes };
}

/** The check's exit, bounded so that a regressed check fails its test instead of hanging it. */
async function exitOf(run) {
  // Unreferenced, so a pending bound never keeps the test process alive after the check exits.
  const bound = delay(60_000, undefined, { ref: false }).then(() => undefined);
  const outcome = await Promise.race([run.exited, bound]);
  assert.ok(outcome !== undefined, 'the check did not exit within 60 s');
  return outcome;
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

/** A killed process can still answer for a moment after its killer exits: wait, with a bound. */
async function assertGone(pid, message) {
  for (let waited = 0; alive(pid); waited += 25) {
    assert.ok(waited < 5_000, message);
    await delay(25);
  }
}

/**
 * Stop the check and every stand-in a regressed check could leave behind: the stand-ins run in their
 * own process groups, so they would outlive a check that died without forwarding its interrupt.
 */
function stopAll(run) {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
  for (const name of [
    'pack.pid',
    'consume-started',
    'writer.pid',
    'grandchild.pid',
    'helper.pid',
  ]) {
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
      const outcome = await exitOf(run);
      assert.equal(outcome.signal, null);
      assert.equal(outcome.code, 130);
      assert.equal(outcome.stdout, '');
      // The consumer received the forwarded interrupt and stopped its writer before its home went.
      await assertGone(pid, 'the consumer writer outlived the interrupt');
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
      const outcome = await exitOf(run);
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
      const outcome = await exitOf(run);
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
    const outcome = await exitOf(run);
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

test('without a named store the check asks pnpm in the repository, with its own private home', async () => {
  // The private home must lie outside the repository, so the temporary directory does too.
  const outside = mkdtempSync(join(scratch, 'outside-'));
  const developer = join(outside, 'developer-home');
  const run = check({
    env: { TMPDIR: outside, HOME: developer },
    pack: RECORDING_PRODUCER,
    consume: PUBLISHING_CONSUMER('local'),
    pnpm: (markers, store) =>
      '#!/usr/bin/env node\n' +
      `require('node:fs').writeFileSync(${JSON.stringify(join(markers, 'pnpm-call'))}, ` +
      'JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), ' +
      'home: process.env.HOME, temporary: process.env.TMPDIR, cache: process.env.XDG_CACHE_HOME }));\n' +
      `process.stdout.write(${JSON.stringify(`${store}\n`)});\n`,
  });
  try {
    const outcome = await exitOf(run);
    assert.equal(outcome.code, 0, outcome.stderr);
    const call = JSON.parse(readFileSync(join(run.markers, 'pnpm-call'), 'utf8'));
    assert.deepEqual(call.args, ['store', 'path']);
    assert.equal(realpathSync(call.cwd), realpathSync(run.root));
    // The store location follows the developer's own HOME; temporary files and caches go to the
    // check's owner-only root.
    assert.equal(call.home, developer);
    assert.equal(dirname(call.temporary), outside);
    assert.match(basename(call.temporary), /^relavium-local-package-check-/u);
    assert.equal(call.cache, call.temporary);
    assert.equal(
      JSON.parse(readFileSync(join(run.markers, 'pack-environment'), 'utf8')).store,
      run.store,
    );
    assert.deepEqual(checkRoots(outside), []);
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
    assert.equal((await exitOf(run)).code, 0);
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
      const outcome = await exitOf(run);
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

test(
  'an interrupt the consumer outlives still gives no summary',
  { skip: process.platform === 'win32' },
  async () => {
    // The consumer signals the check, ignores the interrupt forwarded back to it and publishes.
    const outliving = (markers) =>
      PUBLISHING_CONSUMER('local')(markers) +
      `process.on('SIGINT', () => writeFileSync(${JSON.stringify(join(markers, 'consume-forwarded'))}, 'SIGINT'));\n` +
      `process.kill(process.ppid, 'SIGINT');\nsetTimeout(() => process.exit(0), 500);\n`;
    const run = check({ pack: RECORDING_PRODUCER, consume: outliving });
    try {
      const outcome = await exitOf(run);
      assert.equal(outcome.signal, null);
      assert.equal(outcome.code, 130);
      assert.equal(outcome.stdout, '');
      assert.equal(readFileSync(join(run.markers, 'consume-forwarded'), 'utf8'), 'SIGINT');
      assert.deepEqual(checkRoots(run.temporary), []);
    } finally {
      stopAll(run);
    }
  },
);

test(
  'an interrupt during discovery stops the check before the producer',
  { skip: process.platform === 'win32' },
  async () => {
    // The excludes lookup's Git signals the check, ignores the interrupt forwarded back to it and
    // exits 1 (no setting), so discovery itself completes normally.
    const run = check({
      pack: RECORDING_PRODUCER,
      consume: PUBLISHING_CONSUMER('local'),
      excludes: false,
      git: `#!/bin/sh\ntrap 'exit 1' INT\nkill -INT "$PPID"\nsleep 1 &\nwait\nexit 1\n`,
    });
    try {
      const outcome = await exitOf(run);
      assert.equal(outcome.signal, null);
      assert.equal(outcome.code, 130);
      assert.equal(outcome.stdout, '');
      assert.equal(existsSync(join(run.markers, 'pack-environment')), false);
      assert.equal(existsSync(join(run.markers, 'consume-started')), false);
      assert.deepEqual(checkRoots(run.temporary), []);
    } finally {
      stopAll(run);
    }
  },
);

test(
  'a stage past its deadline is interrupted first, so its own children never outlive the check',
  { skip: process.platform === 'win32' },
  async () => {
    // A producer that handles the interrupt as the real one does, around a detached build child that
    // would write a map into the check root after the check removed it.
    const run = check({
      env: { RELAVIUM_LOCAL_CHECK_DEADLINE_MS: '1500' },
      pack: (markers) => `
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { exitOnInterrupt, isolatedEnvironment, runCommand } from './process.mjs';
const late = join(tmpdir(), 'late');
await exitOnInterrupt(
  () => writeFileSync(${JSON.stringify(join(markers, 'pack-interrupted'))}, 'cleaned'),
  () =>
    runCommand(process.execPath, ['-e', ${JSON.stringify(
      `const fs = require('node:fs');` +
        `fs.writeFileSync(${JSON.stringify(join(markers, 'grandchild.pid'))}, String(process.pid));`,
    )} + 'setTimeout(() => { require("node:fs").mkdirSync(' + JSON.stringify(late) + ', { recursive: true }); require("node:fs").writeFileSync(' + JSON.stringify(join(late, 'index.js.map')) + ', "map"); }, 3000); setInterval(() => {}, 1000);'], {
      env: isolatedEnvironment(tmpdir()),
      timeoutMs: 60_000,
    }),
);
`,
    });
    try {
      const grandchild = Number(await waitForFile(join(run.markers, 'grandchild.pid')));
      const [checkRoot] = checkRoots(run.temporary);
      assert.ok(checkRoot !== undefined);
      const outcome = await exitOf(run);
      assert.equal(outcome.signal, null);
      assert.equal(outcome.code, 1);
      assert.equal(outcome.stdout, '');
      assert.equal(readFileSync(join(run.markers, 'pack-interrupted'), 'utf8'), 'cleaned');
      await assertGone(grandchild, 'the stage build child outlived the deadline');
      // Past the moment the build child would have written: nothing recreated the check root.
      await delay(3500);
      assert.equal(existsSync(join(run.temporary, checkRoot)), false);
    } finally {
      stopAll(run);
    }
  },
);

test('only a shorter, positive stage deadline is admitted', async () => {
  for (const deadline of ['0', '-1', '600001', 'soon', '']) {
    const run = check({
      env: { RELAVIUM_LOCAL_CHECK_DEADLINE_MS: deadline },
      pack: RECORDING_PRODUCER,
      consume: PUBLISHING_CONSUMER('local'),
    });
    try {
      const outcome = await exitOf(run);
      assert.equal(outcome.code, 1, deadline);
      assert.equal(existsSync(join(run.markers, 'pack-environment')), false, deadline);
      assert.deepEqual(checkRoots(run.temporary), []);
    } finally {
      stopAll(run);
    }
  }
});

test(
  'an interrupt during the root removal of the check still ends it with the signal',
  { skip: process.platform === 'win32' },
  async () => {
    // The consumer publishes, leaves a large tree in the check root and starts a helper that signals
    // the check as soon as that tree starts to shrink, that is during the check's own removal.
    const removal = (markers) =>
      PUBLISHING_CONSUMER('local')(markers) +
      `
const bulk = join(reports, 'bulk');
mkdirSync(bulk);
for (let i = 0; i < 20000; i += 1) writeFileSync(join(bulk, String(i)), '');
const { spawn } = await import('node:child_process');
const helper = spawn(process.execPath, ['-e', ${JSON.stringify(
        `const fs = require('node:fs');` +
          `const [bulk, check, marker] = process.argv.slice(1);` +
          `const poll = () => { let count; try { count = fs.readdirSync(bulk).length; } catch { process.exit(0); }` +
          ` if (count < 20000) { process.kill(Number(check), 'SIGINT'); fs.writeFileSync(marker, 'sent'); process.exit(0); }` +
          ` setTimeout(poll, 1); }; poll();`,
      )}, bulk, String(process.ppid), ${JSON.stringify(join(markers, 'removal-signalled'))}], { detached: true, stdio: 'ignore' });
writeFileSync(${JSON.stringify(join(markers, 'helper.pid'))}, String(helper.pid));
helper.unref();
`;
    const run = check({ pack: RECORDING_PRODUCER, consume: removal });
    try {
      const outcome = await exitOf(run);
      assert.equal(readFileSync(join(run.markers, 'removal-signalled'), 'utf8'), 'sent');
      assert.equal(outcome.signal, null);
      assert.equal(outcome.code, 130);
      assert.deepEqual(checkRoots(run.temporary), []);
    } finally {
      stopAll(run);
    }
  },
);

test(
  'a consumer past its deadline is interrupted first too, so its own children never outlive the check',
  { skip: process.platform === 'win32' },
  async () => {
    // The real consumer lifetime around a detached child that would write into the check root later.
    const lateConsumer = (markers) => `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeConsumer } from './consumer-lifetime.mjs';
import { isolatedEnvironment, runCommand } from './process.mjs';
const reports = process.argv[3];
mkdirSync(reports, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'relavium-package-consumer-'));
const late = join(tmpdir(), 'late');
await completeConsumer({
  supportRoot: reports,
  exercise: () =>
    runCommand(process.execPath, ['-e', ${JSON.stringify(
      `require('node:fs').writeFileSync(${JSON.stringify(join(markers, 'grandchild.pid'))}, String(process.pid));`,
    )} + 'setTimeout(() => { require("node:fs").mkdirSync(' + JSON.stringify(late) + ', { recursive: true }); require("node:fs").writeFileSync(' + JSON.stringify(join(late, 'installed.log')) + ', "late"); }, 3000); setInterval(() => {}, 1000);'], {
      env: isolatedEnvironment(home),
      timeoutMs: 60_000,
    }),
  cleanup: () => {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    writeFileSync(${JSON.stringify(join(markers, 'consume-cleaned'))}, 'cleaned');
  },
  cleanupFailed: () => {},
  publish: () => {},
});
`;
    const run = check({
      env: { RELAVIUM_LOCAL_CHECK_DEADLINE_MS: '1500' },
      pack: RECORDING_PRODUCER,
      consume: lateConsumer,
    });
    try {
      const grandchild = Number(await waitForFile(join(run.markers, 'grandchild.pid')));
      const [checkRoot] = checkRoots(run.temporary);
      assert.ok(checkRoot !== undefined);
      const outcome = await exitOf(run);
      assert.equal(outcome.signal, null);
      assert.equal(outcome.code, 1);
      assert.equal(outcome.stdout, '');
      assert.equal(readFileSync(join(run.markers, 'consume-cleaned'), 'utf8'), 'cleaned');
      await assertGone(grandchild, 'the stage build child outlived the deadline');
      await delay(3500);
      assert.equal(existsSync(join(run.temporary, checkRoot)), false);
    } finally {
      stopAll(run);
    }
  },
);
