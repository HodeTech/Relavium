import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaAdmissionError } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { malformedOpusComments, paddedOpus } from '../../shared/src/media-opus-vectors.js';
import { FilesystemMediaStore, InMemoryMediaStore } from './media-store.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-opus-admission-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
async function* fragmented(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let at = 0; at < bytes.length; at += 13) {
    yield await Promise.resolve(new Uint8Array());
    yield bytes.subarray(at, at + 13);
  }
}
function handleOf(bytes: Uint8Array): string {
  return `media://sha256-${createHash('sha256').update(bytes).digest('hex')}`;
}
describe.each(['memory', 'filesystem'] as const)('%s Opus byte admission', (kind) => {
  for (const method of ['put', 'putStream'] as const) {
    it(`MEDIA_OPUS_STORE_TAIL: ${method} preserves padded bytes and validates the original hash`, async () => {
      const store = kind === 'memory' ? new InMemoryMediaStore() : new FilesystemMediaStore(root);
      const accepted: string[] = [];
      for (const tail of [
        new Uint8Array(),
        new Uint8Array(512),
        new Uint8Array([1, 255, 0, 128]),
      ]) {
        const bytes = paddedOpus(tail);
        const handle = handleOf(bytes);
        const [result] = await Promise.allSettled([
          method === 'put'
            ? store.put(bytes, 'audio/opus')
            : store.putStream(fragmented(bytes), 'audio/opus'),
        ]);
        expect(result, 'MEDIA_OPUS_STORE_TAIL').toEqual({ status: 'fulfilled', value: handle });
        expect(await store.get(handle), 'MEDIA_OPUS_STORE_TAIL').toEqual(bytes);
        expect(
          await store.validateMedia(handle, {
            mimeType: 'audio/opus',
            modality: 'audio',
            byteLength: bytes.length,
          }),
          'MEDIA_OPUS_STORE_TAIL',
        ).toEqual({ handle, mimeType: 'audio/opus', modality: 'audio', byteLength: bytes.length });
        accepted.push(handle);
      }
      const bytes = malformedOpusComments();
      const [rejected] = await Promise.allSettled([
        method === 'put'
          ? store.put(bytes, 'audio/opus')
          : store.putStream(fragmented(bytes), 'audio/opus'),
      ]);
      expect(rejected, 'MEDIA_OPUS_STORE_REQUIRED_FRAMING').toMatchObject({
        status: 'rejected',
        reason: { code: 'invalid_format' },
      });
      if (rejected.status === 'rejected')
        expect(rejected.reason).toBeInstanceOf(MediaAdmissionError);
      const [missing] = await Promise.allSettled([store.get(handleOf(bytes))]);
      expect(missing, 'MEDIA_OPUS_STORE_REQUIRED_FRAMING').toMatchObject({ status: 'rejected' });
      if (store instanceof FilesystemMediaStore) {
        expect((await store.listHandles()).map((entry) => entry.handle).sort()).toEqual(
          accepted.sort(),
        );
        // Recursive names include the private temp directory and CAS shards, if present.
        expect(
          readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith('.tmp')),
        ).toEqual([]);
      }
    });
  }
});
