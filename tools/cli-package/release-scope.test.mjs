import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMIT, TREE, fresh } from './candidate-fixture.mjs';
import { CONTAINER_LIMITS } from './container.mjs';
import { ciphertextName } from './custody.mjs';
import {
  CIPHERTEXT_BYTES,
  RELEASE_BINDING_FILE,
  ciphertextFileName,
  tarballName,
} from './release-binding.mjs';
import { ReleaseGuardError, requireReleaseCandidate } from './release-guard-core.mjs';
import { PRODUCTION_RECIPIENT_ROOT, SYNTHETIC_SOURCE } from './release-recipient.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const here = fileURLToPath(new URL('.', import.meta.url));
/** Tracked and new, unignored source files, as repository-relative POSIX paths. */
const tracked = spawnSync(
  'git',
  [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    '*.mjs',
    '*.cjs',
    '*.js',
    '*.ts',
    '*.tsx',
    '*.mts',
    '*.yml',
    '*.yaml',
  ],
  { cwd: repository, encoding: 'utf8' },
)
  .stdout.split('\0')
  .filter(Boolean);
/** Test, fixture and maintainer-only files: everything else is product or tooling code. */
const isTestOnly = (path) =>
  /\.test\.[cm]?[jt]sx?$/u.test(path) ||
  /-fixture\.mjs$/u.test(path) ||
  /(?:^|\/)(?:test|tests|__tests__|lint-fixtures)\//u.test(path) ||
  path.startsWith('tools/cli-package/custody-fixtures/');
const code = tracked.filter((path) => !isTestOnly(path));
const read = (path) => readFileSync(join(repository, path), 'utf8');
/** The code files whose text matches `pattern`. @param {RegExp} pattern */
const naming = (pattern) => code.filter((path) => pattern.test(read(path))).sort();

test('the scan sees the custody modules and leaves the tests out', () => {
  for (const path of [
    'tools/cli-package/custody.mjs',
    'tools/cli-package/release-custody.mjs',
    'tools/cli-package/release-guard-core.mjs',
    '.github/workflows/release.yml',
  ]) {
    assert.ok(code.includes(path), path);
  }
  for (const path of [
    'tools/cli-package/release-custody.test.mjs',
    'tools/cli-package/release-fixture.mjs',
    'tools/cli-package/custody-fixtures/generate.mjs',
  ]) {
    assert.ok(tracked.includes(path) && !code.includes(path), path);
  }
});

test('no product or tooling code reaches a test fixture, and only the loader reads the fixture pins', () => {
  assert.deepEqual(naming(/(?:candidate|gpg|release)-fixture\.mjs/u), []);
  assert.deepEqual(naming(/custody-fixtures/u), ['tools/cli-package/release-recipient.mjs']);
});

test('only the release gate imports encryptOnce', () => {
  assert.deepEqual(
    naming(/['"](?:\.\/|\.\.\/cli-package\/|tools\/cli-package\/)custody\.mjs['"]/u),
    ['tools/cli-package/release-custody.mjs'],
  );
});

test('no product path or workflow names a release module yet', () => {
  // Interim: Step 9d wires the release modules into the originating job and updates this control.
  assert.deepEqual(naming(/release-(?:custody|binding|recipient)\.mjs/u), [
    'tools/cli-package/release-binding.mjs',
    'tools/cli-package/release-custody.mjs',
  ]);
});

/** Every specifier a module's import closure reaches, relative files followed. @param {string} entry */
function closure(entry) {
  const seen = new Set();
  const specifiers = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(
      /^\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gmu,
    )) {
      const specifier = match[1] ?? match[2] ?? match[3];
      specifiers.add(specifier);
      if (specifier.startsWith('.')) visit(join(dirname(path), specifier));
    }
  };
  visit(join(here, entry));
  return {
    files: [...seen].map((path) => relative(here, path).split('\\').join('/')).sort(),
    specifiers: [...specifiers].sort(),
  };
}

test("the binding receipt's closure starts no process, so reuse makes no GnuPG call", () => {
  const { files, specifiers } = closure('release-binding.mjs');
  assert.deepEqual(files, [
    'archive.mjs',
    'custody-error.mjs',
    'files.mjs',
    'release-binding.mjs',
    'release-recipient.mjs',
    'ustar.mjs',
  ]);
  for (const forbidden of ['node:child_process', 'child_process', 'node:worker_threads']) {
    assert.equal(specifiers.includes(forbidden), false, forbidden);
  }
  // The scan reads the imports it claims to: the gate's closure reaches GnuPG.
  const gate = closure('release-custody.mjs');
  for (const reached of ['custody.mjs', 'gnupg.mjs', 'process.mjs', 'container.mjs']) {
    assert.ok(gate.files.includes(reached), reached);
  }
  assert.ok(gate.specifiers.includes('node:child_process'));
});

test('no production recipient is committed in Wave 3', () => {
  // Interim: Wave 4b commits the recipient directory and updates this control.
  assert.equal(existsSync(PRODUCTION_RECIPIENT_ROOT), false);
  const listed = spawnSync(
    'git',
    ['ls-files', '--', posix.join('tools/cli-package', 'release-recipient')],
    { cwd: repository, encoding: 'utf8' },
  );
  assert.equal(listed.status, 0);
  assert.equal(listed.stdout, '');
});

test('the interim release guard still refuses a complete synthetic candidate under the receipt name', () => {
  const directory = fresh('guarded-candidate');
  mkdirSync(directory);
  writeFileSync(join(directory, RELEASE_BINDING_FILE), '{}');
  writeFileSync(join(directory, tarballName('0.1.1')), 'tarball');
  writeFileSync(join(directory, ciphertextFileName('0.1.1')), 'ciphertext');
  assert.throws(
    () => requireReleaseCandidate(directory),
    (error) => error instanceof ReleaseGuardError && error.code === 'RELEASE_CUSTODY_UNAVAILABLE',
  );
});

test('the constants the release modules restate equal their sources', () => {
  for (const version of ['0.1.1', '1.2.3-rc.1', '2.0.0+build.5']) {
    assert.equal(ciphertextFileName(version), ciphertextName(version));
  }
  assert.equal(CIPHERTEXT_BYTES, CONTAINER_LIMITS.totalBytes + 64 * 1024);
  assert.deepEqual(SYNTHETIC_SOURCE, { commit: COMMIT, tree: TREE });
});
