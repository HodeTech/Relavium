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
