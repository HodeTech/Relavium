import { expect, it, vi } from 'vitest';
import { INLINE_MEDIA_CEILING, type ContentPart, type MediaStore } from './content.js';
import {
  admitMediaDescriptor,
  MAX_MEDIA_OBJECT_BYTES,
  MediaAdmissionError,
} from './media-admission.js';
import { deInlineMedia } from './media-deinline.js';
import { createMediaVerifier } from './media-verifier.js';
import { mp4Video, PNG } from './media-test-vectors.js';

const handle = `media://sha256-${'a'.repeat(64)}`;
function part(data: string, mimeType = 'audio/L16'): ContentPart {
  return { type: 'media', mimeType, source: { kind: 'base64', data } };
}
function zeroBase64(length: number): string {
  return (
    'AAAA'.repeat(Math.floor(length / 3)) +
    (length % 3 === 1 ? 'AA==' : length % 3 === 2 ? 'AAA=' : '')
  );
}
/** Independently verifies chunks without concatenating the object or decoding a second copy. */
function inspectingStore() {
  let count = 0;
  const chunkLengths: number[] = [];
  const put = vi.fn((bytes: Uint8Array, mimeType: string) => {
    const verifier = createMediaVerifier(mimeType);
    verifier.push(bytes);
    count = verifier.finish().byteLength;
    return Promise.resolve(handle);
  });
  const putStream = vi.fn(async (chunks: AsyncIterable<Uint8Array>, mimeType: string) => {
    const verifier = createMediaVerifier(mimeType);
    for await (const bytes of chunks) {
      chunkLengths.push(bytes.length);
      verifier.push(bytes);
    }
    count = verifier.finish().byteLength;
    return handle;
  });
  const validateMedia = vi.fn(
    (ref: string, descriptor: Parameters<MediaStore['validateMedia']>[1]) =>
      Promise.resolve(admitMediaDescriptor({ ...descriptor, handle: ref, byteLength: count })),
  );
  const store: MediaStore = {
    put,
    putStream,
    validateMedia,
    get: () => Promise.reject(new Error('Not used')),
    resolveForEgress: () => Promise.reject(new Error('Not used')),
    readRange: () => Promise.reject(new Error('Not used')),
  };
  return { store, put, putStream, validateMedia, chunkLengths };
}

it('MEDIA_GENERATED_OBJECT_EXACT: publishes exact-capacity PCM through bounded decoded chunks', async () => {
  const fixture = inspectingStore();
  const out = await deInlineMedia([part(zeroBase64(MAX_MEDIA_OBJECT_BYTES))], fixture.store);
  expect(out, 'MEDIA_GENERATED_OBJECT_EXACT').toEqual([
    {
      type: 'media',
      mimeType: 'audio/L16',
      source: { kind: 'handle', ref: handle },
      byteLength: MAX_MEDIA_OBJECT_BYTES,
    },
  ]);
  expect(fixture.put, 'MEDIA_GENERATED_STREAM_PREFERRED').not.toHaveBeenCalled();
  expect(fixture.putStream).toHaveBeenCalledTimes(1);
  expect(fixture.chunkLengths.length, 'MEDIA_GENERATED_BOUNDED_CHUNKS').toBeGreaterThan(1);
  expect(Math.max(...fixture.chunkLengths), 'MEDIA_GENERATED_BOUNDED_CHUNKS').toBeLessThanOrEqual(
    64 * 1024,
  );
  expect(fixture.chunkLengths.reduce((sum, n) => sum + n, 0)).toBe(MAX_MEDIA_OBJECT_BYTES);
});

it.each([1, 3])(
  'MEDIA_GENERATED_OBJECT_PREFLIGHT: rejects object capacity +%i before reservation or store entry',
  async (extra) => {
    const fixture = inspectingStore();
    const reserve = vi.fn();
    await expect(
      deInlineMedia(
        [part(zeroBase64(MAX_MEDIA_OBJECT_BYTES + extra))],
        fixture.store,
        undefined,
        reserve,
      ),
      'MEDIA_GENERATED_OBJECT_PREFLIGHT',
    ).rejects.toMatchObject({ code: 'object_limit' });
    expect(reserve, 'MEDIA_GENERATED_OBJECT_PREFLIGHT').not.toHaveBeenCalled();
    expect(fixture.put, 'MEDIA_GENERATED_OBJECT_PREFLIGHT').not.toHaveBeenCalled();
    expect(fixture.putStream, 'MEDIA_GENERATED_OBJECT_PREFLIGHT').not.toHaveBeenCalled();
    expect(fixture.validateMedia, 'MEDIA_GENERATED_OBJECT_PREFLIGHT').not.toHaveBeenCalled();
  },
);

it.each([
  '',
  'AAA',
  'A===',
  'AA=A',
  'AAAA\n',
  'AAAA'.repeat(22000) + '%%%=',
  'AAAA'.repeat(22000) + 'AAA=AAAA',
])(
  'MEDIA_GENERATED_BASE64_PREFLIGHT: rejects malformed encoding case %# before host entry',
  async (data) => {
    const fixture = inspectingStore();
    await expect(
      deInlineMedia([part(data)], fixture.store),
      'MEDIA_GENERATED_BASE64_PREFLIGHT',
    ).rejects.toMatchObject({ code: 'invalid_descriptor' });
    expect(fixture.putStream).not.toHaveBeenCalled();
    expect(fixture.put).not.toHaveBeenCalled();
  },
);

it.each([2, INLINE_MEDIA_CEILING.audio])(
  'MEDIA_GENERATED_SMALL_LEGACY_HOST: preserves %i-byte PCM publication without a stream method',
  async (length) => {
    const fixture = inspectingStore();
    delete fixture.store.putStream;
    const out = await deInlineMedia([part(zeroBase64(length))], fixture.store);
    expect(out[0], 'MEDIA_GENERATED_SMALL_LEGACY_HOST').toMatchObject({
      byteLength: length,
      source: { kind: 'handle', ref: handle },
    });
    expect(fixture.put).toHaveBeenCalledTimes(1);
    expect(fixture.putStream).not.toHaveBeenCalled();
  },
);

it.each([
  part(zeroBase64(INLINE_MEDIA_CEILING.audio + 2)),
  part(Buffer.from(mp4Video()).toString('base64'), 'video/mp4'),
  part(Buffer.from('%PDF-1.7\n%%EOF').toString('base64'), 'application/pdf'),
])(
  'MEDIA_GENERATED_STREAM_REQUIRED: refuses unsupported legacy-host publication case %# before put',
  async (media) => {
    const fixture = inspectingStore();
    delete fixture.store.putStream;
    await expect(
      deInlineMedia([media], fixture.store),
      'MEDIA_GENERATED_STREAM_REQUIRED',
    ).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(fixture.put).not.toHaveBeenCalled();
    expect(fixture.validateMedia).not.toHaveBeenCalled();
  },
);

it.each([Buffer.from(PNG).toString('base64'), zeroBase64(INLINE_MEDIA_CEILING.audio + 2)])(
  'MEDIA_GENERATED_STREAM_NO_FALLBACK: preserves stream failure case %# without put or validation',
  async (data) => {
    const fixture = inspectingStore();
    const failure = new MediaAdmissionError('source_failed');
    fixture.putStream.mockRejectedValueOnce(failure);
    await expect(
      deInlineMedia([part(data)], fixture.store),
      'MEDIA_GENERATED_STREAM_NO_FALLBACK',
    ).rejects.toBe(failure);
    expect(fixture.putStream).toHaveBeenCalledTimes(1);
    expect(fixture.put).not.toHaveBeenCalled();
    expect(fixture.validateMedia).not.toHaveBeenCalled();
  },
);

it('MEDIA_GENERATED_STREAM_EOF: refuses a store that returns before draining generated bytes', async () => {
  const fixture = inspectingStore();
  fixture.putStream.mockResolvedValueOnce(handle);
  await expect(
    deInlineMedia([part('AAA=')], fixture.store),
    'MEDIA_GENERATED_STREAM_EOF',
  ).rejects.toMatchObject({ code: 'stream_incomplete' });
  expect(fixture.put).not.toHaveBeenCalled();
  expect(fixture.validateMedia).not.toHaveBeenCalled();
});
