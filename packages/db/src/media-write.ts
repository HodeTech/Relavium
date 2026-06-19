import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import type { AbortSignalLike, MediaWritePort, MediaWriteResult } from '@relavium/shared';

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
export function createFilesystemMediaWrite(scopeRoot: string): MediaWritePort {
  return (relativePath: string, bytes: Uint8Array, signal?: AbortSignalLike) =>
    writeJailed(scopeRoot, relativePath, bytes, signal);
}

/** A media-write failure naming a reason only (never a path / the bytes) — mirrors `MediaEgressError`. */
export class MediaWriteError extends Error {
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
): Promise<MediaWriteResult> {
  try {
    return await writeJailedUnsafe(scopeRoot, relativePath, bytes, signal);
  } catch (error) {
    // The port's own checks already throw a reason-only MediaWriteError; re-throw those verbatim. A RAW
    // Node fs error (realpath/mkdir/writeFile/rename/lstat) carries the absolute path in `.message`/`.path`/
    // `.dest` — re-wrap it so the resolved path never escapes the port (the I3 self-defending contract).
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
): Promise<MediaWriteResult> {
  throwIfAborted(signal);
  assertRelativePath(relativePath);
  // The scope root must exist and resolve (no dangling/symlinked root) — fail-closed otherwise.
  const realRoot = await realpath(scopeRoot);
  const lexicalTarget = resolve(realRoot, relativePath);
  assertWithinRoot(realRoot, lexicalTarget); // lexical commonpath — defense-in-depth vs a slipped `..`
  const targetDir = dirname(lexicalTarget);
  // Resolve the deepest EXISTING ancestor and verify it is within the root BEFORE any mkdir, so a
  // symlinked ancestor pointing outside the root is caught before we create or write anything there.
  // (A `mkdir(recursive)` through a not-yet-checked symlinked ancestor could create stray empty dirs
  // outside the root, but the post-mkdir realpath re-check below throws before ANY byte is written.)
  assertWithinRoot(realRoot, await deepestExistingReal(targetDir));
  throwIfAborted(signal);
  await mkdir(targetDir, { recursive: true });
  // The parent now exists — re-resolve it and re-check (tightens the window between the ancestor check
  // and the write; a symlink that appeared mid-mkdir surfaces here).
  const realDir = await realpath(targetDir);
  assertWithinRoot(realRoot, realDir);
  const finalTarget = join(realDir, basename(lexicalTarget));
  await assertNotSymlink(finalTarget); // never write THROUGH an existing symlink at the final component
  throwIfAborted(signal);
  // Atomic publish: write a unique temp file in the same (in-root) dir, then rename it onto the final
  // path. `rename` replaces the name atomically and never follows a final-component symlink, so a partial
  // write never lands at the target and a racing symlink cannot redirect the bytes. The `finally` reclaims
  // the temp on ANY non-success exit (a writeFile/rename throw, or a cancel), leaving no orphaned `.tmp`.
  const tmp = join(realDir, `.save-to.${randomUUID()}.tmp`);
  let published = false;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, finalTarget);
    published = true;
  } finally {
    if (!published) {
      await rm(tmp, { force: true }).catch(() => undefined); // best-effort cleanup of the orphaned temp
    }
  }
  return { bytesWritten: bytes.length };
}

/** Reject anything that is not a pure relative path (absolute / drive / UNC / a `..` traversal segment). */
function assertRelativePath(relativePath: string): void {
  if (relativePath === '') {
    throw new MediaWriteError('save_to: the resolved path is empty');
  }
  if (
    isAbsolute(relativePath) ||
    relativePath.startsWith('\\') || // leading backslash / UNC (`\\server\share`)
    /^[A-Za-z]:[\\/]/.test(relativePath) // Windows drive (`C:\` / `C:/`) — isAbsolute misses it on POSIX
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

/** Resolve the deepest existing ancestor of `startDir` through `realpath` (walking up past missing dirs). */
async function deepestExistingReal(startDir: string): Promise<string> {
  let dir = startDir;
  for (;;) {
    try {
      return await realpath(dir);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        // Unreachable in practice: the scope root exists, and the target is lexically within it.
        throw new MediaWriteError('save_to: no existing ancestor directory could be resolved');
      }
      dir = parent;
    }
  }
}

/** Refuse to write through an existing symlink at the final path; a missing path (ENOENT) is fine. */
async function assertNotSymlink(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
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
