import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MEDIA_HANDLE_PATTERN } from '@relavium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  afterAll(() => rmSync(root, { recursive: true, force: true }));

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
});
