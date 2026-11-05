import { randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
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
 * Replace the file at `path` with `content` atomically: write a fresh temp beside it (`wx`, so it never follows a
 * link or reuses a file), `fsync` it, then rename it over `path`. A crash leaves either the old file or the new one,
 * never a truncated mix, and the rename replaces the directory entry rather than writing through a link at `path`.
 * The temp is removed when anything fails.
 *
 * It keeps what a write in place would: a file the user made read-only is refused (`EACCES`), not replaced, and the
 * new file gets `mode`, the old file's permission bits, so a file narrowed to `0600` is not widened to the umask's
 * default by its own rewrite.
 */
export function replaceFileForStorage(path: string, content: string, mode: number): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    accessSync(path, constants.W_OK);
    fd = openSync(temp, 'wx', mode);
    fchmodSync(fd, mode); // `open`'s mode is narrowed by the umask; this sets exactly the old bits
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
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
