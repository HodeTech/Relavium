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
import { tmpdir } from 'node:os';
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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeConsumer } from './consumer-lifetime.mjs';
import { isolatedEnvironment, runCommand } from './process.mjs';
writeFileSync(${JSON.stringify(join(markers, 'consume-started'))}, String(process.pid));
const home = mkdtempSync(join(tmpdir(), 'relavium-package-consumer-'));
const writer = (${writer.toString()})(home, ${JSON.stringify(join(markers, 'writer.pid'))});
await completeConsumer({
  exercise: () =>
    runCommand(process.execPath, ['-e', writer], {
      env: isolatedEnvironment(home),
      timeoutMs: 60_000,
    }),
  abandon: () => {},
  cleanup: () => rmSync(home, { recursive: true, force: true, maxRetries: 3 }),
  cleanupFailed: () => {},
  publish: () => {},
});
`;

/**
 * Start the copied check with stand-ins for its producer and consumer. The store and the excludes
 * file are named explicitly, so the check runs neither pnpm nor Git.
 */
function check({ pack }) {
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
  writeFileSync(join(root, 'tools', 'cli-package', 'pack.mjs'), pack(markers));
  writeFileSync(join(root, 'tools', 'cli-package', 'consume.mjs'), CONSUMER(markers));
  const child = spawn(process.execPath, [join(root, 'tools', 'cli-package', 'check.mjs')], {
    env: {
      PATH: process.env.PATH,
      TMPDIR: temporary,
      RELAVIUM_PACKAGE_STORE_DIR: store,
      RELAVIUM_GIT_EXCLUDES_FILE: excludes,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal, stdout })),
  );
  return { child, exited, markers, temporary };
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
