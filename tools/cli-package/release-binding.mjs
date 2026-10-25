/**
 * The release binding receipt (Step 9b.2; packaging.md, "Recipient custody implementation boundary —
 * Step 9b.2"): schema v1, its validator and the verified reuse of a retained candidate. The receipt is
 * public JSON beside the ciphertext, written once in canonical bytes. It names files by SHA-256 and signs
 * nothing: every field is a claim, and its origin and map-check fields are checked for shape only until
 * Step 9d binds them to the trusted run and a successful `ci` run. Scope always comes from the verifier's
 * expectation, never from the receipt. This module's import closure starts no process, so reuse makes no
 * GnuPG call.
 */
import { Buffer } from 'node:buffer';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { ARCHIVE_LIMITS } from './archive.mjs';
import { CustodyError, refuseCustody } from './custody-error.mjs';
import { readOrdinaryFile, sha256 } from './files.mjs';
import { isProductionRecipient, isSyntheticSource } from './release-recipient.mjs';

/** The receipt's file name beside the ciphertext, as the interim release guard keys on it. */
export const RELEASE_BINDING_FILE = 'release-binding-receipt.json';
export const RELEASE_BINDING_KIND = 'release_binding';
/** The custody container's 128 MiB total plus the 64 KiB a ciphertext may add (container.mjs, custody.mjs). */
export const CIPHERTEXT_BYTES = 128 * 1024 * 1024 + 64 * 1024;
const RECEIPT_BYTES = 64 * 1024;
const MAX_INPUTS = 64;

/** @param {string} version */
export const tarballName = (version) => `relavium-${version}.tgz`;
/** @param {string} version */
export const ciphertextFileName = (version) => `relavium-${version}-private-maps.tar.gpg`;

const KEYS = Object.freeze([
  'version',
  'kind',
  'packageVersion',
  'source',
  'tarball',
  'ciphertext',
  'recipient',
  'toolchain',
  'target',
  'inputs',
  'mapCheck',
  'origin',
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_OBJECT = /^[0-9a-f]{40}$/u;
const FINGERPRINT = /^[0-9A-F]{40}$/u;
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const TOOL_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,64})?$/u;
const SEGMENT = /^[A-Za-z0-9_.-]+$/u;

/**
 * @typedef {import('./release-recipient.mjs').ProductionRecipient} ProductionRecipient
 * @typedef {{scope: 'production', recipient: ProductionRecipient, packageVersion: string, source: string}
 *   | {scope: 'synthetic', pins: {primary: string, subkey: string}, packageVersion: string}} Expected
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value @param {readonly string[]} keys */
function exact(value, keys) {
  if (!isRecord(value) || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) {
    refuseCustody('BINDING_SHAPE');
  }
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {unknown} value @param {RegExp} pattern @param {number} [max] @returns {string} */
function string(value, pattern, max = 256) {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) {
    refuseCustody('BINDING_SHAPE');
  }
  return /** @type {string} */ (value);
}
/** @param {unknown} value @param {number} minimum @param {number} maximum @returns {number} */
function size(value, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) refuseCustody('BINDING_SHAPE');
  if (value < minimum || value > maximum) refuseCustody('BINDING_SIZE');
  return value;
}
/**
 * A repository-relative POSIX path with no empty, `.` or `..` segment, and not an integer-like name, which
 * JavaScript orders ahead of every other key so that the canonical bytes could not list it by path.
 * @param {string} path
 */
const isRelativePath = (path) =>
  path.length <= 256 &&
  !/^(?:0|[1-9]\d*)$/u.test(path) &&
  path.split('/').every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..');

/**
 * A snapshot of the expectation, each field read once: the admitted recipient pairs, the package version
 * and, for production, the source commit.
 * @param {unknown} expected
 * @returns {{scope: 'production' | 'synthetic', history: readonly {primary: unknown, subkey: unknown}[],
 *   packageVersion: unknown, source: unknown}}
 */
function scopeOf(expected) {
  if (!isRecord(expected)) return refuseCustody('BINDING_SCOPE');
  const { scope, recipient, pins, packageVersion, source } = expected;
  if (scope === 'production') {
    if (!isProductionRecipient(recipient)) refuseCustody('RECIPIENT_SOURCE');
    const { history } = /** @type {ProductionRecipient} */ (recipient);
    return Object.freeze({ scope, history, packageVersion, source });
  }
  if (scope !== 'synthetic') refuseCustody('BINDING_SCOPE');
  const pair = isRecord(pins) ? { primary: pins.primary, subkey: pins.subkey } : {};
  return Object.freeze({
    scope,
    history: Object.freeze([Object.freeze({ primary: pair.primary, subkey: pair.subkey })]),
    packageVersion,
    source: undefined,
  });
}

/**
 * @param {unknown} value @param {string} version @param {(version: string) => string} name
 * @param {number} minimum @param {number} maximum
 */
function asset(value, version, name, minimum, maximum) {
  // Each field is read once: the value checked is the value returned.
  const { name: given, bytes, sha256: digest } = exact(value, ['name', 'bytes', 'sha256']);
  if (given !== name(version)) refuseCustody('BINDING_NAME');
  return Object.freeze({
    name: /** @type {string} */ (given),
    bytes: size(bytes, minimum, maximum),
    sha256: string(digest, SHA256),
  });
}

/**
 * Validate a release binding receipt against the verifier's expectation and return its normalized,
 * frozen copy in canonical key order. `expected` has no default: a production expectation needs the
 * loaded production recipient, whose whole history verifies; a synthetic one needs the synthetic pins.
 * @param {unknown} value
 * @param {Expected} expected
 */
export function validateReleaseBinding(value, expected) {
  return bounded(() => validate(value, scopeOf(expected)));
}

/**
 * Run `work` behind the fixed-code boundary: a host error's message, or a throwing accessor's, never
 * leaves; only custody codes do.
 * @template T @param {() => T} work @returns {T}
 */
function bounded(work) {
  try {
    return work();
  } catch (error) {
    if (error instanceof CustodyError) throw error;
    return refuseCustody('UNEXPECTED');
  }
}

/** @param {unknown} value @param {ReturnType<typeof scopeOf>} scope */
function validate(value, scope) {
  if (!isRecord(value) || value.version !== 1 || value.kind !== RELEASE_BINDING_KIND) {
    refuseCustody('BINDING_VERSION');
  }
  const receipt = exact(value, KEYS);
  const packageVersion = string(receipt.packageVersion, PACKAGE_VERSION, 100);
  const { commit, tree, dirty } = exact(receipt.source, ['commit', 'tree', 'dirty']);
  if (typeof dirty !== 'boolean') refuseCustody('BINDING_SHAPE');
  const source = Object.freeze({
    commit: string(commit, GIT_OBJECT),
    tree: string(tree, GIT_OBJECT),
    dirty,
  });
  if (packageVersion !== scope.packageVersion) refuseCustody('BINDING_CANDIDATE');
  if (scope.scope === 'production') {
    if (source.commit !== scope.source) refuseCustody('BINDING_CANDIDATE');
    if (isSyntheticSource(source)) refuseCustody('BINDING_SCOPE');
    if (source.dirty) refuseCustody('BINDING_DIRTY');
  } else if (!isSyntheticSource(source)) {
    refuseCustody('BINDING_SCOPE');
  }

  // A gzip member is at least 18 bytes (archive.mjs); a ciphertext at least one.
  const tarball = asset(
    receipt.tarball,
    packageVersion,
    tarballName,
    18,
    ARCHIVE_LIMITS.compressedBytes,
  );
  const ciphertext = asset(
    receipt.ciphertext,
    packageVersion,
    ciphertextFileName,
    1,
    CIPHERTEXT_BYTES,
  );

  const recipientRecord = exact(receipt.recipient, ['primary', 'subkey']);
  const recipient = Object.freeze({
    primary: string(recipientRecord.primary, FINGERPRINT),
    subkey: string(recipientRecord.subkey, FINGERPRINT),
  });
  if (
    !scope.history.some(
      (entry) => entry.primary === recipient.primary && entry.subkey === recipient.subkey,
    )
  ) {
    refuseCustody('BINDING_RECIPIENT');
  }

  const tools = exact(receipt.toolchain, [
    'node',
    'pnpm',
    'typescript',
    'tsup',
    'esbuild',
    'gnupg',
  ]);
  const toolchain = Object.freeze({
    node: string(tools.node, /^v\d+\.\d+\.\d+$/u, 40),
    pnpm: string(tools.pnpm, TOOL_VERSION, 100),
    typescript: string(tools.typescript, TOOL_VERSION, 100),
    tsup: string(tools.tsup, TOOL_VERSION, 100),
    esbuild: string(tools.esbuild, TOOL_VERSION, 100),
    gnupg: string(tools.gnupg, /^\d+\.\d+\.\d+$/u, 40),
  });
  const target = string(receipt.target, /^node\d{2,3}$/u, 8);

  if (!isRecord(receipt.inputs)) refuseCustody('BINDING_SHAPE');
  const entries = Object.entries(receipt.inputs);
  if (entries.length < 1 || entries.length > MAX_INPUTS) refuseCustody('BINDING_SHAPE');
  const inputs = Object.freeze(
    Object.fromEntries(
      entries
        .map(([path, digest]) => {
          if (!isRelativePath(path)) refuseCustody('BINDING_SHAPE');
          return [path, string(digest, SHA256)];
        })
        .sort(([left], [right]) => (left < right ? -1 : 1)),
    ),
  );

  const mapCheck = exact(receipt.mapCheck, ['status']);
  if (mapCheck.status !== 'complete') refuseCustody('BINDING_MAP_CHECK');

  if (!isRecord(receipt.origin) || receipt.origin.kind !== 'github') {
    refuseCustody('BINDING_ORIGIN');
  }
  const originRecord = exact(receipt.origin, [
    'kind',
    'repository',
    'workflow',
    'runId',
    'runAttempt',
    'event',
    'source',
  ]);
  if (originRecord.event !== 'push' || originRecord.source !== source.commit) {
    refuseCustody('BINDING_ORIGIN');
  }
  const origin = Object.freeze({
    kind: 'github',
    repository: string(originRecord.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 200),
    workflow: string(originRecord.workflow, /^\P{Cc}+$/u, 200),
    runId: string(originRecord.runId, /^[1-9]\d*$/u, 20),
    runAttempt: string(originRecord.runAttempt, /^[1-9]\d*$/u, 6),
    event: 'push',
    source: source.commit,
  });

  return Object.freeze({
    version: 1,
    kind: RELEASE_BINDING_KIND,
    packageVersion,
    source,
    tarball,
    ciphertext,
    recipient,
    toolchain,
    target,
    inputs,
    mapCheck: Object.freeze({ status: 'complete' }),
    origin,
  });
}

/** The canonical bytes of a normalized receipt; the sealer writes exactly these, once. @param {object} receipt */
export const serializeReleaseBinding = (receipt) =>
  Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);

/**
 * Parse a receipt's exact bytes: anything but the canonical serialization of its validated value
 * refuses, so a duplicated key, a reordering, a BOM or trailing data never reaches a verifier.
 * @param {Buffer} bytes @param {Expected} expected
 */
export function parseReleaseBinding(bytes, expected) {
  return bounded(() => parse(bytes, scopeOf(expected)));
}

/** @param {Buffer} bytes @param {ReturnType<typeof scopeOf>} scope */
function parse(bytes, scope) {
  if (!Buffer.isBuffer(bytes) || bytes.length > RECEIPT_BYTES) refuseCustody('BINDING_BYTES');
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return refuseCustody('BINDING_BYTES');
  }
  const receipt = validate(value, scope);
  if (!serializeReleaseBinding(receipt).equals(bytes)) refuseCustody('BINDING_BYTES');
  return receipt;
}

/**
 * Verify a retained candidate for reuse: the directory holds exactly its receipt, tarball and ciphertext,
 * the receipt is valid for the expectation, and each asset has the receipt's size and SHA-256. Returns the
 * verified bytes, never a path to open again; writes, renames and removes nothing.
 * @param {{directory: string, expected: Expected}} options
 */
export function verifyRetainedCandidate(options) {
  return bounded(() => {
    const { directory, expected } = isRecord(options) ? options : {};
    return verify(directory, expected);
  });
}

/** @param {string} directory @param {Expected} expected */
function verify(directory, expected) {
  const scope = scopeOf(expected);
  const { packageVersion } = scope;
  if (typeof packageVersion !== 'string' || !PACKAGE_VERSION.test(packageVersion)) {
    refuseCustody('BINDING_CANDIDATE');
  }
  const names = [
    RELEASE_BINDING_FILE,
    tarballName(packageVersion),
    ciphertextFileName(packageVersion),
  ].sort();
  if (!isDeepStrictEqual(readdirSync(directory).sort(), names)) refuseCustody('CANDIDATE_ENTRIES');
  let bytes;
  try {
    bytes = readOrdinaryFile(join(directory, RELEASE_BINDING_FILE), RECEIPT_BYTES);
  } catch {
    refuseCustody('CANDIDATE_ASSET');
  }
  const receipt = parse(bytes, scope);
  /** @param {{name: string, bytes: number, sha256: string}} entry */
  const retained = (entry) => {
    const path = join(directory, entry.name);
    let info;
    try {
      info = lstatSync(path);
    } catch {
      return refuseCustody('CANDIDATE_ASSET');
    }
    if (!info.isFile()) refuseCustody('CANDIDATE_ASSET');
    if (info.size !== entry.bytes) refuseCustody('CANDIDATE_SIZE');
    let data;
    try {
      data = readOrdinaryFile(path, entry.bytes);
    } catch {
      return refuseCustody('CANDIDATE_ASSET');
    }
    if (sha256(data) !== entry.sha256) refuseCustody('CANDIDATE_DIGEST');
    return data;
  };
  return Object.freeze({
    receipt,
    receiptBytes: bytes,
    tarball: retained(receipt.tarball),
    ciphertext: retained(receipt.ciphertext),
  });
}
