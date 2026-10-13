/** Internal RFC 9639 byte-layout fixtures; no production parser/checksum helpers. */
import { hex, join } from './media-test-vectors.js';

export type FlacStrategy = 'fixed' | 'variable';

// Polynomial long division, with zero initialization and no reflection/final xor.
function crc(bytes: Uint8Array, width: 8 | 16, polynomial: number): number {
  let remainder = 0;
  for (const value of bytes) {
    remainder = remainder * 256 + value;
    for (let bit = width + 7; bit >= width; bit--)
      if (Math.floor(remainder / 2 ** bit) % 2 !== 0)
        remainder ^= (2 ** width + polynomial) * 2 ** (bit - width);
  }
  for (let bit = 0; bit < width; bit++) {
    remainder *= 2;
    if (remainder >= 2 ** width) remainder ^= 2 ** width + polynomial;
  }
  return remainder;
}

function codedNumber(value: number): Uint8Array {
  if (value < 128) return new Uint8Array([value]);
  const count = [2, 3, 4, 5, 6, 7].find((n) => value < 2 ** (5 * n + 1));
  if (count === undefined) throw new Error('FLAC fixture number too large');
  const bytes = new Uint8Array(count);
  for (let i = count - 1; i > 0; i--) {
    bytes[i] = 128 + (value % 64);
    value = Math.floor(value / 64);
  }
  bytes[0] = 256 - 2 ** (8 - count) + value;
  return bytes;
}

/** Mono 16-bit 8000Hz constant-zero subframe with explicit block size and independent CRCs. */
export function flacFrame(block: number, number: number, strategy: FlacStrategy): Uint8Array {
  const size = block - 1;
  const header = join(
    new Uint8Array([255, strategy === 'fixed' ? 248 : 249, block <= 256 ? 0x64 : 0x74, 8]),
    codedNumber(number),
    block <= 256 ? new Uint8Array([size]) : new Uint8Array([size >> 8, size & 255]),
  );
  const body = join(header, new Uint8Array([crc(header, 8, 7), 0, 0, 0]));
  const footer = crc(body, 16, 0x8005);
  return join(body, new Uint8Array([footer >> 8, footer & 255]));
}

/** STREAMINFO's absent MD5/frame-size hints are zero; samples are never decoder evidence. */
export function flacStream(
  frames: readonly Uint8Array[],
  minimum: number,
  maximum: number,
  total: number,
): Uint8Array {
  const info = new Uint8Array(34);
  const view = new DataView(info.buffer);
  view.setUint16(0, minimum);
  view.setUint16(2, maximum);
  const properties = (8000n << 44n) | (15n << 36n) | BigInt(total);
  view.setBigUint64(10, properties);
  return join(hex('664c614380000022'), info, ...frames);
}

export function flacBlocks(
  blocks: readonly number[],
  strategy: FlacStrategy = 'fixed',
  minimum = 16,
  maximum = 32,
  knownTotal = true,
): Uint8Array {
  let samples = 0;
  const frames = blocks.map((block, index) => {
    const frame = flacFrame(block, strategy === 'fixed' ? index : samples, strategy);
    samples += block;
    return frame;
  });
  return flacStream(frames, minimum, maximum, knownTotal ? samples : 0);
}

// Each violates only its designated new block rule, retaining CRC/number/total consistency.
export const FLAC_BLOCK_REFUSALS = [
  ['MINIMUM_FIXED', flacBlocks([1, 1])],
  ['MINIMUM_VARIABLE', flacBlocks([1, 16], 'variable')],
  ['FIXED_NONFINAL', flacBlocks([32, 16, 32])],
  ['FIXED_FINAL_GROWTH', flacBlocks([16, 32])],
] as const;

/** Published bytes: https://www.rfc-editor.org/rfc/rfc9639.html#appendix-D.2.1 */
export const FLAC_RFC_PREDICTOR = hex(
  '664c61430000002200100010' +
    '0000170000440ac442f00000' +
    '0013d5b0564975e98b8d8b93' +
    '0422757b8103030000120000' +
    '000000000000000000000000' +
    '000000100400003a20000000' +
    '7265666572656e6365206c69' +
    '62464c414320312e332e3320' +
    '323031393038303401000000' +
    '0e0000005449544c453dd7a9' +
    'd79cd795d79d810000060000' +
    '00000000fff86998000f9912' +
    '086701623d1442998f5df70d' +
    '6fe00c17caeb21000ee7a77a' +
    '24a1590c1217b603097b784f' +
    'aa9a33d285e070ad5b1b4851' +
    'b4010d99d2cd1a68f1e6b810' +
    'fff869180102a402c382c40b' +
    'c14a03ee48dd03b67c1330',
);

type ResidualPartition = { readonly rice: number } | { readonly escape: number };
export interface FlacPredictorFixture {
  readonly kind?: 'fixed' | 'lpc';
  readonly order?: number;
  readonly block?: number;
  readonly wastedBits?: number;
  readonly method?: number;
  readonly partitionOrder?: number;
  readonly partitions?: readonly ResidualPartition[];
  /** Stored precision-minus-one and signed shift bits, including deliberate forbidden values. */
  readonly precision?: number;
  readonly shift?: number;
  readonly alignmentBit?: 0 | 1;
  readonly subtractWarmupEveryPartition?: boolean;
}

/** Fixture-only bit assembly, intentionally independent of FrameBits and its CRC algorithm. */
function binary(value: number, width: number): string {
  if (width === 0) return '';
  const unsigned = value < 0 ? 2 ** width + value : value;
  if (!Number.isSafeInteger(unsigned) || unsigned < 0 || unsigned >= 2 ** width)
    throw new Error('Invalid FLAC fixture field');
  return unsigned.toString(2).padStart(width, '0');
}
function packed(bits: string, alignmentBit = 0): Uint8Array {
  const padded = bits + String(alignmentBit).repeat((8 - (bits.length % 8)) % 8);
  return Uint8Array.from(padded.match(/.{8}/g) ?? [], (value) => Number.parseInt(value, 2));
}

/** Mono 16-bit predictor frame. Samples are tiny; CRCs cover even deliberately malformed fields. */
export function flacPredictorFrame(options: FlacPredictorFixture = {}): Uint8Array {
  const block = options.block ?? 16;
  const order = options.order ?? 1;
  const lpc = options.kind === 'lpc';
  const wasted = options.wastedBits ?? 0;
  let body = binary(lpc ? 31 + order : 8 + order, 7) + binary(wasted > 0 ? 1 : 0, 1);
  if (wasted > 0) body += '0'.repeat(wasted - 1) + '1';
  body += '0'.repeat(Math.max(0, 16 - wasted) * order);
  if (lpc) {
    const precision = options.precision ?? 3;
    body += binary(precision, 4) + binary(options.shift ?? 0, 5);
    body += '0'.repeat((precision + 1) * order);
  }
  const method = options.method ?? 0;
  const partitionOrder = options.partitionOrder ?? 0;
  const partitions = 2 ** partitionOrder;
  const parameterBits = method === 1 ? 5 : 4;
  body += binary(method, 2) + binary(partitionOrder, 4);
  for (let partition = 0; partition < partitions; partition++) {
    const encoding = options.partitions?.[partition] ?? { rice: 2 };
    const samples =
      Math.floor(block / partitions) -
      (partition === 0 || options.subtractWarmupEveryPartition === true ? order : 0);
    if ('escape' in encoding) {
      body += '1'.repeat(parameterBits) + binary(encoding.escape, 5);
      for (let sample = 0; sample < samples; sample++) body += binary(sample % 2, encoding.escape);
    } else {
      body += binary(encoding.rice, parameterBits);
      for (let sample = 0; sample < samples; sample++) {
        const quotient = encoding.rice === 0 ? sample % 3 : 0;
        body += '0'.repeat(quotient) + '1' + binary(sample % 2, encoding.rice);
      }
    }
  }
  const header = new Uint8Array([0xff, 0xf8, 0x64, 8, 0, block - 1]);
  const framed = join(
    header,
    new Uint8Array([crc(header, 8, 7)]),
    packed(body, options.alignmentBit),
  );
  const footer = crc(framed, 16, 0x8005);
  return join(framed, new Uint8Array([footer >> 8, footer & 255]));
}

export function flacPredictor(options: FlacPredictorFixture = {}): Uint8Array {
  const block = options.block ?? 16;
  return flacStream([flacPredictorFrame(options)], 16, Math.max(16, block), block);
}

/** Metadata body bytes are opaque to this writer; malformed lengths can be tested independently. */
export function flacMetadata(
  blocks: readonly {
    readonly type: number;
    readonly bytes: Uint8Array;
    readonly length?: number;
  }[],
  frame = flacPredictorFrame(),
): Uint8Array {
  const stream = flacStream([frame], 16, 16, 16);
  if (blocks.length === 0) return stream;
  const prefix = stream.slice(0, 42);
  prefix[4] = 0; // STREAMINFO is followed by the supplied metadata chain.
  return join(
    prefix,
    ...blocks.map(({ type, bytes, length = bytes.length }, index) =>
      join(
        new Uint8Array([
          type | (index === blocks.length - 1 ? 128 : 0),
          (length >> 16) & 255,
          (length >> 8) & 255,
          length & 255,
        ]),
        bytes,
      ),
    ),
    frame,
  );
}

// One new mandatory rule per CRC-valid vector; existing inter-frame rules all remain satisfied.
export const FLAC_STRUCTURE_REFUSALS = [
  ['PARTITION_EQUALITY', flacPredictor({ order: 1, partitionOrder: 4 })],
  ['PADDING_ZERO', flacMetadata([{ type: 1, bytes: hex('00000100') }])],
  ['APPLICATION_MINIMUM', flacMetadata([{ type: 2, bytes: hex('616263') }])],
] as const;

export const FLAC_STRUCTURE_ACCEPTANCES = [
  ['PARTITION_ADJACENT', flacPredictor({ order: 1, partitionOrder: 3 })],
  ['PADDING_ZERO', flacMetadata([{ type: 1, bytes: new Uint8Array(4) }])],
  ['APPLICATION_MINIMUM', flacMetadata([{ type: 2, bytes: hex('61626364') }])],
  ['RFC_PREDICTOR', FLAC_RFC_PREDICTOR],
] as const;
