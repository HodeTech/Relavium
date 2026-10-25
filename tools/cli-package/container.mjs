/**
 * The private custody container (Step 9b.1; packaging.md, "Recipient custody" and the private map
 * manifest). One strict owner-only USTAR of the sealed staging — `finalized.json`, `manifest.json`,
 * `metafile-esm.json` and `maps/<chunk>.js.map`, staging-relative — so a decrypted, extracted container
 * is a staging directory the manifest reader and symbolication consume unchanged. It is built only from
 * a staging whose every map is the one the manifest and the finalizer's record name, and read back with
 * the same checks.
 */
import { Buffer } from 'node:buffer';
import { lstatSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { refuseCustody } from './custody-error.mjs';
import { readOrdinaryFile, sha256 } from './files.mjs';
import { MANIFEST_FILE, validateManifest } from './manifest.mjs';
import { readUstar, writeUstar } from './ustar.mjs';

export const CONTAINER_LIMITS = Object.freeze({
  entryBytes: 16 * 1024 * 1024,
  // The three records plus one map for each of the manifest's at most 256 outputs.
  entries: 259,
  totalBytes: 128 * 1024 * 1024,
});
const RECORDS = Object.freeze(['finalized.json', MANIFEST_FILE, 'metafile-esm.json']);
const MAP = /^maps\/[A-Za-z0-9_-]+\.js\.map$/u;
const ENTRY_MODE = 0o600;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {Buffer} bytes @param {string} code */
function json(bytes, code) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return refuseCustody(code);
  }
}

/**
 * The finalizer's record of `{path, bytes, sha256}` entries, sorted by path.
 * @param {unknown} list
 * @returns {{path: string, bytes: number, sha256: string}[]}
 */
function recorded(list) {
  if (
    !Array.isArray(list) ||
    !list.every(
      (item) =>
        isRecord(item) &&
        isDeepStrictEqual(Object.keys(item).sort(), ['bytes', 'path', 'sha256']) &&
        typeof item.path === 'string' &&
        Number.isSafeInteger(item.bytes) &&
        typeof item.sha256 === 'string',
    )
  ) {
    refuseCustody('CONTAINER_RECORD');
  }
  return [...list].sort((left, right) => (left.path < right.path ? -1 : 1));
}

/**
 * Check a container's entries as a whole: exactly the three records and one map per manifest output,
 * each map the manifest's and the finalizer record's, the record naming exactly the manifest's files.
 * @param {Map<string, Buffer>} files
 */
function checkContents(files) {
  for (const name of RECORDS) if (!files.has(name)) refuseCustody('CONTAINER_SET');
  const manifest = (() => {
    try {
      return validateManifest(
        json(/** @type {Buffer} */ (files.get(MANIFEST_FILE)), 'CONTAINER_RECORD'),
      );
    } catch {
      return refuseCustody('CONTAINER_RECORD');
    }
  })();
  const maps = manifest.outputs.map((output) => `maps/${posix.basename(output.map.path)}`);
  if (
    !isDeepStrictEqual(
      [...files.keys()].filter((path) => !RECORDS.includes(path)).sort(),
      [...maps].sort(),
    )
  ) {
    refuseCustody('CONTAINER_SET');
  }
  for (const [index, output] of manifest.outputs.entries()) {
    if (sha256(/** @type {Buffer} */ (files.get(maps[index]))) !== output.map.sha256) {
      refuseCustody('CONTAINER_DRIFT');
    }
  }
  // The manifest records no digest for the metafile; it must at least be the finalizer's JSON object.
  if (!isRecord(json(/** @type {Buffer} */ (files.get('metafile-esm.json')), 'CONTAINER_RECORD'))) {
    refuseCustody('CONTAINER_RECORD');
  }
  const record = json(/** @type {Buffer} */ (files.get('finalized.json')), 'CONTAINER_RECORD');
  if (
    !isRecord(record) ||
    !isDeepStrictEqual(Object.keys(record).sort(), [
      'maps',
      'outputs',
      'upstreamMaps',
      'version',
    ]) ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.upstreamMaps)
  ) {
    refuseCustody('CONTAINER_RECORD');
  }
  const outputs = recorded(record.outputs);
  const recordedMaps = recorded(record.maps);
  if (
    !isDeepStrictEqual(
      outputs.map((item) => [item.path, item.sha256]),
      manifest.outputs.map((output) => [output.path, output.sha256]),
    ) ||
    !isDeepStrictEqual(
      recordedMaps.map((item) => [item.path, item.sha256, item.bytes]),
      manifest.outputs.map((output, index) => [
        output.map.path,
        output.map.sha256,
        /** @type {Buffer} */ (files.get(maps[index])).length,
      ]),
    )
  ) {
    refuseCustody('CONTAINER_RECORD');
  }
  return manifest;
}

/** @param {Map<string, Buffer>} files */
function containerBytes(files) {
  // A header block per entry, padding to the block, and the two-block end.
  return [...files.values()].reduce(
    (total, bytes) => total + 512 + Math.ceil(bytes.length / 512) * 512,
    1024,
  );
}

/**
 * Read the sealed staging into one container. The staging must hold exactly the three records and
 * `maps/` with exactly the manifest's maps, all regular files within the entry bound.
 * @param {string} staging
 * @param {typeof CONTAINER_LIMITS} [limits]
 * @returns {{bytes: Buffer, manifest: import('./manifest.mjs').PrivateManifest}}
 */
export function buildPrivateContainer(staging, limits = CONTAINER_LIMITS) {
  /** @param {string} path */
  const read = (path) => {
    try {
      return readOrdinaryFile(path, limits.entryBytes);
    } catch {
      return refuseCustody('CONTAINER_ENTRY');
    }
  };
  if (!isDeepStrictEqual(readdirSync(staging).sort(), [...RECORDS, 'maps'].sort())) {
    refuseCustody('CONTAINER_SET');
  }
  // lstat: a linked maps directory is not a directory.
  if (!lstatSync(join(staging, 'maps')).isDirectory()) refuseCustody('CONTAINER_SET');
  const names = readdirSync(join(staging, 'maps')).sort();
  if (names.length > limits.entries - RECORDS.length) refuseCustody('CONTAINER_SIZE');
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  for (const name of RECORDS) files.set(name, read(join(staging, name)));
  for (const name of names) {
    if (!MAP.test(`maps/${name}`)) refuseCustody('CONTAINER_SET');
    files.set(`maps/${name}`, read(join(staging, 'maps', name)));
  }
  const manifest = checkContents(files);
  // Refused before the archive is assembled in memory; the read-back check would refuse it after.
  if (containerBytes(files) > limits.totalBytes) refuseCustody('CONTAINER_TOTAL');
  const sorted = [...files].sort(([left], [right]) => (left < right ? -1 : 1));
  const bytes = writeUstar(sorted, () => ENTRY_MODE);
  // The written container must read back as exactly these entries.
  const again = readPrivateContainer(bytes, limits);
  if (!isDeepStrictEqual([...again.files], sorted)) refuseCustody('CONTAINER_SELF_CHECK');
  return { bytes, manifest };
}

/**
 * Read and check a container: the strict owner-only dialect, the bounds, and the contents as a whole.
 * @param {Buffer} bytes
 * @param {typeof CONTAINER_LIMITS} [limits]
 * @returns {{files: Map<string, Buffer>, manifest: import('./manifest.mjs').PrivateManifest}}
 */
export function readPrivateContainer(bytes, limits = CONTAINER_LIMITS) {
  if (!Buffer.isBuffer(bytes) || bytes.length > limits.totalBytes) refuseCustody('CONTAINER_SIZE');
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  readUstar(bytes, {
    admitPath: (path) => {
      if (!RECORDS.includes(path) && !MAP.test(path)) refuseCustody('CONTAINER_PATH');
    },
    modeFor: () => ENTRY_MODE,
    maxFiles: limits.entries,
    maxFileBytes: limits.entryBytes,
    refuse: (code) => refuseCustody(`CONTAINER_${code}`),
    onFile: ({ path, contents }) => files.set(path, Buffer.from(contents)),
  });
  return { files, manifest: checkContents(files) };
}
