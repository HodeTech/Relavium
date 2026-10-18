import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { gunzipSync, inflateRawSync } from 'node:zlib';

// This inspects the pinned pnpm pack dialect, not arbitrary tar archives. There
// is no extraction and no fallback to a more permissive platform tar executable.
export const ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 16 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
  files: 1024,
  manifestBytes: 128 * 1024,
});

export class PackageArchiveError extends Error {
  /** @param {string} code @param {ErrorOptions} [options] */
  constructor(code, options) {
    // Never echo archive paths, manifest data or body contents in diagnostics.
    super(`CLI package archive refused: ${code}`, options);
    this.name = 'PackageArchiveError';
    this.code = code;
  }
}

/** @param {string} code @returns {never} */
function refuse(code) {
  throw new PackageArchiveError(code);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {Uint8Array} value */
function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {Uint8Array} bytes */
function utf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    throw new PackageArchiveError('UTF8', { cause });
  }
}

/** @param {Buffer} bytes */
function unpack(bytes) {
  if (bytes.length < 18 || bytes.length > ARCHIVE_LIMITS.compressedBytes) refuse('GZIP_SIZE');
  // Pinned pnpm emits one gzip member, DEFLATE, no optional fields. Rejecting
  // unknown flags also avoids two parsers interpreting different byte ranges.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8 || bytes[3] !== 0) {
    refuse('GZIP_HEADER');
  }
  try {
    // gunzip validates the native CRC/ISIZE. Its permissive concatenation and
    // trailing-zero behavior is separately fenced by exact DEFLATE consumption.
    const result = gunzipSync(bytes, { maxOutputLength: ARCHIVE_LIMITS.expandedBytes });
    /** @type {unknown} */
    const inflated = inflateRawSync(bytes.subarray(10), {
      info: true,
      maxOutputLength: ARCHIVE_LIMITS.expandedBytes,
    });
    if (
      !isRecord(inflated) ||
      !isRecord(inflated.engine) ||
      inflated.engine.bytesWritten !== bytes.length - 18
    ) {
      refuse('GZIP_TRAILING');
    }
    return result;
  } catch (cause) {
    if (cause instanceof PackageArchiveError) throw cause;
    throw new PackageArchiveError('GZIP_INVALID', { cause });
  }
}

/** @param {Buffer} field */
function octal(field) {
  const text = field.toString('latin1');
  if (!/^[0-7]+[ \0]*$/u.test(text)) refuse('TAR_NUMBER');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) refuse('TAR_NUMBER');
  return value;
}

/** @param {Buffer} field */
function nameField(field) {
  const end = field.indexOf(0);
  if (end < 1 || field.subarray(end).some((byte) => byte !== 0)) refuse('TAR_NAME');
  return utf8(field.subarray(0, end));
}

/** @param {string} path */
export function assertPublicPackagePath(path) {
  if (
    !/^package\/(?:dist\/[A-Za-z0-9_-]+\.js|drizzle\/[0-9]{4}_[a-z0-9_]+\.sql|drizzle\/meta\/(?:[0-9]{4}_snapshot|_journal)\.json|package\.json|README\.md|CHANGELOG\.md|LICENSE)$/u.test(
      path,
    )
  ) {
    refuse('PUBLIC_PATH');
  }
  if (/\/(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\.js$/iu.test(path)) refuse('PUBLIC_PATH');
}

/** @param {Buffer} header */
function readHeader(header) {
  const checksum = octal(header.subarray(148, 156));
  let actual = 0;
  for (let index = 0; index < 512; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  if (checksum !== actual) refuse('TAR_CHECKSUM');
  if (!header.subarray(257, 265).equals(Buffer.from('ustar\0' + '00'))) refuse('TAR_FORMAT');
  if (header[156] !== 48) refuse('TAR_TYPE');
  // No linkname, owner strings, prefix, extension records or reserved bytes.
  // A regular USTAR file is the only dialect produced by our current packer.
  for (const [start, end] of [
    [157, 257],
    [265, 329],
    [345, 512],
  ]) {
    if (start === undefined || end === undefined) refuse('TAR_FORMAT');
    if (header.subarray(start, end).some((byte) => byte !== 0)) refuse('TAR_METADATA');
  }
  for (const [start, end] of [
    [108, 116],
    [116, 124],
    [329, 337],
    [337, 345],
  ]) {
    if (start === undefined || end === undefined) refuse('TAR_FORMAT');
    if (octal(header.subarray(start, end)) !== 0) refuse('TAR_METADATA');
  }
  octal(header.subarray(136, 148)); // Validate mtime syntax without requiring a clock value.
  const path = nameField(header.subarray(0, 100));
  assertPublicPackagePath(path);
  const mode = octal(header.subarray(100, 108));
  if (mode !== (path === 'package/dist/index.js' ? 0o755 : 0o644)) refuse('TAR_MODE');
  const size = octal(header.subarray(124, 136));
  if (size > ARCHIVE_LIMITS.fileBytes) refuse('FILE_SIZE');
  return { path, mode, size };
}

/** @param {Buffer} bytes @param {Record<string, unknown>} expected */
function manifest(bytes, expected) {
  if (bytes.length > ARCHIVE_LIMITS.manifestBytes) refuse('MANIFEST_SIZE');
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(utf8(bytes));
  } catch (cause) {
    throw new PackageArchiveError('MANIFEST_JSON', { cause });
  }
  if (!isRecord(parsed) || !isDeepStrictEqual(parsed, expected)) refuse('MANIFEST_DRIFT');
  if (
    parsed.name !== 'relavium' ||
    typeof parsed.version !== 'string' ||
    parsed.private === true ||
    !isRecord(parsed.dependencies)
  ) {
    refuse('MANIFEST_RUNTIME');
  }
  if (
    !isRecord(parsed.bin) ||
    Object.keys(parsed.bin).length !== 1 ||
    (parsed.bin.relavium !== 'dist/index.js' && parsed.bin.relavium !== './dist/index.js')
  )
    refuse('MANIFEST_BIN');
  if (!isRecord(parsed.engines) || parsed.engines.node !== '>=22') refuse('MANIFEST_NODE_FLOOR');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = parsed[field];
    if (dependencies === undefined) continue;
    if (!isRecord(dependencies)) refuse('MANIFEST_RUNTIME');
    for (const [name, version] of Object.entries(dependencies)) {
      if (
        name.startsWith('@relavium/') ||
        typeof version !== 'string' ||
        /^(?:workspace|catalog|file|link):/u.test(version)
      ) {
        refuse('MANIFEST_RUNTIME');
      }
    }
  }
  return parsed;
}

/**
 * Compare an actual packed artifact with the caller's finalized public inventory.
 * The expected manifest includes pnpm's catalog/workspace publication transform;
 * it is compared semantically in full, every other file byte-for-byte.
 * @param {Uint8Array} bytes
 * @param {{expectedFiles: Map<string, Uint8Array | {sha256: string, bytes: number}>, expectedPackage: Record<string, unknown>}} options
 * @returns {{sha256: string, bytes: number, files: {path: string, bytes: number, sha256: string, mode: number}[], package: Record<string, unknown>}}
 * @throws {PackageArchiveError} for an unsupported or mismatching archive.
 */
export function inspectPackageArchive(bytes, { expectedFiles, expectedPackage }) {
  if (!(bytes instanceof Uint8Array)) refuse('ARCHIVE_INPUT');
  if (!(expectedFiles instanceof Map) || expectedFiles.size > ARCHIVE_LIMITS.files) {
    refuse('EXPECTED_INVENTORY');
  }
  for (const [path, contents] of expectedFiles) {
    assertPublicPackagePath(path);
    if (contents instanceof Uint8Array) {
      if (contents.byteLength > ARCHIVE_LIMITS.fileBytes) refuse('EXPECTED_INVENTORY');
    } else if (
      !isRecord(contents) ||
      Object.keys(contents).length !== 2 ||
      typeof contents.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(contents.sha256) ||
      typeof contents.bytes !== 'number' ||
      !Number.isSafeInteger(contents.bytes) ||
      contents.bytes < 0 ||
      contents.bytes > ARCHIVE_LIMITS.fileBytes
    ) {
      refuse('EXPECTED_INVENTORY');
    }
  }
  if (!expectedFiles.has('package/package.json') || !expectedFiles.has('package/dist/index.js')) {
    refuse('EXPECTED_INVENTORY');
  }
  if (bytes.byteLength > ARCHIVE_LIMITS.compressedBytes) refuse('GZIP_SIZE');
  const compressed = Buffer.from(bytes);
  const tar = unpack(compressed);
  const seen = new Set();
  const portableNames = new Set();
  const files = [];
  let offset = 0;
  let ended = false;
  /** @type {Record<string, unknown> | undefined} */
  let packageManifest;
  while (offset < tar.length) {
    if (tar.length - offset < 512) refuse('TAR_TRUNCATED');
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset !== 1024 || tar.subarray(offset).some((byte) => byte !== 0)) {
        refuse('TAR_END');
      }
      ended = true;
      break;
    }
    if (files.length >= ARCHIVE_LIMITS.files) refuse('FILE_COUNT');
    const { path, mode, size } = readHeader(header);
    if (seen.has(path)) refuse('DUPLICATE_FILE');
    seen.add(path);
    if (portableNames.has(path.toLowerCase())) refuse('PATH_ALIAS');
    portableNames.add(path.toLowerCase());
    const expected = expectedFiles.get(path);
    if (expected === undefined) refuse('EXTRA_FILE');
    const start = offset + 512;
    const end = start + size;
    const next = start + Math.ceil(size / 512) * 512;
    if (next > tar.length) refuse('TAR_TRUNCATED');
    if (tar.subarray(end, next).some((byte) => byte !== 0)) refuse('TAR_PADDING');
    const contents = tar.subarray(start, end);
    if (path === 'package/package.json') packageManifest = manifest(contents, expectedPackage);
    if (expected instanceof Uint8Array) {
      if (path !== 'package/package.json' && !contents.equals(expected)) refuse('FILE_DRIFT');
    } else if (contents.length !== expected.bytes || digest(contents) !== expected.sha256) {
      refuse('FILE_DRIFT');
    }
    if (path.endsWith('.js')) {
      const source = utf8(contents);
      if (
        path === 'package/dist/index.js'
          ? !source.startsWith('#!/usr/bin/env node\n')
          : source.startsWith('#!')
      ) {
        refuse('HASHBANG');
      }
      if (/sourceMappingURL\s*=/u.test(source)) refuse('MAP_LINK');
    }
    files.push({ path, bytes: size, sha256: digest(contents), mode });
    offset = next;
  }
  if (!ended) refuse('TAR_END');
  if (seen.size !== expectedFiles.size || !packageManifest) refuse('MISSING_FILE');
  return {
    sha256: digest(compressed),
    bytes: compressed.length,
    files: files.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
    package: packageManifest,
  };
}
