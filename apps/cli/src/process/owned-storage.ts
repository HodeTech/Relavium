import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  type BigIntStats,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { CliError, toCliError } from './errors.js';

/** Project an escaping open/maintenance failure without inventing storage provenance. */
export function storageBoundaryError(value: unknown): CliError {
  return toCliError(value);
}

/** Directory creation owned by the CLI's storage/export boundary. */
export function mkdirForStorage(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    throwOwnedFilesystemFailure(error);
  }
}

/** Permission hardening owned by the CLI's local storage boundary. */
export function chmodForStorage(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    throwOwnedFilesystemFailure(error);
  }
}

/** The session-export file write, with atomic no-overwrite admission preserved. */
export function writeFileForStorage(path: string, content: string, force: boolean): void {
  try {
    writeFileSync(path, content, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
  } catch (error) {
    throwOwnedFilesystemFailure(error);
  }
}

/**
 * A file's identity: what {@link replaceFileForStorage} re-checks before it renames. The `lstat` fields catch a file
 * put in its place (another device or inode) and most rewrites (a new size or `ctime`), but `ctime` is only as fine
 * as the filesystem's clock — a few milliseconds on a Linux kernel before 6.13, a second on HFS+ — and ext4 reuses a
 * freed inode. The SHA-256 of the bytes catches what those miss: a same-length change inside one clock tick.
 */
export interface StorageFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  /** Hex SHA-256 of the file's bytes. */
  readonly sha256: string;
}

/** The identity of the file `stats` (a `bigint` stat) describes, whose bytes are `content`. */
export function storageFileIdentity(stats: BigIntStats, content: Uint8Array): StorageFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

/** The file to be replaced is no longer the one the caller checked; nothing was written. */
export class StorageTargetChangedError extends Error {
  constructor() {
    super('the file changed after it was checked');
    this.name = 'StorageTargetChangedError';
  }
}

/**
 * Replace the file at `path` with `content` atomically: write a fresh temp beside it (`wx`, so it never follows a
 * link or reuses a file), `fsync` it, then rename it over `path`. A crash leaves either the old file or the new one,
 * never a truncated mix, and the rename replaces the directory entry rather than writing through a link at `path`.
 * The temp is removed when anything fails.
 *
 * It keeps what a write in place would: a file the user made read-only is refused (`EACCES`), not replaced, and the
 * new file gets `mode`, the old file's permission bits, so a file narrowed to `0600` is not widened to the umask's
 * default by its own rewrite.
 *
 * It replaces only the file the caller checked. Before it starts, and again just before the rename, it compares
 * the file at `path` with `expected` and throws {@link StorageTargetChangedError} when it was replaced, rewritten
 * or removed meanwhile — which, for a transcript big enough to take tens of milliseconds to serialize and write, is a
 * window another writer can hit. The stat fields are compared before anything is opened, and the bytes are read
 * only from the same regular file, so a link, a FIFO, a directory or a larger file put there is refused without
 * being followed, blocked on or read whole. Not detected: a swap in the moment between that last check and the
 * rename (Node has no rename that compares first).
 */
export function replaceFileForStorage(
  path: string,
  content: string,
  mode: number,
  expected: StorageFileIdentity,
): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  /** Throw {@link StorageTargetChangedError} unless `path` is still the regular file the caller checked. */
  const ensureUnchanged = (): void => {
    const current = identityIfUnchanged(path, expected);
    if (current?.sha256 !== expected.sha256) throw new StorageTargetChangedError();
  };
  let fd: number | undefined;
  try {
    ensureUnchanged();
    accessSync(path, constants.W_OK);
    fd = openSync(temp, 'wx', mode);
    fchmodSync(fd, mode); // `open`'s mode is narrowed by the umask; this sets exactly the old bits
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    ensureUnchanged();
    renameSync(temp, path);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already failing — a secondary close error adds nothing
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // best-effort: the temp may never have been created
    }
    throwOwnedFilesystemFailure(error);
  }
}

/**
 * The identity of the regular file at `path`, read only when its `lstat` fields already equal `expected`'s, or
 * `undefined` for anything else. The bytes come through a non-blocking, no-follow descriptor whose `fstat` must
 * match too (the open `/export`'s own read uses), and no more of them than `expected.size` plus one, to see growth.
 * A FIFO swapped in between the `lstat` and the open is the case `O_NONBLOCK` is for; no test drives it, since a
 * regression would hang the test worker rather than fail it.
 */
function identityIfUnchanged(
  path: string,
  expected: StorageFileIdentity,
): StorageFileIdentity | undefined {
  const linked = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (linked === undefined || !linked.isFile() || !sameStat(linked, expected)) return undefined;
  let fd: number;
  try {
    // `O_NOFOLLOW` is absent on Windows; the `fstat` check below is its swap guard there.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  } catch {
    return undefined; // removed, turned into a link, or no longer readable since the `lstat`: changed
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameStat(opened, expected)) return undefined;
    const bytes = Buffer.alloc(Number(expected.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return storageFileIdentity(opened, bytes.subarray(0, length));
  } finally {
    try {
      closeSync(fd);
    } catch {
      // a close fault changes nothing about the answer
    }
  }
}

/** Whether `stats` has every stat field of `expected` (all but the hash). */
function sameStat(stats: BigIntStats, expected: StorageFileIdentity): boolean {
  return (
    stats.dev === expected.dev &&
    stats.ino === expected.ino &&
    stats.size === expected.size &&
    stats.mtimeNs === expected.mtimeNs &&
    stats.ctimeNs === expected.ctimeNs
  );
}

/** Concrete native acquisition for the editor's private transcript directory. */
export async function mkdtempForStorage(prefix: string): Promise<string> {
  try {
    return await mkdtemp(prefix);
  } catch (error) {
    throwOwnedFilesystemFailure(error);
  }
}

/** Concrete native transcript write; mode and encoding are fixed at this boundary. */
export async function writePrivateFileForStorage(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    throwOwnedFilesystemFailure(error);
  }
}

// Only these actual native operations grant errno origin. No exported general errno classifier,
// arbitrary callback, message or cause can promote a foreign error to storage authority.
function throwOwnedFilesystemFailure(error: unknown): never {
  let code: unknown;
  try {
    if (typeof error === 'object' && error !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
      if (descriptor !== undefined && 'value' in descriptor) code = descriptor.value;
    }
  } catch {
    // A hostile descriptor trap supplies no native storage fact.
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'ENOSPC' || code === 'EROFS') {
    throw new CliError('storage_unavailable', '', { cause: error });
  }
  throw error;
}
