import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaAdmissionError } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLAC_BLOCK_REFUSALS, flacBlocks } from '../../shared/src/media-flac-vectors.js';
import { FilesystemMediaStore, InMemoryMediaStore } from './media-store.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-flac-admission-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
async function* fragmented(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let at = 0; at < bytes.length; at += 7) {
    yield await Promise.resolve(new Uint8Array());
    yield bytes.subarray(at, at + 7);
  }
}
function handleOf(bytes: Uint8Array): string {
  return `media://sha256-${createHash('sha256').update(bytes).digest('hex')}`;
}
function noTemporaries(): void {
  expect(
    readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith('.tmp')),
  ).toEqual([]);
}

describe.each(['memory', 'filesystem'] as const)('%s FLAC byte admission', (kind) => {
  for (const method of ['put', 'putStream'] as const) {
    it(`MEDIA_FLAC_STORE_SHORT_FINAL: ${method} preserves bytes and the original hash`, async () => {
      const store = kind === 'memory' ? new InMemoryMediaStore() : new FilesystemMediaStore(root);
      const bytes = flacBlocks([32, 32, 1]);
      const handle = handleOf(bytes);
      const [result] = await Promise.allSettled([
        method === 'put'
          ? store.put(bytes, 'audio/flac')
          : store.putStream(fragmented(bytes), 'audio/flac'),
      ]);
      expect(result, 'MEDIA_FLAC_STORE_SHORT_FINAL').toEqual({
        status: 'fulfilled',
        value: handle,
      });
      expect(await store.get(handle)).toEqual(bytes);
      expect(
        await store.validateMedia(handle, {
          mimeType: 'audio/flac',
          modality: 'audio',
          byteLength: bytes.length,
        }),
      ).toEqual({ handle, mimeType: 'audio/flac', modality: 'audio', byteLength: bytes.length });
      if (store instanceof FilesystemMediaStore) {
        expect((await store.listHandles()).map((entry) => entry.handle)).toEqual([handle]);
        noTemporaries();
      }
    });

    it.each(FLAC_BLOCK_REFUSALS)(
      `MEDIA_FLAC_STORE_%s: ${method} refuses before hash publication`,
      async (rule, bytes) => {
        const marker = `MEDIA_FLAC_STORE_${rule}`;
        const store = kind === 'memory' ? new InMemoryMediaStore() : new FilesystemMediaStore(root);
        const [result] = await Promise.allSettled([
          method === 'put'
            ? store.put(bytes, 'audio/flac')
            : store.putStream(fragmented(bytes), 'audio/flac'),
        ]);
        expect(result, marker).toMatchObject({
          status: 'rejected',
          reason: { code: 'invalid_format' },
        });
        if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(MediaAdmissionError);
        const [missing] = await Promise.allSettled([store.get(handleOf(bytes))]);
        expect(missing, marker).toMatchObject({ status: 'rejected' });
        if (store instanceof FilesystemMediaStore) {
          expect(await store.listHandles(), marker).toEqual([]);
          noTemporaries();
        }
      },
    );
  }
});

it.each(FLAC_BLOCK_REFUSALS)(
  'MEDIA_FLAC_LEGACY_%s: revalidation refuses without deleting bytes',
  async (rule, bytes) => {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const shard = join(root, digest.slice(0, 2));
    mkdirSync(shard);
    const target = join(shard, digest.slice(2));
    writeFileSync(target, bytes);
    const store = new FilesystemMediaStore(root);
    const [result] = await Promise.allSettled([
      store.validateMedia(handleOf(bytes), {
        mimeType: 'audio/flac',
        modality: 'audio',
        byteLength: bytes.length,
      }),
    ]);
    expect(result, `MEDIA_FLAC_LEGACY_${rule}`).toMatchObject({
      status: 'rejected',
      reason: { code: 'invalid_format' },
    });
    if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(MediaAdmissionError);
    expect(new Uint8Array(readFileSync(target))).toEqual(bytes);
    expect((await store.listHandles()).map((entry) => entry.handle)).toEqual([handleOf(bytes)]);
    noTemporaries();
  },
);
