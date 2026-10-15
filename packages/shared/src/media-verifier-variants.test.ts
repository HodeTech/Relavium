import { expect, it } from 'vitest';
import { createMediaVerifier } from './media-verifier.js';
import {
  GIF,
  JPEG,
  MPEG,
  WEBP,
  hex,
  join,
  mp4Video,
  textBytes,
  uint32,
  webmVideo,
} from './media-test-vectors.js';
function accept(mime: string, bytes: Uint8Array): void {
  for (let split = 0; split <= bytes.length; split++) {
    const verifier = createMediaVerifier(mime);
    verifier.push(bytes.subarray(0, split));
    verifier.push(bytes.subarray(split));
    expect(verifier.finish(), 'media-supported-variant').toMatchObject({
      mimeType: mime,
      byteLength: bytes.length,
    });
  }
}
function riff(kind: string, ...chunks: Uint8Array[]): Uint8Array {
  const body = join(textBytes(kind), ...chunks);
  return join(textBytes('RIFF'), uint32(body.length, true), body);
}
function chunk(kind: string, body: Uint8Array): Uint8Array {
  return join(
    textBytes(kind),
    uint32(body.length, true),
    body,
    ...(body.length % 2 ? [hex('00')] : []),
  );
}
it('WAVE accepts independently laid out float and extensible PCM', () => {
  for (const fmt of [
    hex('03000100401f0000007d000004002000'),
    hex('feff0100401f0000803e00000200100016001000000000000100000000001000800000aa00389b71'),
  ]) {
    accept('audio/wav', riff('WAVE', chunk('fmt ', fmt), chunk('data', hex('00000000'))));
  }
});
it('ADTS accepts a CRC-bearing frame and multiple consistent frames', () => {
  accept('audio/aac', hex('fff05080015ffc000000fff05080015ffc000000'));
});
it('JPEG accepts two progressive scans with independently specified scan headers', () => {
  const beforeScan = JPEG.slice(0, JPEG.length - 13);
  const sof = Buffer.from(beforeScan).indexOf(hex('ffc0'));
  expect(sof).toBeGreaterThan(0);
  beforeScan[sof + 1] = 0xc2;
  accept('image/jpeg', join(beforeScan, hex('ffda00080101000000003fffda0008010100013f003fffd9')));
});
it('GIF permits a second complete image and WebP static lossless/extended framing', () => {
  accept('image/gif', join(GIF.subarray(0, GIF.length - 1), GIF.subarray(19)));
  accept('image/webp', riff('WEBP', chunk('VP8L', hex('2f0000000000'))));
  accept('image/webp', riff('WEBP', chunk('VP8X', new Uint8Array(10)), WEBP.subarray(12)));
});
it.each(['avc1', 'hvc1', 'vp09', 'av01'] as const)(
  'MP4 admits the finite %s configuration layout',
  (codec) => {
    accept('video/mp4', mp4Video(1, codec));
  },
);
it('MPEG permits correctly sized ID3v2.4 footer and terminal ID3v1 framing', () => {
  accept(
    'audio/mpeg',
    join(
      hex('49443304001000000000'),
      hex('33444904001000000000'),
      MPEG,
      textBytes('TAG'),
      new Uint8Array(125),
    ),
  );
});
it('WebM permits an unknown-size Segment while retaining known-size children', () => {
  const bytes = webmVideo();
  const at = Buffer.from(bytes).indexOf(hex('18538067')) + 4;
  expect(at).toBeGreaterThan(4);
  bytes[at] = 255;
  accept('video/webm', bytes);
});
