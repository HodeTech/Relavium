/** Parser controls, not native-execution evidence. Actual CI owns the target executions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  NODE_LIFECYCLE_CASES,
  rustPopulation,
  WINDOWS_OWNER_CASE,
  WINDOWS_RENAME_PROBE_CASE,
  WINDOWS_RENAME_VARIANTS,
  WINDOWS_RENAME_STATUSES,
  WINDOWS_SECURITY_PROBE_CASE,
  WINDOWS_SECURITY_VARIANTS,
  WINDOWS_SECURITY_STATUSES,
} from './profile-catalog.mjs';
import {
  parseSingleRustResult,
  parseRustListing,
  parseRustResults,
  validateProfileEvidence,
  profileCommandFailure,
  RUST_CHECKPOINTS,
  parseWindowsOwnerContext,
  parseWindowsRenameProbe,
  parseWindowsSecurityProbe,
  windowsSecurityProbeDiagnostic,
  windowsRenameProbeDiagnostic,
  rustCaseArguments,
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
      ...(platform === 'win32' ? { genuineOwnerContext: 'distinct' } : {}),
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
  const name = 'common::producer_crash_tests::native_producer_partial_crashes_recover';
  assert.ok(rustPopulation('win32').passed.includes(name));
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
      ...(phase === 'node-lifecycle' ? { lifecycleStage: 'unavailable' } : {}),
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

test('node lifecycle substage is fixed, phase-scoped and rejects poisoned evidence', () => {
  const prefix = 'NATIVE_FS_LIFECYCLE_STAGE:';
  for (const stage of [
    'addon-load',
    'hardlink-create',
    'hardlink-child',
    'hardlink-cleanup',
    ...NODE_LIFECYCLE_CASES,
  ]) {
    const result = { status: 1, stderr: `${prefix}${stage}\nprivate/path` };
    const failure = profileCommandFailure(result, { phase: 'node-lifecycle' });
    assert.equal(
      JSON.parse(failure.message.slice('NATIVE_FS_PROFILE_COMMAND '.length)).lifecycleStage,
      stage,
    );
    assert.equal(failure.message.includes('private/path'), false);
    const other = profileCommandFailure(result, { phase: 'rust-list' });
    assert.equal(
      'lifecycleStage' in JSON.parse(other.message.slice('NATIVE_FS_PROFILE_COMMAND '.length)),
      false,
    );
  }
  for (const stderr of [
    `${prefix}private/path\n`,
    `${prefix}hardlink-child-extra\n`,
    `${prefix}hardlink-create\n${prefix}hardlink-child\n`,
    `${prefix}${'secret'.repeat(20000)}`,
    `${prefix}hardlink-create\n${'x'.repeat(40000)}\n${prefix}hardlink-child\n${'x'.repeat(40000)}`,
    `${'x'.repeat(32768 - `${prefix}hardlink-child`.length - 1)}\n${prefix}hardlink-child-invalid${'x'.repeat(65536)}`,
    `${prefix}hardlink-child\n${'é'.repeat(40000)}`,
  ]) {
    const failure = profileCommandFailure({ status: 1, stderr }, { phase: 'node-lifecycle' });
    assert.equal(
      JSON.parse(failure.message.slice('NATIVE_FS_PROFILE_COMMAND '.length)).lifecycleStage,
      'unavailable',
    );
    assert.ok(failure.message.length < 1024);
    assert.equal(failure.message.includes('private/path'), false);
  }
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
  const name = 'common::producer_crash_tests::native_producer_partial_crashes_recover';
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
  for (const code of RUST_CHECKPOINTS)
    assert.deepEqual(diagnose(`RELAVIUM_NATIVE_DIAGNOSTIC:${code}\n`).checkpoints, [code]);
  assert.deepEqual(
    diagnose('RELAVIUM_NATIVE_DIAGNOSTIC:first-setup,failure-changed,child-stage-error\n')
      .checkpoints,
    ['first-setup', 'failure-changed', 'child-stage-error'],
  );
  assert.deepEqual(diagnose('RELAVIUM_NATIVE_DIAGNOSTIC:\n').checkpoints, []);
  for (const text of [
    'RELAVIUM_NATIVE_DIAGNOSTIC:stage-recover,private-checkpoint\n',
    'RELAVIUM_NATIVE_DIAGNOSTIC:first-metadata-control-changed\n',
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

test('Windows owner marker has exactly one closed value without exposing private payloads', () => {
  for (const value of ['same', 'distinct']) {
    assert.equal(parseWindowsOwnerContext(`RELAVIUM_NATIVE_OWNER_CONTEXT:${value}\n`), value);
    assert.equal(
      parseWindowsOwnerContext(`successes:\r\nRELAVIUM_NATIVE_OWNER_CONTEXT:${value}\r\n`),
      value,
    );
  }
  for (const text of [
    '',
    'RELAVIUM_NATIVE_OWNER_CONTEXT:',
    'RELAVIUM_NATIVE_OWNER_CONTEXT:private-SID',
    'RELAVIUM_NATIVE_OWNER_CONTEXT:distinct trailing-private-payload',
    'prefix RELAVIUM_NATIVE_OWNER_CONTEXT:distinct',
    'RELAVIUM_NATIVE_OWNER_CONTEXT:distinct\nRELAVIUM_NATIVE_OWNER_CONTEXT:distinct\n',
    'RELAVIUM_NATIVE_OWNER_CONTEXT:same\nRELAVIUM_NATIVE_OWNER_CONTEXT:private-SID\n',
  ]) {
    assert.throws(
      () => parseWindowsOwnerContext(text),
      (error) =>
        error.message === 'NATIVE_FS_WINDOWS_OWNER_CONTEXT' && !String(error).includes('private'),
    );
  }
});

test('Windows local same-owner evidence is truthful but cannot certify distinct-owner CI or complete delivery', () => {
  const population = rustPopulation('win32');
  const value = {
    version: 1,
    rustPassed: population.passed,
    rustIgnored: population.ignored,
    nodeCases: [...NODE_LIFECYCLE_CASES],
    requiresCreationMaskProbe: false,
    genuineOwnerContext: 'same',
  };
  assert.equal(validateProfileEvidence(value, 'win32').genuineOwnerContext, 'same');
  assert.throws(
    () => validateProfileEvidence(value, 'win32', { requireDistinctOwner: true }),
    /NATIVE_FS_WINDOWS_DISTINCT_OWNER_REQUIRED/u,
  );
  validateProfileEvidence({ ...value, genuineOwnerContext: 'distinct' }, 'win32', {
    requireDistinctOwner: true,
  });
  for (const change of [undefined, null, true, 'DISTINCT', 'distinct private']) {
    const altered = { ...value, genuineOwnerContext: change };
    if (change === undefined) delete altered.genuineOwnerContext;
    assert.throws(() => validateProfileEvidence(altered, 'win32'));
  }
  const mac = rustPopulation('darwin');
  assert.throws(() =>
    validateProfileEvidence(
      { ...value, rustPassed: mac.passed, rustIgnored: mac.ignored },
      'darwin',
    ),
  );
});

const probeRecords = (status = 'invalid-parameter') =>
  WINDOWS_RENAME_VARIANTS.map((variant) => `RELAVIUM_NATIVE_RENAME_PROBE:${variant}:${status}`);

test('Windows measurement case runs first while all production parents and eleven Node cases remain mandatory', () => {
  const windows = rustPopulation('win32');
  assert.equal(windows.passed[0], WINDOWS_RENAME_PROBE_CASE);
  assert.equal(windows.passed.length, 20);
  assert.equal(windows.ignored.length, 1);
  assert.equal(
    windows.passed.filter(
      (name) => ![WINDOWS_RENAME_PROBE_CASE, WINDOWS_SECURITY_PROBE_CASE].includes(name),
    ).length,
    18,
  );
  assert.ok(
    windows.passed.includes(
      'common::producer_crash_tests::native_producer_partial_crashes_recover',
    ),
  );
  assert.ok(windows.passed.includes(WINDOWS_OWNER_CASE));
  for (const [platform, count, ignored] of [
    ['darwin', 35, 3],
    ['linux', 15, 2],
  ]) {
    const population = rustPopulation(platform);
    assert.equal(population.passed.length, count);
    assert.equal(population.ignored.length, ignored);
    assert.equal(population.passed.includes(WINDOWS_RENAME_PROBE_CASE), false);
  }
  assert.equal(NODE_LIFECYCLE_CASES.length, 11);
  const oldPopulation = windows.passed.filter((name) => name !== WINDOWS_RENAME_PROBE_CASE);
  assert.throws(() =>
    parseRustListing(
      [...oldPopulation, ...windows.ignored].map((name) => `${name}: test`).join('\n'),
      'win32',
    ),
  );
  // A successful measurement never excuses a missing production result or grants a new receipt field.
  assert.throws(() => parseRustResults(`test ${WINDOWS_RENAME_PROBE_CASE} ... ok\n`, 'win32'));
  const evidence = {
    version: 1,
    rustPassed: windows.passed,
    rustIgnored: windows.ignored,
    nodeCases: [...NODE_LIFECYCLE_CASES],
    requiresCreationMaskProbe: false,
    genuineOwnerContext: 'distinct',
  };
  assert.throws(() =>
    validateProfileEvidence(
      {
        ...evidence,
        rustPassed: windows.passed.filter(
          (name) =>
            name !== 'common::producer_crash_tests::native_producer_partial_crashes_recover',
        ),
      },
      'win32',
    ),
  );
  assert.throws(() =>
    validateProfileEvidence({ ...evidence, nodeCases: evidence.nodeCases.slice(1) }, 'win32'),
  );
  assert.throws(() => validateProfileEvidence({ ...evidence, renameProbe: 'ok' }, 'win32'));
});

test('only the Windows diagnostic measurements and owner observation collect captured successful output', () => {
  for (const platform of ['darwin', 'linux', 'win32'])
    for (const name of rustPopulation(platform).passed) {
      assert.deepEqual(rustCaseArguments(name), [
        '--exact',
        name,
        '--test-threads=1',
        ...([WINDOWS_RENAME_PROBE_CASE, WINDOWS_SECURITY_PROBE_CASE, WINDOWS_OWNER_CASE].includes(
          name,
        )
          ? ['--show-output']
          : []),
      ]);
    }
  assert.throws(() => rustCaseArguments('unreviewed::private'), /NATIVE_FS_PROFILE_CONTEXT/u);
});

test('the Windows rename measurement has exactly the complete 68-variant inventory while preserving the prior 60 rows', () => {
  const independent = [];
  for (const api of ['legacy', 'ex'])
    for (const length of ['minimal', 'nul', 'padded'])
      for (const name of ['relative', 'absolute'])
        for (const location of ['same', 'cross'])
          for (const operation of ['new', 'replace'])
            independent.push([api, length, name, location, operation].join('-'));
  assert.equal(independent.length, 48);
  assert.deepEqual(WINDOWS_RENAME_VARIANTS.slice(0, 48), independent);
  const nt = [];
  for (const length of ['minimal', 'nul', 'padded'])
    for (const location of ['same', 'cross'])
      for (const operation of ['new', 'replace'])
        nt.push(['nt', length, 'relative', location, operation].join('-'));
  assert.equal(nt.length, 12);
  assert.deepEqual(WINDOWS_RENAME_VARIANTS.slice(48, 60), nt);
  const peers = [];
  for (const rights of ['rw', 'thin'])
    for (const location of ['same', 'cross'])
      for (const operation of ['new', 'replace'])
        peers.push(['nt', 'padded', 'peer', rights, location, operation].join('-'));
  assert.equal(peers.length, 8);
  assert.deepEqual(WINDOWS_RENAME_VARIANTS.slice(60), peers);
  assert.equal(new Set(WINDOWS_RENAME_VARIANTS).size, 68);
  assert.throws(
    () => parseWindowsRenameProbe(probeRecords().slice(0, 60).join('\n')),
    (error) => error.message === 'NATIVE_FS_WINDOWS_RENAME_PROBE',
  );
  assert.throws(
    () => parseWindowsRenameProbe(probeRecords().slice(0, 48).join('\n')),
    (error) => error.message === 'NATIVE_FS_WINDOWS_RENAME_PROBE',
  );
  for (const status of WINDOWS_RENAME_STATUSES) {
    const records = parseWindowsRenameProbe(
      'successes:\r\n' + probeRecords(status).reverse().join('\r\n') + '\r\n',
    );
    assert.deepEqual(
      records,
      WINDOWS_RENAME_VARIANTS.map((variant) => ({ variant, status })),
    );
  }
  // All refusals, including mutation, remain measurements; they are not publication acceptance.
  const line = windowsRenameProbeDiagnostic(probeRecords('invalid-parameter').join('\n'));
  assert.ok(line.startsWith('NATIVE_FS_RENAME_PROBE '));
  assert.equal(line.split('\n').length, 2);
  const summary = JSON.parse(line.slice('NATIVE_FS_RENAME_PROBE '.length));
  assert.deepEqual(summary, {
    version: 1,
    measurementOnly: true,
    records: WINDOWS_RENAME_VARIANTS.map((variant) => ({ variant, status: 'invalid-parameter' })),
  });
  assert.ok(
    windowsRenameProbeDiagnostic(probeRecords('privilege-not-held').join('\n')).length < 8192,
  );
});

test('Windows rename measurement refuses missing, duplicate, unknown, malformed or private records without dumping them', () => {
  const valid = probeRecords();
  for (const lines of [
    [],
    valid.slice(1),
    [...valid, valid[0]],
    ['RELAVIUM_NATIVE_RENAME_PROBE:private-variant:ok', ...valid.slice(1)],
    ['RELAVIUM_NATIVE_RENAME_PROBE:nt-minimal-absolute-same-new:ok', ...valid.slice(1)],
    ['RELAVIUM_NATIVE_RENAME_PROBE:nt-minimal-peer-rw-same-new:ok', ...valid.slice(1)],
    ['RELAVIUM_NATIVE_RENAME_PROBE:nt-padded-peer-private-same-new:ok', ...valid.slice(1)],
    [...valid.slice(0, 60), ...valid.slice(61)],
    [...valid, valid[60]],
    [...valid.slice(0, 48), ...valid.slice(49)],
    [...valid, valid[48]],
    [valid[0].replace('invalid-parameter', 'private-status'), ...valid.slice(1)],
    [valid[0] + ':private-payload', ...valid.slice(1)],
    ['prefix ' + valid[0], ...valid.slice(1)],
    [valid[0].replace('RENAME_PROBE:', 'RENAME_PROBE'), ...valid.slice(1)],
    [...valid, 'RELAVIUM_NATIVE_RENAME_PROBE private-payload'],
    [...valid, 'RELAVIUM_NATIVE_RENAME_PROBE:private-path:123'],
  ]) {
    assert.throws(
      () => parseWindowsRenameProbe(lines.join('\n')),
      (error) => error.message === 'NATIVE_FS_WINDOWS_RENAME_PROBE',
    );
    assert.throws(
      () => windowsRenameProbeDiagnostic(lines.join('\n')),
      (error) => error.message === 'NATIVE_FS_WINDOWS_RENAME_PROBE',
    );
  }
  for (const input of [
    null,
    undefined,
    {},
    'x'.repeat(257) + '\n' + valid.join('\n'),
    '\n'.repeat(65537),
    valid.join('\n').replace('invalid-parameter', 'private-秘密'),
  ])
    assert.throws(
      () => parseWindowsRenameProbe(input),
      (error) => error.message === 'NATIVE_FS_WINDOWS_RENAME_PROBE',
    );
});

test('unexpected initial pending is a closed measurement only and cannot replace proven Rust completion', () => {
  assert.ok(WINDOWS_RENAME_STATUSES.includes('pending'));
  const pending = probeRecords('pending').join('\n');
  assert.deepEqual(
    parseWindowsRenameProbe(pending),
    WINDOWS_RENAME_VARIANTS.map((variant) => ({ variant, status: 'pending' })),
  );
  const summary = JSON.parse(
    windowsRenameProbeDiagnostic(pending).slice('NATIVE_FS_RENAME_PROBE '.length),
  );
  assert.equal(summary.measurementOnly, true);
  const incomplete =
    `test ${WINDOWS_RENAME_PROBE_CASE} ... ignored\n` +
    pending +
    '\ntest result: ok. 0 passed; 0 failed; 1 ignored; 18 filtered out\n';
  assert.throws(
    () => parseSingleRustResult(incomplete, WINDOWS_RENAME_PROBE_CASE),
    /NATIVE_FS_RUST_SINGLE_COMPLETION/u,
  );
});

const securityRecords = (status = 'error') =>
  WINDOWS_SECURITY_VARIANTS.map((variant) => `RELAVIUM_NATIVE_SECURITY_PROBE:${variant}:${status}`);

test('Windows descriptor probe preserves all prior nineteen parents and remains a measurement before ordinary work', () => {
  const windows = rustPopulation('win32');
  assert.equal(windows.passed.length, 20);
  assert.equal(windows.ignored.length, 1);
  assert.equal(windows.passed[0], WINDOWS_RENAME_PROBE_CASE);
  assert.equal(windows.passed[1], WINDOWS_SECURITY_PROBE_CASE);
  assert.equal(windows.passed.filter((name) => name !== WINDOWS_SECURITY_PROBE_CASE).length, 19);
  assert.ok(
    windows.passed.indexOf(
      'common::producer_crash_tests::native_producer_partial_crashes_recover',
    ) > 1,
  );
  const withoutProbe = windows.passed.filter((name) => name !== WINDOWS_SECURITY_PROBE_CASE);
  assert.throws(() =>
    parseRustListing(
      [...withoutProbe, ...windows.ignored].map((name) => `${name}: test`).join('\n'),
      'win32',
    ),
  );
  for (const platform of ['darwin', 'linux'])
    assert.equal(rustPopulation(platform).passed.includes(WINDOWS_SECURITY_PROBE_CASE), false);
  const evidence = {
    version: 1,
    rustPassed: windows.passed,
    rustIgnored: windows.ignored,
    nodeCases: [...NODE_LIFECYCLE_CASES],
    requiresCreationMaskProbe: false,
    genuineOwnerContext: 'distinct',
  };
  assert.throws(() => validateProfileEvidence({ ...evidence, securityProbe: 'exact' }, 'win32'));
  const incomplete =
    `test ${WINDOWS_SECURITY_PROBE_CASE} ... ignored\n` +
    securityRecords('exact').join('\n') +
    '\ntest result: ok. 0 passed; 0 failed; 1 ignored; 19 filtered out\n';
  assert.throws(
    () => parseSingleRustResult(incomplete, WINDOWS_SECURITY_PROBE_CASE),
    /NATIVE_FS_RUST_SINGLE_COMPLETION/u,
  );
});

test('Windows descriptor measurements require exactly twelve fixed unique records and normalize every closed status', () => {
  const independent = [];
  for (const policy of ['protected', 'unprotected', 'inherited'])
    for (const setter of ['setinfo', 'nt-basic', 'nt-protection', 'nt-request'])
      independent.push(`${policy}-${setter}`);
  assert.deepEqual(WINDOWS_SECURITY_VARIANTS, independent);
  assert.equal(new Set(WINDOWS_SECURITY_VARIANTS).size, 12);
  const priorNine = [];
  for (const policy of ['protected', 'unprotected', 'inherited'])
    for (const setter of ['setinfo', 'nt-basic', 'nt-protection'])
      priorNine.push(`${policy}-${setter}`);
  assert.deepEqual(
    WINDOWS_SECURITY_VARIANTS.filter((variant) => !variant.endsWith('-nt-request')),
    priorNine,
  );
  assert.deepEqual(
    WINDOWS_SECURITY_VARIANTS.filter((variant) => variant.endsWith('-nt-request')),
    ['protected-nt-request', 'unprotected-nt-request', 'inherited-nt-request'],
  );
  assert.throws(
    () =>
      parseWindowsSecurityProbe(
        priorNine.map((variant) => `RELAVIUM_NATIVE_SECURITY_PROBE:${variant}:exact`).join('\n'),
      ),
    (error) => error.message === 'NATIVE_FS_WINDOWS_SECURITY_PROBE',
  );
  assert.deepEqual(WINDOWS_SECURITY_STATUSES, [
    'exact',
    'owner-changed',
    'group-changed',
    'dacl-changed',
    'protected-changed',
    'auto-inherited-changed',
    'access-denied',
    'unsupported',
    'error',
  ]);
  for (const status of WINDOWS_SECURITY_STATUSES)
    assert.deepEqual(
      parseWindowsSecurityProbe(
        'successes:\r\n' + securityRecords(status).reverse().join('\r\n') + '\r\n',
      ),
      WINDOWS_SECURITY_VARIANTS.map((variant) => ({ variant, status })),
    );
  const line = windowsSecurityProbeDiagnostic(securityRecords('auto-inherited-changed').join('\n'));
  assert.ok(line.startsWith('NATIVE_FS_SECURITY_PROBE '));
  assert.equal(line.split('\n').length, 2);
  assert.ok(line.length < 2048);
  assert.deepEqual(JSON.parse(line.slice('NATIVE_FS_SECURITY_PROBE '.length)), {
    version: 1,
    measurementOnly: true,
    records: WINDOWS_SECURITY_VARIANTS.map((variant) => ({
      variant,
      status: 'auto-inherited-changed',
    })),
  });
});

test('Windows descriptor measurements refuse missing, duplicated, unknown, raw or oversized data with fixed errors', () => {
  const valid = securityRecords();
  const inputs = [
    null,
    undefined,
    {},
    '',
    valid.slice(1).join('\n'),
    [...valid, valid[0]].join('\n'),
    [...valid, 'RELAVIUM_NATIVE_SECURITY_PROBE:protected-nt-request:exact'].join('\n'),
    ['RELAVIUM_NATIVE_SECURITY_PROBE:protected-nt-request-private:exact', ...valid.slice(1)].join(
      '\n',
    ),
    ['RELAVIUM_NATIVE_SECURITY_PROBE:private-policy-setinfo:exact', ...valid.slice(1)].join('\n'),
    ['RELAVIUM_NATIVE_SECURITY_PROBE:protected-setinfo:private-SID', ...valid.slice(1)].join('\n'),
    [valid[0] + ':private-payload', ...valid.slice(1)].join('\n'),
    ['prefix ' + valid[0], ...valid.slice(1)].join('\n'),
    [...valid, 'RELAVIUM_NATIVE_SECURITY_PROBE private-path'].join('\n'),
    [...valid, 'RELAVIUM_NATIVE_SECURITY_PROBE:protected-setinfo:5'].join('\n'),
    'x'.repeat(257) + '\n' + valid.join('\n'),
    '\n'.repeat(65537),
  ];
  for (const input of inputs)
    for (const parse of [parseWindowsSecurityProbe, windowsSecurityProbeDiagnostic])
      assert.throws(
        () => parse(input),
        (error) =>
          error.message === 'NATIVE_FS_WINDOWS_SECURITY_PROBE' &&
          !String(error).includes('private'),
      );
  // The common bounded-record helper preserves each protocol's independent inventory and errors.
  assert.throws(
    () => parseWindowsSecurityProbe(probeRecords().join('\n')),
    /NATIVE_FS_WINDOWS_SECURITY_PROBE/u,
  );
  assert.throws(() => parseWindowsRenameProbe(valid.join('\n')), /NATIVE_FS_WINDOWS_RENAME_PROBE/u);
});
