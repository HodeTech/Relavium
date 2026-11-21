import { timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

/**
 * The file primitives the operator's two permission files share (the grants file and the write-mark file, ADR-0118 §2,
 * ADR-0138): the same refusal of a symbolic link, a FIFO, a device and a directory, the same bounded read, the same
 * constant-time digest comparison. One copy, so the two files cannot drift apart in what they refuse.
 */

export const HEX_DIGEST = /^[0-9a-f]{64}$/u;
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/u;
export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

/** `undefined` when the path does not exist; `'error'` when it cannot be inspected (a permission, a non-directory in the way). */
export function statState(path: string): ReturnType<typeof lstatSync> | undefined | 'error' {
  try {
    return lstatSync(path);
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
      ? undefined
      : 'error';
  }
}

/** Constant-time comparison of two hex digests. */
export function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export type RegularFileRead =
  | { readonly kind: 'text'; readonly text: string; readonly bytes: number }
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'refused';
      /** Why, in words a notice can finish ("it is a symbolic link"). */
      readonly why: string;
      /** The refusal is one `revoke --all` cannot clear (a directory in the way): the notice says to remove it by hand. */
      readonly byHand: boolean;
    };

/**
 * Read the file as a regular file only. An `lstat` refuses a symlink on every platform; the open then does not follow one and
 * does not block (where the platform has those flags), and the descriptor is checked, so a symlink, a FIFO or a device at the
 * path reads as "refused" instead of being followed or hanging the approval hook. Exactly the bytes `fstat` reported are read,
 * so the size bound is the size that was checked.
 */
export function readRegularFile(path: string, bound: number): RegularFileRead {
  const seen = statState(path);
  if (seen === undefined) return { kind: 'absent' };
  if (seen === 'error') return { kind: 'refused', why: 'it cannot be inspected', byHand: false };
  if (seen.isSymbolicLink()) {
    return { kind: 'refused', why: 'it is a symbolic link', byHand: false };
  }
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const info = fstatSync(fd);
    if (info.isDirectory()) return { kind: 'refused', why: 'it is a directory', byHand: true };
    if (!info.isFile()) {
      return { kind: 'refused', why: 'it is not a regular file', byHand: false };
    }
    if (info.size > bound) {
      return { kind: 'refused', why: 'it is larger than the size bound', byHand: false };
    }
    const buffer = Buffer.alloc(info.size);
    let filled = 0;
    while (filled < buffer.length) {
      const count = readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (count === 0) break;
      filled += count;
    }
    return { kind: 'text', text: buffer.toString('utf8', 0, filled), bytes: info.size };
  } catch {
    return { kind: 'refused', why: 'it cannot be read', byHand: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
