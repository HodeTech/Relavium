/**
 * Release custody (Step 9b.2; packaging.md, "Recipient custody implementation boundary — Step 9b.2"): the
 * scope gate in front of the unchanged `encryptOnce`, and the release binding receipt's sealer. Production
 * scope encrypts only a clean, non-synthetic candidate to the loaded production recipient; synthetic scope
 * encrypts only a synthetic candidate, so neither a fixture key nor the per-run ephemeral key can ever
 * encrypt a product staging. The sealer accepts only a record this gate returned, and writes the receipt
 * once, after re-reading the ciphertext it names. This is the only release module that reaches GnuPG.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ARCHIVE_LIMITS } from './archive.mjs';
import { readPrivateContainer } from './container.mjs';
import { CustodyError, refuseCustody } from './custody-error.mjs';
import { encryptOnce } from './custody.mjs';
import { readOrdinaryFile, sha256 } from './files.mjs';
import {
  RELEASE_BINDING_FILE,
  RELEASE_BINDING_KIND,
  serializeReleaseBinding,
  tarballName,
  validateReleaseBinding,
} from './release-binding.mjs';
import { isProductionRecipient, isSyntheticSource } from './release-recipient.mjs';

/**
 * @typedef {import('./custody.mjs').CustodyRecord} CustodyRecord
 * @typedef {import('./release-recipient.mjs').ProductionRecipient} ProductionRecipient
 * @typedef {{kind: 'production', recipient: ProductionRecipient}
 *   | {kind: 'synthetic', recipient: {file: string, pins: unknown}}} Scope
 */

/**
 * The records the gate returned, with what the sealer needs to bind them.
 * @type {WeakMap<object, {scope: Scope, manifest: import('./manifest.mjs').PrivateManifest,
 *   destination: string}>}
 */
const records = new WeakMap();

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Whether `path` names an entry, a dangling link included. @param {string} path */
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a candidate's container once for its scope. Every refusal here comes before any GnuPG call;
 * `encryptOnce`'s own refusals follow unchanged.
 * @param {{scope: Scope, container: Buffer, destination: string, privateRoot: string, now?: number,
 *   run?: typeof import('./process.mjs').runCommand, gpg?: import('./gnupg.mjs').GnupgInstallation}}
 *   options
 * @returns {Promise<CustodyRecord>}
 */
export async function encryptCandidate({
  scope,
  container,
  destination,
  privateRoot,
  now,
  run,
  gpg,
}) {
  let admitted;
  try {
    admitted = admit(scope, container, destination);
  } catch (error) {
    // A host error's message names a path: only fixed custody codes leave.
    if (error instanceof CustodyError) throw error;
    refuseCustody('UNEXPECTED');
  }
  const record = await encryptOnce({
    container,
    recipient: admitted.recipient,
    destination,
    privateRoot,
    now,
    run,
    gpg,
  });
  try {
    records.set(record, {
      scope,
      manifest: admitted.manifest,
      destination: realpathSync(destination),
    });
  } catch {
    refuseCustody('UNEXPECTED');
  }
  return record;
}

/** @param {unknown} scope @param {Buffer} container @param {string} destination */
function admit(scope, container, destination) {
  if (
    !isRecord(scope) ||
    (scope.kind !== 'production' && scope.kind !== 'synthetic') ||
    !isRecord(scope.recipient)
  ) {
    refuseCustody('SCOPE');
  }
  if (scope.kind === 'production' && !isProductionRecipient(scope.recipient)) {
    refuseCustody('RECIPIENT_SOURCE');
  }
  const { manifest } = readPrivateContainer(container);
  let recipient;
  if (scope.kind === 'production') {
    if (manifest.source.dirty) refuseCustody('DIRTY_SOURCE');
    if (isSyntheticSource(manifest.source)) refuseCustody('SYNTHETIC_SOURCE');
    const production = /** @type {ProductionRecipient} */ (scope.recipient);
    recipient = { file: production.file, pins: production.current };
  } else {
    if (!isSyntheticSource(manifest.source)) refuseCustody('FIXTURE_SCOPE');
    recipient = /** @type {{file: string, pins: unknown}} */ (scope.recipient);
  }
  if (present(join(destination, RELEASE_BINDING_FILE))) refuseCustody('ALREADY_SEALED');
  return { manifest, recipient };
}

/** Write a new public file durably; an existing file refuses. @param {string} path @param {Buffer} bytes */
function writePublicFile(path, bytes) {
  const descriptor = openSync(path, 'wx', 0o644);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Publish once and atomically: the bytes go to a fresh sibling, which is then hard-linked to the final
 * name. A link never replaces an existing receipt, and a failed write never leaves a partial file under
 * the final name. Once the link exists the receipt is published: a sibling that cannot be removed then
 * is left behind rather than reported as a refusal.
 * @param {string} directory @param {Buffer} bytes @param {(path: string, bytes: Buffer) => void} write
 */
function publish(directory, bytes, write) {
  const temporary = join(directory, `.${RELEASE_BINDING_FILE}.${randomUUID()}.partial`);
  try {
    write(temporary, bytes);
    try {
      linkSync(temporary, join(directory, RELEASE_BINDING_FILE));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        refuseCustody('ALREADY_SEALED');
      }
      throw error;
    }
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best effort: the final name alone is the published claim.
    }
  }
}

/**
 * Seal the release binding receipt for a record `encryptCandidate` returned, beside its ciphertext and
 * the candidate's tarball. `origin` is the originating trusted run (Step 9d supplies and binds it); `write`
 * is a test seam for fault injection.
 * @param {CustodyRecord} record
 * @param {{origin?: unknown, write?: (path: string, bytes: Buffer) => void}} [options]
 * @returns {{receipt: ReturnType<typeof validateReleaseBinding>, bytes: Buffer}}
 */
export function sealReleaseBinding(record, { origin, write = writePublicFile } = {}) {
  try {
    return seal(record, origin, write);
  } catch (error) {
    if (error instanceof CustodyError) throw error;
    return refuseCustody('UNEXPECTED');
  }
}

/**
 * @param {CustodyRecord} record @param {unknown} origin
 * @param {(path: string, bytes: Buffer) => void} write
 */
function seal(record, origin, write) {
  const entry = records.get(record);
  if (entry === undefined) refuseCustody('RECORD_SOURCE');
  const { scope, manifest, destination } = entry;
  // An existing receipt refuses before anything is read; one is never written over.
  if (present(join(destination, RELEASE_BINDING_FILE))) refuseCustody('ALREADY_SEALED');
  const tarball = tarballName(manifest.packageVersion);
  if (!isDeepStrictEqual(readdirSync(destination).sort(), [record.name, tarball].sort())) {
    refuseCustody('CANDIDATE_ENTRIES');
  }
  // The ciphertext must still be the bytes encrypted: the receipt is sealed only after it exists.
  let ciphertext;
  try {
    ciphertext = readOrdinaryFile(join(destination, record.name), record.bytes);
  } catch {
    refuseCustody('CIPHERTEXT_DRIFT');
  }
  if (ciphertext.length !== record.bytes || sha256(ciphertext) !== record.sha256) {
    refuseCustody('CIPHERTEXT_DRIFT');
  }
  let tarballBytes;
  try {
    tarballBytes = readOrdinaryFile(join(destination, tarball), ARCHIVE_LIMITS.compressedBytes);
  } catch {
    refuseCustody('TARBALL_DRIFT');
  }
  const tarballSha256 = sha256(tarballBytes);
  if (tarballSha256 !== manifest.tarballSha256) refuseCustody('TARBALL_DRIFT');

  const expected =
    scope.kind === 'production'
      ? {
          scope: /** @type {const} */ ('production'),
          recipient: scope.recipient,
          packageVersion: manifest.packageVersion,
          source: manifest.source.commit,
        }
      : {
          scope: /** @type {const} */ ('synthetic'),
          pins: record.recipient,
          packageVersion: manifest.packageVersion,
        };
  const receipt = validateReleaseBinding(
    {
      version: 1,
      kind: RELEASE_BINDING_KIND,
      packageVersion: manifest.packageVersion,
      source: { ...manifest.source },
      tarball: { name: tarball, bytes: tarballBytes.length, sha256: tarballSha256 },
      ciphertext: { name: record.name, bytes: record.bytes, sha256: record.sha256 },
      recipient: { ...record.recipient },
      toolchain: { ...manifest.toolchain, gnupg: record.gnupg },
      target: manifest.target,
      inputs: { ...manifest.inputs },
      mapCheck: { status: 'complete' },
      origin,
    },
    expected,
  );
  const bytes = serializeReleaseBinding(receipt);
  publish(destination, bytes, write);
  records.delete(record);
  return Object.freeze({ receipt, bytes });
}
