import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedInventory, oneTarball, readOrdinaryFile, sha256 } from './files.mjs';

test('native file admission bounds bytes and refuses links/directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-package-files-'));
  try {
    const file = join(root, 'fixture');
    writeFileSync(file, 'abcdef');
    assert.equal(readOrdinaryFile(file, 6).toString(), 'abcdef');
    assert.throws(() => readOrdinaryFile(file, 5), /KIND_OR_BOUND/);
    assert.throws(() => readOrdinaryFile(root, 100), /KIND_OR_BOUND/);
    assert.throws(() => readOrdinaryFile(file, Number.POSITIVE_INFINITY));
    if (process.platform !== 'win32') {
      symlinkSync(file, join(root, 'alias'));
      assert.throws(() => readOrdinaryFile(join(root, 'alias'), 100), /KIND_OR_BOUND/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact selection refuses missing, duplicate and unrelated public files', () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-package-select-'));
  try {
    assert.throws(() => oneTarball(root), /ONE_TARBALL/);
    writeFileSync(join(root, 'relavium-0.1.1.tgz'), 'fixture');
    assert.equal(oneTarball(root), join(root, 'relavium-0.1.1.tgz'));
    writeFileSync(join(root, 'package-test-receipt.json'), '{}');
    assert.equal(oneTarball(root), join(root, 'relavium-0.1.1.tgz'));
    writeFileSync(join(root, 'relavium-0.1.2.tgz'), 'fixture');
    assert.throws(() => oneTarball(root), /ONE_TARBALL/);
    rmSync(join(root, 'relavium-0.1.2.tgz'));
    writeFileSync(join(root, 'private-map-manifest.json'), '{}');
    assert.throws(() => oneTarball(root), /UNEXPECTED_PUBLIC/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed inventory hashes every public byte and admits only installation-owned node_modules exclusion', () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-package-inventory-'));
  try {
    mkdirSync(join(root, 'dist'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'installation-state'), 'not product material');
    writeFileSync(join(root, 'dist', 'index.js'), 'public');
    assert.deepEqual(installedInventory(root), [
      {
        path: 'package/dist/index.js',
        bytes: 6,
        sha256: sha256(Buffer.from('public')),
      },
    ]);
    writeFileSync(join(root, 'dist', 'unexpected.map'), 'extra');
    assert.equal(installedInventory(root).length, 2, 'extra file must remain visible to binding');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
