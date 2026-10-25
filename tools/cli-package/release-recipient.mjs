/**
 * The production recipient and the release scopes (Step 9b.2; packaging.md, "Recipient custody
 * implementation boundary — Step 9b.2"). One committed directory holds the production recipient:
 * `recipient.asc`, the `gpg --armor --export '<subkey>!'` export, and `pins.json`, an append-only history in
 * which exactly one recipient is current and none is ever removed, so an earlier candidate still verifies
 * after a rotation. There is no environment variable, flag or fallback. In Wave 3 the directory does not
 * exist, so every production use refuses; Wave 4b commits the files. A loaded recipient is branded: only the
 * value this module returned counts as a production recipient, never a copy of it.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { CustodyError, refuseCustody } from './custody-error.mjs';
import { readOrdinaryFile } from './files.mjs';

/** The committed production recipient directory, without a trailing separator so a link is never followed. */
export const PRODUCTION_RECIPIENT_ROOT = fileURLToPath(
  new URL('./release-recipient', import.meta.url),
);
/** The committed synthetic fixtures' pins: no production history may name one of their keys. */
export const FIXTURE_PINS_FILE = fileURLToPath(
  new URL('./custody-fixtures/pins.json', import.meta.url),
);
/** The source every synthetic candidate the fixtures seal records: never a real commit or tree. */
export const SYNTHETIC_SOURCE = Object.freeze({ commit: 'c'.repeat(40), tree: 'b'.repeat(40) });

const FILES = Object.freeze(['pins.json', 'recipient.asc']);
const FILE_BYTES = 64 * 1024;
const MAX_RECIPIENTS = 32;
const FINGERPRINT = /^[0-9A-F]{40}$/u;
/** @type {WeakSet<object>} */
const loaded = new WeakSet();

/**
 * @typedef {{primary: string, subkey: string}} Pins
 * @typedef {{file: string, current: Pins, history: readonly (Pins & {status: 'current' | 'retired'})[]}}
 *   ProductionRecipient
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value */
const isFingerprint = (value) => typeof value === 'string' && FINGERPRINT.test(value);

/** Whether `source` is the synthetic candidates' sentinel source. @param {{commit: string, tree: string}} source */
export const isSyntheticSource = (source) =>
  source.commit === SYNTHETIC_SOURCE.commit && source.tree === SYNTHETIC_SOURCE.tree;

/** Whether `value` is a recipient this module loaded: a copy or a hand-built object is not. */
export const isProductionRecipient = (value) => loaded.has(value);

/** @param {Buffer} bytes */
function parseHistory(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return refuseCustody('PRODUCTION_RECIPIENT_INVALID');
  }
  if (
    !isRecord(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), ['recipients', 'version']) ||
    value.version !== 1 ||
    !Array.isArray(value.recipients) ||
    value.recipients.length < 1 ||
    value.recipients.length > MAX_RECIPIENTS
  ) {
    refuseCustody('PRODUCTION_RECIPIENT_INVALID');
  }
  const history = value.recipients.map((entry) => {
    if (
      !isRecord(entry) ||
      !isDeepStrictEqual(Object.keys(entry).sort(), ['primary', 'status', 'subkey']) ||
      !isFingerprint(entry.primary) ||
      !isFingerprint(entry.subkey) ||
      (entry.status !== 'current' && entry.status !== 'retired')
    ) {
      refuseCustody('PRODUCTION_RECIPIENT_INVALID');
    }
    return Object.freeze({ primary: entry.primary, subkey: entry.subkey, status: entry.status });
  });
  if (
    history.filter((entry) => entry.status === 'current').length !== 1 ||
    new Set(history.map((entry) => entry.subkey)).size !== history.length
  ) {
    refuseCustody('PRODUCTION_RECIPIENT_INVALID');
  }
  return Object.freeze(history);
}

/** Every fingerprint the committed fixtures name. @param {string} file */
function fixtureFingerprints(file) {
  let pins;
  try {
    pins = JSON.parse(readOrdinaryFile(file, FILE_BYTES).toString('utf8'));
  } catch {
    return refuseCustody('PRODUCTION_RECIPIENT_INVALID');
  }
  if (!isRecord(pins)) refuseCustody('PRODUCTION_RECIPIENT_INVALID');
  return new Set(
    Object.values(pins).flatMap((entry) => (isRecord(entry) ? [entry.primary, entry.subkey] : [])),
  );
}

/**
 * Load the production recipient. `root` and `fixtures` are test seams only; no product path passes them.
 * @param {{root?: string, fixtures?: string}} [options]
 * @returns {ProductionRecipient}
 */
export function loadProductionRecipient({
  root = PRODUCTION_RECIPIENT_ROOT,
  fixtures = FIXTURE_PINS_FILE,
} = {}) {
  try {
    return load(root, fixtures);
  } catch (error) {
    // A host error's message names a path: only fixed custody codes leave.
    if (error instanceof CustodyError) throw error;
    return refuseCustody('PRODUCTION_RECIPIENT_INVALID');
  }
}

/** @param {string} root @param {string} fixtures @returns {ProductionRecipient} */
function load(root, fixtures) {
  let info;
  try {
    info = lstatSync(root);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      refuseCustody('PRODUCTION_RECIPIENT_ABSENT');
    }
    throw error;
  }
  // lstat: a linked directory is not the committed one.
  if (!info.isDirectory() || !isDeepStrictEqual(readdirSync(root).sort(), FILES)) {
    refuseCustody('PRODUCTION_RECIPIENT_INVALID');
  }
  const file = join(root, 'recipient.asc');
  let pins;
  try {
    readOrdinaryFile(file, FILE_BYTES);
    pins = readOrdinaryFile(join(root, 'pins.json'), FILE_BYTES);
  } catch {
    refuseCustody('PRODUCTION_RECIPIENT_INVALID');
  }
  const history = parseHistory(pins);
  const forbidden = fixtureFingerprints(fixtures);
  if (history.some((entry) => forbidden.has(entry.primary) || forbidden.has(entry.subkey))) {
    refuseCustody('FIXTURE_RECIPIENT');
  }
  const current = history.find((entry) => entry.status === 'current');
  const recipient = Object.freeze({
    file,
    current: Object.freeze({ primary: current.primary, subkey: current.subkey }),
    history,
  });
  loaded.add(recipient);
  return recipient;
}
