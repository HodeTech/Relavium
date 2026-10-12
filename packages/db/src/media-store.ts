import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { open, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { MediaStoreFilesystemError, MediaStorePaths } from './media-store-paths.js';

import {
  MEDIA_HANDLE_PATTERN,
  validateByteRange,
  type ByteRange,
  type MediaSource,
  type MediaStore,
} from '@relavium/shared';

/**
 * Host-side `MediaStore` implementations (1.AF, ADR-0042) — the Node CLI / VS Code blob store the
 * engine references only by the handle string. These live in `@relavium/db` (Node-side: `node:crypto`
 * + `node:fs`), never in the platform-pure engine; the host wires one into `ExecutionHost.mediaStore`.
 * The desktop Rust CAS (ADR-0032) and the managed store are separate host impls (1.AH).
 *
 * The handle is **content-addressed**: `media://sha256-<hex>` where the hex IS the sha256 of the bytes,
 * so it doubles as the integrity hash (no separate checksum) and `put` is naturally idempotent.
 */

const HANDLE_PREFIX = 'media://sha256-';

/** sha256 hex of the bytes — the content address that forms the handle. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Build a handle from raw bytes. */
function handleOf(bytes: Uint8Array): string {
  return `${HANDLE_PREFIX}${sha256Hex(bytes)}`;
}

/** Windows MoveFileExW may refuse replacement while a cooperating reader owns the target fd. */
function isWindowsRenameContention(error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'EPERM' || error.code === 'EBUSY')
  );
}

/** Extract the validated 64-hex digest from a handle, or throw — never trust an arbitrary string. */
function digestOf(handle: string): string {
  if (!MEDIA_HANDLE_PATTERN.test(handle)) {
    throw new Error('not a media://sha256-<64hex> handle');
  }
  return handle.slice(HANDLE_PREFIX.length);
}

/** base64 of the bytes — the in-flight inline carrier `resolveForEgress` returns for the seam. */
function toBase64Source(bytes: Uint8Array): MediaSource {
  return { kind: 'base64', data: Buffer.from(bytes).toString('base64') };
}

/**
 * Defensively slice an **inclusive** {@link ByteRange} from already-loaded bytes (1.AF/D13). The engine
 * pre-validates the range against `media_objects.byteLength` ({@link validateByteRange}); this re-bounds
 * against the ACTUAL stored size and fails closed on a bad range — never trusting the caller's size.
 */
function sliceRange(bytes: Uint8Array, range: ByteRange): Uint8Array {
  const checked = validateByteRange(range, bytes.length);
  if (!checked.ok) {
    throw new Error(`media readRange: ${checked.reason}`);
  }
  // Slice with the VALIDATED snapshot (checked.range), never re-reading the input `range` — an
  // accessor-backed / mutated range object cannot TOCTOU past the validated bounds.
  return bytes.slice(checked.range.start, checked.range.end + 1); // inclusive end ⇒ +1 (exclusive slice)
}

/**
 * A filesystem content-addressed store (CAS). Bytes live under `<root>/<aa>/<rest-of-hash>` (sharded by
 * the first hash byte). The digest is validated 64-lowercase-hex (from {@link MEDIA_HANDLE_PATTERN}), so
 * a handle can never name a path outside the root; a defensive `commonpath`-style jail check fails
 * closed regardless. `mimeType` is not stored here — it is recorded in the `media_objects` row by the
 * engine; the CAS is pure bytes-by-content-hash. The byte-delivery `Range` gate (read_media) is 1.AF/D13.
 */
export class FilesystemMediaStore implements MediaStore {
  readonly #paths: MediaStorePaths;

  constructor(rootDir: string) {
    this.#paths = new MediaStorePaths(rootDir);
  }

  put(bytes: Uint8Array): Promise<string> {
    // Own the bytes before the first asynchronous boundary: the hash and published file must agree.
    const owned = new Uint8Array(bytes);
    return this.#publish(async (file) => {
      await file.writeFile(owned).catch((error: unknown) => {
        throw this.#paths.error(error);
      });
      return handleOf(owned);
    });
  }

  /** Incremental hashing/writing; caller stream failures preserve their primary outcome and publish nothing. */
  putStream(chunks: AsyncIterable<Uint8Array>): Promise<string> {
    return this.#publish(async (file) => {
      const hash = createHash('sha256');
      for await (const chunk of chunks) {
        const owned = new Uint8Array(chunk);
        hash.update(owned);
        const { bytesWritten } = await file.write(owned).catch((error: unknown) => {
          throw this.#paths.error(error);
        });
        if (bytesWritten !== owned.length)
          throw new Error('media putStream: short write — the content address would not match');
      }
      return HANDLE_PREFIX + hash.digest('hex');
    });
  }

  async #publish(write: (file: FileHandle) => Promise<string>): Promise<string> {
    const root = this.#paths.root(true);
    if (root === undefined) throw new MediaStoreFilesystemError('missing');
    const tmp = join(root, `stream.${randomUUID()}.tmp`);
    this.#paths.assertParent(tmp);
    // No cleanup is attempted for an EEXIST occupant: the exclusive open did not make it ours.
    const file = await open(
      tmp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    ).catch((error: unknown) => {
      throw this.#paths.error(error);
    });
    let identity: Stats | undefined;
    let closed = false;
    let published = false;
    let result: string | undefined;
    let cleanupError: MediaStoreFilesystemError | undefined;
    try {
      identity = await file.stat().catch((error: unknown) => {
        throw this.#paths.error(error);
      });
      this.#paths.assertOwnedFile(tmp, identity);
      const handle = await write(file);
      const digest = digestOf(handle);
      const target = this.#paths.path(digest, true);
      if (target === undefined) throw new MediaStoreFilesystemError('unsafe_path');
      this.#paths.fileSnapshot(target); // Final links/special files refuse; a detached snapshot may reflect another publisher.
      this.#paths.assertOwnedFile(tmp, identity);
      await file.close().catch((error: unknown) => {
        throw this.#paths.error(error);
      });
      closed = true;
      this.#paths.assertOwnedFile(tmp, identity);
      if (this.#paths.path(digest, false) !== target)
        throw new MediaStoreFilesystemError('unsafe_path');
      this.#paths.fileSnapshot(target);
      try {
        await rename(tmp, target);
        published = true;
      } catch (error) {
        if (!isWindowsRenameContention(error)) throw this.#paths.error(error);
        // Another publisher's admitted, hash-verified bytes satisfy the same content address.
        // This is one verification, not a retry or permission bypass. Keep our temp owned and
        // unpublished so the finally block removes it; missing/corrupt/unsafe winners still fail.
        try {
          await this.get(handle);
        } catch {
          throw this.#paths.error(error);
        }
      }
      result = handle;
    } finally {
      // Join close and cleanup independently. A cleanup fault must not replace the upstream stream failure.
      if (!closed) {
        try {
          await file.close();
        } catch (error) {
          cleanupError = this.#paths.error(error);
        }
      }
      if (!published && identity !== undefined) {
        try {
          this.#paths.assertOwnedFile(tmp, identity);
          await rm(tmp);
        } catch (error) {
          cleanupError ??= this.#paths.error(error);
        }
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
    if (result === undefined) throw new MediaStoreFilesystemError('io');
    return result;
  }

  async get(handle: string): Promise<Uint8Array> {
    const digest = digestOf(handle);
    const path = this.#paths.path(digest, false);
    if (path === undefined) throw new MediaStoreFilesystemError('missing');
    const admitted = this.#paths.fileSnapshot(path);
    if (admitted === undefined) throw new MediaStoreFilesystemError('missing');
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error: unknown) => {
      throw this.#paths.error(error);
    });
    let result: Uint8Array | undefined;
    let cleanupError: MediaStoreFilesystemError | undefined;
    try {
      const opened = await file.stat().catch((error: unknown) => {
        throw this.#paths.error(error);
      });
      if (opened.dev !== admitted.dev) throw new MediaStoreFilesystemError('unsafe_path');
      // An idempotent publisher may replace the admitted inode before open, or unlink the opened
      // inode afterwards. Validate the live pathname floor independently and hash only this fd.
      this.#paths.assertReadableFile(path, opened);
      // Step 6 adds bounded fd delivery; physical containment and one-fd integrity are established here.
      const bytes = new Uint8Array(
        await file.readFile().catch((error: unknown) => {
          throw this.#paths.error(error);
        }),
      );
      const finished = await file.stat().catch((error: unknown) => {
        throw this.#paths.error(error);
      });
      if (finished.dev !== opened.dev || finished.ino !== opened.ino)
        throw new MediaStoreFilesystemError('unsafe_path');
      this.#paths.assertReadableFile(path, finished);
      if (sha256Hex(bytes) !== digest)
        throw new Error('media bytes failed their content-address (sha256) integrity check');
      result = bytes;
    } finally {
      try {
        await file.close();
      } catch (error) {
        // Preserve the primary delivery/integrity outcome; a close failure is reported on an otherwise successful read.
        cleanupError = this.#paths.error(error);
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
    if (result === undefined) throw new MediaStoreFilesystemError('io');
    return result;
  }

  async readRange(handle: string, range: ByteRange): Promise<Uint8Array> {
    return sliceRange(await this.get(handle), range);
  }

  async resolveForEgress(handle: string): Promise<MediaSource> {
    return toBase64Source(await this.get(handle));
  }

  /** Host GC is subject to the same physical root/shard/final identity checks as delivery. */
  async delete(handle: string): Promise<void> {
    const path = this.#paths.path(digestOf(handle), false);
    if (path === undefined || this.#paths.file(path) === undefined) return;
    await rm(path).catch((error: unknown) => {
      throw this.#paths.error(error);
    });
  }

  async listHandles(): Promise<Array<{ handle: string; mtimeMs: number }>> {
    const root = this.#paths.root(false);
    if (root === undefined) return [];
    const shards = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      throw this.#paths.error(error);
    });
    this.#paths.root(false);
    const perShard = await Promise.all(
      shards
        .filter(
          (entry) =>
            /^[0-9a-f]{2}$/.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()),
        )
        .map(async (shard) => {
          const dir = this.#paths.shard(shard.name + '0'.repeat(62), false);
          if (dir === undefined) return [];
          const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
            throw this.#paths.error(error);
          });
          this.#paths.shard(shard.name + '0'.repeat(62), false);
          const found: Array<{ handle: string; mtimeMs: number }> = [];
          for (const entry of entries) {
            const handle = HANDLE_PREFIX + shard.name + entry.name;
            // Nonconforming names and stray subdirectories are not blobs. Valid-name links are refused.
            if (!MEDIA_HANDLE_PATTERN.test(handle) || entry.isDirectory()) continue;
            const info = this.#paths.file(join(dir, entry.name));
            if (info !== undefined) found.push({ handle, mtimeMs: info.mtimeMs });
          }
          return found;
        }),
    );
    return perShard.flat();
  }
}

/** An in-memory content-addressed store — the reference impl for tests and ephemeral runs. */
export class InMemoryMediaStore implements MediaStore {
  readonly #blobs = new Map<string, Uint8Array>();

  put(bytes: Uint8Array): Promise<string> {
    const handle = handleOf(bytes);
    // Defensive copy on write (match FilesystemMediaStore.get's copy-on-read): a later mutation of the
    // caller's array must never corrupt the content-addressed blob this handle names.
    this.#blobs.set(handle, new Uint8Array(bytes));
    return Promise.resolve(handle);
  }

  /**
   * The streaming write (ADR-0089 §2). An in-MEMORY store necessarily ends up holding the whole body — that
   * is what it is — so this exists for CONTRACT parity, not for a memory saving: an engine that refuses the
   * url path without a `putStream` would otherwise be untestable against the reference store, and a test
   * host would be forced to pretend. Nothing about the real guarantee rests on this implementation; the
   * filesystem one is where it is kept.
   */
  async putStream(chunks: AsyncIterable<Uint8Array>): Promise<string> {
    const collected: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of chunks) {
      collected.push(chunk);
      total += chunk.length;
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of collected) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return this.put(bytes);
  }

  get(handle: string): Promise<Uint8Array> {
    if (!MEDIA_HANDLE_PATTERN.test(handle)) {
      return Promise.reject(new Error('not a media://sha256-<64hex> handle'));
    }
    const bytes = this.#blobs.get(handle);
    return bytes === undefined
      ? Promise.reject(new Error(`no media bytes for ${handle}`))
      : Promise.resolve(bytes.slice()); // copy on read — the caller cannot mutate the stored blob
  }

  async resolveForEgress(handle: string): Promise<MediaSource> {
    return toBase64Source(await this.get(handle));
  }

  // The `signal` of the `MediaStore.readRange` contract is omitted (a fewer-param method still satisfies
  // the interface): the in-memory blob is already resident, so there is no streamed I/O to abort.
  async readRange(handle: string, range: ByteRange): Promise<Uint8Array> {
    return sliceRange(await this.get(handle), range);
  }
}
