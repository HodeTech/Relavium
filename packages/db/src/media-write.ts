import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import {
  RelaviumError,
  deepestExistingReal,
  type AbortSignalLike,
  type MediaWritePort,
  type MediaWriteResult,
} from '@relavium/shared';

/**
 * `createFilesystemMediaWrite` (1.AF/D16, [ADR-0044](../../../docs/decisions/0044-media-access-governance-read-media-save-to-cost.md)
 * §2) — the Node host **mechanism** half of `save_to`: write an `output` node's produced media bytes to a
 * relative path under a fixed scope root, fail-closed. It lives in `@relavium/db` (Node `node:fs`), never in
 * the platform-pure engine; the host wires the returned port into `ExecutionHost.mediaWrite`. The engine owns
 * the **policy** (resolve the `save_to` template's `{{ run.id }}`, resolve the single produced handle to bytes
 * via `MediaStore.get`); this port owns the **path mechanism** — the same fail-closed discipline as
 * `FilesystemMediaStore` / `read_media` byte delivery (security-review.md §Media byte delivery):
 *
 * - **Relative-only, no traversal** — an absolute path, a Windows drive (`C:\`/`C:/`), a leading backslash /
 *   UNC (`\\server`), and any `..` segment are rejected before any I/O (defense-in-depth — the authored
 *   `save_to` is already schema-validated, but the host port is a general contract that must self-defend).
 * - **`realpath` + `commonpath` jail** — the scope root is `realpath`-resolved (it MUST exist, else
 *   fail-closed), the deepest **existing** ancestor of the target is `realpath`-resolved and re-checked to be
 *   within the root **before** any `mkdir`/write (so a symlinked ancestor that escapes the root is caught
 *   before anything is created outside it), and the materialized parent dir is `realpath`-re-checked after
 *   `mkdir`.
 * - **Symlinks OFF** — the final component is `lstat`-checked and a symlink is refused; the publish is an
 *   atomic temp-write + `rename` (which replaces a name, never follows a final symlink — the binding control).
 *
 * Errors are a {@link MediaWriteError} naming a **reason only** — never the resolved path, the scope root, or
 * the bytes (rule 6 / I3). A raw Node `fs` error (whose `message`/`path`/`dest` would carry the absolute
 * path) is caught at the boundary and re-wrapped, so the port honours its own contract regardless of caller.
 */
/** Captured host-only checks; no CLI or native type crosses the DB boundary. */
export interface CapturedMediaWriteGuard {
  assertPath(lexical: string, canonical: string): void;
  assertIdentity(identity: { readonly dev: bigint; readonly ino: bigint }): void;
}
export interface FilesystemMediaWriteGuard {
  capture(signal?: AbortSignalLike): Promise<CapturedMediaWriteGuard>;
}
export function createFilesystemMediaWrite(
  scopeRoot: string,
  guard?: FilesystemMediaWriteGuard,
): MediaWritePort {
  return (relativePath, bytes, signal) =>
    writeJailed(scopeRoot, relativePath, bytes, signal, guard);
}

/** Fixed public diagnostic; raw filesystem and private inventory failures never cross this boundary. */
export class MediaWriteError extends RelaviumError {
  constructor(message: string) {
    super(message);
    this.name = 'MediaWriteError';
  }
}

async function writeJailed(
  scopeRoot: string,
  relativePath: string,
  bytes: Uint8Array,
  signal: AbortSignalLike | undefined,
  guard: FilesystemMediaWriteGuard | undefined,
): Promise<MediaWriteResult> {
  try {
    throwIfAborted(signal);
    assertRelativePath(relativePath);
    const captured = await guard?.capture(signal);
    throwIfAborted(signal);
    return await writeJailedUnsafe(scopeRoot, relativePath, bytes, signal, captured);
  } catch (error) {
    throwIfAborted(signal);
    throw error instanceof MediaWriteError
      ? error
      : new MediaWriteError('save_to: the filesystem write failed');
  }
}

async function writeJailedUnsafe(
  scopeRoot: string,
  relativePath: string,
  bytes: Uint8Array,
  signal: AbortSignalLike | undefined,
  guard: CapturedMediaWriteGuard | undefined,
): Promise<MediaWriteResult> {
  const lexicalRoot = resolve(scopeRoot);
  const requested = resolve(lexicalRoot, relativePath);
  guard?.assertPath(lexicalRoot, lexicalRoot);
  guard?.assertPath(requested, requested);
  const resolveGuarded = async (path: string): Promise<string> => {
    guard?.assertPath(path, path);
    const canonical = await realpath(path);
    guard?.assertPath(path, canonical);
    return canonical;
  };
  const inspect = async (path: string) => {
    guard?.assertPath(path, path);
    const info = await lstat(path, { bigint: true });
    guard?.assertIdentity(info);
    return info;
  };
  const realRoot = await resolveGuarded(lexicalRoot);
  const rootIdentity = await inspect(realRoot);
  const target = resolve(realRoot, relativePath);
  assertWithinRoot(realRoot, target);
  guard?.assertPath(requested, target);
  const targetDir = dirname(target);
  const ancestor = await deepestExistingReal(targetDir, {
    realpath: resolveGuarded,
    lstat: inspect,
    dirname,
    isMissing: (error) => errnoCode(error) === 'ENOENT',
  });
  assertWithinRoot(realRoot, ancestor);
  await inspect(ancestor);
  throwIfAborted(signal);
  await mkdir(targetDir, { recursive: true });
  const realDir = await resolveGuarded(targetDir);
  const parentIdentity = await inspect(realDir);
  assertWithinRoot(realRoot, realDir);
  const finalTarget = join(realDir, basename(target));
  guard?.assertPath(requested, finalTarget);
  await assertNotSymlink(finalTarget, guard);
  if (guard !== undefined) await inspectOpenedTarget(finalTarget, guard);
  throwIfAborted(signal);
  const tmp = join(realDir, `.save-to.${randomUUID()}.tmp`);
  guard?.assertPath(tmp, tmp);
  let published = false;
  let owned: { readonly dev: bigint; readonly ino: bigint } | undefined;
  try {
    // Inspect the actual exclusive fd before payload bytes; a pathname alone cannot prove its identity.
    const handle = await open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n)
        throw new MediaWriteError('save_to: temporary ownership could not be verified');
      owned = { dev: info.dev, ino: info.ino };
      guard?.assertIdentity(info);
      throwIfAborted(signal);
      await handle.writeFile(bytes);
      const after = await handle.stat({ bigint: true });
      if (!after.isFile() || after.nlink !== 1n || !sameIdentity(after, owned))
        throw new MediaWriteError('save_to: temporary ownership changed');
      guard?.assertIdentity(after);
    } finally {
      await handle.close();
    }
    const entry = await inspect(tmp);
    if (
      owned === undefined ||
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink !== 1n ||
      !sameIdentity(entry, owned)
    )
      throw new MediaWriteError('save_to: temporary ownership changed');
    const finalParent = await resolveGuarded(targetDir);
    const currentParent = await inspect(finalParent);
    const currentRoot = await inspect(await resolveGuarded(lexicalRoot));
    if (
      finalParent !== realDir ||
      !sameIdentity(currentParent, parentIdentity) ||
      !sameIdentity(currentRoot, rootIdentity)
    )
      throw new MediaWriteError('save_to: parent identity changed');
    await assertNotSymlink(finalTarget, guard);
    if (guard !== undefined) await inspectOpenedTarget(finalTarget, guard);
    guard?.assertPath(requested, finalTarget);
    throwIfAborted(signal);
    await rename(tmp, finalTarget);
    published = true;
  } finally {
    if (!published && owned !== undefined) {
      const identity = owned;
      // Cleanup retains an uncertain/replaced/linked entry; it never removes an unproven pathname.
      await (async () => {
        guard?.assertPath(tmp, tmp);
        const entry = await lstat(tmp, { bigint: true });
        guard?.assertIdentity(entry);
        if (
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          entry.nlink === 1n &&
          sameIdentity(entry, identity)
        )
          await rm(tmp);
      })().catch(() => undefined);
    }
  }
  return { bytesWritten: bytes.length };
}

function sameIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
async function inspectOpenedTarget(path: string, guard: CapturedMediaWriteGuard): Promise<void> {
  let observed;
  try {
    observed = await lstat(path, { bigint: true });
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return;
    throw error;
  }
  if (observed.isSymbolicLink() || !observed.isFile())
    throw new MediaWriteError('save_to: refusing an unsafe target');
  guard.assertPath(path, path);
  guard.assertIdentity(observed);
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
  );
  try {
    const actual = await handle.stat({ bigint: true });
    guard.assertIdentity(actual);
    if (!actual.isFile() || !sameIdentity(actual, observed))
      throw new MediaWriteError('save_to: target identity changed');
  } finally {
    await handle.close();
  }
}

/** Reject anything that is not a pure relative path (absolute / drive / UNC / a `..` traversal segment). */
function assertRelativePath(relativePath: string): void {
  if (relativePath === '') {
    throw new MediaWriteError('save_to: the resolved path is empty');
  }
  if (
    isAbsolute(relativePath) ||
    relativePath.startsWith('\\') || // leading backslash / UNC (`\\server\share`)
    /^[A-Za-z]:/.test(relativePath) // Also refuse drive-relative C:relative on every platform.
  ) {
    throw new MediaWriteError('save_to: the resolved path must be relative');
  }
  if (relativePath.split(/[\\/]/).includes('..')) {
    throw new MediaWriteError('save_to: the resolved path must not contain a ".." segment');
  }
}

/** `commonpath` jail: `target` must be the root itself or a descendant of it. */
function assertWithinRoot(realRoot: string, target: string): void {
  // Normalize the boundary so a root ending in `sep` (the filesystem root `/`, or `C:\`) does not produce
  // a doubled separator a valid child path would fail to match (a false positive).
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (target !== realRoot && !target.startsWith(prefix)) {
    throw new MediaWriteError('save_to: the resolved path escapes the scope root');
  }
}

/** Refuse to write through an existing symlink at the final path; a missing path (ENOENT) is fine. */
async function assertNotSymlink(target: string, guard?: CapturedMediaWriteGuard): Promise<void> {
  try {
    const stat = await lstat(target, { bigint: true });
    guard?.assertPath(target, target);
    guard?.assertIdentity(stat);
    if (stat.isSymbolicLink()) {
      throw new MediaWriteError('save_to: refusing to write through a symlink');
    }
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return; // not present yet — the common case
    }
    throw error;
  }
}

/** A Node `errno` code (`ENOENT`, …) off an unknown thrown value, or `undefined`. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Cooperative cancellation — throw before the (potentially slow) filesystem steps if the run aborted. */
function throwIfAborted(signal: AbortSignalLike | undefined): void {
  if (signal?.aborted === true) {
    throw new MediaWriteError('save_to: the write was aborted');
  }
}
