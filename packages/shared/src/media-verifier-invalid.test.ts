import { describe, expect, it } from 'vitest';
import { createMediaVerifier } from './media-verifier.js';
import { MAX_MEDIA_OBJECT_BYTES, MediaAdmissionError } from './media-admission.js';
import {
  AAC,
  FLAC,
  GIF,
  JPEG,
  MPEG,
  PNG,
  WEBP,
  hex,
  join,
  mp4Video,
  opus,
  pdfDocument,
  textBytes,
  uint32,
  wave,
  webmVideo,
} from './media-test-vectors.js';
function accepts(mime: string, bytes: Uint8Array): void {
  const v = createMediaVerifier(mime);
  v.push(bytes);
  expect(v.finish().byteLength).toBe(bytes.length);
}
function refuses(mime: string, bytes: Uint8Array, marker = 'media-invalid-structure'): void {
  expect(() => {
    const v = createMediaVerifier(mime);
    v.push(bytes);
    v.finish();
  }, marker).toThrow(MediaAdmissionError);
}
function changed(bytes: Uint8Array, at: number, value: number): Uint8Array {
  const copy = bytes.slice();
  copy[at] = value;
  return copy;
}
function location(bytes: Uint8Array, needle: string): number {
  const at = Buffer.from(bytes).indexOf(Buffer.from(needle, 'latin1'));
  expect(at).toBeGreaterThanOrEqual(0);
  return at;
}
function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const bytes = join(textBytes(type), payload);
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return join(uint32(payload.length), bytes, uint32((crc ^ 0xffffffff) >>> 0));
}
function ebml(id: string, payload: Uint8Array): Uint8Array {
  const length = payload.length;
  const size =
    length < 127
      ? new Uint8Array([0x80 + length])
      : new Uint8Array([0x40 + (length >> 8), length & 255]);
  return join(hex(id), size, payload);
}
function webmWithCounts(trackCount: number, blockCount: number): Uint8Array {
  const header = ebml('1a45dfa3', ebml('4282', textBytes('webm')));
  const tracks = ebml(
    '1654ae6b',
    join(
      ...Array.from({ length: trackCount }, (_, index) =>
        ebml(
          'ae',
          join(
            ebml('d7', new Uint8Array([index + 1])),
            ebml('83', new Uint8Array([1])),
            ebml('86', textBytes('V_VP8')),
            ebml('e0', join(ebml('b0', new Uint8Array([1])), ebml('ba', new Uint8Array([1])))),
          ),
        ),
      ),
    ),
  );
  const cluster = ebml(
    '1f43b675',
    join(
      ...Array.from({ length: blockCount }, (_, index) =>
        ebml('a3', new Uint8Array([0x81 + index, 0, 0, 0x80, 0])),
      ),
    ),
  );
  return join(header, ebml('18538067', join(cluster, tracks)));
}
function oggPage(packet: Uint8Array, sequence: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  let remaining = packet.length;
  while (remaining >= 255) {
    lacing.push(255);
    remaining -= 255;
  }
  if (remaining > 0 || lacing.length < 255) lacing.push(remaining);
  const bytes = join(
    textBytes('OggS'),
    new Uint8Array([0, flags]),
    new Uint8Array(8),
    uint32(42, true),
    uint32(sequence, true),
    new Uint8Array(4),
    new Uint8Array([lacing.length]),
    new Uint8Array(lacing),
    packet,
  );
  let crc = 0;
  for (const value of bytes) {
    crc ^= value << 24;
    for (let bit = 0; bit < 8; bit++)
      crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  }
  new DataView(bytes.buffer).setUint32(22, crc, true);
  return bytes;
}
function opusWithCommentCount(count: number): Uint8Array {
  const tags = join(
    textBytes('OpusTags'),
    uint32(0, true),
    uint32(count, true),
    new Uint8Array(count * 4),
  );
  const pages = [oggPage(join(textBytes('OpusHead'), hex('0101380180bb0000000000')), 0, 2)];
  let sequence = 1;
  for (let offset = 0; offset < tags.length; offset += 65025) {
    pages.push(oggPage(tags.subarray(offset, offset + 65025), sequence++, offset === 0 ? 0 : 1));
  }
  pages.push(oggPage(hex('f8fffe'), sequence, 4));
  return join(...pages);
}
describe('independent malformed-format controls', () => {
  it.each(['V_VP8', 'V_VP9', 'V_AV1'] as const)(
    'MEDIA_WEBM_ENCODING_REFUSAL: refuses encrypted %s tracks at every input split',
    (codec) => {
      accepts('video/webm', webmVideo(9, { codec }));
      // WebM encryption: ContentEncodingType=1, AES=5, a key ID and CTR cipher mode=1.
      // https://www.webmproject.org/docs/webm-encryption/#43-supported-matroska-encryption-elements
      const bytes = webmVideo(9, {
        codec,
        contentEncodings: hex(
          '6240a150318100503281015033810150359247e1810547e2840102030447e78447e88101',
        ),
      });
      for (let split = 0; split <= bytes.length; split++) {
        let failure: unknown;
        try {
          const verifier = createMediaVerifier('video/webm');
          verifier.push(bytes.subarray(0, split));
          verifier.push(bytes.subarray(split));
          verifier.finish();
        } catch (error) {
          failure = error;
        }
        expect(failure, 'MEDIA_WEBM_ENCODING_REFUSAL').toBeInstanceOf(MediaAdmissionError);
        expect(failure, 'MEDIA_WEBM_ENCODING_REFUSAL').toMatchObject({ code: 'invalid_format' });
      }
    },
  );
  it('PNG checks CRC, critical identity, IHDR fields, animation refusal and exact terminal', () => {
    accepts('image/png', PNG);
    refuses('image/png', changed(PNG, 29, 0), 'media-png-checksum');
    for (const kind of ['ABCD', 'acTL'])
      refuses(
        'image/png',
        join(PNG.subarray(0, 33), pngChunk(kind, new Uint8Array(0)), PNG.subarray(33)),
      );
    for (const [at, b] of [
      [0, 0],
      [8, 3],
      [9, 1],
      [10, 1],
      [12, 2],
    ] satisfies [number, number][]) {
      const header = PNG.slice(16, 29);
      header[at] = b;
      if (at === 0) header.fill(0, 0, 4);
      refuses('image/png', join(PNG.subarray(0, 8), pngChunk('IHDR', header), PNG.subarray(33)));
    }
    refuses('image/png', join(PNG, new Uint8Array(1)));
  });
  it('PNG skips large ancillary chunks and bounds structure count at exact/+1', () => {
    const chunk = pngChunk('teXt', new Uint8Array(0)),
      base = PNG.subarray(0, 33),
      tail = PNG.subarray(33);
    const exact = new Uint8Array(base.length + tail.length + 65533 * chunk.length);
    exact.set(base);
    for (let i = 0; i < 65533; i++) exact.set(chunk, base.length + i * chunk.length);
    exact.set(tail, exact.length - tail.length);
    accepts('image/png', exact);
    refuses(
      'image/png',
      join(base, chunk, exact.subarray(base.length)),
      'media-structure-count-bound',
    );
    accepts('image/png', join(base, pngChunk('teXt', new Uint8Array(100000)), tail));
  });
  it('JPEG rejects marker-only, missing tables, bad segment lengths and incomplete entropy escapes', () => {
    refuses('image/jpeg', hex('ffd8ffd9'));
    refuses(
      'image/jpeg',
      join(JPEG.subarray(0, 2), JPEG.subarray(71)),
      'media-jpeg-required-tables',
    );
    refuses('image/jpeg', changed(JPEG, 5, 1));
    refuses('image/jpeg', changed(JPEG, 6, 2));
    refuses('image/jpeg', changed(JPEG, JPEG.length - 3, 255));
    refuses('image/jpeg', changed(JPEG, location(JPEG, '\xff\xc0') + 1, 0xc3));
  });
  it('GIF requires complete palettes, valid sub-blocks, real images and trailer', () => {
    refuses('image/gif', join(GIF.subarray(0, 19), hex('3b')));
    refuses('image/gif', changed(GIF, 29, 9));
    refuses('image/gif', changed(GIF, 30, 100));
    refuses('image/gif', changed(GIF, 23, 2));
    refuses('image/gif', join(GIF, hex('00')));
  });
  it('WebP checks RIFF extent, VP8 keyframe evidence and static profile', () => {
    refuses('image/webp', changed(WEBP, 4, 1));
    refuses('image/webp', changed(WEBP, 20, 1));
    refuses('image/webp', changed(WEBP, 23, 0));
    const x = join(textBytes('VP8X'), uint32(10, true), hex('02000000000000000000'));
    refuses(
      'image/webp',
      join(
        textBytes('RIFF'),
        uint32(WEBP.length - 8 + x.length, true),
        textBytes('WEBP'),
        x,
        WEBP.subarray(12),
      ),
    );
  });
  it('WAV rejects unsupported codec, inconsistent alignment/rate, bad extent and missing data', () => {
    for (const [at, b] of [
      [20, 6],
      [22, 0],
      [28, 0],
      [32, 1],
      [34, 12],
      [40, 3],
    ] satisfies [number, number][])
      refuses('audio/wav', changed(wave(), at, b));
    refuses('audio/wav', wave(1));
    refuses('audio/wav', wave(0));
    accepts('audio/wav', wave(262100));
  });
  it('ADTS refuses foreign/raw audio, reserved frequencies, multi-blocks and truncated frames', () => {
    for (const [at, b] of [
      [0, 0],
      [1, 0xf6],
      [2, 0x7c],
      [6, 0xfd],
      [4, 0],
    ] satisfies [number, number][])
      refuses('audio/aac', changed(AAC, at, b));
    refuses('audio/aac', join(AAC, AAC.subarray(0, 7)));
    accepts('audio/aac', join(AAC, AAC));
  });
  it('MPEG requires frame continuity, valid indices and exact metadata/body extent', () => {
    refuses('audio/mpeg', MPEG.subarray(0, 417));
    for (const [at, b] of [
      [2, 0],
      [2, 0xfc],
      [418, 0xeb],
      [419, 0x94],
    ] satisfies [number, number][])
      refuses('audio/mpeg', changed(MPEG, at, b));
    accepts('audio/mpeg', join(hex('49443304000000000000'), MPEG));
    refuses('audio/mpeg', join(hex('49443304000080000000'), MPEG));
  });
  it('FLAC requires actual complete frames, STREAMINFO agreement, headerCRC8 and footerCRC16', () => {
    refuses('audio/flac', FLAC.subarray(0, 42));
    for (const at of [20, 23, 48, 55, 56])
      refuses('audio/flac', changed(FLAC, at, (FLAC[at] ?? 0) ^ 1), 'media-flac-frame-integrity');
  });
  it('Ogg requires codec packets, page checksums, continuity and EOS', () => {
    const valid = opus();
    refuses('audio/opus', changed(valid, 22, 1), 'media-ogg-page-checksum');
    const tags = location(valid, 'OpusTags');
    refuses('audio/opus', changed(valid, tags, 88));
    refuses('audio/opus', valid.subarray(0, valid.length - 31));
    refuses('audio/opus', join(valid, valid));
  });
  it('Ogg comment count admits exactly 65536 framed entries and refuses one more', () => {
    accepts('audio/opus', opusWithCommentCount(65536));
    refuses('audio/opus', opusWithCommentCount(65537), 'media-ogg-comment-count-bound');
  });
  it('MP4 rejects ftyp-only, no mdat, audio handlers, missing config and invalid child extents', () => {
    const bytes = mp4Video();
    refuses('video/mp4', bytes.subarray(0, 20));
    refuses('video/mp4', join(bytes.subarray(0, 20), bytes.subarray(29)));
    for (const name of ['vide', 'avcC'])
      refuses('video/mp4', changed(bytes, location(bytes, name), 88));
    const boxAt = location(bytes, 'avc1') - 4;
    refuses('video/mp4', changed(bytes, boxAt, 127));
    refuses(
      'video/mp4',
      changed(changed(bytes, location(bytes, 'mdhd') + 18, 0), location(bytes, 'mdhd') + 19, 0),
    );
  });
  it('WebM refuses generic EBML, audio-only tracks, mismatched block tracks, lacing and unknown clusters', () => {
    const bytes = webmVideo();
    refuses('video/webm', bytes.subarray(0, 12));
    refuses('video/webm', changed(bytes, location(bytes, 'V_VP8'), 65));
    const block = bytes.indexOf(0xa3);
    refuses('video/webm', changed(bytes, block + 2, 0x82), 'media-webm-track-block-link');
    refuses('video/webm', changed(bytes, block + 5, 0x86));
    const cluster = Buffer.from(bytes).indexOf(hex('1f43b675'));
    refuses('video/webm', changed(bytes, cluster + 4, 0xff));
  });
  it('WebM bounds separately identified tracks and blocks at exact 32 plus one', () => {
    accepts('video/webm', webmWithCounts(32, 1));
    refuses('video/webm', webmWithCounts(33, 1), 'media-webm-track-count-bound');
    accepts('video/webm', webmWithCounts(1, 32));
    refuses('video/webm', webmWithCounts(1, 33), 'media-webm-block-count-bound');
  });
  it('PDF checks final offset, classic xref structure, required Root/Size and bounded tail', () => {
    const bytes = pdfDocument();
    for (const name of ['xref', 'trailer', '/Root', '/Size', '%%EOF'])
      refuses('application/pdf', changed(bytes, location(bytes, name), 88), 'media-pdf-tail');
    const str = Buffer.from(bytes).toString();
    refuses('application/pdf', textBytes(str.replace(/startxref\n[0-9]+/, 'startxref\n1')));
    refuses('application/pdf', textBytes(str.replace('/Size 2', '/Size 1')));
    refuses('application/pdf', textBytes(str.replace('/Root 1 0 R', '/Encrypt 1 0 R')));
    refuses('application/pdf', textBytes(str.replace('trailer', ' '.repeat(49152) + 'trailer')));
  });
  it('PDF bounds an admitted trailer ID hex token at exact length plus one', () => {
    const original = Buffer.from(pdfDocument()).toString();
    const withId = (digits: number): Uint8Array =>
      textBytes(
        original.replace('>>\nstartxref', `/ID [<${'a'.repeat(digits)}> <00>] >>\nstartxref`),
      );
    accepts('application/pdf', withId(255));
    refuses('application/pdf', withId(256), 'media-pdf-id-hex-bound');
  });
  it('byte-view intrinsics ignore length, slice, subarray and iterator overrides', () => {
    let calls = 0;
    const bytes = PNG.slice();
    for (const key of ['length', 'byteLength', 'slice', 'subarray', Symbol.iterator])
      Object.defineProperty(bytes, key, {
        get() {
          calls++;
          throw new Error('private-override');
        },
      });
    const v = createMediaVerifier('image/png');
    v.push(bytes);
    expect(v.finish().byteLength, 'media-byte-view-intrinsics').toBe(PNG.length);
    expect(calls).toBe(0);
    const huge = new Uint8Array(MAX_MEDIA_OBJECT_BYTES + 1);
    Object.defineProperty(huge, 'length', {
      get() {
        calls++;
        return 2;
      },
    });
    refuses('audio/L16', huge, 'media-byte-view-cap');
    expect(calls).toBe(0);
    refuses('audio/L16', new Proxy(new Uint8Array(2), {}));
  });
});
