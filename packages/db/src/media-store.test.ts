import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MEDIA_HANDLE_PATTERN } from '@relavium/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FilesystemMediaStore, InMemoryMediaStore } from './media-store.js';

const HELLO = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
const expectedHandle = `media://sha256-${createHash('sha256').update(HELLO).digest('hex')}`;

describe('FilesystemMediaStore (1.AF, ADR-0042 — content-addressed CAS)', () => {
  let root: string;
  let store: FilesystemMediaStore;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-media-'));
    store = new FilesystemMediaStore(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  /** An `AsyncIterable` over a chunk list, optionally throwing part-way. */
  function chunkStream(
    chunks: readonly Uint8Array[],
    throwAfter?: number,
  ): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        let i = 0;
        return {
          next: (): Promise<IteratorResult<Uint8Array>> => {
            if (throwAfter !== undefined && i === throwAfter) {
              return Promise.reject(new Error('body failed mid-stream'));
            }
            const chunk = chunks[i];
            i += 1;
            return Promise.resolve(
              chunk === undefined ? { done: true, value: undefined } : { done: false, value: chunk },
            );
          },
        };
      },
    };
  }

  it('putStream content-addresses a chunked body to the SAME handle put would', async () => {
    // The digest is computed incrementally, so a body split across chunks must land on the byte-identical
    // content address — otherwise two writes of the same asset would produce two handles and the CAS would
    // stop being content-addressed.
    const handle = await store.putStream(
      chunkStream([HELLO.slice(0, 2), HELLO.slice(2)]));
    expect(handle).toBe(expectedHandle);
    expect(await store.get(handle)).toEqual(HELLO);
  });

  it('publishes NOTHING and leaves no temp file when the body fails mid-stream', async () => {
    // ADR-0089 §2 makes this a decision bullet: "a partial write is cleaned up and the handle is published
    // only once the whole object is durable". A half-object at a content-addressed path would be worse than
    // no object — `get()` verifies the digest on every read, so it would be a permanently unreadable handle
    // the durable event insists exists.
    const failRoot = mkdtempSync(join(tmpdir(), 'relavium-media-partial-'));
    try {
      const failing = new FilesystemMediaStore(failRoot);
      await expect(
        failing.putStream(chunkStream([HELLO.slice(0, 2)], 1)),
      ).rejects.toThrow(/body failed mid-stream/);
      expect(readdirSync(failRoot)).toEqual([]); // no shard directory, and no stray `.tmp`
    } finally {
      rmSync(failRoot, { recursive: true, force: true });
    }
  });

  it('does not hold the whole body — it writes as it consumes', async () => {
    // The claim the whole change exists for, asserted the only honest way at this seam: the store must pull
    // chunk N+1 only AFTER it has dealt with chunk N. A store that buffered would drain the source first.
    const seen: number[] = [];
    let written = 0;
    const observed: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        let i = 0;
        return {
          next: (): Promise<IteratorResult<Uint8Array>> => {
            seen.push(written); // how much had been written when this chunk was requested
            i += 1;
            if (i > 3) return Promise.resolve({ done: true, value: undefined });
            written += 1;
            return Promise.resolve({ done: false, value: new Uint8Array([i]) });
          },
        };
      },
    };
    const streamRoot = mkdtempSync(join(tmpdir(), 'relavium-media-lazy-'));
    try {
      await new FilesystemMediaStore(streamRoot).putStream(observed);
      // Pull N happened when N-1 chunks had been produced — strictly interleaved, never drained up front.
      expect(seen).toEqual([0, 1, 2, 3]);
    } finally {
      rmSync(streamRoot, { recursive: true, force: true });
    }
  });

  it('put returns the canonical media://sha256-<hex> handle = sha256 of the bytes', async () => {
    const handle = await store.put(HELLO);
    expect(handle).toBe(expectedHandle);
    expect(handle).toMatch(MEDIA_HANDLE_PATTERN);
  });

  it('get round-trips the exact bytes; put is idempotent (same bytes → same handle)', async () => {
    const h1 = await store.put(HELLO);
    const h2 = await store.put(HELLO); // content-addressed ⇒ the same bytes always yield the same handle
    expect(h2).toBe(h1);
    expect([...(await store.get(h1))]).toEqual([...HELLO]);
  });

  it('resolveForEgress returns an inline base64 source of the bytes', async () => {
    const handle = await store.put(HELLO);
    const source = await store.resolveForEgress(handle);
    expect(source).toEqual({ kind: 'base64', data: Buffer.from(HELLO).toString('base64') });
  });

  it('rejects a non-handle string (never reads an arbitrary path)', async () => {
    await expect(store.get('../../etc/passwd')).rejects.toThrow(/handle/);
    await expect(store.get('media://sha256-not-hex')).rejects.toThrow(/handle/);
  });

  it('rejects a tampered/corrupt blob on read (sha256 integrity-on-read)', async () => {
    // The CAS tamper-evidence property is the security-critical core of the content-addressed store: the
    // handle IS the sha256, so a corrupted/partial/tampered blob must be REJECTED on read, never served.
    // A fresh root keeps the corrupted blob from perturbing the shared-store round-trip/idempotency tests.
    const tamperRoot = mkdtempSync(join(tmpdir(), 'relavium-media-tamper-'));
    try {
      const tamperStore = new FilesystemMediaStore(tamperRoot);
      const handle = await tamperStore.put(HELLO);
      const digest = handle.slice('media://sha256-'.length);
      const casPath = join(tamperRoot, digest.slice(0, 2), digest.slice(2));
      writeFileSync(casPath, new Uint8Array([0xff])); // overwrite the stored bytes in place
      await expect(tamperStore.get(handle)).rejects.toThrow(/content-address/);
    } finally {
      rmSync(tamperRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('InMemoryMediaStore (1.AF — reference impl)', () => {
  it('round-trips bytes content-addressed and rejects an unknown / malformed handle', async () => {
    const store = new InMemoryMediaStore();
    const handle = await store.put(HELLO);
    expect(handle).toBe(expectedHandle);
    expect([...(await store.get(handle))]).toEqual([...HELLO]);
    await expect(store.get(`media://sha256-${'f'.repeat(64)}`)).rejects.toThrow(/no media bytes/);
    await expect(store.get('nonsense')).rejects.toThrow(/handle/);
  });

  it('copies on put and get — a caller mutation cannot corrupt the stored blob', async () => {
    const store = new InMemoryMediaStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const handle = await store.put(bytes);
    bytes[0] = 99; // mutate the caller's array AFTER put
    const got = await store.get(handle);
    expect([...got]).toEqual([1, 2, 3]); // the stored blob is intact (put copied)
    got[0] = 88; // mutate the returned array
    expect([...(await store.get(handle))]).toEqual([1, 2, 3]); // still intact (get copied)
  });
});

describe('MediaStore.readRange (1.AF/D13 — byte-delivery Range gate)', () => {
  it('InMemoryMediaStore reads a valid inclusive range and rejects an out-of-bounds one', async () => {
    const store = new InMemoryMediaStore();
    const handle = await store.put(HELLO); // [0x68,0x65,0x6c,0x6c,0x6f] = "hello"
    expect([...(await store.readRange(handle, { start: 1, end: 3 }))]).toEqual([0x65, 0x6c, 0x6c]); // "ell"
    expect([...(await store.readRange(handle, { start: 0, end: 4 }))]).toEqual([...HELLO]); // whole
    await expect(store.readRange(handle, { start: 0, end: 5 })).rejects.toThrow(/out of bounds/);
    await expect(store.readRange(handle, { start: 3, end: 1 })).rejects.toThrow(
      /reversed|>= start/,
    );
    await expect(store.readRange(handle, { start: -1, end: 2 })).rejects.toThrow(/non-negative/);
  });

  it('InMemoryMediaStore.readRange rejects a malformed handle (never reads an unknown blob)', async () => {
    const store = new InMemoryMediaStore();
    await expect(store.readRange('nonsense', { start: 0, end: 0 })).rejects.toThrow(/handle/);
  });

  it('FilesystemMediaStore reads a validated range (reusing the path-jail + sha256 integrity check)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relavium-media-range-'));
    try {
      const store = new FilesystemMediaStore(root);
      const handle = await store.put(HELLO);
      expect([...(await store.readRange(handle, { start: 1, end: 2 }))]).toEqual([0x65, 0x6c]); // "el"
      await expect(store.readRange(handle, { start: 2, end: 99 })).rejects.toThrow(/out of bounds/);
      await expect(store.readRange('../../etc/passwd', { start: 0, end: 1 })).rejects.toThrow(
        /handle/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('FilesystemMediaStore — host GC support (2.S/D-GC: delete + listHandles)', () => {
  let root: string;
  let store: FilesystemMediaStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-media-gc-'));
    store = new FilesystemMediaStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  it('listHandles enumerates every stored handle (with mtime); an empty or absent root yields []', async () => {
    expect(await store.listHandles()).toEqual([]); // the root exists but is empty
    // A store at a NEVER-created path exercises the absent-root (readdir ENOENT) branch — not just empty-dir.
    const absent = new FilesystemMediaStore(join(root, 'never-created-subdir'));
    expect(await absent.listHandles()).toEqual([]);
    const h1 = await store.put(new Uint8Array([1]));
    const h2 = await store.put(new Uint8Array([2, 3]));
    const listed = await store.listHandles();
    expect(new Set(listed.map((e) => e.handle))).toEqual(new Set([h1, h2]));
    expect(listed.every((e) => typeof e.mtimeMs === 'number' && e.mtimeMs > 0)).toBe(true);
  });

  it('listHandles skips strays: a non-conforming file, a non-shard dir, a root file, a subdir in a shard', async () => {
    const h1 = await store.put(HELLO);
    const shard = h1.slice('media://sha256-'.length, 'media://sha256-'.length + 2);
    // (a) a leftover temp file in the shard dir; (b) a subdir inside the shard dir (would reconstruct a bogus
    // handle if treated as a file); (c) a non-2-hex dir at the root; (d) a loose file at the root.
    writeFileSync(join(root, shard, `.save.${'0'.repeat(8)}.tmp`), 'x');
    mkdirSync(join(root, shard, 'a'.repeat(62)), { recursive: true });
    mkdirSync(join(root, 'zz-not-a-shard'), { recursive: true });
    writeFileSync(join(root, 'loose-file'), 'x');
    expect((await store.listHandles()).map((e) => e.handle)).toEqual([h1]); // only the real blob
  });

  it('delete removes a blob (a later get fails) and is idempotent on a missing blob', async () => {
    const handle = await store.put(HELLO);
    await store.delete(handle);
    await expect(store.get(handle)).rejects.toThrow();
    await expect(store.delete(handle)).resolves.toBeUndefined(); // a 2nd delete is a no-op
  });

  it('delete rejects a non-media:// handle (the digest jail) — never unlinks outside the root', async () => {
    await expect(store.delete('not-a-handle')).rejects.toThrow(/handle/);
  });
});
