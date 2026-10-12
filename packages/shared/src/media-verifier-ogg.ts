import { MediaInspectionMemory } from './media-inspection-memory.js';
import { type CanonicalMediaMimeType } from './media-admission.js';
import {
  ascii,
  byte,
  countStructure,
  fail,
  le32,
  oggCrc,
  read,
  type MediaParser,
} from './media-verifier-reader.js';

/** Streaming comment framing; skips strings using declared lengths without retaining them. */
class Comments {
  #phase = 'vendor-length';
  #integer = 0;
  #integerBytes = 0;
  #remaining = 0;
  #comments = 0;
  push(value: number): void {
    if (this.#phase === 'done') fail();
    if (this.#phase === 'vendor' || this.#phase === 'comment') {
      if (--this.#remaining === 0)
        this.#phase =
          this.#phase === 'vendor' ? 'count' : this.#comments > 0 ? 'comment-length' : 'done';
      return;
    }
    this.#integer += value * 2 ** (8 * this.#integerBytes++);
    if (this.#integerBytes !== 4) return;
    const n = this.#integer;
    this.#integer = 0;
    this.#integerBytes = 0;
    if (n > 25 * 1024 * 1024) fail();
    if (this.#phase === 'count') {
      if (n > 65536) fail('inspection_limit');
      this.#comments = n;
      this.#phase = n === 0 ? 'done' : 'comment-length';
    } else if (this.#phase === 'vendor-length') {
      this.#remaining = n;
      this.#phase = n === 0 ? 'count' : 'vendor';
    } else {
      this.#comments--;
      this.#remaining = n;
      this.#phase = n === 0 ? (this.#comments > 0 ? 'comment-length' : 'done') : 'comment';
    }
  }
  get done(): boolean {
    return this.#phase === 'done';
  }
}
export function* ogg(memory = new MediaInspectionMemory()): MediaParser {
  let serial = -1,
    sequence = 0,
    pages = 0,
    packetIndex = 0,
    packetSize = 0,
    continued = false,
    eos = false;
  let codec: CanonicalMediaMimeType | undefined;
  const prefix = memory.allocate(32);
  const lacing = memory.allocate(255);
  let last = 0;
  let comments: Comments | undefined;
  let commentFrame = false;
  for (;;) {
    if (eos) {
      if (packetIndex < 3 || continued) fail();
      return codec ?? fail();
    }
    const h = yield* read(27);
    if (ascii(h, 0, 4) !== 'OggS' || byte(h, 4) !== 0) fail();
    const flags = byte(h, 5),
      pageSerial = le32(h, 14),
      seq = le32(h, 18),
      checksum = le32(h, 22),
      segments = byte(h, 26);
    if (
      (flags & 0xf8) !== 0 ||
      ((flags & 1) !== 0) !== continued ||
      (pages === 0 ? flags !== 2 : (flags & 2) !== 0) ||
      seq !== sequence
    )
      fail();
    if (serial !== -1 && serial !== pageSerial) fail();
    serial = pageSerial;
    sequence++;
    pages = countStructure(pages, 1048576);
    let crc = 0;
    for (let i = 0; i < 27; i++) {
      const b = i >= 22 && i <= 25 ? 0 : byte(h, i);
      crc = oggCrc(crc, new Uint8Array([b]));
    }
    // Capped page lacing is the only copied table; arena views cannot survive the next read.
    lacing.set(yield* read(segments));
    const lace = lacing.subarray(0, segments);
    crc = oggCrc(crc, lace);
    for (const length of lace) {
      const data = yield* read(length);
      crc = oggCrc(crc, data);
      for (const b of data) {
        if (packetSize < 32) prefix[packetSize] = b;
        last = b;
        packetSize++;
        if (packetSize > 25 * 1024 * 1024) fail();
        if (packetIndex === 1 && codec !== undefined) {
          const header = codec === 'audio/opus' ? 8 : 7;
          if (packetSize === header) {
            if (ascii(prefix, 0, header) !== (codec === 'audio/opus' ? 'OpusTags' : '\x03vorbis'))
              fail();
            comments = new Comments();
          } else if (packetSize > header) {
            if (comments?.done) {
              if (codec !== 'audio/ogg' || commentFrame || b !== 1) fail();
              commentFrame = true;
            } else comments?.push(b);
          }
        }
      }
      continued = length === 255;
      if (!continued) {
        if (packetIndex === 0) {
          if (packetSize === 19 && ascii(prefix, 0, 8) === 'OpusHead') {
            if (
              byte(prefix, 8) !== 1 ||
              ![1, 2].includes(byte(prefix, 9)) ||
              byte(prefix, 18) !== 0
            )
              fail();
            codec = 'audio/opus';
          } else if (packetSize === 30 && ascii(prefix, 0, 7) === '\x01vorbis') {
            const block = byte(prefix, 28);
            if (
              le32(prefix, 7) !== 0 ||
              byte(prefix, 11) === 0 ||
              le32(prefix, 12) === 0 ||
              (block & 15) < 6 ||
              block >> 4 > 13 ||
              (block & 15) > block >> 4 ||
              byte(prefix, 29) !== 1
            )
              fail();
            codec = 'audio/ogg';
          } else fail();
        } else if (packetIndex === 1) {
          if (!comments?.done || (codec === 'audio/ogg' && !commentFrame)) fail();
        } else if (packetIndex === 2 && codec === 'audio/ogg') {
          if (packetSize < 8 || ascii(prefix, 0, 7) !== '\x05vorbis' || (last & 1) !== 1) fail();
        } else {
          if (packetSize === 0 || (codec === 'audio/ogg' && (byte(prefix, 0) & 1) !== 0)) fail();
        }
        packetIndex = countStructure(packetIndex, 1048576);
        packetSize = 0;
        comments = undefined;
        commentFrame = false;
      }
    }
    if (crc !== checksum) fail();
    eos = (flags & 4) !== 0;
    if (eos && (packetIndex < (codec === 'audio/ogg' ? 4 : 3) || continued)) fail();
  }
}
