import { MediaInspectionMemory } from './media-inspection-memory.js';
import { mediaByteLength } from './media-byte-view.js';
import { MediaAdmissionError, type CanonicalMediaMimeType } from './media-admission.js';

/** One reusable 4KiB arena. Views yielded to a parser expire at its next read. */
export interface ReadStep {
  readonly size: number;
  readonly skip?: boolean;
  readonly optional?: boolean;
}
export type MediaParser = Generator<ReadStep, CanonicalMediaMimeType, Uint8Array>;
export function* read(size: number, optional = false): Generator<ReadStep, Uint8Array, Uint8Array> {
  if (!Number.isSafeInteger(size) || size < 0 || size > 4096) fail('inspection_limit');
  if (size === 0) return new Uint8Array(0);
  return yield { size, optional };
}
export function* skip(size: number): Generator<ReadStep, void, Uint8Array> {
  if (!Number.isSafeInteger(size) || size < 0 || size > 25 * 1024 * 1024) fail();
  if (size > 0) yield { size, skip: true };
}
export function fail(code: 'invalid_format' | 'inspection_limit' = 'invalid_format'): never {
  throw new MediaAdmissionError(code);
}
export function byte(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? fail();
}
export function be16(b: Uint8Array, i = 0): number {
  return byte(b, i) * 256 + byte(b, i + 1);
}
export function le16(b: Uint8Array, i = 0): number {
  return byte(b, i) + byte(b, i + 1) * 256;
}
export function be32(b: Uint8Array, i = 0): number {
  return be16(b, i) * 65536 + be16(b, i + 2);
}
export function le32(b: Uint8Array, i = 0): number {
  return le16(b, i) + le16(b, i + 2) * 65536;
}
export function ascii(b: Uint8Array, start = 0, end = b.length): string {
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(byte(b, i));
  return out;
}
export function crc32(crc: number, b: Uint8Array): number {
  for (const value of b) {
    crc ^= value;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
}
export function oggCrcByte(crc: number, value: number): number {
  crc ^= value << 24;
  for (let i = 0; i < 8; i++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  return crc >>> 0;
}
export function oggCrc(crc: number, b: Uint8Array): number {
  for (const value of b) crc = oggCrcByte(crc, value);
  return crc >>> 0;
}
export function countStructure(value: number, maximum = 65536): number {
  if (value >= maximum) fail('inspection_limit');
  return value + 1;
}
export class ParserReader {
  readonly #arena: Uint8Array;
  readonly #parser: MediaParser;
  #step: IteratorResult<ReadStep, CanonicalMediaMimeType>;
  #filled = 0;
  constructor(parser: MediaParser, memory = new MediaInspectionMemory()) {
    this.#arena = memory.allocate(4096);
    this.#parser = parser;
    this.#step = parser.next();
  }
  push(chunk: Uint8Array): void {
    let offset = 0;
    const length = mediaByteLength(chunk);
    while (offset < length) {
      if (this.#step.done) fail();
      const request = this.#step.value;
      const take = Math.min(request.size - this.#filled, length - offset);
      if (take <= 0) fail();
      if (!request.skip)
        for (let i = 0; i < take; i++) this.#arena[this.#filled + i] = chunk[offset + i] ?? fail();
      offset += take;
      this.#filled += take;
      if (this.#filled === request.size) {
        this.#filled = 0;
        this.#step = this.#parser.next(
          request.skip ? this.#arena.subarray(0, 0) : this.#arena.subarray(0, request.size),
        );
      }
    }
  }
  finish(): CanonicalMediaMimeType {
    if (!this.#step.done && this.#step.value.optional && this.#filled === 0)
      this.#step = this.#parser.next(this.#arena.subarray(0, 0));
    if (!this.#step.done || this.#filled !== 0) fail();
    return this.#step.value;
  }
}
