import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMIT, TREE, fresh } from './candidate-fixture.mjs';
import { CONTAINER_LIMITS } from './container.mjs';
import { ciphertextName } from './custody.mjs';
import { sha256 } from './files.mjs';
import {
  CIPHERTEXT_BYTES,
  RELEASE_BINDING_FILE,
  ciphertextFileName,
  serializeReleaseBinding,
  tarballName,
  validateReleaseBinding,
  verifyRetainedCandidate,
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

/**
 * Whether `text`, a file at repository-relative `path`, names repository-relative `target` by any quoted
 * specifier that resolves to it: relative to the file, or to the repository root for a workflow (whose
 * steps run there) and for a `tools/` specifier; a query suffix is ignored.
 * @param {string} path @param {string} text @param {string} target
 */
function resolvesTo(path, text, target) {
  const name = posix.basename(target).replaceAll('.', '\\.');
  const literal = new RegExp(`['"\`]([^'"\`\\s]*(?:^|/)${name})(?:\\?[^'"\`\\s]*)?['"\`]`, 'gu');
  const root = /\.ya?ml$/u.test(path) ? '.' : posix.dirname(path);
  for (const match of text.matchAll(literal)) {
    const specifier = match[1];
    const base = specifier.startsWith('tools/') ? '.' : root;
    const resolved = posix.normalize(posix.join(base, specifier));
    if (resolved === target) return true;
  }
  return false;
}

test('the import match resolves every spelling, and only the real target', () => {
  const target = 'tools/cli-package/custody.mjs';
  for (const [path, text] of [
    ['tools/cli-package/smoke/x.mjs', "import { encryptOnce } from '../custody.mjs';"],
    ['tools/x.mjs', "import { encryptOnce } from './cli-package/custody.mjs';"],
    ['tools/ci/x/y.mjs', 'const m = await import("../../cli-package/custody.mjs?v=1");'],
    ['.github/workflows/x.yml', 'run: node -e "import(\'./tools/cli-package/custody.mjs\')"'],
    ['apps/cli/x.ts', "export * as custody from '../../tools/cli-package/custody.mjs';"],
    ['tools/cli-package/x.mjs', 'require(`./custody.mjs`)'],
  ]) {
    assert.equal(resolvesTo(path, text, target), true, `${path}: ${text}`);
  }
  for (const [path, text] of [
    ['tools/cli-package/x.mjs', "import { refuseCustody } from './custody-error.mjs';"],
    ['tools/cli-package/x.mjs', "import { encryptCandidate } from './release-custody.mjs';"],
    ['tools/x.mjs', "import { x } from './custody.mjs';"],
    ['tools/cli-package/x.mjs', '// encryptOnce lives in custody.mjs'],
  ]) {
    assert.equal(resolvesTo(path, text, target), false, `${path}: ${text}`);
  }
});

test('only the release gate imports encryptOnce, by any spelling', () => {
  const target = 'tools/cli-package/custody.mjs';
  assert.deepEqual(code.filter((path) => resolvesTo(path, read(path), target)).sort(), [
    'tools/cli-package/release-custody.mjs',
  ]);
});

test('the loader takes no argument, and no product or tooling code reaches its test seam', () => {
  // Permanent: these controls stay when Step 9d updates the interim one below.
  assert.deepEqual(naming(/\bloadRecipientForTests\b/u), [
    'tools/cli-package/release-recipient.mjs',
  ]);
  assert.deepEqual(naming(/\bloadProductionRecipient\s*\(\s*[^)\s]/u), []);
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
      /^\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|^\s*export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gmu,
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
  for (const forbidden of ['child_process', 'worker_threads', 'cluster', 'module']) {
    assert.equal(specifiers.includes(forbidden), false, forbidden);
    assert.equal(specifiers.includes(`node:${forbidden}`), false, forbidden);
  }
  // Nor can a closure file reach a process without importing one.
  for (const file of files) {
    const source = readFileSync(join(here, file), 'utf8');
    assert.doesNotMatch(
      source,
      /\b(?:getBuiltinModule|createRequire|process\.binding|process\.dlopen)\b|\brequire\s*\(/u,
      file,
    );
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

test('the interim release guard still refuses a complete, valid synthetic candidate', () => {
  const directory = fresh('guarded-candidate');
  mkdirSync(directory);
  const tarball = Buffer.from('a synthetic tarball, never a package\n');
  const ciphertext = Buffer.from('synthetic ciphertext bytes');
  const pins = { primary: '4'.repeat(40), subkey: '5'.repeat(40) };
  const expected = { scope: 'synthetic', pins, packageVersion: '0.1.1' };
  const receipt = validateReleaseBinding(
    {
      version: 1,
      kind: 'release_binding',
      packageVersion: '0.1.1',
      source: { ...SYNTHETIC_SOURCE, dirty: true },
      tarball: { name: tarballName('0.1.1'), bytes: tarball.length, sha256: sha256(tarball) },
      ciphertext: {
        name: ciphertextFileName('0.1.1'),
        bytes: ciphertext.length,
        sha256: sha256(ciphertext),
      },
      recipient: pins,
      toolchain: {
        node: 'v22.23.1',
        pnpm: '9.12.3',
        typescript: '5.6.3',
        tsup: '8.3.5',
        esbuild: '0.24.0',
        gnupg: '2.5.21',
      },
      target: 'node22',
      inputs: { 'package.json': 'a'.repeat(64) },
      mapCheck: { status: 'complete' },
      origin: {
        kind: 'github',
        repository: 'example/relavium',
        workflow: 'release',
        runId: '1',
        runAttempt: '1',
        event: 'push',
        source: SYNTHETIC_SOURCE.commit,
      },
    },
    expected,
  );
  writeFileSync(join(directory, RELEASE_BINDING_FILE), serializeReleaseBinding(receipt));
  writeFileSync(join(directory, tarballName('0.1.1')), tarball);
  writeFileSync(join(directory, ciphertextFileName('0.1.1')), ciphertext);
  // The candidate is complete and reusable as it stands, and the guard still refuses it.
  verifyRetainedCandidate({ directory, expected });
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
