import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import {
  exactStats,
  MediaStoreFilesystemError,
  MediaStorePaths,
  type ExactStats,
} from './media-store-paths.js';
import { assertMediaNotAborted, scanMediaFile } from './media-store-read.js';
import {
  MediaStoreTemporaries,
  type MediaTemporarySweepResult,
} from './media-store-temporaries.js';

import {
  MEDIA_HANDLE_PATTERN,
  MAX_MEDIA_OBJECT_BYTES,
  INLINE_MEDIA_CEILING,
  MediaAdmissionError,
  admitMediaDescriptor,
  canonicalMediaMimeType,
  createMediaVerifier,
  closeMediaIterator,
  type AbortSignalLike,
  type DurableMediaMeta,
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
type Descriptor = Omit<DurableMediaMeta, 'handle' | 'byteLength'> & {
  readonly byteLength?: number;
};

/** Snapshot all metadata before asynchronous fd operations; optional count remains a claim. */
function snapshotDescriptor(
  handle: string,
  descriptor: Descriptor,
): { meta: DurableMediaMeta; count?: number } {
  let fields: PropertyDescriptorMap;
  try {
    fields = Object.getOwnPropertyDescriptors(descriptor);
  } catch {
    throw new MediaAdmissionError('invalid_descriptor');
  }
  const owned: Record<string, unknown> = { handle };
  for (const key of ['mimeType', 'modality', 'byteLength', 'durationMs']) {
    const field = fields[key];
    if (field === undefined) continue;
    if (!('value' in field)) throw new MediaAdmissionError('invalid_descriptor');
    owned[key] = field.value;
  }
  const count = owned['byteLength'];
  if (count === undefined) owned['byteLength'] = 0;
  const meta = admitMediaDescriptor(owned);
  return count === undefined ? { meta } : { meta, count: meta.byteLength };
}

/** Use the typed-array internal byte length; subclasses cannot waive a pre-copy ceiling. */
function inputByteLength(bytes: Uint8Array): number {
  try {
    if (!(bytes instanceof Uint8Array)) throw new MediaAdmissionError('source_failed');
    const prototype: unknown = Object.getPrototypeOf(Uint8Array.prototype);
    if (typeof prototype !== 'object' || prototype === null)
      throw new MediaAdmissionError('source_failed');
    const length: unknown = Object.getOwnPropertyDescriptor(prototype, 'byteLength')?.get?.call(
      bytes,
    );
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
      throw new MediaAdmissionError('source_failed');
    return length;
  } catch {
    throw new MediaAdmissionError('source_failed');
  }
}

function admitInline(bytes: Uint8Array, mimeType: string): void {
  const mime = canonicalMediaMimeType(mimeType);
  const ceiling = mime.startsWith('image/')
    ? INLINE_MEDIA_CEILING.image
    : mime.startsWith('audio/')
      ? INLINE_MEDIA_CEILING.audio
      : 0;
  if (ceiling === 0 || inputByteLength(bytes) > ceiling)
    throw new MediaAdmissionError('inline_limit');
}

function validatedDescriptor(
  snapshot: ReturnType<typeof snapshotDescriptor>,
  evidence: Readonly<Pick<DurableMediaMeta, 'mimeType' | 'modality' | 'byteLength'>>,
): DurableMediaMeta {
  if (snapshot.count !== undefined && snapshot.count !== evidence.byteLength)
    throw new MediaAdmissionError('descriptor_conflict');
  return admitMediaDescriptor({ ...snapshot.meta, ...evidence });
}

/** Join owned retirement without replacing the primary verification/write/cancellation failure. */
async function closeMediaIteratorPreservingFailure(
  iterator: AsyncIterator<Uint8Array>,
): Promise<void> {
  // Both callers can leave their read loop before EOF only by throwing a primary failure.
  await closeMediaIterator(iterator).catch(() => undefined);
}

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
  readonly #temporaries: MediaStoreTemporaries;

  constructor(rootDir: string) {
    this.#paths = new MediaStorePaths(rootDir);
    this.#temporaries = new MediaStoreTemporaries(this.#paths);
  }

  async put(bytes: Uint8Array, mimeType: string): Promise<string> {
    admitInline(bytes, mimeType);
    const owned = new Uint8Array(bytes);
    const verifier = createMediaVerifier(mimeType);
    verifier.push(owned);
    verifier.finish();
    return this.#publish(async (file) => {
      await file.writeFile(owned).catch((error: unknown) => {
        throw this.#paths.error(error);
      });
      return handleOf(owned);
    }, mimeType);
  }

  /** Count before every copy/hash/write; EOF verification precedes publication. */
  async putStream(chunks: AsyncIterable<Uint8Array>, mimeType: string): Promise<string> {
    const verifier = createMediaVerifier(mimeType);
    const iterator = chunks[Symbol.asyncIterator]();
    let ended = false;
    try {
      // #publish retires its own file and temporary before this outer finally joins the source.
      return await this.#publish(async (file) => {
        const hash = createHash('sha256');
        let total = 0;
        for (;;) {
          const step = await iterator.next();
          if (step.done === true) {
            ended = true;
            break;
          }
          const chunk = step.value;
          if (inputByteLength(chunk) > MAX_MEDIA_OBJECT_BYTES - total)
            throw new MediaAdmissionError('object_limit');
          const owned = new Uint8Array(chunk);
          verifier.push(owned);
          total += owned.length;
          hash.update(owned);
          const { bytesWritten } = await file.write(owned).catch((error: unknown) => {
            throw this.#paths.error(error);
          });
          if (bytesWritten !== owned.length) throw new MediaStoreFilesystemError('io');
        }
        verifier.finish();
        return HANDLE_PREFIX + hash.digest('hex');
      }, mimeType);
    } finally {
      if (!ended) await closeMediaIteratorPreservingFailure(iterator);
    }
  }

  async #publish(write: (file: FileHandle) => Promise<string>, mimeType: string): Promise<string> {
    const root = this.#paths.root(true);
    if (root === undefined) throw new MediaStoreFilesystemError('missing');
    this.#temporaries.assertProducerAllowed();
    const tmp = this.#temporaries.producerPath(root);
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
    let identity: ExactStats | undefined;
    let closed = false;
    let published = false;
    let result: string | undefined;
    let cleanupError: MediaStoreFilesystemError | undefined;
    try {
      identity = exactStats(
        await file.stat({ bigint: true }).catch((error: unknown) => {
          throw this.#paths.error(error);
        }),
      );
      this.#paths.assertOwnedFile(tmp, identity);
      this.#temporaries.assertProducerAllowed();
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
          await scanMediaFile(this.#paths, digest, false, mimeType);
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
    const result = await scanMediaFile(this.#paths, digestOf(handle), true);
    if (result.bytes === undefined) throw new MediaStoreFilesystemError('io');
    return result.bytes;
  }

  async validateMedia(handle: string, descriptor: Descriptor): Promise<DurableMediaMeta> {
    const snapshot = snapshotDescriptor(handle, descriptor);
    const result = await scanMediaFile(
      this.#paths,
      digestOf(handle),
      false,
      snapshot.meta.mimeType,
    );
    if (result.evidence === undefined) throw new MediaAdmissionError('store_contract');
    return validatedDescriptor(snapshot, result.evidence);
  }

  async readRange(handle: string, range: ByteRange, signal?: AbortSignalLike): Promise<Uint8Array> {
    assertMediaNotAborted(signal);
    const result = await scanMediaFile(this.#paths, digestOf(handle), true, undefined, signal);
    if (result.bytes === undefined) throw new MediaStoreFilesystemError('io');
    const bytes = sliceRange(result.bytes, range);
    assertMediaNotAborted(signal);
    return bytes;
  }

  async resolveForEgress(handle: string): Promise<MediaSource> {
    return toBase64Source(await this.get(handle));
  }

  sweepTemporaries(options?: { readonly now?: number }): Promise<MediaTemporarySweepResult> {
    return this.#temporaries.sweep(options);
  }

  pruneLegacyTemporaries(options: {
    readonly legacyOffline: true;
    readonly force: true;
  }): Promise<MediaTemporarySweepResult> {
    return this.#temporaries.pruneLegacy(options);
  }

  /** Host GC is subject to the same physical root/shard/final identity checks as delivery. */
  async delete(handle: string): Promise<void> {
    const digest = digestOf(handle);
    const path = this.#paths.path(digest, false);
    if (path === undefined || this.#paths.file(path) === undefined) return;
    await rm(path).catch((error: unknown) => {
      const failure = this.#paths.error(error);
      if (failure.reason === 'missing') {
        // A cooperating collector may remove the admitted blob before native rm starts.
        // Revalidate containment and absence; a revoked root or replacement is not success.
        const current = this.#paths.path(digest, false);
        if (current === undefined || this.#paths.file(current) === undefined) return;
      }
      throw failure;
    });
  }

  async listHandles(): Promise<Array<{ handle: string; mtimeMs: number }>> {
    const root = this.#paths.root(false);
    if (root === undefined) return [];
    const shards = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      throw this.#paths.error(error);
    });
    this.#paths.root(false);
    let failure: { readonly cause: unknown } | undefined;
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
        })
        .map((work) =>
          work.catch((cause: unknown) => {
            // Propagate the original typed failure only after every launched shard has settled.
            failure ??= { cause };
            return [];
          }),
        ),
    );
    if (failure !== undefined) throw failure.cause;
    return perShard.flat();
  }
}

/** An in-memory content-addressed store — the reference impl for tests and ephemeral runs. */
export class InMemoryMediaStore implements MediaStore {
  readonly #blobs = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array, mimeType: string): Promise<string> {
    admitInline(bytes, mimeType);
    const owned = new Uint8Array(bytes);
    const verifier = createMediaVerifier(mimeType);
    verifier.push(owned);
    verifier.finish();
    const handle = handleOf(owned);
    this.#blobs.set(handle, owned);
    return Promise.resolve(handle);
  }

  async putStream(chunks: AsyncIterable<Uint8Array>, mimeType: string): Promise<string> {
    const verifier = createMediaVerifier(mimeType);
    // Bound collection metadata independently of source fragmentation: at most 400 blocks,
    // rather than retaining one array entry for every byte or empty source chunk.
    const collected: Uint8Array[] = [];
    let block: Uint8Array | undefined;
    let used = 0;
    let total = 0;
    const iterator = chunks[Symbol.asyncIterator]();
    let ended = false;
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) {
          ended = true;
          break;
        }
        const chunk = step.value;
        if (inputByteLength(chunk) > MAX_MEDIA_OBJECT_BYTES - total)
          throw new MediaAdmissionError('object_limit');
        const owned = new Uint8Array(chunk);
        verifier.push(owned);
        let offset = 0;
        while (offset < owned.length) {
          if (block === undefined || used === block.length) {
            block = new Uint8Array(64 * 1024);
            collected.push(block);
            used = 0;
          }
          const count = Math.min(block.length - used, owned.length - offset);
          block.set(owned.subarray(offset, offset + count), used);
          used += count;
          offset += count;
        }
        total += owned.length;
      }
      verifier.finish();
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const chunk of collected) {
        const count = Math.min(chunk.length, total - at);
        bytes.set(chunk.subarray(0, count), at);
        at += count;
      }
      const handle = handleOf(bytes);
      this.#blobs.set(handle, bytes);
      return handle;
    } finally {
      // Drop unpublished collection before an owned native acknowledgement can suspend retirement.
      collected.length = 0;
      block = undefined;
      if (!ended) await closeMediaIteratorPreservingFailure(iterator);
    }
  }

  async get(handle: string): Promise<Uint8Array> {
    digestOf(handle);
    const bytes = this.#blobs.get(handle);
    if (bytes === undefined) throw new MediaStoreFilesystemError('missing');
    if (bytes.byteLength > MAX_MEDIA_OBJECT_BYTES) throw new MediaAdmissionError('object_limit');
    return Promise.resolve(bytes.slice());
  }

  async validateMedia(handle: string, descriptor: Descriptor): Promise<DurableMediaMeta> {
    const snapshot = snapshotDescriptor(handle, descriptor);
    const bytes = this.#blobs.get(handle);
    if (bytes === undefined) throw new MediaStoreFilesystemError('missing');
    if (bytes.byteLength > MAX_MEDIA_OBJECT_BYTES) throw new MediaAdmissionError('object_limit');
    const verifier = createMediaVerifier(snapshot.meta.mimeType);
    verifier.push(bytes);
    const evidence = verifier.finish();
    if (handleOf(bytes) !== handle) throw new MediaAdmissionError('store_contract');
    return Promise.resolve(validatedDescriptor(snapshot, evidence));
  }

  async resolveForEgress(handle: string): Promise<MediaSource> {
    return toBase64Source(await this.get(handle));
  }

  async readRange(handle: string, range: ByteRange, signal?: AbortSignalLike): Promise<Uint8Array> {
    assertMediaNotAborted(signal);
    const bytes = sliceRange(await this.get(handle), range);
    assertMediaNotAborted(signal);
    return bytes;
  }
}
