import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ReleaseGuardError, requireReleaseCandidate } from './release-guard-core.mjs';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-release-guard-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
const guard = fileURLToPath(new URL('./release-guard.mjs', import.meta.url));
let count = 0;

function artifact(files) {
  count += 1;
  const directory = join(scratch, `artifact-${count}`);
  mkdirSync(directory);
  for (const [name, contents] of Object.entries(files))
    writeFileSync(join(directory, name), contents);
  return directory;
}

/** Run the guard entry as the publish job does, from `cwd` with the given script path and arguments. */
function runGuard(script, args, cwd = scratch) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 10_000 });
}

const PACKAGE_TEST = {
  'relavium-0.1.1.tgz': 'tarball',
  'package-test-receipt.json': JSON.stringify({ mode: 'compiled_package_test' }),
};

for (const [label, files, code] of [
  ['a package-test artifact', PACKAGE_TEST, 'PACKAGE_TEST_ARTIFACT'],
  [
    'a package-test artifact whose receipt claims release mode',
    { ...PACKAGE_TEST, 'package-test-receipt.json': JSON.stringify({ mode: 'release' }) },
    'PACKAGE_TEST_ARTIFACT',
  ],
  ['a bare tarball', { 'relavium-0.1.1.tgz': 'tarball' }, 'RELEASE_CANDIDATE_REQUIRED'],
  ['an empty artifact', {}, 'RELEASE_CANDIDATE_REQUIRED'],
  [
    'a self-declared release candidate',
    {
      'relavium-0.1.1.tgz': 'tarball',
      'relavium-0.1.1.tgz.gpg': 'ciphertext',
      'release-binding-receipt.json': JSON.stringify({ mode: 'release' }),
    },
    'RELEASE_CUSTODY_UNAVAILABLE',
  ],
]) {
  test(`the interim publication guard refuses ${label}`, () => {
    const directory = artifact(files);
    assert.throws(
      () => requireReleaseCandidate(directory),
      (error) => error instanceof ReleaseGuardError && error.code === code,
    );
    const run = runGuard(guard, [directory]);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, `::error::CLI publication refused: ${code}\n`);
  });
}

test('the guard refuses an unreadable artifact and wrong usage with one fixed line', () => {
  const missing = join(scratch, 'absent');
  assert.throws(
    () => requireReleaseCandidate(missing),
    (error) => error instanceof ReleaseGuardError && error.code === 'ARTIFACT_UNREADABLE',
  );
  for (const args of [[], [scratch, scratch]]) {
    const run = runGuard(guard, args);
    assert.equal(run.status, 1);
    assert.equal(run.stderr, '::error::CLI publication refused: USAGE\n');
  }
});

test('the guard refuses however its entry point is reached', () => {
  const directory = artifact(PACKAGE_TEST);
  const expected = '::error::CLI publication refused: PACKAGE_TEST_ARTIFACT\n';
  // A symlinked checkout directory makes the entry's argv path differ from its loaded real path.
  const linked = join(scratch, 'linked-tools');
  symlinkSync(dirname(guard), linked, process.platform === 'win32' ? 'junction' : 'dir');
  // A relative, non-canonical path reaches the same file another way.
  const relativePath = relative(scratch, join(linked, '..', 'linked-tools', 'release-guard.mjs'));
  for (const script of [join(linked, 'release-guard.mjs'), relativePath]) {
    const run = runGuard(script, [directory]);
    assert.equal(run.status, 1, script);
    assert.equal(run.stderr, expected, script);
  }
});

test('the guard refuses when its rule cannot be loaded', () => {
  // The entry point alone, without the core module beside it, still exits 1 with a fixed line.
  const lonely = join(scratch, 'lonely');
  mkdirSync(lonely);
  copyFileSync(guard, join(lonely, 'release-guard.mjs'));
  const run = runGuard(join(lonely, 'release-guard.mjs'), [artifact(PACKAGE_TEST)]);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '::error::CLI publication refused: GUARD_FAILURE\n');
});
