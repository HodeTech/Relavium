import { describe, expect, it } from 'vitest';
import { MediaAdmissionError } from './media-admission.js';
import {
  FLAC_BLOCK_REFUSALS,
  FLAC_RFC_PREDICTOR,
  FLAC_STRUCTURE_ACCEPTANCES,
  FLAC_STRUCTURE_REFUSALS,
  flacBlocks,
  flacFrame,
  flacMetadata,
  flacPredictor,
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

it.each(FLAC_STRUCTURE_REFUSALS)(
  'MEDIA_FLAC_%s: refuses an independently checksummed structural violation',
  (rule, bytes) => refuses(bytes, `MEDIA_FLAC_${rule}`),
);
it.each(FLAC_STRUCTURE_ACCEPTANCES)(
  'MEDIA_FLAC_VALID_%s: preserves adjacent legal framing across every byte split',
  (_rule, bytes) => accepts(bytes),
);

describe('FLAC predictor and residual grammar', () => {
  it.each([0, 1, 2, 3, 4])('accepts fixed predictor order %i', (order) => {
    accepts(flacPredictor({ order }));
  });
  it.each([1, 2, 32])(
    'accepts LPC order %i with independent coefficients and residuals',
    (order) => {
      accepts(flacPredictor({ kind: 'lpc', order, block: 64 }));
    },
  );
  it.each([0, 14])('accepts LPC coefficient precision-minus-one %i', (precision) => {
    accepts(flacPredictor({ kind: 'lpc', precision, shift: 15 }));
  });
  it.each([1, 15])('accepts %i wasted bits before warm-up samples', (wastedBits) => {
    // Zero residuals keep decoded samples representable even at the one-bit depth boundary.
    accepts(flacPredictor({ wastedBits, partitions: [{ escape: 0 }] }));
  });
  it('uses the fifth parameter bit for Rice method 1', () => {
    accepts(flacPredictor({ method: 1, partitions: [{ rice: 16 }] }));
  });
  it.each([0, 1])('accepts zero-width and nonzero escaped partitions for method %i', (method) => {
    accepts(flacPredictor({ method, partitions: [{ escape: 0 }] }));
    accepts(flacPredictor({ method, partitions: [{ escape: 3 }] }));
  });
  it('subtracts warm-up samples only from the first of four mixed partitions', () => {
    const options = {
      block: 32,
      order: 2,
      method: 1,
      partitionOrder: 2,
      partitions: [{ rice: 0 }, { escape: 0 }, { rice: 16 }, { escape: 3 }],
    };
    accepts(flacPredictor(options));
    refuses(
      flacPredictor({ ...options, subtractWarmupEveryPartition: true }),
      'MEDIA_FLAC_FIRST_PARTITION_WARMUP',
    );
  });
  it.each([
    { order: 1, block: 16, partitionOrder: 4 },
    { order: 2, block: 16, partitionOrder: 3 },
    { order: 3, block: 24, partitionOrder: 3 },
    { order: 4, block: 16, partitionOrder: 2 },
  ])('requires positive first-partition residual count for fixed order $order', (options) => {
    refuses(flacPredictor(options), 'MEDIA_FLAC_PARTITION_EQUALITY');
    accepts(flacPredictor({ ...options, partitionOrder: options.partitionOrder - 1 }));
  });
  it('requires positive first-partition residual count for LPC', () => {
    refuses(flacPredictor({ kind: 'lpc', order: 16 }), 'MEDIA_FLAC_PARTITION_EQUALITY');
    accepts(flacPredictor({ kind: 'lpc', order: 15 }));
  });
  it.each([
    { method: 2 },
    { method: 3 },
    { kind: 'lpc', precision: 15 },
    { kind: 'lpc', shift: -1 },
    { wastedBits: 16 },
    { wastedBits: 18 },
    { block: 17, partitionOrder: 1 },
    { block: 3, order: 4 },
    { alignmentBit: 1 },
  ] as const)('refuses reserved or inconsistent predictor fields %#', (options) => {
    refuses(flacPredictor(options), 'MEDIA_FLAC_PREDICTOR_FRAMING');
  });
  it('refuses every truncated predictor body and footer', () => {
    for (const bytes of [
      FLAC_RFC_PREDICTOR,
      flacPredictor({ kind: 'lpc', method: 1, partitions: [{ rice: 16 }] }),
      flacPredictor({ partitions: [{ escape: 3 }] }),
    ]) {
      for (let end = 42; end < bytes.length; end++) {
        const partial = bytes.subarray(0, end);
        expect(verify([partial]), 'MEDIA_FLAC_PREDICTOR_TRUNCATION').toMatchObject({
          status: 'rejected',
          reason: { code: 'invalid_format' },
        });
        expect(
          verify(Array.from(partial, (value) => new Uint8Array([value]))),
          'MEDIA_FLAC_PREDICTOR_TRUNCATION',
        ).toMatchObject({ status: 'rejected', reason: { code: 'invalid_format' } });
      }
    }
  });
});

describe('FLAC bounded metadata grammar', () => {
  it('accepts empty/repeated padding and opaque application data', () => {
    accepts(
      flacMetadata([
        { type: 1, bytes: new Uint8Array() },
        { type: 1, bytes: new Uint8Array(8) },
        { type: 2, bytes: hex('6162636400ff0080') },
      ]),
    );
  });
  it('checks padding across arena boundaries in fragmented deliveries', () => {
    const padding = new Uint8Array(8193);
    const good = flacMetadata([{ type: 1, bytes: padding }]);
    padding[8192] = 1;
    const bad = flacMetadata([{ type: 1, bytes: padding }]);
    for (const size of [1, 4095, 4096, 4097]) {
      const fragments = (bytes: Uint8Array): Uint8Array[] =>
        Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) =>
          bytes.subarray(index * size, (index + 1) * size),
        );
      expect(verify(fragments(good)), 'MEDIA_FLAC_PADDING_ZERO').toMatchObject({
        status: 'fulfilled',
      });
      expect(verify(fragments(bad)), 'MEDIA_FLAC_PADDING_ZERO').toMatchObject({
        status: 'rejected',
        reason: { code: 'invalid_format' },
      });
    }
  });
  it.each([0, 1, 2, 3])('requires all four APPLICATION identifier bytes, length %i', (length) => {
    refuses(
      flacMetadata([{ type: 2, bytes: new Uint8Array(length) }]),
      'MEDIA_FLAC_APPLICATION_MINIMUM',
    );
  });
  it('keeps unrelated metadata opaque, including reserved skippable types', () => {
    accepts(
      flacMetadata([
        { type: 3, bytes: hex('ff') },
        { type: 7, bytes: hex('0080ff') },
        { type: 126, bytes: new Uint8Array() },
      ]),
    );
  });
  it('retains metadata-chain forbidden type, duplicate STREAMINFO and truncation refusals', () => {
    for (const type of [0, 127])
      refuses(flacMetadata([{ type, bytes: new Uint8Array(34) }]), 'MEDIA_FLAC_METADATA_CHAIN');
    for (const type of [1, 2]) {
      const bytes = flacMetadata([{ type, bytes: new Uint8Array(8) }]);
      for (let end = 42; end < 54; end++)
        refuses(bytes.subarray(0, end), 'MEDIA_FLAC_METADATA_TRUNCATION');
      refuses(
        flacMetadata([{ type, bytes: new Uint8Array(8), length: 100 }]),
        'MEDIA_FLAC_METADATA_TRUNCATION',
      );
    }
  });
});
