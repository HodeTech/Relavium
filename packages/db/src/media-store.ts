import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

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
  readonly #root: string;

  constructor(rootDir: string) {
    this.#root = resolve(rootDir);
  }

  // `mimeType` is intentionally not a parameter here (a fewer-param method still satisfies the
  // `MediaStore` interface): the CAS is pure bytes-by-content-hash. mimeType is NOT persisted yet — the
  // P3/P4 media-lifecycle wiring (D10/D11) will record it (and byteLength/modality) in the `media_objects`
  // row when the store is invoked; no code populates that table at P1+P2.
  put(bytes: Uint8Array): Promise<string> {
    return this.#write(bytes);
  }

  async #write(bytes: Uint8Array): Promise<string> {
    const handle = handleOf(bytes);
    const path = this.#pathFor(digestOf(handle));
    await mkdir(dirname(path), { recursive: true });
    // Atomic publish: write a unique temp file in the same directory, then rename it onto the final
    // content-addressed path. An interrupted write leaves a stray `.tmp`, never a partial blob at the
    // canonical path — so a later get() never serves (and its sha256 check never trips on) a truncated
    // file. `rename` within a directory is atomic on POSIX. Content-addressed ⇒ the final path is
    // byte-identical across writers, so racing an identical publish is harmless.
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
    return handle;
  }

  async get(handle: string): Promise<Uint8Array> {
    const digest = digestOf(handle);
    const bytes = new Uint8Array(await readFile(this.#pathFor(digest)));
    // Content-address integrity: the handle IS the sha256, so verify the bytes on read — a corrupted
    // file (bit rot, partial write, tampering) is caught here rather than propagating corrupt bytes.
    if (sha256Hex(bytes) !== digest) {
      throw new Error('media bytes failed their content-address (sha256) integrity check');
    }
    return bytes;
  }

  // The `signal` of the `MediaStore.readRange` contract is omitted (a fewer-param method satisfies the
  // interface): the Node reference reads the bounded blob whole (it is already size-capped by the put/egress
  // path) and reuses get()'s path-jail + sha256 integrity check, then defensively re-bounds the inclusive
  // range. The real desktop Rust CAS (1.AH) streams the validated range with an abort.
  async readRange(handle: string, range: ByteRange): Promise<Uint8Array> {
    return sliceRange(await this.get(handle), range);
  }

  // `provider` is intentionally not a parameter yet (a fewer-param method satisfies the interface):
  // 1.AF resolves to inline base64 for every provider. The provider-aware file re-upload optimization
  // for over-ceiling media is the egress/sidecar work (1.AF/D8, ADR-0043); the engine, not the adapter,
  // calls this before egress.
  async resolveForEgress(handle: string): Promise<MediaSource> {
    return toBase64Source(await this.get(handle));
  }

  /**
   * Delete a blob by handle — the host GC's byte-reclamation step (2.S/D-GC, ADR-0042 §4: a grace-expired handle
   * (§4c) or a row-less-orphan handle from a crash). `digestOf` rejects a non-`media://` handle and `#pathFor`
   * jails the path, so this can never unlink outside the store root. Idempotent: a missing blob (already
   * reclaimed / never written) is a no-op via `rm`'s `force`. NOT on the `MediaStore` engine port — GC is a host
   * concern, not an engine one.
   */
  async delete(handle: string): Promise<void> {
    await rm(this.#pathFor(digestOf(handle)), { force: true });
  }

  /**
   * Enumerate every well-formed `media://sha256-<hex>` handle the CAS currently holds, each with its blob's
   * `mtimeMs` — the host GC's orphan-detection + age-guard input (a row-less blob, 2.S/D-GC; the `mtimeMs` lets
   * the GC skip a freshly-written blob a concurrent run may not have `recordObject`'d yet). Reconstructs the
   * handle from the shard dir + filename and re-validates it against {@link MEDIA_HANDLE_PATTERN}, so a stray
   * `.tmp` from an interrupted publish, or any non-conforming name, is skipped; the inner loop also skips a
   * non-file (a stray subdir). An absent root (the CAS was never written) yields `[]`.
   */
  async listHandles(): Promise<Array<{ handle: string; mtimeMs: number }>> {
    if (!existsSync(this.#root)) {
      return [];
    }
    const out: Array<{ handle: string; mtimeMs: number }> = [];
    for (const shard of await readdir(this.#root, { withFileTypes: true })) {
      // CAS layout: `<root>/<aa>/<rest-of-hash>` — only a 2-hex-char shard DIR holds blobs; skip strays.
      if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) {
        continue;
      }
      const shardDir = join(this.#root, shard.name);
      for (const entry of await readdir(shardDir, { withFileTypes: true })) {
        if (!entry.isFile()) {
          continue; // a stray subdir inside a shard could otherwise reconstruct a bogus 62-hex "handle"
        }
        const handle = `${HANDLE_PREFIX}${shard.name}${entry.name}`;
        if (MEDIA_HANDLE_PATTERN.test(handle)) {
          out.push({ handle, mtimeMs: (await stat(join(shardDir, entry.name))).mtimeMs });
        }
      }
    }
    return out;
  }

  /** Resolve the CAS path for a validated digest, fail-closed if it would escape the store root. */
  #pathFor(digest: string): string {
    const full = resolve(this.#root, join(digest.slice(0, 2), digest.slice(2)));
    // Normalize the boundary so a root that already ends in `sep` (the filesystem root `/` or `C:\`)
    // does not produce a `//`/`C:\\` prefix that a valid child path would fail to match (false positive).
    const prefix = this.#root.endsWith(sep) ? this.#root : this.#root + sep;
    if (full !== this.#root && !full.startsWith(prefix)) {
      throw new Error('media path escapes the store root');
    }
    return full;
  }
}

/** An in-memory content-addressed store — the reference impl for tests and ephemeral runs. */
export class InMemoryMediaStore implements MediaStore {
  readonly #blobs = new Map<string, Uint8Array>();

  put(bytes: Uint8Array): Promise<string> {
    const handle = handleOf(bytes);
    // Defensive copy on write (match FilesystemMediaStore.get's copy-on-read): a later mutation of the
    // caller's array must never corrupt the content-addressed blob this handle names.
    this.#blobs.set(handle, bytes.slice());
    return Promise.resolve(handle);
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
