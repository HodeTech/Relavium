import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  writeSync,
} from 'node:fs';

/**
 * One append to one of the CLI's append-only, owner-only files under `~/.relavium` (the MCP consent log and the terminal outbox).
 *
 * The file is opened ONCE, and everything after the open is asked of the DESCRIPTOR: that it is a regular file, the write itself,
 * and the `0600` mode. A check by path followed by `appendFileSync` and `chmodSync` by path (an `lstat` for a link, then two
 * operations that each follow one) left a window in which a process that replaced the file with a symbolic link turned the store
 * into a write primitive against any file the CLI can write; every one of those operations now acts on the file that was checked.
 * `O_NOFOLLOW` refuses a link at the open where the platform has it, `O_NONBLOCK` keeps the open of a FIFO from waiting, and the
 * `fstat` refuses anything that is not a regular file (a FIFO, a device, a directory), so a swapped-in special file is neither
 * written to nor waited on. Windows has no `O_NOFOLLOW`: there an `lstat` first is the best check there is, and the `fstat` still
 * holds.
 *
 * The file is created with `mode` from its FIRST byte (`O_CREAT`), and the mode is set again on the descriptor on every append, so a
 * file restored from a backup with a wider one is repaired rather than trusted. The mode step is best effort (Windows, or a file
 * the process does not own): a wide mode never blocks the append.
 *
 * Throws {@link AppendTargetRefusedError} for a link or a file that is not regular, and the filesystem's own error for anything else
 * (a missing directory, a full disk, a denied write): the caller decides what each means.
 */
export function appendToOwnerOnlyFile(path: string, data: string, mode: number): void {
  if (constants.O_NOFOLLOW === undefined && isSymbolicLink(path)) {
    throw new AppendTargetRefusedError('symlink');
  }
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
      mode,
    );
  } catch (error) {
    // `O_NOFOLLOW` on a link fails with ELOOP (EMLINK on some BSDs); nothing was opened, so nothing was written.
    if (errnoCode(error) === 'ELOOP' || errnoCode(error) === 'EMLINK') {
      throw new AppendTargetRefusedError('symlink');
    }
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new AppendTargetRefusedError('not-regular');
    const bytes = Buffer.from(data, 'utf8');
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written);
    try {
      fchmodSync(fd, mode);
    } catch {
      // Windows, or a file we do not own. The at-rest guard there is the per-user profile ACL (ADR-0050).
    }
  } finally {
    closeSync(fd);
  }
}

/** The path is a link (not followed) or not a regular file: the append was refused and nothing was written. */
export class AppendTargetRefusedError extends Error {
  readonly reason: 'symlink' | 'not-regular';

  constructor(reason: 'symlink' | 'not-regular') {
    super(
      reason === 'symlink'
        ? 'the file is a symbolic link; refusing to write through it'
        : 'the file is not a regular file; refusing to write to it',
    );
    this.name = 'AppendTargetRefusedError';
    this.reason = reason;
  }
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false; // absent — the open creates it
  }
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
