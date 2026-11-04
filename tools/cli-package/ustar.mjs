/**
 * The one strict USTAR dialect the packaging tools read and write (Step 9b.1, the 2026-10-19 C1 ruling):
 * regular files only, no linkname, owner strings, prefix, extension records or reserved bytes, zero
 * owner ids and device numbers, an exact two-block end and zero padding. The caller decides which
 * paths and modes it admits and how a refusal is reported. There is no extraction here and no fallback
 * to a more permissive platform tar.
 */
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

const BLOCK = 512;
const MAGIC = Buffer.from('ustar\0' + '00');

/** @param {Buffer} header */
function checksumOf(header) {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  return sum;
}

/** @param {Buffer} header */
export function writeChecksum(header) {
  header.fill(32, 148, 156);
  header.write(checksumOf(header).toString(8).padStart(6, '0'), 148);
  header[154] = 0;
  header[155] = 32;
}

/**
 * One regular-file entry: header, bytes and zero padding.
 * @param {string} path @param {Uint8Array} bytes @param {number} mode
 */
export function ustarEntry(path, bytes, mode) {
  const header = Buffer.alloc(BLOCK);
  header.write(path, 0, 100);
  for (const offset of [100, 108, 116, 329, 337]) header.write('000000 \0', offset);
  header.write(mode.toString(8).padStart(6, '0'), 100);
  header.write(bytes.length.toString(8).padStart(11, '0') + ' ', 124);
  header.write('00000000000 ', 136);
  header[156] = 48;
  MAGIC.copy(header, 257);
  writeChecksum(header);
  return Buffer.concat([header, bytes, Buffer.alloc((BLOCK - (bytes.length % BLOCK)) % BLOCK)]);
}

/**
 * A whole archive in the given entry order.
 * @param {Iterable<[string, Uint8Array]>} entries
 * @param {(path: string) => number} modeFor
 */
export function writeUstar(entries, modeFor) {
  return Buffer.concat([
    ...[...entries].map(([path, bytes]) => ustarEntry(path, bytes, modeFor(path))),
    Buffer.alloc(2 * BLOCK),
  ]);
}

/**
 * @typedef {{
 *   admitPath: (path: string) => void,
 *   modeFor: (path: string) => number,
 *   maxFiles: number,
 *   maxFileBytes: number,
 *   refuse: (code: string, cause?: unknown) => never,
 *   admitEntry?: (path: string) => void,
 *   onFile: (file: {path: string, mode: number, size: number, contents: Buffer}) => void,
 * }} UstarReader
 */

/**
 * Read every entry of an uncompressed archive in order. `admitEntry` runs after the header, duplicate
 * and case-alias checks and before the entry's bytes are bounded; `onFile` runs once its bytes and
 * padding are checked. Returns the entry count.
 * @param {Buffer} tar
 * @param {UstarReader} reader
 */
export function readUstar(tar, reader) {
  const { refuse } = reader;
  /** @param {Buffer} field */
  const octal = (field) => {
    const text = field.toString('latin1');
    if (!/^[0-7]+[ \0]*$/u.test(text)) refuse('TAR_NUMBER');
    const value = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(value)) refuse('TAR_NUMBER');
    return value;
  };
  /** @param {Buffer} field */
  const nameField = (field) => {
    const end = field.indexOf(0);
    if (end < 1 || field.subarray(end).some((byte) => byte !== 0)) refuse('TAR_NAME');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        field.subarray(0, end),
      );
    } catch (cause) {
      return refuse('UTF8', cause);
    }
  };
  /** @param {Buffer} header */
  const readHeader = (header) => {
    if (octal(header.subarray(148, 156)) !== checksumOf(header)) refuse('TAR_CHECKSUM');
    if (!header.subarray(257, 265).equals(MAGIC)) refuse('TAR_FORMAT');
    if (header[156] !== 48) refuse('TAR_TYPE');
    for (const [start, end] of [
      [157, 257],
      [265, 329],
      [345, 512],
    ]) {
      if (header.subarray(start, end).some((byte) => byte !== 0)) refuse('TAR_METADATA');
    }
    for (const [start, end] of [
      [108, 116],
      [116, 124],
      [329, 337],
      [337, 345],
    ]) {
      if (octal(header.subarray(start, end)) !== 0) refuse('TAR_METADATA');
    }
    octal(header.subarray(136, 148)); // Validate mtime syntax without requiring a clock value.
    const path = nameField(header.subarray(0, 100));
    reader.admitPath(path);
    const mode = octal(header.subarray(100, 108));
    if (mode !== reader.modeFor(path)) refuse('TAR_MODE');
    const size = octal(header.subarray(124, 136));
    if (size > reader.maxFileBytes) refuse('FILE_SIZE');
    return { path, mode, size };
  };

  const seen = new Set();
  const portableNames = new Set();
  let count = 0;
  let offset = 0;
  let ended = false;
  while (offset < tar.length) {
    if (tar.length - offset < BLOCK) refuse('TAR_TRUNCATED');
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset !== 2 * BLOCK || tar.subarray(offset).some((byte) => byte !== 0)) {
        refuse('TAR_END');
      }
      ended = true;
      break;
    }
    if (count >= reader.maxFiles) refuse('FILE_COUNT');
    const { path, mode, size } = readHeader(header);
    if (seen.has(path)) refuse('DUPLICATE_FILE');
    seen.add(path);
    if (portableNames.has(path.toLowerCase())) refuse('PATH_ALIAS');
    portableNames.add(path.toLowerCase());
    reader.admitEntry?.(path);
    const start = offset + BLOCK;
    const end = start + size;
    const next = start + Math.ceil(size / BLOCK) * BLOCK;
    if (next > tar.length) refuse('TAR_TRUNCATED');
    if (tar.subarray(end, next).some((byte) => byte !== 0)) refuse('TAR_PADDING');
    reader.onFile({ path, mode, size, contents: tar.subarray(start, end) });
    count += 1;
    offset = next;
  }
  if (!ended) refuse('TAR_END');
  return count;
}
