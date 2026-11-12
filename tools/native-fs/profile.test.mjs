/** Parser controls, not native-execution evidence. Actual CI owns the target executions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { NODE_LIFECYCLE_CASES, rustPopulation } from './profile-catalog.mjs';
import {
  parseRustListing,
  parseRustResults,
  validateProfileEvidence,
  profileCommandFailure,
  RUST_CHECKPOINTS,
} from './profile.mjs';
for (const platform of ['darwin', 'linux', 'win32']) {
  test(`native profile population refuses missing, duplicated, ignored or failed ${platform} cases`, () => {
    const population = rustPopulation(platform);
    const names = [...population.passed, ...population.ignored];
    const listing = names.map((name) => `${name}: test`).join('\n');
    assert.deepEqual(parseRustListing(listing, platform), population);
    assert.throws(() =>
      parseRustListing(
        names
          .slice(1)
          .map((name) => `${name}: test`)
          .join('\n'),
        platform,
      ),
    );
    assert.throws(() => parseRustListing(listing + `\n${names[0]}: test`, platform));
    const results = [
      ...population.passed.map((name) => `test ${name} ... ok`),
      ...population.ignored.map((name) => `test ${name} ... ignored, owned child fixture`),
    ].join('\n');
    assert.deepEqual(parseRustResults(results, platform), population);
    assert.throws(() => parseRustResults(results.replace(' ... ok', ' ... FAILED'), platform));
    assert.throws(() => parseRustResults(results.replace(' ... ok', ' ... ignored'), platform));
    assert.throws(() => parseRustResults(results + `\ntest ${names[0]} ... ok`, platform));
    const evidence = {
      version: 1,
      rustPassed: population.passed,
      rustIgnored: population.ignored,
      nodeCases: [...NODE_LIFECYCLE_CASES],
      requiresCreationMaskProbe: false,
    };
    validateProfileEvidence(evidence, platform);
    for (const mutate of [
      (value) => {
        delete value.requiresCreationMaskProbe;
      },
      (value) => {
        value.requiresCreationMaskProbe = 'false';
      },
      (value) => value.nodeCases.pop(),
      (value) => value.nodeCases.push(value.nodeCases[0]),
      (value) => value.rustPassed.pop(),
      (value) => value.rustIgnored.push('unreviewed ignored test'),
      (value) => {
        value.version = 2;
      },
    ]) {
      const value = JSON.parse(JSON.stringify(evidence));
      mutate(value);
      assert.throws(() => validateProfileEvidence(value, platform));
    }
  });
}

test('joined Rust parent completion is required even when owned subprocess fixture output interleaves', async () => {
  const { parseSingleRustResult } = await import('./profile.mjs');
  const text =
    'test parent::case ... \nrunning 1 test\ntest child::fixture ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 3 filtered out\nok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 23 filtered out\n';
  assert.equal(parseSingleRustResult(text, 'parent::case'), 'parent::case');
  assert.throws(() => parseSingleRustResult(text, 'other::case'));
  assert.throws(() =>
    parseSingleRustResult(
      text.replace('1 passed; 0 failed; 0 ignored; 23', '0 passed; 0 failed; 1 ignored; 23'),
      'parent::case',
    ),
  );
  assert.throws(() =>
    parseSingleRustResult(text + 'test result: FAILED. 0 passed; 1 failed\n', 'parent::case'),
  );
});

test('failed native commands expose only fixed case context, classifications and bounded Rust coordinates', () => {
  const name = rustPopulation('win32').passed[0];
  assert.equal(name, 'common::producer_crash_tests::native_producer_partial_crashes_recover');
  const error = profileCommandFailure(
    {
      status: 101,
      signal: null,
      stdout: `test ${name} ... FAILED\ntest arbitrary_private_case ... FAILED\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 10 filtered out\n`,
      stderr: `thread '${name}' panicked at C:\\private-account\\secret-workspace\\src\\common.rs:1490:17:\nnative phase did not arrive\nassertion \`left == right\` failed: arbitrary-private-message\nleft: private-value\nright: another-private-value`,
    },
    { phase: 'rust-case', case: name },
  );
  const diagnostic = JSON.parse(error.message.slice('NATIVE_FS_PROFILE_COMMAND '.length));
  assert.deepEqual(diagnostic, {
    version: 1,
    phase: 'rust-case',
    case: name,
    exit: 101,
    signal: 'none',
    error: 'none',
    locations: [{ file: 'common.rs', line: 1490, column: 17 }],
    summaries: [{ result: 'FAILED', passed: 0, failed: 1, ignored: 0 }],
    failures: [name],
    assertions: ['equal', 'native-phase-timeout'],
    checkpoints: 'unavailable',
  });
  for (const secret of [
    'private-account',
    'secret-workspace',
    'arbitrary_private_case',
    'private-message',
    'private-value',
  ])
    assert.equal(error.message.includes(secret), false);
});

test('spawn errors, signals and non-Rust phases use closed diagnostic fields without raw child output', () => {
  for (const phase of ['rust-list', 'rust-build', 'node-lifecycle']) {
    const error = profileCommandFailure(
      {
        status: null,
        signal: 'SIGTERM',
        error: { code: 'ETIMEDOUT', message: 'private path' },
        stdout: 'private stdout',
        stderr: 'private stderr',
      },
      { phase },
    );
    assert.deepEqual(JSON.parse(error.message.slice('NATIVE_FS_PROFILE_COMMAND '.length)), {
      version: 1,
      phase,
      exit: null,
      signal: 'SIGTERM',
      error: 'ETIMEDOUT',
    });
  }
  const unknown = profileCommandFailure(
    {
      status: 'private status',
      signal: 'private signal',
      error: { code: 'private code', message: 'private path' },
    },
    { phase: 'rust-build' },
  );
  assert.deepEqual(JSON.parse(unknown.message.slice('NATIVE_FS_PROFILE_COMMAND '.length)), {
    version: 1,
    phase: 'rust-build',
    exit: null,
    signal: 'other',
    error: 'other',
  });
  assert.throws(
    () => profileCommandFailure({}, { phase: 'private phase' }),
    /NATIVE_FS_PROFILE_CONTEXT/u,
  );
  assert.throws(
    () => profileCommandFailure({}, { phase: 'rust-case', case: 'private case' }),
    /NATIVE_FS_PROFILE_CONTEXT/u,
  );
  assert.throws(
    () => profileCommandFailure({}, { phase: 'rust-list', case: 'private case' }),
    /NATIVE_FS_PROFILE_CONTEXT/u,
  );
});

test('diagnostic evidence remains bounded under repeated or oversized child failures', () => {
  const name = rustPopulation('darwin').passed[0];
  const error = profileCommandFailure(
    {
      status: 101,
      signal: null,
      stdout: Array.from(
        { length: 20_000 },
        (_, index) =>
          `src/common.rs:${index + 1}:1\ntest ${name} ... FAILED\ntest result: FAILED. 0 passed; 1 failed; 0 ignored;\n`,
      ).join(''),
      stderr: 'private payload'.repeat(100_000),
    },
    { phase: 'rust-case', case: name },
  );
  const diagnostic = JSON.parse(error.message.slice('NATIVE_FS_PROFILE_COMMAND '.length));
  assert.equal(diagnostic.locations.length, 8);
  assert.equal(diagnostic.summaries.length, 4);
  assert.deepEqual(diagnostic.failures, [name]);
  assert.ok(error.message.length < 4096);
  assert.equal(error.message.includes('private payload'), false);
});

test('native child checkpoints match the source-owned Rust allowlist and redact unknown or malformed markers', () => {
  const source = readFileSync(
    new URL('../../apps/cli/native/fs-metadata/src/common.rs', import.meta.url),
    'utf8',
  );
  const definition = /const CHECKPOINTS: &\[&str\] = &\[([^\]]+)\];/u.exec(source)?.[1];
  assert.equal(typeof definition, 'string');
  assert.deepEqual(
    [...definition.matchAll(/"([a-z-]+)"/gu)].map((match) => match[1]),
    RUST_CHECKPOINTS,
  );
  const name = rustPopulation('win32').passed[0];
  const diagnose = (text) =>
    JSON.parse(
      profileCommandFailure(
        { status: 101, signal: null, stderr: text },
        { phase: 'rust-case', case: name },
      ).message.slice('NATIVE_FS_PROFILE_COMMAND '.length),
    );
  assert.deepEqual(
    diagnose('RELAVIUM_NATIVE_DIAGNOSTIC:child-parent-open,stage-recover,index-home-flush\n')
      .checkpoints,
    ['child-parent-open', 'stage-recover', 'index-home-flush'],
  );
  assert.deepEqual(diagnose('RELAVIUM_NATIVE_DIAGNOSTIC:\n').checkpoints, []);
  for (const text of [
    'RELAVIUM_NATIVE_DIAGNOSTIC:stage-recover,private-checkpoint\n',
    'RELAVIUM_NATIVE_DIAGNOSTIC:' + Array(17).fill('stage-recover').join(','),
    'RELAVIUM_NATIVE_DIAGNOSTIC:stage-recover\nRELAVIUM_NATIVE_DIAGNOSTIC:index-home-flush\n',
    'RELAVIUM_NATIVE_DIAGNOSTIC:' + 'private-value'.repeat(1000),
    'RELAVIUM_NATIVE_DIAGNOSTIC:stage-recover,\n',
  ]) {
    const result = diagnose(text);
    assert.equal(result.checkpoints, 'unavailable');
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});
