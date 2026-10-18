import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exerciseInstalledCommand,
  isolatedEnvironment,
  resolvePnpm,
  runCommand,
  runPnpm,
} from './process.mjs';

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
