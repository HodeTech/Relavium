/**
 * Recipient custody (Step 9b.1; ADR-0111; packaging.md, "Recipient custody"): encrypt a private
 * container once to one pinned recipient. The recipient file must hold exactly one OpenPGP v4 key
 * whose only usable encryption subkey is the pinned one, with a cv25519 or RSA ≥ 3072 encryption
 * subkey, neither expired, revoked nor disabled; a colon listing classifies it before GnuPG's own
 * refusal, a second, independent layer. The ciphertext must be SEIPDv1 with MDC and AES-256, carry
 * exactly one recipient — the pinned subkey — and is published once, never over an existing file.
 * Plaintext lives only in an owner-only work directory under the caller's private root, removed on
 * every path; the caller's interrupt scope stops GnuPG and removes that root. This library holds no
 * production recipient: Step 9b uses synthetic recipients only.
 */
import { randomUUID } from 'node:crypto';
import {
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readPrivateContainer } from './container.mjs';
import { CustodyError, refuseCustody } from './custody-error.mjs';
import { readOrdinaryFile, sha256 } from './files.mjs';
import { writePrivateFile } from './finalize.mjs';
import {
  GNUPG_CALL,
  assertHomeState,
  assertNoGlobalConfig,
  createGnupgHome,
  encryptArgs,
  gnupgEnvironment,
  gnupgVersion,
  listArgs,
  parseColons,
  parseStatus,
  recipientsArgs,
  resolveGpg,
} from './gnupg.mjs';
import { runCommand } from './process.mjs';

const FINGERPRINT = /^[0-9A-F]{40}$/u;
/**
 * An armored secret key, refused from the bytes before any listing: whether GnuPG lists secret input
 * (as `sec`/`ssb`, refused too) or fails depends on the home's agent socket path.
 */
const SECRET_ARMOR = ['-----BEGIN PGP', 'PRIVATE KEY BLOCK-----'].join(' ');
const RECIPIENT_BYTES = 256 * 1024;
/** Literal-packet and packet framing overhead a ciphertext may add to its container. */
const CIPHERTEXT_OVERHEAD = 64 * 1024;
/** The keywords a successful encryption never reports. */
const FAILURE_STATUS = Object.freeze([
  'INV_RECP',
  'NO_RECP',
  'FAILURE',
  'ERROR',
  'KEYEXPIRED',
  'KEYREVOKED',
  'INV_SGNR',
]);

/** The ciphertext's file name for a package version. */
export const ciphertextName = (version) => `relavium-${version}-private-maps.tar.gpg`;

/**
 * Maintainer-confirmed pins: the primary and encryption-subkey fingerprints, 40 uppercase hex digits
 * each (OpenPGP v4). A user ID, a short key ID or a `!` suffix refuses.
 * @param {unknown} pins
 * @returns {{primary: string, subkey: string}}
 */
export function parsePins(pins) {
  if (pins === null || typeof pins !== 'object') return refuseCustody('PIN_FORMAT');
  const { primary, subkey } = /** @type {Record<string, unknown>} */ (pins);
  if (
    !isDeepStrictEqual(Object.keys(pins).sort(), ['primary', 'subkey']) ||
    typeof primary !== 'string' ||
    typeof subkey !== 'string' ||
    !FINGERPRINT.test(primary) ||
    !FINGERPRINT.test(subkey)
  ) {
    refuseCustody('PIN_FORMAT');
  }
  return Object.freeze({ primary, subkey });
}

/**
 * The keys of a colon listing, each with its fingerprint.
 * @param {string[][]} records
 */
function keysOf(records) {
  /** @type {{type: string, fields: string[], fpr?: string}[]} */
  const keys = [];
  for (const fields of records) {
    if (['pub', 'sec', 'sub', 'ssb'].includes(fields[0])) keys.push({ type: fields[0], fields });
    else if (fields[0] === 'fpr' && keys.length > 0 && keys.at(-1).fpr === undefined) {
      keys.at(-1).fpr = fields[9];
    }
  }
  return keys;
}

/** @param {string[]} fields @param {number} now */
const expired = (fields, now) =>
  fields[1] === 'e' || (fields[6] !== '' && Number(fields[6]) <= now);

/**
 * A usable subkey with any of `capabilities`: `e` encrypts, and `r` marks an additional decryption
 * subkey (ADSK, GnuPG 2.4.1 and later), which GnuPG adds as a further recipient.
 * @param {string[]} fields @param {number} now @param {string} [capabilities]
 */
const usableEncryption = (fields, now, capabilities = 'e') =>
  !['e', 'r', 'i', 'n', 'd'].includes(fields[1]) &&
  !expired(fields, now) &&
  [...capabilities].some((capability) => fields[11].includes(capability)) &&
  !fields[11].includes('D');

/** The approved encryption-subkey algorithms: cv25519 ECDH, or RSA of at least 3072 bits. */
const approvedAlgorithm = (fields) =>
  (fields[3] === '18' && fields[16] === 'cv25519') ||
  (fields[3] === '1' && Number(fields[2]) >= 3072);

/**
 * Classify a recipient listing against its pins, in a fixed order: secret material, a missing primary,
 * more than one key, a missing subkey, revocation, expiry, unusability, then another usable
 * encryption or additional decryption subkey.
 * @param {string[][]} records colon records of `--show-keys`
 * @param {{primary: string, subkey: string}} pins
 * @param {number} now seconds since the epoch
 */
export function inspectRecipient(records, pins, now) {
  const keys = keysOf(records);
  if (keys.some((key) => key.type === 'sec' || key.type === 'ssb')) {
    refuseCustody('RECIPIENT_SECRET');
  }
  const primaries = keys.filter((key) => key.type === 'pub');
  const primary = primaries.find((key) => key.fpr === pins.primary);
  if (!primary) refuseCustody('RECIPIENT_MISSING');
  if (primaries.length !== 1) refuseCustody('RECIPIENT_UNEXPECTED');
  const subkeys = keys.filter((key) => key.type === 'sub');
  const pinned = keys.find((key) => key.fpr === pins.subkey);
  if (!pinned) refuseCustody('RECIPIENT_MISSING');
  if (primary.fields[1] === 'r' || pinned.fields[1] === 'r') refuseCustody('RECIPIENT_REVOKED');
  if (expired(primary.fields, now) || expired(pinned.fields, now)) {
    refuseCustody('RECIPIENT_EXPIRED');
  }
  if (
    pinned.type !== 'sub' ||
    ['i', 'n', 'd'].includes(primary.fields[1]) ||
    primary.fields[11].includes('D') ||
    !primary.fields[11].includes('E') ||
    !usableEncryption(pinned.fields, now) ||
    Number(primary.fields[5]) > now ||
    Number(pinned.fields[5]) > now ||
    !approvedAlgorithm(pinned.fields)
  ) {
    refuseCustody('RECIPIENT_UNUSABLE');
  }
  if (subkeys.some((key) => key !== pinned && usableEncryption(key.fields, now, 'er'))) {
    refuseCustody('RECIPIENT_UNEXPECTED');
  }
  return pins;
}

/** @param {string} root @param {string} path */
function within(root, path) {
  // Compared by identity, not spelling: a case-insensitive volume or a bind mount can give one
  // directory two spellings that no string comparison relates.
  const { dev, ino } = statSync(root, { bigint: true });
  for (let current = path; ; current = dirname(current)) {
    const info = statSync(current, { bigint: true });
    if (info.dev === dev && info.ino === ino) return true;
    if (dirname(current) === current) return false;
  }
}

/** A directory, not a link; a missing path is not one. */
function plainDirectory(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * An owner-only directory of this user, not a link; a missing path is not one. Windows modes say
 * nothing about access and no ACL check exists, so no directory there is one.
 */
function privateDirectory(path) {
  if (process.platform === 'win32') return false;
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return false;
  }
  return info.isDirectory() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.();
}

/**
 * Publish once and atomically: the bytes go to a fresh sibling, which is then hard-linked to the
 * final name. A link never replaces an existing file, and a failed write never leaves a partial
 * file under the final name.
 * @param {string} directory @param {string} name @param {Buffer} bytes
 */
function publish(directory, name, bytes) {
  const temporary = join(directory, `.${name}.${randomUUID()}.partial`);
  try {
    writePrivateFile(temporary, bytes);
    try {
      linkSync(temporary, join(directory, name));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        refuseCustody('ALREADY_ENCRYPTED');
      }
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * @typedef {{name: string, bytes: number, sha256: string,
 *   recipient: {primary: string, subkey: string}, gnupg: string}} CustodyRecord
 */

/**
 * Encrypt one container once to one pinned recipient and publish the ciphertext into `destination`.
 * @param {{
 *   container: Buffer,
 *   recipient: {file: string, pins: unknown},
 *   destination: string,
 *   privateRoot: string,
 *   now?: number,
 *   run?: typeof runCommand,
 *   gpg?: import('./gnupg.mjs').GnupgInstallation,
 * }} options
 * @returns {Promise<CustodyRecord>}
 */
export async function encryptOnce(options) {
  /** @type {{work?: string}} */
  const scope = {};
  /** @type {{record?: CustodyRecord, error?: CustodyError}} */
  let outcome;
  try {
    outcome = { record: await encrypt(options, scope) };
  } catch (error) {
    // A host error's message can name a private path: only fixed custody codes leave.
    outcome = { error: error instanceof CustodyError ? error : new CustodyError('UNEXPECTED') };
  }
  if (scope.work !== undefined) {
    try {
      rmSync(scope.work, { recursive: true, force: true });
    } catch {
      // The plaintext may remain: refuse with a fixed code rather than a host message.
      outcome = { error: new CustodyError('CLEANUP') };
    }
  }
  if (outcome.error) throw outcome.error;
  return /** @type {CustodyRecord} */ (outcome.record);
}

/**
 * The encryption itself; `scope.work` names its work directory as soon as it exists.
 * @param {Parameters<typeof encryptOnce>[0]} options
 * @param {{work?: string}} scope
 * @returns {Promise<CustodyRecord>}
 */
async function encrypt(
  {
    container,
    recipient,
    destination,
    privateRoot,
    now = Math.floor(Date.now() / 1000),
    run = runCommand,
    gpg,
  },
  scope,
) {
  const pins = parsePins(recipient.pins);
  const { manifest } = readPrivateContainer(container);
  const name = ciphertextName(manifest.packageVersion);
  if (!plainDirectory(destination)) refuseCustody('PLACEMENT');
  if (readdirSync(destination).includes(name)) refuseCustody('ALREADY_ENCRYPTED');
  if (!privateDirectory(privateRoot)) refuseCustody('PRIVATE_ROOT');
  const destinationPath = realpathSync(destination);
  const root = realpathSync(privateRoot);
  if (within(root, destinationPath) || within(destinationPath, root)) {
    refuseCustody('PLACEMENT');
  }
  const binary = gpg ?? resolveGpg();

  const work = mkdtempSync(join(root, 'custody-'));
  scope.work = work;
  const env = gnupgEnvironment(work);
  const listing = createGnupgHome(work, 'listing');
  const encryption = createGnupgHome(work, 'encryption');
  const recipientsHome = createGnupgHome(work, 'recipients');
  const call = async (args, code) => {
    try {
      return await run(binary.command, [...binary.prefix, ...args], { ...GNUPG_CALL, env });
    } catch {
      return refuseCustody(code);
    }
  };
  const version = await gnupgVersion(binary, { run, env, home: encryption });
  await assertNoGlobalConfig(binary, { run, env });

  // Every later step reads this copy, so the bytes checked are the bytes encrypted to.
  let key;
  try {
    key = readOrdinaryFile(recipient.file, RECIPIENT_BYTES);
  } catch {
    refuseCustody('RECIPIENT_UNREADABLE');
  }
  if (key.includes(SECRET_ARMOR)) refuseCustody('RECIPIENT_SECRET');
  const recipientPath = join(work, 'recipient.asc');
  writePrivateFile(recipientPath, key);
  const listed = await call(listArgs(listing, recipientPath), 'RECIPIENT_UNREADABLE');
  inspectRecipient(parseColons(String(listed.stdout)), pins, now);
  assertHomeState(listing, ['trustdb.gpg']);

  const input = join(work, 'container.tar');
  const output = join(work, 'ciphertext.gpg');
  writePrivateFile(input, container);
  const encrypted = await call(
    encryptArgs(encryption, recipientPath, input, output),
    'ENCRYPTION_FAILED',
  );
  const status = parseStatus(String(encrypted.stdout));
  if (status.some((line) => FAILURE_STATUS.includes(line.keyword))) refuseCustody('STATUS');
  const begins = status.filter((line) => line.keyword === 'BEGIN_ENCRYPTION');
  const ends = status.filter((line) => line.keyword === 'END_ENCRYPTION');
  const considered = status.filter((line) => line.keyword === 'KEY_CONSIDERED');
  if (
    begins.length !== 1 ||
    ends.length !== 1 ||
    status.indexOf(ends[0]) < status.indexOf(begins[0]) ||
    considered.length !== 1 ||
    !isDeepStrictEqual(considered[0].args.slice(0, 2), [pins.primary, '0'])
  ) {
    refuseCustody('STATUS');
  }
  // SEIPDv1 with MDC (method 2) and AES-256 (algorithm 9); an AEAD algorithm refuses.
  if (begins[0].args[0] !== '2' || begins[0].args[1] !== '9' || begins[0].args.length > 2) {
    refuseCustody('PROFILE');
  }
  assertHomeState(encryption, ['random_seed']);

  if (
    !isDeepStrictEqual(readdirSync(work).sort(), [
      'ciphertext.gpg',
      'container.tar',
      'encryption',
      'listing',
      'recipient.asc',
      'recipients',
    ])
  ) {
    refuseCustody('ASSET');
  }
  let ciphertext;
  try {
    ciphertext = readOrdinaryFile(output, container.length + CIPHERTEXT_OVERHEAD);
  } catch {
    refuseCustody('ASSET');
  }
  const listedRecipients = await call(recipientsArgs(recipientsHome, output), 'RECIPIENTS');
  const recipients = parseStatus(String(listedRecipients.stdout)).filter(
    (line) => line.keyword === 'ENC_TO',
  );
  if (
    recipients.length !== 1 ||
    // A hidden recipient's all-zero key ID never equals the pinned subkey's.
    recipients[0].args[0] !== pins.subkey.slice(-16)
  ) {
    refuseCustody('RECIPIENTS');
  }
  assertHomeState(recipientsHome, []);
  // The listed file must still be the bytes about to be published.
  let listedBytes;
  try {
    listedBytes = readOrdinaryFile(output, container.length + CIPHERTEXT_OVERHEAD);
  } catch {
    refuseCustody('ASSET');
  }
  if (!listedBytes.equals(ciphertext)) refuseCustody('ASSET');

  // The plaintext goes before anything is published, so a failed removal publishes nothing.
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    refuseCustody('CLEANUP');
  }
  scope.work = undefined;
  publish(destinationPath, name, ciphertext);
  return Object.freeze({
    name,
    bytes: ciphertext.length,
    sha256: sha256(ciphertext),
    recipient: Object.freeze({ primary: pins.primary, subkey: pins.subkey }),
    gnupg: version,
  });
}
