import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { ARCHIVE_LIMITS, inspectPackageArchive } from './archive.mjs';
import { runAggregate } from './aggregate.mjs';
import {
  aggregateConsumers,
  originFromEnvironment,
  PackageBindingError,
  REQUIRED_CONSUMER_LEGS,
  requirePackageJobResults,
  validateConsumerRecord,
  validatePackageReceipt,
} from './binding.mjs';
import { REQUIRED_SMOKE_CASES } from './smoke/cases.mjs';

const source = 'a'.repeat(40);
const digest = 'b'.repeat(64);
/** @type {import('./binding.mjs').Expected} */
const expected = { source, origin: { kind: 'local' }, nodeMajor: 24 };
function receipt() {
  return {
    version: 1,
    mode: 'package_test',
    source,
    dirty: false,
    packageVersion: '0.1.1',
    tarball: 'relavium-0.1.1.tgz',
    tarballSha256: digest,
    archiveBytes: 900,
    files: [
      { path: 'package/dist/index.js', bytes: 40, sha256: 'c'.repeat(64), mode: 0o755 },
      { path: 'package/dist/chunk-ABC.js', bytes: 10, sha256: 'd'.repeat(64), mode: 0o644 },
      { path: 'package/package.json', bytes: 120, sha256: 'e'.repeat(64), mode: 0o644 },
    ],
    package: {
      name: 'relavium',
      version: '0.1.1',
      type: 'module',
      bin: { relavium: './dist/index.js' },
      engines: { node: '>=22' },
      dependencies: { commander: '^14.0.0' },
      devDependencies: { '@relavium/core': '0.0.0' },
    },
    origin: { kind: 'local' },
    toolchain: { node: 'v24.9.0', pnpm: '9.12.3' },
  };
}
/** @param {string} [leg] */
function consumer(leg = 'current-linux') {
  const pack = receipt();
  return {
    version: 1,
    kind: 'installed-cli-consumer',
    source,
    tarballSha256: digest,
    leg,
    origin: { kind: 'local' },
    node: leg === 'minimum-linux' ? 'v22.0.0' : 'v24.9.0',
    platform: leg === 'current-macos' ? 'darwin' : leg === 'current-windows' ? 'win32' : 'linux',
    arch: 'x64',
    success: true,
    bootstrap: { controls: 177, entrySha256: 'c'.repeat(64) },
    installedCommand: { help: true, version: true },
    installedFiles: pack.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    smoke: { success: true, cases: REQUIRED_SMOKE_CASES.map((id) => ({ id, passed: true })) },
    packageVersion: '0.1.1',
    dependencies: [{ name: 'commander', version: '14.0.2', manifestSha256: 'f'.repeat(64) }],
  };
}
/** @param {Record<string, unknown>} object @param {string} key */
function omit(object, key) {
  return Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
}
/** @param {() => unknown} operation */
function refuses(operation) {
  assert.throws(
    operation,
    (error) =>
      error instanceof PackageBindingError ||
      (error instanceof Error && error.name === 'PackageArchiveError'),
  );
}
/** @param {string} [attempt] @returns {import('./binding.mjs').Origin} */
function github(attempt = '1') {
  return {
    kind: 'github',
    repository: 'HodeTech/Relavium',
    workflow: 'CI',
    runId: '12345',
    runAttempt: attempt,
    event: 'pull_request',
    source,
  };
}

test('one actual artifact binds every required OS/minimum-runtime consumer', () => {
  const result = aggregateConsumers(receipt(), REQUIRED_CONSUMER_LEGS.map(consumer), expected);
  assert.equal(result.success, true);
  assert.deepEqual(
    result.consumers.map((item) => item.leg).sort(),
    [...REQUIRED_CONSUMER_LEGS].sort(),
  );
  assert.equal(result.tarballSha256, digest);
});

test('strict receipt refuses omitted or added private/custody claims', () => {
  for (const key of Object.keys(receipt()))
    refuses(() => validatePackageReceipt(omit(receipt(), key), expected));
  for (const key of [
    'sourceMaps',
    'sourceInventory',
    'sourcesContent',
    'custody',
    'mapCheckComplete',
  ]) {
    refuses(() => validatePackageReceipt({ ...receipt(), [key]: true }, expected));
  }
  for (const changed of [
    { mode: 'release' },
    // The mode before the product map controls existed.
    { mode: 'compiled_package_test' },
    { source: '0'.repeat(40) },
    { dirty: 'false' },
    { version: 2 },
    { tarball: '../relavium-0.1.1.tgz' },
    { packageVersion: '0.1.2' },
    { tarballSha256: 'invalid' },
    { archiveBytes: ARCHIVE_LIMITS.compressedBytes + 1 },
    { archiveBytes: 0 },
    { toolchain: { node: 'v22.0.0', pnpm: '9.12.3' } },
    { toolchain: { node: 'v24.9.0', pnpm: '10.0.0' } },
  ])
    refuses(() => validatePackageReceipt({ ...receipt(), ...changed }, expected));
});

test('public inventory independently rejects duplicates, escapes, source/map files and incorrect modes', () => {
  const pack = receipt();
  const entry = pack.files[0];
  assert.ok(entry);
  for (const files of [
    [],
    pack.files.slice(1),
    [...pack.files, entry],
    [...pack.files, { ...entry, path: 'package/dist/CHUNK-ABC.js' }],
    pack.files.map((item) => ({ ...item, mode: 0o777 })),
    pack.files.map((item) => ({ ...item, bytes: -1 })),
    pack.files.map((item) => ({ ...item, sha256: 'NO' })),
    [...pack.files, { ...entry, path: 'package/dist/../escape.js' }],
    [...pack.files, { ...entry, path: 'package/dist/index.js.map' }],
    [...pack.files, { ...entry, path: 'package/src/index.ts' }],
    [...pack.files, { ...entry, source: 'private' }],
  ])
    refuses(() => validatePackageReceipt({ ...pack, files }, expected));
});

test('package metadata is public-only and keeps private packages out of runtime', () => {
  const pack = receipt();
  for (const changed of [
    { name: 'different' },
    { version: '0.2.0' },
    { private: true },
    { sourceInventory: [] },
    { bin: undefined },
    { bin: 'dist/index.js' },
    { bin: {} },
    { bin: { relavium: './dist/missing.js' } },
    { bin: { relavium: '../dist/index.js' } },
    { bin: { relavium: './dist/../dist/index.js' } },
    { bin: { relavium: './dist/index.js', other: './dist/index.js' } },
    { engines: undefined },
    { engines: {} },
    ...['>=20', '>=22.1', '>=24', '*', '^22 || >=24'].map((node) => ({ engines: { node } })),
    { dependencies: { '@relavium/core': '0.0.0' } },
    { dependencies: { commander: 'workspace:*' } },
    { dependencies: { commander: 'catalog:' } },
  ])
    refuses(() =>
      validatePackageReceipt({ ...pack, package: { ...pack.package, ...changed } }, expected),
    );
});

test('GitHub identity binds repo/workflow/run/event/source and rejects local or dirty receipts', () => {
  const trusted = { ...expected, origin: github('3') };
  const pack = { ...receipt(), origin: github('1') };
  assert.doesNotThrow(() => validatePackageReceipt(pack, trusted));
  refuses(() => validatePackageReceipt(receipt(), trusted));
  refuses(() => validatePackageReceipt({ ...pack, dirty: true }, trusted));
  refuses(() => validatePackageReceipt(pack, expected));
  for (const changed of [
    { repository: 'Other/Relavium' },
    { workflow: 'Release' },
    { runId: '999' },
    { runAttempt: '4' },
    { runAttempt: '0' },
    { event: 'push' },
    { source: '0'.repeat(40) },
  ])
    refuses(() =>
      validatePackageReceipt({ ...pack, origin: { ...github(), ...changed } }, trusted),
    );
});

test('failed-jobs retries retain exact artifact consumers within the originating/current attempt interval', () => {
  const trusted = { ...expected, origin: github('3') };
  const pack = { ...receipt(), origin: github('2') };
  for (const attempt of ['2', '3'])
    assert.doesNotThrow(() =>
      validateConsumerRecord({ ...consumer(), origin: github(attempt) }, pack, trusted),
    );
  for (const attempt of ['1', '4'])
    refuses(() =>
      validateConsumerRecord({ ...consumer(), origin: github(attempt) }, pack, trusted),
    );
});

test('consumer refuses replay, mismatched files, failed/skipped/incomplete controls and wrong runtime/platform', () => {
  const report = consumer();
  for (const key of Object.keys(report))
    refuses(() => validateConsumerRecord(omit(report, key), receipt(), expected));
  for (const changed of [
    { source: '0'.repeat(40) },
    { tarballSha256: '0'.repeat(64) },
    { packageVersion: '0.1.2' },
    { success: false },
    { success: 'true' },
    { skipped: true },
    { platform: 'darwin' },
    { node: 'v22.0.0' },
    { node: 'v24.0.0-preview' },
    { bootstrap: { controls: 176, entrySha256: 'c'.repeat(64) } },
    { bootstrap: { controls: 177, entrySha256: '0'.repeat(64) } },
    { installedCommand: { version: true } },
    { installedCommand: { help: true } },
    { installedCommand: { help: false, version: true } },
    { installedCommand: { help: true, version: false } },
    { installedCommand: { help: true, version: true, skipped: false } },
    { installedFiles: report.installedFiles.slice(1) },
    { installedFiles: report.installedFiles.map((item) => ({ ...item, mode: 0o644 })) },
    { installedFiles: report.installedFiles.map((item) => ({ ...item, sha256: '0'.repeat(64) })) },
    { smoke: { ...report.smoke, success: false } },
    { smoke: { ...report.smoke, cases: report.smoke.cases.slice(1) } },
    {
      smoke: {
        ...report.smoke,
        cases: report.smoke.cases.map((item) => ({ ...item, passed: false })),
      },
    },
    {
      smoke: {
        ...report.smoke,
        cases: report.smoke.cases.map((item) => ({ ...item, id: 'installed-version' })),
      },
    },
  ])
    refuses(() => validateConsumerRecord({ ...report, ...changed }, receipt(), expected));
  refuses(() =>
    validateConsumerRecord({ ...consumer('minimum-linux'), node: 'v22.1.0' }, receipt(), expected),
  );
});

test('each required platform refuses every missing or failed independently pinned installed case', () => {
  assert.deepEqual(REQUIRED_SMOKE_CASES, [
    'native-addon-load-only',
    'installed-version',
    'installed-provider-list',
    'installed-unknown-logs',
    'workflow-gate-budget-effects',
    'real-sdk-chat-persistence-resume',
    'actual-mcp-initialize-version',
    'actual-media-cas-iterator-cleanup',
    'actual-native-process-owner',
    'actual-native-bootstrap-lifecycle',
  ]);
  for (const nativeCase of REQUIRED_SMOKE_CASES)
    for (const leg of REQUIRED_CONSUMER_LEGS) {
      const report = consumer(leg);
      const cases = report.smoke.cases.filter((item) => item.id !== nativeCase);
      assert.equal(cases.length, 9);
      refuses(() =>
        validateConsumerRecord({ ...report, smoke: { success: true, cases } }, receipt(), expected),
      );
      refuses(() =>
        validateConsumerRecord(
          {
            ...report,
            smoke: {
              success: true,
              cases: report.smoke.cases.map((item) =>
                item.id === nativeCase ? { ...item, passed: false } : item,
              ),
            },
          },
          receipt(),
          expected,
        ),
      );
    }
});

test('resolved dependency evidence records every approved package without exposing host paths', () => {
  const report = consumer();
  const dependency = report.dependencies[0];
  assert.ok(dependency);
  for (const dependencies of [
    [],
    [dependency, dependency],
    [{ ...dependency, name: 'other' }],
    [{ ...dependency, version: '' }],
    [{ ...dependency, manifestSha256: 'x' }],
    [{ ...dependency, path: '/private/host/node_modules/commander' }],
  ])
    refuses(() => validateConsumerRecord({ ...report, dependencies }, receipt(), expected));
  assert.doesNotThrow(() =>
    validateConsumerRecord(
      { ...report, dependencies: [{ ...dependency, version: '14.1.0' }] },
      receipt(),
      expected,
    ),
  );
});

test('aggregate cannot substitute duplicate or absent platform legs', () => {
  const reports = REQUIRED_CONSUMER_LEGS.map(consumer);
  refuses(() => aggregateConsumers(receipt(), reports.slice(1), expected));
  refuses(() => aggregateConsumers(receipt(), [...reports, consumer()], expected));
  refuses(() =>
    aggregateConsumers(
      receipt(),
      reports.map(() => consumer()),
      expected,
    ),
  );
});

test('environment origin is derived from the current job and fails closed on incomplete GitHub identity', () => {
  assert.deepEqual(originFromEnvironment({}), { kind: 'local' });
  const environment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'HodeTech/Relavium',
    GITHUB_WORKFLOW: 'CI',
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_SHA: source,
  };
  assert.deepEqual(originFromEnvironment(environment), github());
  for (const key of Object.keys(environment).filter((key) => key !== 'GITHUB_ACTIONS')) {
    const missing = Object.fromEntries(
      Object.entries(environment).filter(([name]) => name !== key),
    );
    refuses(() => originFromEnvironment(missing));
  }
  refuses(() =>
    originFromEnvironment({ ...environment, GITHUB_EVENT_NAME: 'pull_request_target' }),
  );
});

test('CI/release job statuses are an independent required gate; missing/skipped/cancelled never pass', () => {
  for (const pair of [
    ['pack-cli', 'packed-cli-consumer'],
    ['pack', 'smoke'],
  ]) {
    const good = Object.fromEntries(pair.map((name) => [name, { result: 'success' }]));
    assert.doesNotThrow(() => requirePackageJobResults(good));
    for (const name of pair) {
      refuses(() => requirePackageJobResults(omit(good, name)));
      for (const result of ['failure', 'cancelled', 'skipped', 'pending', ''])
        refuses(() => requirePackageJobResults({ ...good, [name]: { result } }));
    }
  }
  for (const value of [
    undefined,
    null,
    [],
    {},
    { 'pack-cli': { result: 'success' }, smoke: { result: 'success' } },
  ])
    refuses(() => requirePackageJobResults(value));
});

test('an explicitly local run retains its runtime scope and cannot fill a required platform leg', () => {
  const local = { ...consumer('local'), node: 'v25.0.0', platform: 'darwin' };
  assert.doesNotThrow(() =>
    validateConsumerRecord(local, receipt(), { ...expected, allowLocal: true }),
  );
  refuses(() => validateConsumerRecord(local, receipt(), expected));
  refuses(() =>
    validateConsumerRecord({ ...local, node: 'v20.0.0' }, receipt(), {
      ...expected,
      allowLocal: true,
    }),
  );
  refuses(() =>
    aggregateConsumers(receipt(), [local, ...REQUIRED_CONSUMER_LEGS.slice(1).map(consumer)], {
      ...expected,
      allowLocal: true,
    }),
  );
  refuses(() =>
    validateConsumerRecord(
      { ...local, origin: github() },
      { ...receipt(), origin: github() },
      { ...expected, origin: github(), allowLocal: true },
    ),
  );
  const localPack = { ...receipt(), toolchain: { node: 'v22.23.1', pnpm: '9.12.3' } };
  assert.doesNotThrow(() => validatePackageReceipt(localPack, { ...expected, allowLocal: true }));
  refuses(() => validatePackageReceipt(localPack, expected));
  refuses(() =>
    aggregateConsumers(localPack, REQUIRED_CONSUMER_LEGS.map(consumer), {
      ...expected,
      allowLocal: true,
    }),
  );
});

// Tiny, synthetic package for exercising the aggregator's real filesystem and
// gzip/archive boundary. This never packs, installs or builds the product.
function syntheticPackage() {
  const pack = receipt();
  const files = new Map([
    ['package/dist/index.js', Buffer.from('#!/usr/bin/env node\nimport "./chunk-ABC.js";\n')],
    ['package/dist/chunk-ABC.js', Buffer.from('export {};\n')],
    ['package/package.json', Buffer.from(JSON.stringify(pack.package))],
  ]);
  const records = [...files].map(([path, bytes]) => {
    const header = Buffer.alloc(512);
    header.write(path);
    for (const offset of [100, 108, 116, 329, 337]) header.write('000000 \0', offset);
    header.write(path.endsWith('/index.js') ? '000755' : '000644', 100);
    header.write(bytes.length.toString(8).padStart(11, '0') + ' ', 124);
    header.write('00000000000 ', 136);
    header[156] = 48;
    header.write('ustar\0' + '00', 257);
    header.fill(32, 148, 156);
    header.write(
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0'),
      148,
    );
    header[154] = 0;
    header[155] = 32;
    return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
  });
  const tarball = gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]));
  const archive = inspectPackageArchive(tarball, {
    expectedFiles: files,
    expectedPackage: pack.package,
  });
  return {
    tarball,
    pack: {
      ...pack,
      archiveBytes: archive.bytes,
      tarballSha256: archive.sha256,
      files: archive.files,
    },
  };
}

/** @param {(fixture: ReturnType<typeof filesystemFixture>) => void} operation */
function withFilesystem(operation) {
  const fixture = filesystemFixture();
  try {
    operation(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}
function filesystemFixture() {
  const root = mkdtempSync(join(tmpdir(), 'relavium-package-aggregate-test-'));
  const artifact = join(root, 'artifact');
  const reports = join(root, 'reports');
  mkdirSync(artifact);
  mkdirSync(reports);
  const { tarball, pack } = syntheticPackage();
  writeFileSync(join(artifact, pack.tarball), tarball);
  writeFileSync(join(artifact, 'package-test-receipt.json'), JSON.stringify(pack));
  const entry = pack.files.find((file) => file.path === 'package/dist/index.js');
  assert.ok(entry);
  for (const leg of REQUIRED_CONSUMER_LEGS) {
    mkdirSync(join(reports, leg));
    writeFileSync(
      join(reports, leg, 'installed-consumer.json'),
      JSON.stringify({
        ...consumer(leg),
        tarballSha256: pack.tarballSha256,
        installedFiles: pack.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
        bootstrap: { controls: 177, entrySha256: entry.sha256 },
      }),
    );
  }
  const environment = {
    RELAVIUM_PACKAGE_SOURCE_SHA: source,
    RELAVIUM_PACKAGE_JOB_RESULTS: JSON.stringify({
      'pack-cli': { result: 'success' },
      'packed-cli-consumer': { result: 'success' },
    }),
  };
  return { root, artifact, reports, pack, environment };
}

test('aggregate reads and independently inspects one tarball and four bounded consumer artifacts', () => {
  withFilesystem(({ artifact, reports, environment }) =>
    assert.equal(runAggregate([artifact, reports], environment).success, true),
  );
});

test('aggregate rejects modified tarball, oversized input, extra/missing reports and symlink directories', () => {
  withFilesystem(({ artifact, reports, environment, pack }) => {
    writeFileSync(join(artifact, pack.tarball), Buffer.alloc(100));
    refuses(() => runAggregate([artifact, reports], environment));
  });
  withFilesystem(({ artifact, reports, environment }) => {
    writeFileSync(join(artifact, 'package-test-receipt.json'), Buffer.alloc(512 * 1024 + 1));
    refuses(() => runAggregate([artifact, reports], environment));
  });
  withFilesystem(({ artifact, reports, environment }) => {
    writeFileSync(join(reports, 'current-linux', 'private-map.json'), '{}');
    refuses(() => runAggregate([artifact, reports], environment));
  });
  withFilesystem(({ artifact, reports, environment }) => {
    rmSync(join(reports, 'current-linux'), { recursive: true });
    refuses(() => runAggregate([artifact, reports], environment));
  });
  withFilesystem(({ root, artifact, reports, environment }) => {
    const moved = join(root, 'moved');
    renameSync(join(reports, 'current-linux'), moved);
    symlinkSync(
      moved,
      join(reports, 'current-linux'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    refuses(() => runAggregate([artifact, reports], environment));
  });
  withFilesystem(({ artifact, reports, environment }) => {
    refuses(() =>
      runAggregate([artifact, reports], { ...environment, RELAVIUM_PACKAGE_JOB_RESULTS: 'null' }),
    );
    refuses(() =>
      runAggregate([artifact, reports], {
        ...environment,
        RELAVIUM_PACKAGE_SOURCE_SHA: 'f'.repeat(40),
      }),
    );
    refuses(() => runAggregate([artifact, reports, 'extra'], environment));
  });
});
