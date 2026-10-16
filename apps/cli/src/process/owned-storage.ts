import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';

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
