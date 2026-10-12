import {
  ascii,
  be16,
  be32,
  byte,
  countStructure,
  fail,
  read,
  skip,
  type MediaParser,
  type ReadStep,
} from './media-verifier-reader.js';
interface Track {
  readonly seen: Set<string>;
  handler: boolean;
  sample: boolean;
  header: boolean;
  mediaHeader: boolean;
}
/** ISO BMFF box lengths and video-track identity; nonfragmented self-contained profile. */
export function* mp4(): MediaParser {
  let offset = 0,
    count = 0,
    ftyp = false,
    moov = false,
    video = false,
    mdat = false;
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
  const configuration = function* (
    kind: string,
    end: number,
  ): Generator<ReadStep, void, Uint8Array> {
    const nal = function* (expected: number, hevc = false): Generator<ReadStep, void, Uint8Array> {
      if (end - offset < 3) fail();
      const length = be16(yield* take(2));
      if (length < (hevc ? 2 : 1) || length > end - offset) fail();
      const first = byte(yield* take(1), 0);
      if ((first & 128) !== 0 || (hevc ? (first >> 1) & 63 : first & 31) !== expected) fail();
      yield* omit(length - 1);
    };
    if (kind === 'avcC') {
      if (end - offset < 7) fail();
      const header = yield* take(6),
        profile = byte(header, 1),
        sps = byte(header, 5) & 31;
      if (
        byte(header, 0) !== 1 ||
        (byte(header, 4) & 0xfc) !== 0xfc ||
        (byte(header, 4) & 3) === 2 ||
        (byte(header, 5) & 0xe0) !== 0xe0 ||
        !sps
      )
        fail();
      for (let i = 0; i < sps; i++) yield* nal(7);
      if (offset >= end) fail();
      const pps = byte(yield* take(1), 0);
      if (!pps) fail();
      for (let i = 0; i < pps; i++) yield* nal(8);
      if (offset < end) {
        if (
          ![100, 110, 122, 144, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile) ||
          end - offset < 4
        )
          fail();
        const extension = yield* take(4),
          n = byte(extension, 3);
        if (
          (byte(extension, 0) & 0xfc) !== 0xfc ||
          (byte(extension, 1) & 0xf8) !== 0xf8 ||
          (byte(extension, 2) & 0xf8) !== 0xf8
        )
          fail();
        for (let i = 0; i < n; i++) yield* nal(13);
      }
    } else if (kind === 'hvcC') {
      if (end - offset < 23) fail();
      const header = yield* take(23),
        arrays = byte(header, 22);
      if (byte(header, 0) !== 1 || arrays === 0) fail();
      let sps = false,
        pps = false;
      for (let i = 0; i < arrays; i++) {
        if (end - offset < 3) fail();
        const entry = yield* take(3),
          type = byte(entry, 0) & 63,
          n = be16(entry, 1);
        if ((byte(entry, 0) & 64) !== 0 || n === 0 || ![32, 33, 34, 39, 40].includes(type)) fail();
        if (type === 33) sps = true;
        if (type === 34) pps = true;
        for (let j = 0; j < n; j++) {
          count = countStructure(count);
          yield* nal(type, true);
        }
      }
      if (!sps || !pps) fail();
    } else if (kind === 'vpcC') {
      if (end - offset < 12) fail();
      const config = yield* take(12),
        depth = byte(config, 6) >> 4,
        profile = byte(config, 4),
        chroma = (byte(config, 6) >> 1) & 7;
      if (
        be32(config) !== 0x01000000 ||
        profile > 3 ||
        ![8, 10, 12].includes(depth) ||
        (profile < 2 ? depth !== 8 : depth === 8) ||
        (profile % 2 === 0 ? chroma > 1 : chroma < 2 || chroma > 3) ||
        (byte(config, 9) === 0 && chroma !== 3) ||
        ![0, 10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 52, 60, 61, 62].includes(byte(config, 5)) ||
        be16(config, 10) !== 0 ||
        end !== offset
      )
        fail();
      yield* omit(end - offset);
    } else {
      if (end - offset < 4) fail();
      const config = yield* take(4);
      if (
        byte(config, 0) !== 0x81 ||
        byte(config, 1) >> 5 > 2 ||
        (byte(config, 3) & 0xe0) !== 0 ||
        ((byte(config, 3) & 16) === 0 && (byte(config, 3) & 15) !== 0)
      )
        fail();
      yield* omit(end - offset);
    }
    if (offset !== end) fail();
  };
  const boxes = function* (
    end: number,
    context: string,
    depth: number,
    track?: Track,
  ): Generator<ReadStep, void, Uint8Array> {
    if (depth > 16) fail('inspection_limit');
    while (offset < end) {
      const start = offset,
        h = yield* take(8, end === Infinity);
      if (h.length === 0) return;
      count = countStructure(count);
      let size = be32(h),
        header = 8;
      const type = ascii(h, 4);
      if (size === 1) {
        const wide = yield* take(8);
        const high = be32(wide),
          low = be32(wide, 4);
        if (high !== 0) fail();
        size = low;
        header = 16;
      }
      if (size === 0) {
        if (context !== 'root' || type !== 'mdat') fail();
        let payload = false;
        for (;;) {
          const b = yield* take(1, true);
          if (b.length === 0) break;
          payload = true;
        }
        if (!payload) fail();
        mdat = true;
        return;
      }
      if (size < header || size > 25 * 1024 * 1024 || start + size > end) fail();
      const stop = start + size,
        payload = size - header;
      if (
        track !== undefined &&
        (['mdia', 'minf', 'stbl', 'tkhd', 'mdhd', 'hdlr', 'stsd'].includes(type) ||
          context === 'stsd')
      ) {
        // The declared one-entry stsd and each track identity/container own exactly one value.
        const identity = context === 'stsd' ? 'sample-entry' : type;
        if (track.seen.has(identity)) fail();
        track.seen.add(identity);
      }
      if (type === 'ftyp') {
        if (context !== 'root' || ftyp || payload < 8 || payload % 4 !== 0) fail();
        const major = ascii(yield* take(4));
        yield* omit(4);
        let supported = [
          'isom',
          'iso2',
          'iso3',
          'iso4',
          'iso5',
          'iso6',
          'mp41',
          'mp42',
          'avc1',
          'hvc1',
          'hev1',
        ].includes(major);
        while (offset < stop) {
          if (
            ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'hvc1', 'hev1'].includes(ascii(yield* take(4)))
          )
            supported = true;
        }
        if (!supported) fail();
        ftyp = true;
      } else if (type === 'moov') {
        if (context !== 'root' || moov) fail();
        moov = true;
        yield* boxes(stop, 'moov', depth + 1);
      } else if (type === 'trak') {
        if (context !== 'moov') fail();
        const next: Track = {
          seen: new Set<string>(),
          handler: false,
          sample: false,
          header: false,
          mediaHeader: false,
        };
        yield* boxes(stop, 'trak', depth + 1, next);
        if (next.handler) {
          if (!next.sample || !next.header || !next.mediaHeader) fail();
          video = true;
        }
      } else if (['mdia', 'minf', 'stbl'].includes(type)) {
        const parent = type === 'mdia' ? 'trak' : type === 'minf' ? 'mdia' : 'minf';
        if (context !== parent || track === undefined) fail();
        yield* boxes(stop, type, depth + 1, track);
      } else if (type === 'tkhd' || type === 'mdhd') {
        if (track === undefined || context !== (type === 'tkhd' ? 'trak' : 'mdia') || payload < 4)
          fail();
        const version = byte(yield* take(4), 0),
          minimum = type === 'tkhd' ? (version === 1 ? 96 : 84) : version === 1 ? 36 : 24;
        if (version > 1 || payload < minimum) fail();
        const identifying = yield* take(version === 1 ? 20 : 12);
        if (be32(identifying, version === 1 ? 16 : 8) === 0) fail();
        if (type === 'tkhd') track.header = true;
        else track.mediaHeader = true;
        yield* omit(stop - offset);
      } else if (type === 'hdlr') {
        if (context !== 'mdia' || track === undefined || payload < 24) fail();
        const hdlr = yield* take(12);
        if (be32(hdlr) !== 0) fail();
        track.handler = ascii(hdlr, 8) === 'vide';
        yield* omit(stop - offset);
      } else if (type === 'stsd') {
        if (context !== 'stbl' || track === undefined || payload < 8) fail();
        const st = yield* take(8);
        if (be32(st) !== 0 || be32(st, 4) !== 1) fail();
        yield* boxes(stop, 'stsd', depth + 1, track);
      } else if (context === 'stsd') {
        const config =
          type === 'avc1' || type === 'avc3'
            ? 'avcC'
            : type === 'hvc1' || type === 'hev1'
              ? 'hvcC'
              : type === 'vp09'
                ? 'vpcC'
                : type === 'av01'
                  ? 'av1C'
                  : undefined;
        if (config === undefined) {
          yield* omit(payload);
          continue;
        }
        if (track === undefined || track.sample || payload < 86) fail();
        const entry = yield* take(78);
        if (be16(entry, 6) === 0 || be16(entry, 24) === 0 || be16(entry, 26) === 0) fail();
        let found = false;
        while (offset < stop) {
          if (stop - offset < 8) fail();
          count = countStructure(count);
          const child = yield* take(8),
            n = be32(child),
            kind = ascii(child, 4);
          if (n < 8 || n > stop - offset + 8) fail();
          if (kind === config) {
            if (
              found ||
              n < (config === 'hvcC' ? 31 : config === 'avcC' ? 15 : config === 'vpcC' ? 20 : 12)
            )
              fail();
            yield* configuration(config, offset + n - 8);
            found = true;
          } else yield* omit(n - 8);
        }
        if (!found) fail();
        track.sample = true;
      } else if (type === 'mdat') {
        if (context !== 'root' || payload === 0) fail();
        mdat = true;
        yield* omit(payload);
      } else {
        if (['moof', 'traf', 'mvex'].includes(type)) fail();
        yield* omit(payload);
      }
      if (offset !== stop) fail();
    }
  };
  yield* boxes(Infinity, 'root', 0);
  if (!ftyp || !moov || !video || !mdat) fail();
  return 'video/mp4';
}
