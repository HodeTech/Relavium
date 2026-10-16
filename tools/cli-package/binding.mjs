import { isDeepStrictEqual } from 'node:util';
import { ARCHIVE_LIMITS, assertPublicPackagePath } from './archive.mjs';
import { REQUIRED_SMOKE_CASES } from './smoke/cases.mjs';

/** @typedef {{kind: 'local'} | {kind: 'github', repository: string, workflow: string, runId: string, runAttempt: string, event: string, source: string}} Origin */
/** @typedef {{path: string, bytes: number, sha256: string, mode: number}} PublicFile */
/** @typedef {{source: string, origin: Origin, nodeMajor: number, allowLocal?: boolean}} Expected */

export const REQUIRED_CONSUMER_LEGS = Object.freeze([
  'current-linux',
  'current-macos',
  'current-windows',
  'minimum-linux',
]);

export class PackageBindingError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`CLI package binding refused: ${code}`);
    this.name = 'PackageBindingError';
    this.code = code;
  }
}
/** @param {string} code @returns {never} */
function refuse(code) {
  throw new PackageBindingError(code);
}
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  if (!isRecord(value)) refuse('SHAPE');
  return value;
}
/** @param {unknown} value @param {string[]} expected */
function exact(value, expected) {
  const object = record(value);
  if (!isDeepStrictEqual(Object.keys(object).sort(), [...expected].sort())) refuse('FIELDS');
  return object;
}
/** @param {unknown} value @param {RegExp} pattern @param {number} [max] */
function string(value, pattern, max = 256) {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) refuse('VALUE');
  return value;
}
/** @param {unknown} value @param {number} maximum @param {number} [minimum] */
function integer(value, maximum, minimum = 0) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    refuse('VALUE');
  return value;
}
/** @param {unknown} value */
function sha(value) {
  return string(value, /^[0-9a-f]{64}$/u);
}
/** @param {unknown} value */
function sourceSha(value) {
  return string(value, /^[0-9a-f]{40}$/u);
}
/** @param {unknown} value */
function version(value) {
  return string(value, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u, 100);
}
/** @param {unknown} value */
function nodeVersion(value) {
  return string(value, /^v\d+\.\d+\.\d+$/u, 40);
}

/** @param {unknown} value @returns {Origin} */
function parseOrigin(value) {
  const origin = record(value);
  if (origin.kind === 'local') {
    exact(origin, ['kind']);
    return { kind: 'local' };
  }
  exact(origin, ['kind', 'repository', 'workflow', 'runId', 'runAttempt', 'event', 'source']);
  if (origin.kind !== 'github') refuse('ORIGIN');
  return {
    kind: 'github',
    repository: string(origin.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 200),
    workflow: string(origin.workflow, /^\P{Cc}+$/u, 200),
    runId: string(origin.runId, /^[1-9]\d*$/u, 20),
    runAttempt: string(origin.runAttempt, /^[1-9]\d*$/u, 6),
    event: string(origin.event, /^(?:push|pull_request|workflow_dispatch)$/u),
    source: sourceSha(origin.source),
  };
}

/**
 * Environment values are provided by the current trusted job, never a receipt.
 * A local origin cannot be promoted to GitHub evidence.
 * @param {Record<string, string | undefined>} environment
 * @returns {Origin}
 */
export function originFromEnvironment(environment) {
  if (environment.GITHUB_ACTIONS !== 'true') return { kind: 'local' };
  return parseOrigin({
    kind: 'github',
    repository: environment.GITHUB_REPOSITORY,
    workflow: environment.GITHUB_WORKFLOW,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
    event: environment.GITHUB_EVENT_NAME,
    source: environment.RELAVIUM_PACKAGE_SOURCE_SHA ?? environment.GITHUB_SHA,
  });
}

/** @param {unknown} value @param {Expected} expected @param {boolean} olderAttempt */
function bindOrigin(value, expected, olderAttempt) {
  const actual = parseOrigin(value);
  const trusted = parseOrigin(expected.origin);
  if (actual.kind !== trusted.kind) refuse('ORIGIN');
  if (actual.kind === 'github' && trusted.kind === 'github') {
    if (
      actual.source !== expected.source ||
      trusted.source !== expected.source ||
      actual.repository !== trusted.repository ||
      actual.workflow !== trusted.workflow ||
      actual.runId !== trusted.runId ||
      actual.event !== trusted.event ||
      (olderAttempt
        ? BigInt(actual.runAttempt) > BigInt(trusted.runAttempt)
        : actual.runAttempt !== trusted.runAttempt)
    )
      refuse('ORIGIN');
  }
  return actual;
}

/** @param {unknown} value @returns {PublicFile[]} */
function inventory(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > ARCHIVE_LIMITS.files)
    refuse('INVENTORY');
  const paths = new Set();
  let total = 1024;
  const files = value.map((item) => {
    const file = exact(item, ['path', 'bytes', 'sha256', 'mode']);
    const path = string(file.path, /^[\x20-\x7e]+$/u, 99);
    assertPublicPackagePath(path);
    if (paths.has(path.toLowerCase())) refuse('INVENTORY');
    paths.add(path.toLowerCase());
    const bytes = integer(
      file.bytes,
      path === 'package/package.json' ? ARCHIVE_LIMITS.manifestBytes : ARCHIVE_LIMITS.fileBytes,
    );
    total += 512 + Math.ceil(bytes / 512) * 512;
    const mode = path === 'package/dist/index.js' ? 0o755 : 0o644;
    if (file.mode !== mode) refuse('INVENTORY');
    return { path, bytes, sha256: sha(file.sha256), mode };
  });
  if (
    total > ARCHIVE_LIMITS.expandedBytes ||
    !paths.has('package/package.json') ||
    !paths.has('package/dist/index.js')
  )
    refuse('INVENTORY');
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/** @param {unknown} value */
function publicPackage(value) {
  const manifest = record(value);
  const allowed = new Set([
    'name',
    'version',
    'description',
    'license',
    'type',
    'bin',
    'files',
    'keywords',
    'repository',
    'engines',
    'scripts',
    'dependencies',
    'devDependencies',
  ]);
  if (
    Object.keys(manifest).some((key) => !allowed.has(key)) ||
    manifest.name !== 'relavium' ||
    manifest.type !== 'module'
  )
    refuse('PACKAGE');
  version(manifest.version);
  const dependencies = record(manifest.dependencies);
  if (Object.keys(dependencies).length < 1 || Object.keys(dependencies).length > 100)
    refuse('PACKAGE');
  for (const [name, requirement] of Object.entries(dependencies)) {
    string(name, /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u, 200);
    if (
      name.startsWith('@relavium/') ||
      typeof requirement !== 'string' ||
      requirement.length > 100 ||
      /(?:workspace|catalog|file|link):/u.test(requirement)
    )
      refuse('PACKAGE');
  }
  // Full package metadata is public npm material. Keep it bounded; private map
  // manifests and build/source inventories have no admitted top-level field.
  if (JSON.stringify(manifest).length > ARCHIVE_LIMITS.manifestBytes) refuse('PACKAGE');
  return manifest;
}

/** @param {unknown} value @param {Expected} expected */
export function validatePackageReceipt(value, expected) {
  sourceSha(expected.source);
  integer(expected.nodeMajor, 100, 22);
  const receipt = exact(value, [
    'version',
    'mode',
    'source',
    'dirty',
    'packageVersion',
    'tarball',
    'tarballSha256',
    'archiveBytes',
    'files',
    'package',
    'origin',
    'toolchain',
  ]);
  if (
    receipt.version !== 1 ||
    receipt.mode !== 'compiled_package_test' ||
    receipt.source !== expected.source ||
    typeof receipt.dirty !== 'boolean'
  )
    refuse('RECEIPT');
  const origin = bindOrigin(receipt.origin, expected, true);
  if (origin.kind === 'github' && receipt.dirty) refuse('DIRTY_SOURCE');
  const packageVersion = version(receipt.packageVersion);
  if (receipt.tarball !== `relavium-${packageVersion}.tgz`) refuse('TARBALL');
  const toolchain = exact(receipt.toolchain, ['node', 'pnpm']);
  const node = nodeVersion(toolchain.node);
  const producerMajor = Number(node.split('.')[0]?.slice(1));
  if (
    toolchain.pnpm !== '9.12.3' ||
    (origin.kind === 'local' && expected.allowLocal === true
      ? producerMajor < 22
      : producerMajor !== expected.nodeMajor)
  )
    refuse('TOOLCHAIN');
  const manifest = publicPackage(receipt.package);
  if (manifest.version !== packageVersion) refuse('PACKAGE');
  return {
    version: 1,
    mode: 'compiled_package_test',
    source: expected.source,
    dirty: receipt.dirty,
    packageVersion,
    tarball: `relavium-${packageVersion}.tgz`,
    tarballSha256: sha(receipt.tarballSha256),
    archiveBytes: integer(receipt.archiveBytes, ARCHIVE_LIMITS.compressedBytes, 18),
    files: inventory(receipt.files),
    package: manifest,
    origin,
    toolchain: { node, pnpm: '9.12.3' },
  };
}

/** @param {unknown} value @param {unknown} receiptValue @param {Expected} expected */
export function validateConsumerRecord(value, receiptValue, expected) {
  const receipt = validatePackageReceipt(receiptValue, expected);
  const consumer = exact(value, [
    'version',
    'kind',
    'source',
    'tarballSha256',
    'leg',
    'origin',
    'node',
    'platform',
    'arch',
    'success',
    'bootstrap',
    'installedFiles',
    'smoke',
    'packageVersion',
    'dependencies',
  ]);
  if (
    consumer.version !== 1 ||
    consumer.kind !== 'installed-cli-consumer' ||
    consumer.success !== true ||
    consumer.source !== receipt.source ||
    consumer.tarballSha256 !== receipt.tarballSha256 ||
    consumer.packageVersion !== receipt.packageVersion
  )
    refuse('CONSUMER');
  const consumerOrigin = bindOrigin(consumer.origin, expected, true);
  if (
    consumerOrigin.kind === 'github' &&
    receipt.origin.kind === 'github' &&
    BigInt(consumerOrigin.runAttempt) < BigInt(receipt.origin.runAttempt)
  )
    refuse('ORIGIN');
  const leg = string(consumer.leg, /^(?:current-(?:linux|macos|windows)|minimum-linux|local)$/u);
  if (leg === 'local' && (expected.allowLocal !== true || consumerOrigin.kind !== 'local'))
    refuse('LOCAL_LEG');
  const platform =
    leg === 'local'
      ? string(consumer.platform, /^(?:linux|darwin|win32)$/u)
      : leg === 'current-macos'
        ? 'darwin'
        : leg === 'current-windows'
          ? 'win32'
          : 'linux';
  if (consumer.platform !== platform || (consumer.arch !== 'x64' && consumer.arch !== 'arm64'))
    refuse('PLATFORM');
  const node = nodeVersion(consumer.node);
  const major = Number(node.split('.')[0]?.slice(1));
  if (
    leg === 'local'
      ? major < 22
      : leg === 'minimum-linux'
        ? node !== 'v22.0.0'
        : major !== expected.nodeMajor
  )
    refuse('RUNTIME');
  if (
    !Array.isArray(consumer.installedFiles) ||
    consumer.installedFiles.length !== receipt.files.length
  )
    refuse('INSTALLED_FILES');
  const installedFiles = consumer.installedFiles
    .map((item) => {
      const file = exact(item, ['path', 'bytes', 'sha256']);
      return {
        path: string(file.path, /^[\x20-\x7e]+$/u, 99),
        bytes: integer(file.bytes, ARCHIVE_LIMITS.fileBytes),
        sha256: sha(file.sha256),
      };
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const packedFiles = receipt.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  if (!isDeepStrictEqual(installedFiles, packedFiles)) refuse('INSTALLED_FILES');
  const bootstrap = exact(consumer.bootstrap, ['controls', 'entrySha256']);
  const entry = receipt.files.find((file) => file.path === 'package/dist/index.js');
  if (bootstrap.controls !== 175 || bootstrap.entrySha256 !== entry?.sha256) refuse('BOOTSTRAP');
  const smoke = exact(consumer.smoke, ['success', 'cases']);
  if (
    smoke.success !== true ||
    !Array.isArray(smoke.cases) ||
    smoke.cases.length !== REQUIRED_SMOKE_CASES.length
  )
    refuse('SMOKE');
  const cases = smoke.cases.map((item) => {
    const result = exact(item, ['id', 'passed']);
    if (result.passed !== true) refuse('SMOKE');
    return string(result.id, /^[a-z0-9-]+$/u);
  });
  if (!isDeepStrictEqual(cases.sort(), [...REQUIRED_SMOKE_CASES].sort())) refuse('SMOKE');
  const approved = Object.keys(record(receipt.package.dependencies)).sort();
  if (!Array.isArray(consumer.dependencies) || consumer.dependencies.length !== approved.length)
    refuse('DEPENDENCIES');
  const names = consumer.dependencies.map((item) => {
    const dependency = exact(item, ['name', 'version', 'manifestSha256']);
    version(dependency.version);
    sha(dependency.manifestSha256);
    return string(dependency.name, /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u, 200);
  });
  if (!isDeepStrictEqual(names.sort(), approved)) refuse('DEPENDENCIES');
  return { leg, node, platform, source: receipt.source, tarballSha256: receipt.tarballSha256 };
}

/** @param {unknown} receiptValue @param {unknown} records @param {Expected} expected */
export function aggregateConsumers(receiptValue, records, expected) {
  const aggregateExpected = { ...expected, allowLocal: false };
  const receipt = validatePackageReceipt(receiptValue, aggregateExpected);
  if (!Array.isArray(records) || records.length !== REQUIRED_CONSUMER_LEGS.length) refuse('LEGS');
  const consumers = records.map((value) =>
    validateConsumerRecord(value, receipt, aggregateExpected),
  );
  if (
    !isDeepStrictEqual(consumers.map((item) => item.leg).sort(), [...REQUIRED_CONSUMER_LEGS].sort())
  )
    refuse('LEGS');
  return {
    version: 1,
    kind: 'installed-cli-aggregate',
    source: receipt.source,
    tarballSha256: receipt.tarballSha256,
    packageVersion: receipt.packageVersion,
    success: true,
    consumers,
  };
}

/** @param {unknown} value */
export function requirePackageJobResults(value) {
  const jobs = record(value);
  const keys = Object.keys(jobs).sort();
  const ci = ['pack-cli', 'packed-cli-consumer'];
  const release = ['pack', 'smoke'];
  if (!isDeepStrictEqual(keys, ci) && !isDeepStrictEqual(keys, release)) refuse('JOBS');
  for (const key of keys) if (record(jobs[key]).result !== 'success') refuse('JOBS');
}
