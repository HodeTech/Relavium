import { describe, expect, it } from 'vitest';
import { MediaAdmissionError } from './media-admission.js';
import {
  FLAC_BLOCK_REFUSALS,
  flacBlocks,
  flacFrame,
  flacStream,
  type FlacStrategy,
} from './media-flac-vectors.js';
import { FLAC, hex, join } from './media-test-vectors.js';
import { createMediaVerifier } from './media-verifier.js';

function verify(parts: readonly Uint8Array[]): unknown {
  try {
    const verifier = createMediaVerifier('audio/flac');
    for (const part of parts) verifier.push(part);
    return { status: 'fulfilled', value: verifier.finish() };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}
function* deliveries(bytes: Uint8Array): Iterable<readonly Uint8Array[]> {
  for (let split = 0; split <= bytes.length; split++)
    yield [bytes.subarray(0, split), new Uint8Array(), bytes.subarray(split)];
  for (const sizes of [[1], [4, 34, 4, 1, 1, 1, 3, 2]]) {
    const parts: Uint8Array[] = [new Uint8Array()];
    for (let at = 0, i = 0; at < bytes.length; i++) {
      const size = sizes[i % sizes.length] ?? 1;
      parts.push(bytes.subarray(at, at + size), new Uint8Array());
      at += size;
    }
    yield parts;
  }
}
function accepts(bytes: Uint8Array): void {
  for (const parts of deliveries(bytes))
    expect(verify(parts), 'MEDIA_FLAC_VALID_FINAL').toEqual({
      status: 'fulfilled',
      value: { mimeType: 'audio/flac', modality: 'audio', byteLength: bytes.length },
    });
}
function refuses(bytes: Uint8Array, marker: string): void {
  for (const parts of deliveries(bytes))
    expect(verify(parts), marker).toMatchObject({
      status: 'rejected',
      reason: { code: 'invalid_format' },
    });
}

it.each(FLAC_BLOCK_REFUSALS)(
  'MEDIA_FLAC_%s: refuses independently numbered blocks',
  (rule, bytes) => {
    refuses(bytes, `MEDIA_FLAC_${rule}`);
  },
);

describe.each(['fixed', 'variable'] satisfies FlacStrategy[])('%s block framing', (strategy) => {
  it.each([true, false])('exact minimum and min-1 with knownTotal=%s', (knownTotal) => {
    accepts(flacBlocks([16, 16], strategy, 16, 32, knownTotal));
    refuses(flacBlocks([15, 15], strategy, 16, 32, knownTotal), 'MEDIA_FLAC_MINIMUM');
    refuses(flacBlocks([1, 4096], strategy, 4096, 4096, knownTotal), 'MEDIA_FLAC_MINIMUM');
  });
  it.each([1, 15, 16])('preserves final block %i after equal nonfinal frames', (last) => {
    accepts(flacBlocks([32, 32, last], strategy, 32, 32));
    accepts(flacBlocks([32, 32, last], strategy, 32, 32, false));
  });
  it('preserves a short singleton and a full singleton', () => {
    accepts(flacBlocks([1], strategy, 4096, 4096));
    accepts(flacBlocks([16], strategy, 16, 16));
  });
});

it('preserves the immutable RFC Appendix D.1.1 short singleton', () => accepts(FLAC));
it.each([{ blocks: [16, 32, 16] }, { blocks: [32, 16, 32] }, { blocks: [16, 32] }])(
  'fixed $blocks refuses while the correctly sample-numbered variable pair accepts',
  ({ blocks }) => {
    refuses(flacBlocks(blocks), 'MEDIA_FLAC_FIXED_CONSISTENCY');
    accepts(flacBlocks(blocks, 'variable'));
  },
);
it('variable blocks need not attain either declared bound', () => {
  accepts(flacBlocks([32, 48, 1], 'variable', 16, 64));
});
it('fixed blocks may have unequal STREAMINFO bounds and a short final', () => {
  accepts(flacBlocks([32, 32, 15], 'fixed', 16, 64));
});
it('preserves exact extended frame and sample numbers', () => {
  accepts(flacBlocks([4096, 4096, 1], 'variable', 4096, 4096));
  // Cross the single-byte frame-number boundary without buffering sample payloads.
  accepts(
    flacBlocks(
      Array.from({ length: 129 }, () => 16),
      'fixed',
      16,
      16,
    ),
  );
});

it('retains strategy, number, maximum, CRC, total and partial-next-frame guards', () => {
  const first = flacFrame(16, 0, 'fixed');
  const second = flacFrame(16, 1, 'fixed');
  const crc8 = second.slice();
  crc8[6] = (crc8[6] ?? 0) ^ 1;
  const crc16 = second.slice();
  crc16[crc16.length - 1] = (crc16[crc16.length - 1] ?? 0) ^ 1;
  const cases = [
    flacStream([first, flacFrame(16, 16, 'variable')], 16, 32, 32),
    flacStream([first, flacFrame(16, 2, 'fixed')], 16, 32, 32),
    flacStream([flacFrame(16, 0, 'variable'), flacFrame(16, 1, 'variable')], 16, 32, 32),
    flacBlocks([33], 'fixed', 16, 32),
    flacStream([first, crc8], 16, 32, 32),
    flacStream([first, crc16], 16, 32, 32),
    flacStream([first, second], 16, 32, 31),
    flacStream([], 16, 32, 0),
    ...Array.from({ length: second.length - 1 }, (_, i) =>
      flacStream([first, second.subarray(0, i + 1)], 16, 32, 0),
    ),
    join(flacBlocks([16, 1]), hex('ff')),
  ];
  for (const bytes of cases) refuses(bytes, 'MEDIA_FLAC_EXISTING_FRAMING');
});
it('a block-rule refusal poisons subsequent pushes and finish', () => {
  const verifier = createMediaVerifier('audio/flac');
  expect(() => verifier.push(flacBlocks([32, 16, 32]))).toThrow(MediaAdmissionError);
  expect(() => verifier.push(new Uint8Array())).toThrow(MediaAdmissionError);
  expect(() => verifier.finish()).toThrow(MediaAdmissionError);
});
