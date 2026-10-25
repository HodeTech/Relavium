/**
 * Release custody (Step 9b.2; packaging.md, "Recipient custody implementation boundary — Step 9b.2"): the
 * scope gate in front of the unchanged `encryptOnce`, and the release binding receipt's sealer. Production
 * scope encrypts only a clean, non-synthetic candidate to the loaded production recipient; synthetic scope
 * encrypts only a synthetic candidate, so neither a fixture key nor the per-run ephemeral key can ever
 * encrypt a product staging. The sealer accepts only a record this gate returned, and writes the receipt
 * once, after re-reading the ciphertext it names. This is the only release module that reaches GnuPG.
 */
import { Buffer } from 'node:buffer';
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
  ciphertextFileName,
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
 * @type {WeakMap<object, {kind: 'production' | 'synthetic', recipient: ProductionRecipient | undefined,
 *   manifest: import('./manifest.mjs').PrivateManifest, destination: string}>}
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
 * `encryptOnce` then runs on the caller's destination, so its own refusals follow unchanged.
 * @param {{scope: Scope, container: Buffer, destination: string, privateRoot: string, now?: number,
 *   run?: typeof import('./process.mjs').runCommand, gpg?: import('./gnupg.mjs').GnupgInstallation}}
 *   options
 * @returns {Promise<CustodyRecord>}
 */
export async function encryptCandidate(options) {
  let admitted;
  let ports;
  try {
    const { scope, container, destination, privateRoot, now, run, gpg } = isRecord(options)
      ? options
      : {};
    admitted = admit(scope, container, destination);
    ports = { destination, privateRoot, now, run, gpg };
  } catch (error) {
    // A host error's message names a path: only fixed custody codes leave.
    if (error instanceof CustodyError) throw error;
    refuseCustody('UNEXPECTED');
  }
  // The admitted copy is the one encrypted: the caller's buffer may change, it may not.
  const record = await encryptOnce({
    ...ports,
    container: admitted.container,
    recipient: admitted.recipient,
  });
  records.set(record, {
    kind: admitted.kind,
    recipient: admitted.production,
    manifest: admitted.manifest,
    destination: admitted.destination,
  });
  return record;
}

/**
 * Admit one encryption, reading the caller's scope and container once: the scope's rules, then a plain,
 * unsealed destination that holds exactly the candidate's tarball, all before any GnuPG call.
 * @param {unknown} scope @param {unknown} container @param {string} destination
 */
function admit(scope, container, destination) {
  const { kind, recipient: given } = isRecord(scope) ? scope : {};
  if ((kind !== 'production' && kind !== 'synthetic') || !isRecord(given)) refuseCustody('SCOPE');
  if (kind === 'production' && !isProductionRecipient(given)) refuseCustody('RECIPIENT_SOURCE');
  const bytes = Buffer.isBuffer(container) ? Buffer.from(container) : container;
  const { manifest } = readPrivateContainer(/** @type {Buffer} */ (bytes));
  let recipient;
  let production;
  if (kind === 'production') {
    if (manifest.source.dirty) refuseCustody('DIRTY_SOURCE');
    if (isSyntheticSource(manifest.source)) refuseCustody('SYNTHETIC_SOURCE');
    production = /** @type {ProductionRecipient} */ (given);
    recipient = { file: production.file, pins: production.current };
  } else {
    if (!isSyntheticSource(manifest.source)) refuseCustody('FIXTURE_SCOPE');
    recipient = { file: given.file, pins: given.pins };
  }
  if (present(join(destination, RELEASE_BINDING_FILE))) refuseCustody('ALREADY_SEALED');
  // A plain directory, as encryptOnce requires, resolved now so that nothing after the ciphertext is
  // published can fail on it.
  let resolved;
  try {
    if (!lstatSync(destination).isDirectory()) refuseCustody('PLACEMENT');
    resolved = realpathSync(destination);
  } catch (error) {
    if (error instanceof CustodyError) throw error;
    refuseCustody('PLACEMENT');
  }
  // The sealer admits exactly the tarball and the ciphertext: a destination holding anything else, or a
  // missing or different tarball, would leave an unsealable ciphertext, so it refuses first.
  const tarballFile = tarballName(manifest.packageVersion);
  const entries = readdirSync(resolved);
  if (entries.includes(ciphertextFileName(manifest.packageVersion))) {
    refuseCustody('ALREADY_ENCRYPTED');
  }
  if (!isDeepStrictEqual(entries, [tarballFile])) refuseCustody('CANDIDATE_ENTRIES');
  let tarball;
  try {
    tarball = readOrdinaryFile(join(resolved, tarballFile), ARCHIVE_LIMITS.compressedBytes);
  } catch {
    refuseCustody('TARBALL_DRIFT');
  }
  if (sha256(tarball) !== manifest.tarballSha256) refuseCustody('TARBALL_DRIFT');
  return { kind, recipient, production, manifest, container: bytes, destination: resolved };
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
  const { kind, recipient, manifest, destination } = entry;
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
    kind === 'production'
      ? {
          scope: /** @type {const} */ ('production'),
          recipient,
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
