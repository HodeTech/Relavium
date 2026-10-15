import { MediaInspectionMemory } from './media-inspection-memory.js';
import { ogg } from './media-verifier-ogg.js';
import { describe, expect, it } from 'vitest';
import { createMediaVerifier } from './media-verifier.js';
import { MediaAdmissionError, MAX_MEDIA_OBJECT_BYTES } from './media-admission.js';
import {
  AAC,
  FLAC,
  GIF,
  JPEG,
  MPEG,
  PNG,
  WEBP,
  VORBIS,
  mp4Video,
  opus,
  pdfDocument,
  wave,
  webmVideo,
} from './media-test-vectors.js';
import { ParserReader, read, skip } from './media-verifier-reader.js';
import { png } from './media-verifier-images.js';
import { PdfVerifier } from './media-verifier-pdf.js';
const cases: readonly (readonly [string, Uint8Array])[] = [
  ['image/png', PNG],
  ['image/jpeg', JPEG],
  ['image/gif', GIF],
  ['image/webp', WEBP],
  ['audio/wav', wave()],
  ['audio/aac', AAC],
  ['audio/mpeg', MPEG],
  ['audio/flac', FLAC],
  ['audio/opus', opus()],
  ['audio/ogg', VORBIS],
  ['audio/L16', new Uint8Array([1, 2])],
  ['video/mp4', mp4Video()],
  ['video/webm', webmVideo()],
  ['application/pdf', pdfDocument()],
];
describe('finite incremental media recognition', () => {
  for (const [mime, bytes] of cases) {
    it(`${mime}: independently specified complete body and every split`, () => {
      for (let split = 0; split <= bytes.length; split++) {
        const v = createMediaVerifier(mime);
        v.push(bytes.subarray(0, split));
        v.push(bytes.subarray(split));
        expect(v.finish()).toMatchObject({ mimeType: mime, byteLength: bytes.length });
      }
      const v = createMediaVerifier(mime);
      for (const b of bytes) v.push(new Uint8Array([b]));
      expect(v.finish().mimeType).toBe(mime);
    });
    it(`${mime}: empty and truncated body refuse at finish`, () => {
      for (const body of [
        new Uint8Array(0),
        bytes.subarray(0, bytes.length - (mime === 'application/pdf' ? 2 : 1)),
      ]) {
        const v = createMediaVerifier(mime);
        expect(() => {
          v.push(body);
          v.finish();
        }, 'media-verifier-finish-required').toThrow(MediaAdmissionError);
      }
    });
  }
  it('counts borrowed bytes without retaining caller mutations and enforces exact/+1 object cap', () => {
    const v = createMediaVerifier('audio/L16'),
      chunk = new Uint8Array(1024);
    for (let i = 0; i < MAX_MEDIA_OBJECT_BYTES / chunk.length; i++) v.push(chunk);
    expect(v.finish().byteLength).toBe(MAX_MEDIA_OBJECT_BYTES);
    const over = createMediaVerifier('audio/L16');
    over.push(new Uint8Array(MAX_MEDIA_OBJECT_BYTES));
    expect(() => over.push(new Uint8Array(1)), 'media-verifier-object-bound').toThrowError(
      new MediaAdmissionError('object_limit'),
    );
  });
  it('bounds the reader request and skip contracts at exact/+1 without allocating a body', () => {
    expect(read(4096).next()).toMatchObject({ done: false, value: { size: 4096 } });
    expect(() => read(4097).next(), 'media-reader-request-bound').toThrowError(
      new MediaAdmissionError('inspection_limit'),
    );
    expect(skip(25 * 1024 * 1024).next()).toMatchObject({
      done: false,
      value: { size: 25 * 1024 * 1024, skip: true },
    });
    expect(() => skip(25 * 1024 * 1024 + 1).next(), 'media-reader-skip-bound').toThrowError(
      new MediaAdmissionError('invalid_format'),
    );
  });
  it('enforces state after finished or failed', () => {
    const v = createMediaVerifier('image/png');
    expect(() => v.push(new Uint8Array(9))).toThrow();
    expect(() => v.push(PNG)).toThrowError(new MediaAdmissionError('verifier_state'));
    const p = createMediaVerifier('audio/L16');
    p.push(new Uint8Array(2));
    p.finish();
    expect(() => p.finish()).toThrowError(new MediaAdmissionError('verifier_state'));
  });
  it('identifies Opus under a generic Ogg declaration, refuses reverse and foreign codec', () => {
    const v = createMediaVerifier('audio/ogg');
    v.push(opus());
    expect(v.finish().mimeType, 'media-ogg-codec-identity').toBe('audio/opus');
    const bad = createMediaVerifier('audio/opus');
    expect(() => {
      bad.push(VORBIS);
      bad.finish();
    }).toThrow();
  });
  it('streams large comment bodies and late container metadata with bounded retained arenas', () => {
    for (const [mime, bytes] of [
      ['audio/opus', opus(32000)],
      ['video/mp4', mp4Video(200000)],
      ['video/webm', webmVideo(100000)],
      ['application/pdf', pdfDocument(200000)],
    ] satisfies [string, Uint8Array][]) {
      const v = createMediaVerifier(mime);
      for (let i = 0; i < bytes.length; i += 997) v.push(bytes.subarray(i, i + 997));
      expect(v.finish().byteLength).toBe(bytes.length);
    }
    for (const family of ['png', 'ogg', 'pdf']) {
      const retained: Uint8Array[] = [];
      const memory = new MediaInspectionMemory((buffer) => retained.push(buffer));
      const parser =
        family === 'pdf'
          ? new PdfVerifier(memory)
          : new ParserReader(family === 'ogg' ? ogg(memory) : png(), memory);
      const bytes = family === 'pdf' ? pdfDocument(200000) : family === 'ogg' ? opus(32000) : PNG;
      for (let i = 0; i < bytes.length; i += 997) parser.push(bytes.subarray(i, i + 997));
      parser.finish();
      expect(
        retained.reduce((sum, buffer) => sum + buffer.buffer.byteLength, 0),
        'media-total-inspection-scratch',
      ).toBeLessThanOrEqual(65536);
    }
    const memory = new MediaInspectionMemory();
    expect(memory.allocate(65536).length).toBe(65536);
    expect(() => memory.allocate(1), 'media-inspection-bound').toThrow(
      new MediaAdmissionError('inspection_limit'),
    );
  });
  it('refuses generic signatures and forged tail/track identity', () => {
    for (const [mime, bytes, needle] of [
      ['video/mp4', mp4Video(), 'vide'],
      ['video/webm', webmVideo(), 'V_VP8'],
      ['application/pdf', pdfDocument(), 'xref'],
    ] satisfies [string, Uint8Array, string][]) {
      const copy = bytes.slice();
      const at = Buffer.from(copy).indexOf(needle);
      expect(at).toBeGreaterThanOrEqual(0);
      copy[at] = 0;
      const v = createMediaVerifier(mime);
      expect(
        () => {
          v.push(copy);
          v.finish();
        },
        mime === 'video/mp4'
          ? 'media-mp4-video-track'
          : mime === 'video/webm'
            ? 'media-webm-video-track'
            : 'media-pdf-tail',
      ).toThrow(MediaAdmissionError);
    }
  });
});
