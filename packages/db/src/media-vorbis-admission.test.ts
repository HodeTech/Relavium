import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deInlineMedia, DurableContentPartSchema, MediaAdmissionError } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  changeVorbisField,
  nativeVorbis,
  vorbisContainer,
  vorbisSetup,
} from '../../shared/src/media-vorbis-vectors.js';
import { FilesystemMediaStore, InMemoryMediaStore } from './media-store.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-vorbis-admission-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
async function* fragments(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let at = 0; at < bytes.length; at += 13) {
    yield await Promise.resolve(new Uint8Array());
    yield bytes.subarray(at, at + 13);
  }
}
function handleOf(bytes: Uint8Array): string {
  return `media://sha256-${createHash('sha256').update(bytes).digest('hex')}`;
}
async function publish(
  store: InMemoryMediaStore | FilesystemMediaStore,
  method: 'put' | 'putStream' | 'de-inline',
  bytes: Uint8Array,
): Promise<string> {
  if (method === 'put') return store.put(bytes, 'audio/ogg');
  if (method === 'putStream') return store.putStream(fragments(bytes), 'audio/ogg');
  const part = DurableContentPartSchema.parse(
    await deInlineMedia(
      {
        type: 'media',
        mimeType: 'audio/ogg',
        source: { kind: 'base64', data: Buffer.from(bytes).toString('base64') },
        byteLength: bytes.length,
      },
      store,
    ),
  );
  if (part.type !== 'media' || part.source.kind !== 'handle')
    throw new Error('Expected a durable Vorbis fixture handle');
  return part.source.ref;
}
describe.each(['memory', 'filesystem'] as const)('%s real Vorbis publication', (kind) => {
  for (const method of ['put', 'putStream', 'de-inline'] as const) {
    it(`MEDIA_VORBIS_STORE_NATIVE: ${method} preserves all eight native-decoded framing positions`, async () => {
      const store = kind === 'memory' ? new InMemoryMediaStore() : new FilesystemMediaStore(root);
      const handles: string[] = [];
      for (let modes = 1; modes <= 8; modes++) {
        const bytes = nativeVorbis(modes),
          handle = handleOf(bytes),
          [outcome] = await Promise.allSettled([publish(store, method, bytes)]);
        expect(outcome, 'MEDIA_VORBIS_STORE_NATIVE').toEqual({
          status: 'fulfilled',
          value: handle,
        });
        expect(await store.get(handle), 'MEDIA_VORBIS_STORE_NATIVE').toEqual(bytes);
        expect(
          await store.validateMedia(handle, {
            mimeType: 'audio/ogg',
            modality: 'audio',
            byteLength: bytes.length,
          }),
          'MEDIA_VORBIS_STORE_NATIVE',
        ).toEqual({ handle, mimeType: 'audio/ogg', modality: 'audio', byteLength: bytes.length });
        handles.push(handle);
      }
      if (store instanceof FilesystemMediaStore) {
        expect((await store.listHandles()).map((entry) => entry.handle).sort()).toEqual(
          handles.sort(),
        );
        expect(
          readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith('.tmp')),
        ).toEqual([]);
      }
    });
    it(`MEDIA_VORBIS_STORE_INVALID: ${method} rejects a missing actual framing bit before publication`, async () => {
      const store = kind === 'memory' ? new InMemoryMediaStore() : new FilesystemMediaStore(root),
        bytes = vorbisContainer(changeVorbisField(vorbisSetup(), 'framing', 0)),
        [outcome] = await Promise.allSettled([publish(store, method, bytes)]);
      expect(outcome, 'MEDIA_VORBIS_STORE_INVALID').toMatchObject({
        status: 'rejected',
        reason: { code: 'invalid_format' },
      });
      if (outcome?.status === 'rejected')
        expect(outcome.reason).toBeInstanceOf(MediaAdmissionError);
      const [missing] = await Promise.allSettled([store.get(handleOf(bytes))]);
      expect(missing, 'MEDIA_VORBIS_STORE_INVALID').toMatchObject({ status: 'rejected' });
      if (store instanceof FilesystemMediaStore) {
        expect(await store.listHandles()).toEqual([]);
        expect(
          readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith('.tmp')),
        ).toEqual([]);
      }
    });
  }
});
