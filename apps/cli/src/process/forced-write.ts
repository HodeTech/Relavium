import { randomUUID } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { CliError } from './errors.js';

/**
 * The write of a file the person asked to REPLACE (`--force`), shared by every command that writes an authored or exported YAML file:
 * `writeAuthoredFile` (import, create, export, the Home's two cards) and the session export's `writeFileForStorage`
 * (PR #102 review P0-1 and the security sitting's M1). One sequence, so a rule fixed here is fixed for all of them.
 *
 * `open(path, 'w')` follows a link at the final component, waits for a writer on a FIFO and truncates before it writes, so a link
 * committed to a repository took `--force` out of the project, a FIFO swapped in held the command, and a failure half way left a damaged
 * file. The sequence here never opens the target:
 *
 * 1. LOOK at the final component without following it (`lstat`). A link, a FIFO, a socket or a device is refused in fixed words and a
 *    directory is an `EISDIR`; nothing is created or opened.
 * 2. A regular file is replaced through a FRESH temporary beside it (`wx`: never a link, never an existing file), flushed, then renamed
 *    over the name. A rename replaces the directory entry and never writes through one, so whatever sits at the name when it runs (a
 *    link, a FIFO, another file) is replaced and not followed or waited on, however it got there after the look.
 * 3. Nothing there: create it with `wx`. If the name was taken in the meantime, look once more and take step 2 for a plain file.
 */

/**
 * The refusal for a write target that is a link, a FIFO, a socket or a device. Fixed words: no path, no errno, nothing of the entry's
 * own. (A directory is an `EISDIR` and each caller words that one itself.)
 */
export const NOT_A_PLAIN_FILE =
  'The target exists and is a link or not a regular file, so nothing was written. Remove it or choose another path, then retry.';

/** What {@link lookAtWriteTarget} learned about a regular file it will replace: the bits and the group the replacement must keep. */
export interface PlainFile {
  readonly mode: number;
  readonly gid: number;
}

/** A check a caller asks to be run before each step that touches the directory. It throws to refuse; it must not write. */
export type DirectoryGuard = () => void;

const noGuard: DirectoryGuard = () => undefined;

function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code: unknown = err.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * What the final component of a write target is, looked at WITHOUT following it: `undefined` when nothing is there, the mode and group of
 * a regular file, an `EISDIR` error for a directory (each caller words that refusal itself) and a typed exit-2 {@link CliError} with
 * {@link NOT_A_PLAIN_FILE} for anything else. The target is never opened, so a FIFO with no reader cannot hold the process and a link is
 * never followed.
 */
export function lookAtWriteTarget(path: string): PlainFile | undefined {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  if (stats.isFile()) return { mode: stats.mode & 0o777, gid: stats.gid };
  if (stats.isDirectory()) {
    throw Object.assign(new Error('EISDIR: the target is a directory'), { code: 'EISDIR' });
  }
  throw new CliError('invalid_invocation', NOT_A_PLAIN_FILE);
}

/** Create `path` with `content`, failing `EEXIST` if anything is there: `O_EXCL` never follows a link at the final component. */
export function createExclusive(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
}

/**
 * Give a replacement file the old file's permission bits and, as far as it can, its group (the umask narrows what `open` creates, and the
 * new file starts in the process's or the directory's group). Best effort and never a throw: when the group cannot be carried over (the
 * process is not a member of it, a file system that refuses `chown`), the file keeps ONLY the owner's bits, so a `0660` file of one
 * group is never left readable and writable by another. ACLs and extended attributes are not carried over, on any platform.
 */
function carryOwnership(fd: number, existing: PlainFile): void {
  let mode = existing.mode;
  try {
    if (fstatSync(fd).gid !== existing.gid) fchownSync(fd, -1, existing.gid);
  } catch {
    mode &= ~0o077;
  }
  fchmodSync(fd, mode);
}

/**
 * Replace the regular file at `path` with `content`, atomically: a fresh temporary beside it (`wx`, so it never follows a link or reuses
 * a file), `fsync`ed, then renamed over `path`. A rename replaces the directory entry and never writes through one, so a link put at
 * `path` after {@link lookAtWriteTarget} looked is REPLACED, not followed; a crash leaves the old file or the new one, never a
 * truncated mix. The new file takes the old file's permission bits and group ({@link carryOwnership}), and a file its owner made
 * read-only is refused (`EACCES`) as an in-place write would have refused it. The temporary is created, renamed and, on any failure,
 * removed by the SAME path, so a failing step cannot leave one behind under a name another step does not see. A name a hard link shares
 * is replaced and not the link's other names, which an in-place write would have changed.
 *
 * `guard` runs before the temporary is created and again right before the rename: the directory is looked at on both sides of the
 * work. What it cannot close is a swap of the directory's own name in the instant between the last look and the system call that
 * follows it, and a temporary created in a directory that was swapped away just afterwards stays in that directory, which the name no
 * longer reaches.
 */
export function replacePlainFile(
  path: string,
  content: string,
  existing: PlainFile,
  guard: DirectoryGuard = noGuard,
): void {
  const temp = join(dirname(path), `.relavium-write-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    guard();
    accessSync(path, constants.W_OK);
    fd = openSync(temp, 'wx', existing.mode);
    carryOwnership(fd, existing);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    guard();
    renameSync(temp, path);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already failing: a secondary close error adds nothing
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // best effort: the temporary may never have been created
    }
    throw err;
  }
}

/**
 * Write `content` to `path` as a forced write does (the sequence above). Faults are the file system's own errors, except a target that is
 * not a plain file ({@link NOT_A_PLAIN_FILE}); a directory at the target is an `EISDIR` error. `guard` is {@link replacePlainFile}'s and
 * also runs before the look and before an exclusive create.
 */
export function writeForced(path: string, content: string, guard: DirectoryGuard = noGuard): void {
  guard();
  const existing = lookAtWriteTarget(path);
  if (existing !== undefined) {
    replacePlainFile(path, content, existing, guard);
    return;
  }
  try {
    guard();
    createExclusive(path, content);
  } catch (err) {
    // Something took the name between the look and the create: look once more, and replace it if it is a plain file.
    if (errnoCode(err) !== 'EEXIST') throw err;
    const raced = lookAtWriteTarget(path);
    if (raced === undefined) throw err;
    replacePlainFile(path, content, raced, guard);
  }
}
