import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/**
 * Independent PNG construction from the retained October 15 review proof: RGB8 pixels are
 * SHA-256(counter), rows use filter 0, IDAT is zlib-compressed, and each chunk has its own CRC.
 * That proof's 1024×1024 image decoded with native sips. Keeping the same construction avoids
 * a multi-megabyte opaque fixture and does not use the product recognizer to generate evidence.
 */
export function generatedPng(): Uint8Array {
  const width = 1024;
  const height = 1024;
  const pixels = Buffer.alloc(width * height * 3);
  const counter = Buffer.alloc(4);
  for (let at = 0; at < pixels.length; at += 32) {
    counter.writeUInt32BE(at / 32);
    createHash('sha256').update(counter).digest().copy(pixels, at);
  }
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++)
    pixels.copy(rows, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(rows)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 'ascii');
  chunk.set(data, 8);
  let crc = 0xffffffff;
  for (const value of chunk.subarray(4, chunk.length - 4)) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

/** Independent RIFF/WAVE PCM: mono 8 kHz, 16-bit, 150,000 zero-valued sample words. */
export function generatedWav(): Uint8Array {
  const dataBytes = 300000;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(bytes);
}

/**
 * Independent finite-profile MPEG-1 Layer III framing: 640 complete 417-byte frames,
 * 128 kbit/s, 44.1 kHz, no padding. Like the MP4 fixture, this supplies structural
 * evidence only; the compressed audio payload is not a native-decoder validity claim.
 */
export function generatedMpeg(): Uint8Array {
  const bytes = new Uint8Array(640 * 417);
  for (let offset = 0; offset < bytes.length; offset += 417)
    bytes.set([0xff, 0xfb, 0x90, 0x00], offset);
  return bytes;
}
