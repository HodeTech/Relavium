import {
  ascii,
  byte,
  countStructure,
  fail,
  read,
  skip,
  type MediaParser,
  type ReadStep,
} from './media-verifier-reader.js';
interface Track {
  number: number;
  type: number;
  codec: string;
  width: number;
  height: number;
}
/** RFC 8794 and WebM container guidelines: known-size clusters, unlaced blocks. */
export function* webm(): MediaParser {
  let offset = 0,
    count = 0,
    doc = false,
    segment = false,
    header = false;
  const tracks = new Set<number>(),
    blocks = new Set<number>(),
    allTracks = new Set<number>();
  const take = function* (
    n: number,
    optional = false,
  ): Generator<ReadStep, Uint8Array, Uint8Array> {
    const b = yield* read(n, optional);
    offset += b.length;
    return b;
  };
  const omit = function* (n: number): Generator<ReadStep, void, Uint8Array> {
    yield* skip(n);
    offset += n;
  };
  const vint = function* (id: boolean, optional = false): Generator<ReadStep, number, Uint8Array> {
    const h = yield* take(1, optional);
    if (h.length === 0) return -2;
    const first = byte(h, 0);
    let mask = 128,
      length = 1;
    while (mask !== 0 && (first & mask) === 0) {
      mask >>= 1;
      length++;
    }
    if (mask === 0 || length > (id ? 4 : 8)) fail();
    let value = id ? first : first & (mask - 1),
      unknown = !id && value === mask - 1;
    for (let i = 1; i < length; i++) {
      const b = byte(yield* take(1), 0);
      unknown = unknown && b === 255;
      value = value * 256 + b;
      if (!Number.isSafeInteger(value) && !unknown) fail();
    }
    return unknown ? -1 : value;
  };
  const uint = function* (n: number): Generator<ReadStep, number, Uint8Array> {
    if (n < 1 || n > 8) fail();
    let value = 0;
    for (const b of yield* take(n)) {
      value = value * 256 + b;
      if (!Number.isSafeInteger(value)) fail();
    }
    return value;
  };
  const elements = function* (
    end: number,
    context: string,
    depth: number,
    track?: Track,
  ): Generator<ReadStep, void, Uint8Array> {
    if (depth > 16) fail('inspection_limit');
    const seen = new Set<number>();
    while (offset < end) {
      const id = yield* vint(true, end === Infinity);
      if (id === -2) return;
      const length = yield* vint(false);
      count = countStructure(count);
      if (length < 0 && id !== 0x18538067) fail();
      const stop = length < 0 ? Infinity : offset + length;
      if (stop > end || length > 25 * 1024 * 1024) fail();
      // Identity is singular within its owner; later fields cannot replace earlier evidence.
      const singleton =
        context === 'header' ||
        (context === 'segment' && id === 0x1654ae6b) ||
        (context === 'track' && [0xd7, 0x83, 0x86, 0xe0].includes(id)) ||
        (context === 'video' && [0xb0, 0xba].includes(id));
      if (singleton) {
        if (seen.has(id)) fail();
        seen.add(id);
      }
      if (id === 0x1a45dfa3) {
        if (context !== 'root' || header) fail();
        header = true;
        yield* elements(stop, 'header', depth + 1);
        if (!doc) fail();
      } else if (id === 0x18538067) {
        if (context !== 'root' || segment || !header) fail();
        segment = true;
        yield* elements(stop, 'segment', depth + 1);
      } else if (context === 'header') {
        if (id === 0x4282) {
          if (length !== 4 || ascii(yield* take(length)) !== 'webm') fail();
          doc = true;
        } else if ([0x4286, 0x42f7, 0x42f2, 0x42f3, 0x4287, 0x4285].includes(id)) {
          const v = yield* uint(length);
          if (
            v === 0 ||
            (id === 0x42f7 && v !== 1) ||
            (id === 0x42f2 && v > 4) ||
            (id === 0x42f3 && v > 8) ||
            (id === 0x4285 && v > 2)
          )
            fail();
        } else fail();
      } else if (id === 0x1654ae6b) {
        if (context !== 'segment') fail();
        yield* elements(stop, 'tracks', depth + 1);
      } else if (id === 0xae) {
        if (context !== 'tracks' || allTracks.size >= 32) fail('inspection_limit');
        const t: Track = { number: 0, type: 0, codec: '', width: 0, height: 0 };
        yield* elements(stop, 'track', depth + 1, t);
        if (!t.number || !t.type || !t.codec || allTracks.has(t.number)) fail();
        allTracks.add(t.number);
        if (t.type === 1) {
          if (
            !t.number ||
            !['V_VP8', 'V_VP9', 'V_AV1'].includes(t.codec) ||
            !t.width ||
            !t.height ||
            tracks.has(t.number)
          )
            fail();
          tracks.add(t.number);
        }
      } else if (id === 0xe0) {
        if (context !== 'track' || track === undefined) fail();
        yield* elements(stop, 'video', depth + 1, track);
      } else if (id === 0x6d80) {
        // ContentEncodings includes encryption and compression. Neither is in the untransformed
        // WebM profile, so this known element must never fall through to unknown-element skipping.
        fail();
      } else if (
        track !== undefined &&
        ((context === 'track' && [0xd7, 0x83, 0x86].includes(id)) ||
          (context === 'video' && [0xb0, 0xba].includes(id)))
      ) {
        if (id === 0x86) {
          if (length > 32) fail();
          track.codec = ascii(yield* take(length));
        } else {
          const value = yield* uint(length);
          if (!value) fail();
          if (id === 0xd7) track.number = value;
          else if (id === 0x83) track.type = value;
          else if (id === 0xb0) track.width = value;
          else track.height = value;
        }
      } else if (id === 0x1f43b675) {
        if (context !== 'segment') fail();
        yield* elements(stop, 'cluster', depth + 1);
      } else if (id === 0xa0) {
        if (context !== 'cluster') fail();
        yield* elements(stop, 'block-group', depth + 1);
      } else if (id === 0xa3 || id === 0xa1) {
        if (context !== (id === 0xa3 ? 'cluster' : 'block-group')) fail();
        const number = yield* vint(false);
        if (number <= 0 || stop - offset <= 3) fail();
        const b = yield* take(3);
        if ((byte(b, 2) & (id === 0xa3 ? 0x76 : 0xf7)) !== 0) fail();
        if (blocks.size >= 32 && !blocks.has(number)) fail('inspection_limit');
        blocks.add(number);
        yield* omit(stop - offset);
      } else yield* omit(length);
      if (stop === Infinity) return;
      if (offset !== stop) fail();
    }
  };
  yield* elements(Infinity, 'root', 0);
  if (!doc || !segment || ![...tracks].some((t) => blocks.has(t))) fail();
  return 'video/webm';
}
