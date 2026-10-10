/** Verify the archive against the actual immutable commit's Git objects before any source executes. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { systemTool } from './system-tools.mjs';

export const baselineCommit = '1b3f8d70c05c9152043dcc476eaa1afaaa87381d';
export function assertBaselineAvailable(repository) {
  try {
    execFileSync(
      systemTool('git'),
      ['--no-replace-objects', 'cat-file', '-e', `${baselineCommit}^{commit}`],
      {
        cwd: repository,
        stdio: 'ignore',
        timeout: 15000,
      },
    );
  } catch {
    throw new Error(
      `Immutable replay predecessor ${baselineCommit} is unavailable locally. Fetch that exact commit from origin before rerunning the offline check: git fetch --no-tags origin ${baselineCommit}`,
    );
  }
}

export function verifyBaselineProvenance(repository, frozen, manifest) {
  assertBaselineAvailable(repository);
  assert.equal(manifest.baselineCommit, baselineCommit);
  assert.equal(manifest.files.length, 143);
  const seen = new Set();
  for (const file of manifest.files) {
    assert.ok(file.path.length > 0 && !/[\0\r\n\\]/.test(file.path));
    assert.ok(
      !file.path.startsWith('/') &&
        !file.path.split('/').some((part) => part === '..' || part === '.'),
    );
    assert.ok(!seen.has(file.path), 'duplicate baseline path');
    assert.match(file.gitBlob, /^[a-f0-9]{40}$/);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0);
    seen.add(file.path);
  }
  const output = execFileSync(systemTool('git'), ['--no-replace-objects', 'cat-file', '--batch'], {
    cwd: repository,
    input: manifest.files.map((file) => `${baselineCommit}:${file.path}\n`).join(''),
    maxBuffer: manifest.files.reduce((sum, file) => sum + file.bytes + 128, 1024),
    timeout: 15000,
  });
  let offset = 0;
  for (const file of manifest.files) {
    const end = output.indexOf(10, offset);
    assert.ok(end >= offset, `missing baseline Git object: ${file.path}`);
    assert.equal(
      output.subarray(offset, end).toString('ascii'),
      `${file.gitBlob} blob ${file.bytes}`,
      `baseline Git identity: ${file.path}; check out the immutable predecessor history`,
    );
    const start = end + 1;
    const bytes = output.subarray(start, start + file.bytes);
    assert.equal(bytes.length, file.bytes);
    assert.equal(output[start + file.bytes], 10);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
    assert.ok(
      bytes.equals(readFileSync(join(frozen, file.path))),
      `baseline archive differs from Git: ${file.path}`,
    );
    offset = start + file.bytes + 1;
  }
  assert.equal(offset, output.length, 'unexpected baseline Git objects');
  return { baselineCommit, gitObjectsVerified: manifest.files.length };
}

/** Permanent controls compare with actual Git; mutations occur only in a separate writable fixture. */
export function checkBaselineProvenanceGuards(repository, frozen, manifest, owned) {
  assert.equal(verifyBaselineProvenance(repository, frozen, manifest).gitObjectsVerified, 143);
  const results = [];
  for (const [label, change, message] of [
    [
      'forged-git-identity',
      (copy) => {
        copy.files[0].gitBlob = '0'.repeat(40);
      },
      /baseline Git identity/,
    ],
    [
      'forged-archive-hash',
      (copy) => {
        copy.files[0].sha256 = '0'.repeat(64);
      },
      /apps\/cli\/package.json/,
    ],
    [
      'missing-git-path',
      (copy) => {
        copy.files[0].path = 'not-in-the-predecessor';
      },
      /baseline Git identity/,
    ],
    [
      'git-input-newline',
      (copy) => {
        copy.files[0].path += '\nextra';
      },
      undefined,
    ],
    [
      'different-baseline',
      (copy) => {
        copy.baselineCommit = '0'.repeat(40);
      },
      undefined,
    ],
  ]) {
    const copy = globalThis.structuredClone(manifest);
    change(copy);
    assert.throws(() => verifyBaselineProvenance(repository, frozen, copy), message);
    results.push({ label, refusedBeforeWorker: true });
  }
  const copy = globalThis.structuredClone(manifest);
  const first = copy.files[0];
  const scratch = mkdtempSync(join(owned, 'baseline-provenance-fixture-'));
  for (const file of manifest.files) {
    const target = join(scratch, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(frozen, file.path)), { flag: 'wx', mode: 0o600 });
  }
  const path = join(scratch, first.path);
  const original = readFileSync(path);
  const changed = Buffer.from(original);
  changed[0] ^= 1;
  first.sha256 = createHash('sha256').update(changed).digest('hex');
  try {
    writeFileSync(path, changed);
    assert.throws(
      () => verifyBaselineProvenance(repository, scratch, copy),
      /apps\/cli\/package.json/,
    );
    results.push({
      label: 'archive-and-self-declared-hash-changed-together',
      refusedBeforeWorker: true,
    });
  } finally {
    writeFileSync(path, original);
  }
  assert.equal(verifyBaselineProvenance(repository, frozen, manifest).gitObjectsVerified, 143);
  results.push({ label: 'restored-actual-git-archive', gitObjectsVerified: 143 });
  writeFileSync(
    join(owned, 'baseline-provenance-guards.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );
}
