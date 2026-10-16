import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function readOrdinaryFile(path, maxBytes) {
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0);
  const info = lstatSync(path, { bigint: true });
  assert.ok(info.isFile() && info.size <= BigInt(maxBytes), 'PACKED_CLI_FILE_KIND_OR_BOUND');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assert.ok(
      opened.isFile() &&
        opened.dev === info.dev &&
        opened.ino === info.ino &&
        opened.size === info.size,
      'PACKED_CLI_FILE_CHANGED',
    );
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    assert.equal(BigInt(offset), opened.size, 'PACKED_CLI_FILE_CHANGED');
    assert.equal(
      fstatSync(descriptor, { bigint: true }).size,
      opened.size,
      'PACKED_CLI_FILE_CHANGED',
    );
    return bytes.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

export function flatFiles(directory, prefix) {
  const result = new Map();
  assert.ok(lstatSync(directory).isDirectory());
  for (const name of readdirSync(directory).sort()) {
    assert.ok(!name.includes('/') && !name.includes('\\'));
    const path = join(directory, name),
      info = lstatSync(path);
    if (info.isDirectory()) {
      for (const [key, bytes] of flatFiles(path, `${prefix}/${name}`)) result.set(key, bytes);
    } else result.set(`${prefix}/${name}`, readOrdinaryFile(path, 8 * 1024 * 1024));
  }
  return result;
}

export function oneTarball(directory) {
  const names = readdirSync(directory);
  const tarballs = names.filter((name) => /^relavium-[A-Za-z0-9.+-]+\.tgz$/u.test(name));
  assert.equal(tarballs.length, 1, 'PACKED_CLI_EXACTLY_ONE_TARBALL');
  assert.ok(
    names.every((name) => name === tarballs[0] || name === 'package-test-receipt.json'),
    'PACKED_CLI_UNEXPECTED_PUBLIC_ARTIFACT',
  );
  return join(directory, tarballs[0]);
}

/** Actual installed public files; node_modules is installation state, never product content. */
export function installedInventory(packageRoot) {
  const files = new Map();
  for (const name of readdirSync(packageRoot).sort()) {
    if (name === 'node_modules') continue;
    const path = join(packageRoot, name),
      info = lstatSync(path);
    if (info.isDirectory()) {
      for (const [key, bytes] of flatFiles(path, `package/${name}`)) files.set(key, bytes);
    } else files.set(`package/${name}`, readOrdinaryFile(path, 8 * 1024 * 1024));
  }
  return [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }));
}
