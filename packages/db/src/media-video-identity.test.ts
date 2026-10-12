import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ambiguousVideoIdentities } from '../../shared/src/media-identity-vectors.js';
import { mp4Video, webmVideo } from '../../shared/src/media-test-vectors.js';
import { FilesystemMediaStore, InMemoryMediaStore } from './media-store.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'relavium-video-identity-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function* chunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  const middle = Math.floor(bytes.length / 2);
  yield bytes.subarray(0, middle);
  await Promise.resolve();
  yield bytes.subarray(middle);
}

describe.each(['memory', 'filesystem'] as const)('%s video identity publication', (kind) => {
  it.each([
    { name: 'WebM unknown then supported codec', positive: webmVideo() },
    { name: 'MP4 repeated handler soun-vide', positive: mp4Video() },
  ])('refuses $name through stream publication without a handle', async ({ name, positive }) => {
    const vector = ambiguousVideoIdentities.find((candidate) => candidate.name === name);
    if (vector === undefined) throw new Error('Missing independent identity fixture');
    const store = kind === 'filesystem' ? new FilesystemMediaStore(root) : new InMemoryMediaStore();
    const refusedHandle = `media://sha256-${createHash('sha256').update(vector.bytes).digest('hex')}`;
    // Video has no inline carrier; only the streaming path reaches byte verification.
    await expect(store.put(vector.bytes, vector.mimeType)).rejects.toMatchObject({
      name: 'MediaAdmissionError',
      code: 'inline_limit',
    });
    await expect(store.putStream(chunks(vector.bytes), vector.mimeType)).rejects.toMatchObject({
      name: 'MediaAdmissionError',
      code: 'invalid_format',
    });
    await expect(store.get(refusedHandle)).rejects.toThrow();
    if (store instanceof FilesystemMediaStore) {
      expect(await store.listHandles()).toEqual([]);
      expect(await readdir(root)).toEqual([]);
    }
    const handle = await store.putStream(chunks(positive), vector.mimeType);
    expect(await store.putStream(chunks(positive), vector.mimeType)).toBe(handle);
    expect(await store.get(handle)).toEqual(positive);
  });
});
