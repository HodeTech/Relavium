/** Joined native profile validation; exact populations and artifact bytes are independently pinned. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { NODE_LIFECYCLE_CASES, rustPopulation } from './profile-catalog.mjs';
import { NATIVE_TOOLCHAIN } from './catalog.mjs';
export function parseRustListing(text, platform) {
  const names = [...text.matchAll(/^([a-zA-Z0-9_:]+): test\r?$/gmu)]
    .map((match) => match[1])
    .sort();
  const expected = rustPopulation(platform);
  assert.deepEqual(
    names,
    [...expected.passed, ...expected.ignored].sort(),
    'NATIVE_FS_RUST_POPULATION',
  );
  return expected;
}
export function parseRustResults(text, platform) {
  const expected = rustPopulation(platform);
  const passed = [...text.matchAll(/^test ([a-zA-Z0-9_:]+) \.\.\. ok\r?$/gmu)]
    .map((match) => match[1])
    .sort();
  const ignored = [...text.matchAll(/^test ([a-zA-Z0-9_:]+) \.\.\. ignored(?:, [^\r\n]*)?\r?$/gmu)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(passed, expected.passed, 'NATIVE_FS_RUST_PASSED_POPULATION');
  assert.deepEqual(ignored, expected.ignored, 'NATIVE_FS_RUST_IGNORED_POPULATION');
  assert.ok(!/^test .* \.\.\. (?:FAILED|failed|filtered)/mu.test(text), 'NATIVE_FS_RUST_FAILURE');
  return { passed, ignored };
}
export function validateProfileEvidence(value, platform) {
  const keys = (item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item).sort()
      : [];
  assert.deepEqual(keys(value), [
    'nodeCases',
    'requiresCreationMaskProbe',
    'rustIgnored',
    'rustPassed',
    'version',
  ]);
  assert.equal(value.version, 1);
  assert.equal(typeof value.requiresCreationMaskProbe, 'boolean');
  if (platform !== 'darwin') assert.equal(value.requiresCreationMaskProbe, false);
  const expected = rustPopulation(platform);
  assert.deepEqual(value.rustPassed, expected.passed, 'NATIVE_FS_PROFILE_RUST_POPULATION');
  assert.deepEqual(value.rustIgnored, expected.ignored, 'NATIVE_FS_PROFILE_IGNORED_POPULATION');
  assert.deepEqual(value.nodeCases, NODE_LIFECYCLE_CASES, 'NATIVE_FS_PROFILE_NODE_POPULATION');
  return value;
}
export function parseSingleRustResult(text, name) {
  assert.ok(text.includes(`test ${name} ... `), 'NATIVE_FS_RUST_SELECTED_TEST');
  const summaries = [
    ...text.matchAll(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;.*$/gmu),
  ];
  const last = summaries.at(-1);
  assert.ok(
    last !== undefined && last[1] === '1' && last[2] === '0' && last[3] === '0',
    'NATIVE_FS_RUST_SINGLE_COMPLETION',
  );
  assert.ok(!/^test result: FAILED/mu.test(text), 'NATIVE_FS_RUST_FAILURE');
  return name;
}
function command(program, args, options) {
  const result = spawnSync(program, args, {
    ...options,
    shell: false,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0)
    throw new Error('NATIVE_FS_PROFILE_COMMAND');
  return result.stdout;
}
export function validateNativeProfile({ repository, native, target, bytes, environment }) {
  const args = [`+${NATIVE_TOOLCHAIN}`, 'test', '--release', '--locked', '--target', target];
  parseRustListing(
    command('cargo', [...args, '--', '--list'], { cwd: native, env: environment }),
    process.platform,
  );
  const build = command('cargo', [...args, '--no-run', '--message-format=json'], {
    cwd: native,
    env: environment,
  });
  const artifacts = build
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(
      (entry) =>
        entry.reason === 'compiler-artifact' &&
        entry.target?.name === 'relavium_fs_metadata' &&
        entry.profile?.test === true &&
        typeof entry.executable === 'string',
    );
  assert.equal(artifacts.length, 1, 'NATIVE_FS_RUST_TEST_EXECUTABLE');
  const executable = artifacts[0].executable;
  const tail = relative(join(native, 'target', target, 'release', 'deps'), executable);
  assert.ok(
    isAbsolute(executable) && /^relavium_fs_metadata-[0-9a-f]+(?:\.exe)?$/u.test(tail),
    'NATIVE_FS_RUST_TEST_EXECUTABLE',
  );
  const rust = rustPopulation(process.platform);
  for (const name of rust.passed)
    parseSingleRustResult(
      command(executable, ['--exact', name, '--test-threads=1'], { cwd: native, env: environment }),
      name,
    );
  const directory = mkdtempSync(join(tmpdir(), 'relavium-native-profile-'));
  let lifecycle;
  try {
    const binary = join(directory, 'metadata.node');
    writeFileSync(binary, bytes, { flag: 'wx', mode: 0o600 });
    const text = command(
      process.execPath,
      [join(repository, 'tools/native-fs/lifecycle.mjs'), binary],
      { cwd: repository, env: environment },
    );
    lifecycle = JSON.parse(text);
    assert.deepEqual(Object.keys(lifecycle).sort(), [
      'cases',
      'requiresCreationMaskProbe',
      'version',
    ]);
    assert.equal(lifecycle.version, 1);
    assert.ok(
      isDeepStrictEqual(lifecycle.cases, NODE_LIFECYCLE_CASES),
      'NATIVE_FS_NODE_LIFECYCLE_POPULATION',
    );
    assert.deepEqual(readFileSync(binary), bytes, 'NATIVE_FS_PROFILE_BINARY_CHANGED');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return validateProfileEvidence(
    {
      version: 1,
      rustPassed: rust.passed,
      rustIgnored: rust.ignored,
      nodeCases: lifecycle.cases,
      requiresCreationMaskProbe: lifecycle.requiresCreationMaskProbe,
    },
    process.platform,
  );
}
