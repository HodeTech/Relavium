import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { MEDIA_HANDLE_PATTERN, type MediaSource, type MediaStore } from '@relavium/shared';

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
  // `MediaStore` interface): the CAS is pure bytes-by-content-hash; the engine records mimeType in the
  // `media_objects` row, not in the blob store.
  put(bytes: Uint8Array): Promise<string> {
    return this.#write(bytes);
  }

  async #write(bytes: Uint8Array): Promise<string> {
    const handle = handleOf(bytes);
    const path = this.#pathFor(digestOf(handle));
    await mkdir(dirname(path), { recursive: true });
    // Content-addressed ⇒ same bytes write the same path; an overwrite is byte-identical (idempotent).
    await writeFile(path, bytes);
    return handle;
  }

  async get(handle: string): Promise<Uint8Array> {
    const buf = await readFile(this.#pathFor(digestOf(handle)));
    return new Uint8Array(buf);
  }

  // `provider` is intentionally not a parameter yet (a fewer-param method satisfies the interface):
  // 1.AF resolves to inline base64 for every provider. The provider-aware file re-upload optimization
  // for over-ceiling media is the egress/sidecar work (1.AF/D8, ADR-0043); the engine, not the adapter,
  // calls this before egress.
  async resolveForEgress(handle: string): Promise<MediaSource> {
    return toBase64Source(await this.get(handle));
  }

  /** Resolve the CAS path for a validated digest, fail-closed if it would escape the store root. */
  #pathFor(digest: string): string {
    const full = resolve(this.#root, join(digest.slice(0, 2), digest.slice(2)));
    if (full !== this.#root && !full.startsWith(this.#root + sep)) {
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
    this.#blobs.set(handle, bytes);
    return Promise.resolve(handle);
  }

  get(handle: string): Promise<Uint8Array> {
    if (!MEDIA_HANDLE_PATTERN.test(handle)) {
      return Promise.reject(new Error('not a media://sha256-<64hex> handle'));
    }
    const bytes = this.#blobs.get(handle);
    return bytes === undefined
      ? Promise.reject(new Error(`no media bytes for ${handle}`))
      : Promise.resolve(bytes);
  }

  async resolveForEgress(handle: string): Promise<MediaSource> {
    return toBase64Source(await this.get(handle));
  }
}
