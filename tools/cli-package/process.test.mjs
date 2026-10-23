import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { devNull, homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  corepackHome,
  exerciseInstalledCommand,
  isolatedEnvironment,
  isolatedGitEnvironment,
  resolvePnpm,
  runCommand,
  runPnpm,
  stopLiveCommands,
} from './process.mjs';

test('Git reading the original checkout gets no home, global or system configuration nor replace refs', () => {
  const env = isolatedGitEnvironment();
  assert.deepEqual(env, {
    ...isolatedEnvironment(devNull),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_REPLACE_OBJECTS: '1',
  });
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']) assert.equal(env[key], devNull);
});

test('installer receives an explicit credential/config/preload-free environment', () => {
  const home = join(tmpdir(), 'synthetic-installer-home');
  const env = isolatedEnvironment(home);
  assert.equal(env.HOME, home);
  assert.equal(env.USERPROFILE, home);
  assert.equal(env.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0');
  for (const key of [
    'NODE_OPTIONS',
    'NPM_TOKEN',
    'NODE_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'RELAVIUM_OPENAI_API_KEY',
    'npm_config_userconfig',
    'TURBO_TOKEN',
    'TURBO_TEAM',
  ])
    assert.equal(Object.hasOwn(env, key), false, key);
});

test('pnpm JS shim and Windows action layout resolve without executing a shell', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-pnpm-layout-')));
  try {
    writeFileSync(join(root, 'pnpm'), '#!/usr/bin/env node\nthrow new Error("not executed")');
    assert.deepEqual(resolvePnpm(root, 'darwin'), {
      command: process.execPath,
      prefix: [join(root, 'pnpm')],
    });
    mkdirSync(join(root, '.bin'));
    mkdirSync(join(root, 'pnpm-bin', 'bin'), { recursive: true });
    writeFileSync(join(root, '.bin', 'pnpm.cjs'), 'throw new Error("not executed")');
    assert.deepEqual(resolvePnpm(join(root, '.bin'), 'win32'), {
      command: process.execPath,
      prefix: [join(root, '.bin', 'pnpm.cjs')],
    });
    assert.throws(() => resolvePnpm(join(root, 'absent')), /PINNED_PNPM_NOT_FOUND/);
    assert.throws(() => resolvePnpm('relative-not-authoritative'), /PINNED_PNPM_NOT_FOUND/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the actual POSIX action shell-wrapper layout resolves only its reviewed Node sibling', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-pnpm-action-layout-')));
  try {
    const bin = join(root, 'node_modules', '.bin');
    const entry = join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pnpm', 'bin'), { recursive: true });
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 99\n');
    // The shell wrapper is neither parsed nor executed, and cannot alone confer an executable route.
    assert.throws(() => resolvePnpm(bin, 'linux'), /PINNED_PNPM_NOT_FOUND/);
    writeFileSync(entry, 'throw new Error("synthetic entry must not execute during resolution")');
    assert.deepEqual(resolvePnpm(bin, 'linux'), { command: process.execPath, prefix: [entry] });
    rmSync(entry);
    assert.throws(() => resolvePnpm(bin, 'darwin'), /PINNED_PNPM_NOT_FOUND/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installer preserves nonzero exit evidence and joins its actual child', async () => {
  await assert.rejects(
    runCommand(
      process.execPath,
      ['-e', 'process.stderr.write("synthetic-install-failure");process.exitCode=12'],
      { env: isolatedEnvironment(tmpdir()), timeoutMs: 5000 },
    ),
    (error) => {
      assert.equal(error.result.code, 12);
      assert.equal(error.result.signal, null);
      assert.equal(error.result.stderr, 'synthetic-install-failure');
      return true;
    },
  );
});

test('installer rejects and joins a real output flood', async () => {
  await assert.rejects(
    runCommand(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(20000));setInterval(()=>{},1000)'],
      { env: isolatedEnvironment(tmpdir()), timeoutMs: 5000, maxBytes: 32 },
    ),
    /OUTPUT_BOUND/,
  );
});

test('installer rejects and joins a real deadline violation', async () => {
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      env: isolatedEnvironment(tmpdir()),
      timeoutMs: 100,
    }),
    /CHILD_TIMEOUT/,
  );
});

test('actual pnpm install command shim runs help/version and a broken or absent shim refuses', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-installed-command-test-')));
  try {
    const home = join(root, 'consumer'),
      source = join(root, 'package');
    mkdirSync(home);
    mkdirSync(source);
    writeFileSync(
      join(home, 'package.json'),
      JSON.stringify({ private: true, packageManager: 'pnpm@9.12.3' }),
    );
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'relavium',
        version: '0.0.0',
        bin: { relavium: './index.cjs' },
      }),
    );
    writeFileSync(
      join(source, 'index.cjs'),
      '#!/usr/bin/env node\nconsole.log(process.argv[2] === "--version" ? "0.0.0" : "Usage: relavium synthetic");\n',
    );
    await runPnpm(
      ['add', '--offline', '--ignore-scripts', '--ignore-workspace', `file:${source}`],
      {
        cwd: home,
        env: isolatedEnvironment(home),
        timeoutMs: 30_000,
      },
    );
    assert.deepEqual(await exerciseInstalledCommand(home, '0.0.0'), { help: true, version: true });
    await assert.rejects(exerciseInstalledCommand(home, '0.0.1'), /INSTALLED_COMMAND_VERSION/);
    const shim = join(
      home,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'relavium.cmd' : 'relavium',
    );
    writeFileSync(shim, process.platform === 'win32' ? '@exit /b 17\r\n' : '#!/bin/sh\nexit 17\n');
    await assert.rejects(exerciseInstalledCommand(home, '0.0.0'), /CHILD_FAILED/);
    rmSync(shim);
    await assert.rejects(exerciseInstalledCommand(home, '0.0.0'), { code: 'ENOENT' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(file) {
  for (let waited = 0; !existsSync(file) || readFileSync(file, 'utf8') === ''; waited += 25) {
    assert.ok(waited < 20_000, `${file} never appeared`);
    await delay(25);
  }
  return readFileSync(file, 'utf8');
}

test(
  'a tool forwards an interrupt to the detached children that clean up after themselves',
  { skip: process.platform === 'win32' },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-forwarded-interrupt-')));
    const pidFile = join(root, 'child.pid');
    const marker = join(root, 'received');
    // The child cleans up on SIGINT, as the producer does; a SIGKILL would leave no marker.
    const childCode =
      `const { writeFileSync } = require('node:fs');` +
      `process.on('SIGINT', () => { writeFileSync(${JSON.stringify(marker)}, 'SIGINT'); process.exit(0); });` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      `setInterval(() => {}, 1000);`;
    const harness = `
import { constants } from 'node:os';
import { forwardInterrupts, isolatedEnvironment, runCommand } from ${JSON.stringify(new URL('./process.mjs', import.meta.url).href)};
const interrupts = forwardInterrupts();
try {
  await runCommand(process.execPath, ['-e', ${JSON.stringify(childCode)}], {
    env: isolatedEnvironment(${JSON.stringify(root)}),
    timeoutMs: 60_000,
  });
} catch (error) {
  if (interrupts.received() === undefined) throw error;
} finally {
  await interrupts.dispose();
}
const signal = interrupts.received();
if (signal !== undefined) process.exit(128 + constants.signals[signal]);
`;
    const tool = spawn(process.execPath, ['--input-type=module', '-e', harness], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let child;
    try {
      child = Number(await waitForFile(pidFile));
      assert.ok(alive(child));
      const exited = new Promise((resolve) => tool.once('exit', resolve));
      tool.kill('SIGINT');
      const bound = delay(20_000).then(() => 'still running');
      assert.equal(await Promise.race([exited, bound]), 130);
      assert.equal(readFileSync(marker, 'utf8'), 'SIGINT');
      for (let waited = 0; alive(child); waited += 25) {
        assert.ok(waited < 5_000, 'the child outlived the forwarded interrupt');
        await delay(25);
      }
    } finally {
      if (tool.exitCode === null && tool.signalCode === null) tool.kill('SIGKILL');
      if (child !== undefined && alive(child)) process.kill(child, 'SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'an interrupt caught during the cleanup after the last child is still recorded',
  { skip: process.platform === 'win32' },
  async () => {
    // The last await completes from an I/O callback, so the cleanup runs inside the loop's poll
    // phase: a listener removed after one more turn would drop the caught signal.
    const harness = `
import { readFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { forwardInterrupts } from ${JSON.stringify(new URL('./process.mjs', import.meta.url).href)};
const interrupts = forwardInterrupts();
try {
  await readFile(${JSON.stringify(fileURLToPath(import.meta.url))});
} finally {
  process.kill(process.pid, 'SIGINT');
  for (const until = Date.now() + 50; Date.now() < until; );
  await interrupts.dispose();
}
const signal = interrupts.received();
if (signal !== undefined) process.exit(128 + constants.signals[signal]);
console.log('not interrupted');
`;
    const tool = spawn(process.execPath, ['--input-type=module', '-e', harness], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    tool.stdout.on('data', (chunk) => (stdout += chunk));
    const [code, signal] = await new Promise((resolve) =>
      tool.once('exit', (exitCode, signalCode) => resolve([exitCode, signalCode])),
    );
    assert.equal(signal, null);
    assert.equal(code, 130);
    assert.equal(stdout, '');
  },
);

test(
  'a settled child leaves nothing for an interrupt to kill',
  { skip: process.platform === 'win32' },
  async (t) => {
    // A finished child's process group may be recycled; an interrupt must never signal it.
    await runCommand(process.execPath, ['-e', ''], { timeoutMs: 20_000 });
    await assert.rejects(
      runCommand(process.execPath, ['-e', 'process.exit(3)'], { timeoutMs: 20_000 }),
      /PACKED_CLI_CHILD_FAILED/u,
    );
    await assert.rejects(
      runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 }),
      /PACKED_CLI_CHILD_TIMEOUT/u,
    );
    const kill = t.mock.method(process, 'kill', () => true);
    stopLiveCommands();
    assert.equal(kill.mock.callCount(), 0);
  },
);

test('the corepack cache is computed as corepack computes it, and isolated children keep it', () => {
  assert.equal(
    corepackHome({ COREPACK_HOME: '/explicit/corepack' }),
    resolve('/explicit/corepack'),
  );
  assert.equal(
    corepackHome({ XDG_CACHE_HOME: '/xdg', LOCALAPPDATA: '/local' }),
    resolve('/xdg', 'node', 'corepack'),
  );
  assert.equal(corepackHome({ LOCALAPPDATA: '/local' }), resolve('/local', 'node', 'corepack'));
  assert.equal(
    corepackHome({}),
    resolve(
      homedir(),
      process.platform === 'win32' ? join('AppData', 'Local') : '.cache',
      'node',
      'corepack',
    ),
  );
  // An isolated child carries this process's corepack cache, never one inside its own home.
  const home = join(tmpdir(), 'synthetic-installer-home');
  const env = isolatedEnvironment(home);
  assert.equal(env.COREPACK_HOME, corepackHome());
  assert.equal(env.COREPACK_HOME.startsWith(`${home}${sep}`), false);
});

test(
  'a corepack-managed pnpm never runs from the temporary directory an isolated home sits in',
  { skip: process.platform === 'win32' },
  async () => {
    // A module another local user could plant in the shared temporary directory, on the lookup
    // path of code that runs from a home inside it.
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-corepack-temporary-')));
    try {
      const marker = join(temporary, 'planted-module-ran');
      for (const name of ['v8-compile-cache', 'supports-color']) {
        mkdirSync(join(temporary, 'node_modules', name), { recursive: true });
        writeFileSync(
          join(temporary, 'node_modules', name, 'index.js'),
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name)});`,
        );
      }
      const home = realpathSync(mkdtempSync(join(temporary, 'relavium-package-build-')));
      writeFileSync(join(home, 'package.json'), '{"packageManager":"pnpm@9.12.3"}\n');
      const version = await runPnpm(['--version'], {
        cwd: home,
        env: isolatedEnvironment(home),
        timeoutMs: 120_000,
      });
      assert.equal(version.stdout.trim(), '9.12.3');
      assert.equal(existsSync(marker), false, 'a module planted in the temporary directory ran');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

test(
  'past its deadline a child is interrupted first, stops its own children and then settles',
  { skip: process.platform === 'win32' },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-graceful-deadline-')));
    const marker = join(root, 'cleaned');
    const pidFile = join(root, 'grandchild.pid');
    try {
      // A child that handles the interrupt as the producer does, around a detached grandchild.
      const child = `
import { writeFileSync } from 'node:fs';
import { exitOnInterrupt, isolatedEnvironment, runCommand } from ${JSON.stringify(new URL('./process.mjs', import.meta.url).href)};
await exitOnInterrupt(
  () => writeFileSync(${JSON.stringify(marker)}, 'cleaned'),
  () => runCommand(process.execPath, ['-e', ${JSON.stringify(
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
  )}], { env: isolatedEnvironment(${JSON.stringify(root)}), timeoutMs: 60_000 }),
);
`;
      const started = Date.now();
      await assert.rejects(
        runCommand(process.execPath, ['--input-type=module', '-e', child], {
          timeoutMs: 3000,
          graceMs: 20_000,
        }),
        /PACKED_CLI_CHILD_TIMEOUT/u,
      );
      // It settled when the child exited on the interrupt, long before the grace ran out.
      assert.ok(Date.now() - started < 15_000);
      assert.equal(readFileSync(marker, 'utf8'), 'cleaned');
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
      for (let waited = 0; alive(grandchild); waited += 25) {
        assert.ok(waited < 5_000, 'the grandchild outlived the cleanup of its parent');
        await delay(25);
      }
    } finally {
      // A regressed deadline leaves the detached grandchild running: it never outlives the test.
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : NaN;
      if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'a child that ignores the interrupt is killed once the grace runs out',
  { skip: process.platform === 'win32' },
  async () => {
    const started = Date.now();
    await assert.rejects(
      runCommand(
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        { timeoutMs: 500, graceMs: 1000 },
      ),
      (error) =>
        /PACKED_CLI_CHILD_TIMEOUT/u.test(error.message) && error.result.signal === 'SIGKILL',
    );
    assert.ok(Date.now() - started >= 1500);
  },
);
