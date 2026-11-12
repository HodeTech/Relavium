/** Joined native profile validation; exact populations and artifact bytes are independently pinned. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  NODE_LIFECYCLE_CASES,
  rustPopulation,
  WINDOWS_OWNER_CASE,
  WINDOWS_RENAME_PROBE_CASE,
  WINDOWS_RENAME_VARIANTS,
  WINDOWS_RENAME_STATUSES,
} from './profile-catalog.mjs';
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
/** Closed diagnostic records only. Even 68 successful observations do not certify publication. */
export function parseWindowsRenameProbe(text) {
  const refuse = () => {
    throw new Error('NATIVE_FS_WINDOWS_RENAME_PROBE');
  };
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 64 * 1024) refuse();
  const lines = text.split(/\r?\n/u);
  if (lines.some((line) => Buffer.byteLength(line, 'utf8') > 256)) refuse();
  const prefix = 'RELAVIUM_NATIVE_RENAME_PROBE';
  const records = new Map();
  for (const line of lines.filter((item) => item.includes(prefix))) {
    const matched = /^RELAVIUM_NATIVE_RENAME_PROBE:([a-z-]+):([a-z-]+)$/u.exec(line);
    if (
      matched === null ||
      !WINDOWS_RENAME_VARIANTS.includes(matched[1]) ||
      !WINDOWS_RENAME_STATUSES.includes(matched[2]) ||
      records.has(matched[1])
    )
      refuse();
    records.set(matched[1], matched[2]);
  }
  if (records.size !== WINDOWS_RENAME_VARIANTS.length) refuse();
  return WINDOWS_RENAME_VARIANTS.map((variant) => ({ variant, status: records.get(variant) }));
}
export function windowsRenameProbeDiagnostic(text) {
  return `NATIVE_FS_RENAME_PROBE ${JSON.stringify({ version: 1, measurementOnly: true, records: parseWindowsRenameProbe(text) })}\n`;
}
export function parseWindowsOwnerContext(text) {
  assert.ok(
    typeof text === 'string' && text.length <= 4 * 1024 * 1024,
    'NATIVE_FS_WINDOWS_OWNER_CONTEXT',
  );
  const lines = text
    .split(/\r?\n/u)
    .filter((line) => line.includes('RELAVIUM_NATIVE_OWNER_CONTEXT:'));
  assert.ok(lines.length === 1, 'NATIVE_FS_WINDOWS_OWNER_CONTEXT');
  const matched = /^RELAVIUM_NATIVE_OWNER_CONTEXT:(distinct|same)$/u.exec(lines[0]);
  assert.ok(matched !== null, 'NATIVE_FS_WINDOWS_OWNER_CONTEXT');
  return matched[1];
}
export function validateProfileEvidence(value, platform, { requireDistinctOwner = false } = {}) {
  const keys = (item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item).sort()
      : [];
  assert.deepEqual(keys(value), [
    ...(platform === 'win32' ? ['genuineOwnerContext'] : []),
    'nodeCases',
    'requiresCreationMaskProbe',
    'rustIgnored',
    'rustPassed',
    'version',
  ]);
  assert.equal(value.version, 1);
  if (platform === 'win32') {
    assert.ok(
      ['distinct', 'same'].includes(value.genuineOwnerContext),
      'NATIVE_FS_WINDOWS_OWNER_CONTEXT',
    );
    if (requireDistinctOwner)
      assert.equal(
        value.genuineOwnerContext,
        'distinct',
        'NATIVE_FS_WINDOWS_DISTINCT_OWNER_REQUIRED',
      );
  }
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
const PROFILE_PHASES = new Set(['rust-list', 'rust-build', 'rust-case', 'node-lifecycle']);
const PROFILE_CASES = new Set(
  ['darwin', 'linux', 'win32'].flatMap((platform) => {
    const population = rustPopulation(platform);
    return [...population.passed, ...population.ignored];
  }),
);
export function rustCaseArguments(name) {
  assert.ok(PROFILE_CASES.has(name), 'NATIVE_FS_PROFILE_CONTEXT');
  return [
    '--exact',
    name,
    '--test-threads=1',
    ...([WINDOWS_OWNER_CASE, WINDOWS_RENAME_PROBE_CASE].includes(name) ? ['--show-output'] : []),
  ];
}
export const RUST_CHECKPOINTS = Object.freeze([
  'case-new-payload',
  'case-existing-metadata',
  'case-existing-payload',
  'first-metadata-control-changed',
  'first-metadata-dacl-changed',
  'first-metadata-final-attribute-changed',
  'first-metadata-final-attribute-read',
  'first-metadata-final-bind',
  'first-metadata-final-context-changed',
  'first-metadata-final-credentials',
  'first-metadata-final-stream-changed',
  'first-metadata-final-stream-read',
  'first-metadata-group-changed',
  'first-metadata-owner-changed',
  'first-metadata-policy-readback',
  'first-metadata-security-set',
  'metadata-security-set',
  'rename-invalid-parameter',
  'rename-not-supported',
  'rename-invalid-name',
  'rename-not-same-device',
  'rename-privilege-not-held',
  'rename-access-denied',
  'rename-sharing-violation',
  'rename-lock-violation',
  'rename-source-missing',
  'rename-destination-exists',
  'rename-other',
  'first-metadata-context-changed',
  'first-metadata-credentials',
  'first-metadata-source-changed',
  'first-metadata-source-identity',
  'first-metadata-source-policy',
  'first-metadata-source-streams',
  'first-metadata-stage-bind',
  'first-metadata-stage-identity',
  'first-metadata-stage-streams',
  'first-metadata-stage-unexpected-stream',
  'first-metadata-zone-flush',
  'first-metadata-zone-identity',
  'first-metadata-zone-mismatch',
  'first-metadata-zone-open',
  'first-metadata-zone-write',
  'first-pin-context-after-remove',
  'first-pin-context-before-remove',
  'first-pin-final-flush',
  'first-pin-postflush-budget',
  'first-pin-postflush-recheck',
  'first-pin-rename',
  'first-pin-reservation-remove',
  'first-stream-no-data-header',
  'failure-access-denied',
  'failure-cancelled',
  'failure-changed',
  'failure-cleanup-uncertain',
  'failure-possibly-published',
  'failure-unsupported',
  'first-index-open',
  'first-lock-acquire',
  'first-lock-directory-flush',
  'first-lock-file-flush',
  'first-lock-open',
  'first-lock-recheck',
  'first-lock-verify',
  'first-metadata',
  'first-parent-recheck',
  'first-payload-flush',
  'first-payload-result',
  'first-payload-verify',
  'first-payload-write',
  'first-pin',
  'first-pin-directory',
  'first-pin-directory-flush',
  'first-pin-index',
  'first-pin-index-flush',
  'first-pin-owned-payload',
  'first-pin-parent-flush',
  'first-pin-payload-flush',
  'first-pin-record-create',
  'first-pin-record-flush',
  'first-pin-record-write',
  'first-pin-reservation',
  'first-recover',
  'first-reservation-create',
  'first-reservation-finish',
  'first-reserve',
  'first-reserve-entries',
  'first-reserve-lock',
  'first-setup',
  'first-source-recheck',
  'first-stage-directory',
  'first-stage-payload',
  'first-template',
  'first-unclassified',
  'child-parent-open',
  'child-parent-capture',
  'child-source-open',
  'child-source-capture',
  'child-stage-new',
  'child-stage-existing',
  'child-stage-error',
  'stage-recover',
  'stage-reserve',
  'index-parent-open',
  'index-home-flush',
  'index-directory-open',
  'index-parent-flush',
  'index-parent-flush-done',
  'index-first-recheck',
  'index-first-recheck-done',
  'recheck-home-path',
  'recheck-held-identities',
  'recheck-home-reopen',
  'recheck-parent-private',
  'recheck-index-private',
  'reserve-lock',
  'reserve-entries',
  'lock-create',
  'lock-file-flush',
  'lock-directory-flush',
  'lock-existing-open',
  'lock-private-verify',
  'lock-acquire',
  'lock-recheck',
  'private-policy-read',
  'private-expected-build',
  'private-owner-mismatch',
  'private-protection-mismatch',
  'private-dacl-mismatch',
  'private-file-parent-check',
  'private-file-open',
  'private-file-verify',
  'stage-directory-create',
  'stage-file-create',
  'stage-template-create',
  'stage-pin',
  'stage-metadata',
  'pin-record-flush',
  'pin-payload-flush',
  'pin-stage-flush',
  'pin-parent-flush',
  'pin-index-flush',
]);
function checkpoints(text) {
  const matches = [...text.matchAll(/^RELAVIUM_NATIVE_DIAGNOSTIC:([^\r\n]{0,1024})\r?$/gmu)];
  if (matches.length !== 1) return 'unavailable';
  const codes = matches[0][1] === '' ? [] : matches[0][1].split(',');
  return codes.length <= 16 && codes.every((code) => RUST_CHECKPOINTS.includes(code))
    ? codes
    : 'unavailable';
}
const SIGNALS = new Set([
  'SIGABRT',
  'SIGSEGV',
  'SIGBUS',
  'SIGILL',
  'SIGKILL',
  'SIGTERM',
  'SIGINT',
  'SIGTRAP',
  'SIGFPE',
  'SIGPIPE',
  'SIGXCPU',
  'SIGXFSZ',
  'SIGQUIT',
  'SIGBREAK',
]);
const SPAWN_ERRORS = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ETIMEDOUT',
  'ENOBUFS',
  'ENOMEM',
  'E2BIG',
  'EBADF',
]);
function numeric(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;
}
function boundedOutput(value) {
  if (typeof value !== 'string') return '';
  return value.length <= 64 * 1024
    ? value
    : value.slice(0, 32 * 1024) + '\n' + value.slice(-32 * 1024);
}
/** Only fixed context, counts and native source coordinates leave the failed owned test child. */
export function profileCommandFailure(result, context) {
  assert.ok(PROFILE_PHASES.has(context.phase), 'NATIVE_FS_PROFILE_CONTEXT');
  assert.ok(
    context.phase === 'rust-case' ? PROFILE_CASES.has(context.case) : context.case === undefined,
    'NATIVE_FS_PROFILE_CONTEXT',
  );
  const text = boundedOutput(result.stdout) + '\n' + boundedOutput(result.stderr);
  const locations = [];
  const seen = new Set();
  if (context.phase === 'rust-case') {
    for (const match of text.matchAll(
      /src[\\/](common|linux|windows|lib|stage_index|profile_api|macos|unix_template_guard)\.rs:(\d{1,6}):(\d{1,5})/gu,
    )) {
      const location = { file: `${match[1]}.rs`, line: Number(match[2]), column: Number(match[3]) };
      const key = JSON.stringify(location);
      if (!seen.has(key) && locations.length < 8) {
        seen.add(key);
        locations.push(location);
      }
    }
  }
  const summaries = [
    ...text.matchAll(
      /^test result: (ok|FAILED)\. (\d{1,4}) passed; (\d{1,4}) failed; (\d{1,4}) ignored;/gmu,
    ),
  ]
    .slice(-4)
    .map((match) => ({
      result: match[1],
      passed: Number(match[2]),
      failed: Number(match[3]),
      ignored: Number(match[4]),
    }));
  const failures = [];
  for (const match of text.matchAll(/^test ([a-zA-Z0-9_:]+) \.\.\. FAILED\r?$/gmu))
    if (PROFILE_CASES.has(match[1]) && !failures.includes(match[1]) && failures.length < 8)
      failures.push(match[1]);
  const assertions = [
    ['equal', 'assertion `left == right` failed'],
    ['not-equal', 'assertion `left != right` failed'],
    ['assertion', 'assertion failed:'],
    ['result-unwrap', 'called `Result::unwrap()` on an `Err` value'],
    ['option-unwrap', 'called `Option::unwrap()` on a `None` value'],
    ['native-phase-timeout', 'native phase did not arrive'],
  ]
    .filter(([, fixed]) => text.includes(fixed))
    .map(([kind]) => kind);
  const diagnostic = {
    version: 1,
    phase: context.phase,
    ...(context.case === undefined ? {} : { case: context.case }),
    exit: numeric(result.status),
    signal:
      result.signal === null || result.signal === undefined
        ? 'none'
        : SIGNALS.has(result.signal)
          ? result.signal
          : 'other',
    error:
      result.error === undefined
        ? 'none'
        : SPAWN_ERRORS.has(result.error.code)
          ? result.error.code
          : 'other',
    ...(context.phase === 'rust-case'
      ? {
          locations,
          summaries,
          failures,
          assertions,
          ...(context.case ===
          'common::producer_crash_tests::native_producer_partial_crashes_recover'
            ? { checkpoints: checkpoints(text) }
            : {}),
        }
      : {}),
  };
  return new Error(`NATIVE_FS_PROFILE_COMMAND ${JSON.stringify(diagnostic)}`);
}
function command(program, args, options, context) {
  const result = spawnSync(program, args, {
    ...options,
    shell: false,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0)
    throw profileCommandFailure(result, context);
  return result.stdout;
}
export function validateNativeProfile({ repository, native, target, bytes, environment }) {
  const args = [`+${NATIVE_TOOLCHAIN}`, 'test', '--release', '--locked', '--target', target];
  parseRustListing(
    command(
      'cargo',
      [...args, '--', '--list'],
      { cwd: native, env: environment },
      { phase: 'rust-list' },
    ),
    process.platform,
  );
  const build = command(
    'cargo',
    [...args, '--no-run', '--message-format=json'],
    {
      cwd: native,
      env: environment,
    },
    { phase: 'rust-build' },
  );
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
  let genuineOwnerContext;
  for (const name of rust.passed) {
    const text = command(
      executable,
      rustCaseArguments(name),
      { cwd: native, env: environment },
      { phase: 'rust-case', case: name },
    );
    parseSingleRustResult(text, name);
    if (name === WINDOWS_RENAME_PROBE_CASE)
      process.stderr.write(windowsRenameProbeDiagnostic(text));
    if (name === WINDOWS_OWNER_CASE) genuineOwnerContext = parseWindowsOwnerContext(text);
  }
  const directory = mkdtempSync(join(tmpdir(), 'relavium-native-profile-'));
  let lifecycle;
  try {
    const binary = join(directory, 'metadata.node');
    writeFileSync(binary, bytes, { flag: 'wx', mode: 0o600 });
    const text = command(
      process.execPath,
      [join(repository, 'tools/native-fs/lifecycle.mjs'), binary],
      { cwd: repository, env: environment },
      { phase: 'node-lifecycle' },
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
      ...(process.platform === 'win32' ? { genuineOwnerContext } : {}),
    },
    process.platform,
  );
}
