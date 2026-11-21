import { createHmac, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

import {
  DIR_MODE,
  FILE_MODE,
  HEX_DIGEST,
  ISO_TIME,
  readRegularFile,
  sameDigest,
  statState,
} from './file-state.js';

/**
 * The write marks of ADR-0138: for each project root, when a chat of this machine last applied a file write there. A remembered
 * command whose grant is OLDER than its root's mark asks again in `auto` ("the write may have changed what the command does",
 * ADR-0118 §2), however many chats ago the write was; a grant made after the mark stands. The in-memory flag the chat keeps for its
 * own writes is the same rule inside one chat; this file is what carries it across `/clear`, a model reseat, a resume and a new
 * process.
 *
 * One small JSON file, replaced whole (write a sibling, rename over): unlike the grants file nothing in it is a revocation, so
 * losing it can only make a remembered command run unasked again, which is what the chat without the file did. Each entry is
 * keyed by the same root digest the grants use and authenticated by the same installation key, so a mark minted without the key is
 * ignored; deleting the file or an entry needs the same operator account that can edit the grants themselves, which the store
 * does not defend against (ADR-0118 §2).
 */

/** The file's name beside the grants file. */
export const COMMAND_WRITE_MARKS_FILE = 'command-write-marks.json';

/** The bounds: roots kept (the oldest mark is dropped past them) and the size a file may have to be read. */
export const WRITE_MARK_LIMITS = Object.freeze({ roots: 256, bytes: 64 * 1024 });

const MARK_TAG = 'relavium/command-grants/write-mark/v1';

const MarkSchema = z
  .object({
    root: z.string().regex(HEX_DIGEST),
    at: z.string().regex(ISO_TIME),
    /** HMAC over the root and the time under the installation key: see {@link markMac}. */
    mac: z.string().regex(HEX_DIGEST),
  })
  .strict();

const MarksFileSchema = z
  .object({ v: z.literal(1), marks: z.array(MarkSchema).max(WRITE_MARK_LIMITS.roots) })
  .strict();

export interface WriteMark {
  readonly root: string;
  readonly at: string;
  readonly mac: string;
  /** `at` as milliseconds since the epoch. */
  readonly ms: number;
}

export type WriteMarks =
  | { readonly kind: 'absent' }
  /** A line of reasoning for a notice, never a path or a command: the file cannot be trusted, so every remembered command asks. */
  | { readonly kind: 'unreadable'; readonly why: string }
  | { readonly kind: 'ready'; readonly marks: readonly WriteMark[] };

/** HMAC-SHA256 over the tag, the root digest and the time, NUL-separated. */
export function markMac(key: Buffer, root: string, at: string): string {
  return createHmac('sha256', key).update(`${MARK_TAG}\0${root}\0${at}`).digest('hex');
}

/**
 * Read the marks. An entry whose MAC does not verify is dropped (it was minted without this key, or under an overwritten one): a
 * dropped mark can only make a grant look fresher than a forged mark would, and a forger can already edit the grants file. A file
 * that cannot be read or does not have exactly the shape is `unreadable`, never "no marks": the reader then treats every
 * remembered command as stale.
 */
export function readWriteMarks(path: string, key: Buffer): WriteMarks {
  const read = readRegularFile(path, WRITE_MARK_LIMITS.bytes);
  if (read.kind === 'absent') return { kind: 'absent' };
  if (read.kind === 'refused') return { kind: 'unreadable', why: read.why };
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    return { kind: 'unreadable', why: 'it does not parse' };
  }
  const parsed = MarksFileSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'unreadable', why: 'it is not a write-mark file' };
  const marks: WriteMark[] = [];
  for (const mark of parsed.data.marks) {
    const ms = Date.parse(mark.at);
    if (Number.isNaN(ms)) return { kind: 'unreadable', why: 'a time does not parse' };
    if (!sameDigest(mark.mac, markMac(key, mark.root, mark.at))) continue;
    marks.push({ ...mark, ms });
  }
  return { kind: 'ready', marks };
}

/** The latest time a write was recorded for `root`, in milliseconds; `undefined` when none was. */
export function latestWriteMark(
  marks: WriteMark[] | readonly WriteMark[],
  root: string,
): number | undefined {
  let latest: number | undefined;
  for (const mark of marks) {
    if (!sameDigest(mark.root, root)) continue;
    if (latest === undefined || mark.ms > latest) latest = mark.ms;
  }
  return latest;
}

export type RecordWriteMarkResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unreadable' | 'unwritable' };

/**
 * Record that a file write was applied under `root` at `when`. The mark never moves backwards (a clock set back keeps the later
 * mark), the other roots' marks are kept (the oldest dropped past {@link WRITE_MARK_LIMITS}), and a file that cannot be read is
 * NOT replaced: overwriting an unreadable file would hand every other project's remembered commands a clean slate, so it stays
 * unreadable (and every remembered command asks) until `relavium permissions revoke --all` removes it.
 */
export function recordWriteMark(
  path: string,
  key: Buffer,
  root: string,
  when: Date,
): RecordWriteMarkResult {
  const current = readWriteMarks(path, key);
  if (current.kind === 'unreadable') return { ok: false, reason: 'unreadable' };
  const existing = current.kind === 'ready' ? current.marks : [];
  const previous = latestWriteMark(existing, root);
  const ms = previous === undefined ? when.getTime() : Math.max(previous, when.getTime());
  const at = new Date(ms).toISOString();
  const others = existing
    .filter((mark) => !sameDigest(mark.root, root))
    .sort((left, right) => right.ms - left.ms)
    .slice(0, WRITE_MARK_LIMITS.roots - 1)
    .map(({ root: otherRoot, at: otherAt, mac }) => ({ root: otherRoot, at: otherAt, mac }));
  const marks = [{ root, at, mac: markMac(key, root, at) }, ...others];
  try {
    replaceFile(path, `${JSON.stringify({ v: 1, marks })}\n`);
  } catch {
    return { ok: false, reason: 'unwritable' };
  }
  return { ok: true };
}

/**
 * Replace the file whole: write a sibling created with the owner-only mode from its first byte (exclusive, without following a
 * link), then rename it over the target. A target that is a symbolic link or cannot be inspected is refused; a rename replaces a
 * link itself, never what it points at, and a directory in the way makes the rename fail.
 */
function replaceFile(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  const seen = statState(path);
  if (seen === 'error' || seen?.isSymbolicLink() === true) {
    throw new Error(
      'the write-mark file cannot be inspected or is a symbolic link; refusing to write',
    );
  }
  const sibling = `${path}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(
    sibling,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    FILE_MODE,
  );
  try {
    if (!fstatSync(fd).isFile()) throw new Error('the write-mark sibling is not a regular file');
    const bytes = Buffer.from(data, 'utf8');
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written);
    try {
      fchmodSync(fd, FILE_MODE);
    } catch {
      // Windows, or a file we do not own: the guard there is the per-user profile ACL (ADR-0050).
    }
  } catch (error) {
    closeSync(fd);
    removeQuietly(sibling);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(sibling, path);
  } catch (error) {
    removeQuietly(sibling);
    throw error;
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove: the caller is already reporting a failure.
  }
}

/** Remove the mark file (the recovery `revoke --all` offers); `false` only when it exists and could not be removed. */
export function removeWriteMarks(path: string): boolean {
  if (statState(path) === undefined) return true;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return statState(path) === undefined;
  }
}
