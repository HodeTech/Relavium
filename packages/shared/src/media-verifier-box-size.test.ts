import { describe, expect, it } from 'vitest';
import { MediaAdmissionError } from './media-admission.js';
import { join, mp4Video, textBytes, uint32 } from './media-test-vectors.js';
import { createMediaVerifier } from './media-verifier.js';

/** Independent root-box reconstruction; the production parser is not the fixture oracle. */
function videoWithFinalMdat(size: 'ordinary' | 'eof' | number): Uint8Array {
  const source = mp4Video(3),
    view = new DataView(source.buffer, source.byteOffset, source.byteLength),
    firstEnd = view.getUint32(0),
    dataEnd = firstEnd + view.getUint32(firstEnd),
    payload = source.subarray(firstEnd + 8, dataEnd),
    header =
      size === 'ordinary'
        ? join(uint32(8 + payload.length), textBytes('mdat'))
        : size === 'eof'
          ? join(uint32(0), textBytes('mdat'))
          : join(uint32(1), textBytes('mdat'), uint32(0), uint32(size));
  return join(source.subarray(0, firstEnd), source.subarray(dataEnd), header, payload);
}
function outcome(bytes: Uint8Array, split: number): unknown {
  try {
    const verifier = createMediaVerifier('video/mp4');
    verifier.push(bytes.subarray(0, split));
    verifier.push(bytes.subarray(split));
    return { status: 'fulfilled', value: verifier.finish() };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}
describe('ISO BMFF ordinary and extended box sizes remain distinct', () => {
  it.each(['ordinary', 'eof', 19] as const)('preserves the legal final mdat size %s', (size) => {
    const bytes = videoWithFinalMdat(size);
    for (let split = 0; split <= bytes.length; split++)
      expect(outcome(bytes, split), 'MEDIA_MP4_SIZE_FORM').toEqual({
        status: 'fulfilled',
        value: { mimeType: 'video/mp4', modality: 'video', byteLength: bytes.length },
      });
  });
  it.each([0, 1, 15, 16, 18, 20])('refuses the malformed extended mdat extent %i', (size) => {
    const bytes = videoWithFinalMdat(size);
    for (let split = 0; split <= bytes.length; split++)
      expect(outcome(bytes, split), 'MEDIA_MP4_EXTENDED_ZERO').toEqual({
        status: 'rejected',
        reason: new MediaAdmissionError('invalid_format'),
      });
  });
});
