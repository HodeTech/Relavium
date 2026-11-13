import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  captureNativeInputs,
  inspectNativeAssets,
  nativeSourceBinding,
  NativeAssetError,
} from './assets.mjs';
import { syntheticNativeAssets } from './fixture.mjs';

// Exercise Git's actual checkout filters, including Windows-style autocrlf, without touching the checkout.
test('LF attributes preserve every native input under autocrlf while an unpinned control converts to CRLF', (t) => {
  const repository = fileURLToPath(new URL('../..', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'relavium-native-checkout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = captureNativeInputs(repository);
  const names = ['.gitattributes', ...before.files.map((file) => file.path)];
  for (const name of names) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), readFileSync(join(repository, name)));
  }
  writeFileSync(join(root, 'unpinned.txt'), 'control\n');
  const git = (args) =>
    execFileSync('git', ['-c', 'core.autocrlf=true', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git(['init', '--quiet']);
  git(['add', '--all']);
  for (const name of [...names, 'unpinned.txt']) rmSync(join(root, name));
  git(['checkout-index', '--all', '--force']);
  assert.equal(readFileSync(join(root, 'unpinned.txt'), 'utf8'), 'control\r\n');
  assert.deepEqual(captureNativeInputs(root), before);
  const loader = join(root, 'tools/native-fs/loader.cjs');
  writeFileSync(loader, readFileSync(loader, 'utf8').replaceAll('\n', '\r\n'));
  assert.notEqual(nativeSourceBinding(root).buildSha256, before.binding.buildSha256);
});

test('forced CRLF loader bytes still fail the reviewed loader pin', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-native-crlf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const value = syntheticNativeAssets(root);
  const loader = join(value.directory, 'loader.cjs');
  writeFileSync(loader, readFileSync(loader, 'utf8').replaceAll('\n', '\r\n'));
  assert.throws(
    () => inspectNativeAssets(value.directory),
    (error) => error instanceof NativeAssetError && error.code === 'LOADER',
  );
});
