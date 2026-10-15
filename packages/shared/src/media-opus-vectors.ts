/** Internal RFC 3533 / RFC 7845 fixtures; no production parser or checksum helpers. */
import { hex, join, textBytes, uint32 } from './media-test-vectors.js';

export function oggFixturePage(
  body: Uint8Array,
  laces: readonly number[],
  sequence: number,
  flags: number,
): Uint8Array {
  const bytes = join(
    textBytes('OggS'),
    new Uint8Array([0, flags]),
    // RFC 7845 §4: unfinished packets use -1; completed headers use zero.
    // The fixture's silence packet ends at 960 samples.
    laces.every((length) => length === 255)
      ? new Uint8Array(8).fill(255)
      : new Uint8Array([...(flags & 4 ? [192, 3] : [0, 0]), 0, 0, 0, 0, 0, 0]),
    uint32(0x3147544f, true),
    uint32(sequence, true),
    new Uint8Array(4),
    new Uint8Array([laces.length, ...laces]),
    body,
  );
  let remainder = 0;
  for (const value of bytes) {
    remainder ^= value << 24;
    for (let bit = 0; bit < 8; bit++)
      remainder = ((remainder << 1) ^ (remainder & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  }
  new DataView(bytes.buffer).setUint32(22, remainder, true);
  return bytes;
}

export function opusTags(
  tail: Uint8Array = new Uint8Array(),
  vendor: Uint8Array = textBytes('fixture'),
  comments: readonly Uint8Array[] = [new Uint8Array(), textBytes('TITLE=padding')],
): Uint8Array {
  return join(
    textBytes('OpusTags'),
    uint32(vendor.length, true),
    vendor,
    uint32(comments.length, true),
    ...comments.flatMap((comment) => [uint32(comment.length, true), comment]),
    tail,
  );
}

/** Every packet ends its page; an exact multiple of 255 has a final zero lace. */
export function opusPages(tags: Uint8Array = opusTags()): readonly Uint8Array[] {
  const head = join(textBytes('OpusHead'), hex('0102000080bb0000000000'));
  const pages = [oggFixturePage(head, [head.length], 0, 2)];
  const laces = [...new Array<number>(Math.floor(tags.length / 255)).fill(255), tags.length % 255];
  let offset = 0;
  for (let start = 0; start < laces.length; start += 255) {
    const pageLaces = laces.slice(start, start + 255);
    const size = pageLaces.reduce((sum, length) => sum + length, 0);
    pages.push(
      oggFixturePage(
        tags.subarray(offset, offset + size),
        pageLaces,
        pages.length,
        start === 0 ? 0 : 1,
      ),
    );
    offset += size;
  }
  pages.push(oggFixturePage(hex('f8fffe'), [3], pages.length, 4));
  return pages;
}

export function paddedOpus(tail: Uint8Array = new Uint8Array(512)): Uint8Array {
  return join(...opusPages(opusTags(tail)));
}

/** A valid page CRC around malformed mandatory comment framing. */
export function malformedOpusComments(): Uint8Array {
  return join(
    ...opusPages(join(textBytes('OpusTags'), uint32(0, true), uint32(2, true), uint32(0, true))),
  );
}
