import {
  ascii,
  byte,
  countStructure,
  fail,
  le16,
  le32,
  read,
  skip,
  type MediaParser,
} from './media-verifier-reader.js';

// Microsoft RIFF/WAVEFORMATEX and WAVEFORMATEXTENSIBLE. PCM and IEEE float only.
export function* wav(): MediaParser {
  const h = yield* read(12);
  if (ascii(h, 0, 4) !== 'RIFF' || ascii(h, 8) !== 'WAVE') fail();
  let remaining = le32(h, 4) - 4;
  let format = false,
    data = false,
    align = 0,
    count = 0;
  while (remaining > 0) {
    count = countStructure(count);
    if (remaining < 8) fail();
    const c = yield* read(8),
      type = ascii(c, 0, 4),
      size = le32(c, 4);
    remaining -= 8;
    if (size + (size % 2) > remaining) fail();
    remaining -= size + (size % 2);
    if (type === 'fmt ') {
      if (format || data || size < 16 || size > 40) fail();
      const f = yield* read(size);
      let tag = le16(f);
      const bits = le16(f, 14);
      const channels = le16(f, 2),
        rate = le32(f, 4),
        byteRate = le32(f, 8);
      align = le16(f, 12);
      if (tag === 0xfffe) {
        if (
          size !== 40 ||
          le16(f, 16) !== 22 ||
          le16(f, 18) > bits ||
          le16(f, 18) === 0 ||
          ascii(f, 26, 40) !== '\0\0\0\0\x10\0\x80\0\0\xaa\0\x38\x9b\x71'
        )
          fail();
        tag = le16(f, 24);
      } else if (size !== 16 && (size !== 18 || le16(f, 16) !== 0)) fail();
      if (
        ![1, 3].includes(tag) ||
        channels === 0 ||
        channels > 32 ||
        !rate ||
        rate > 768000 ||
        !(tag === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bits) ||
        align !== (channels * bits) / 8 ||
        byteRate !== rate * align
      )
        fail();
      format = true;
    } else if (type === 'data') {
      if (!format || data || size === 0 || size % align !== 0) fail();
      data = true;
      yield* skip(size);
    } else yield* skip(size);
    if (size % 2) yield* skip(1);
  }
  if (!format || !data) fail();
  return 'audio/wav';
}
// ISO/IEC 13818-7 ADTS fixed + variable header. CRC-bearing frames are framed, not CRC-decoded.
export function* aac(): MediaParser {
  let frames = 0,
    parameters = -1;
  for (;;) {
    const h = yield* read(7, true);
    if (h.length === 0) {
      if (frames === 0) fail();
      return 'audio/aac';
    }
    const b1 = byte(h, 1),
      b2 = byte(h, 2),
      b3 = byte(h, 3),
      b6 = byte(h, 6);
    const frequency = (b2 >> 2) & 15,
      channels = ((b2 & 1) << 2) | (b3 >> 6),
      size = ((b3 & 3) << 11) | (byte(h, 4) << 3) | (byte(h, 5) >> 5),
      header = b1 & 1 ? 7 : 9;
    if (
      byte(h, 0) !== 255 ||
      (b1 & 0xf6) !== 0xf0 ||
      frequency > 12 ||
      channels === 0 ||
      channels > 7 ||
      (b6 & 3) !== 0 ||
      size <= header
    )
      fail();
    const p = (b1 & 8) * 65536 + (b2 & 0xfd) * 256 + (b3 & 0xc0);
    if (parameters !== -1 && parameters !== p) fail();
    parameters = p;
    if (header === 9) yield* skip(2);
    yield* skip(size - header);
    frames = countStructure(frames, 1048576);
  }
}
const MPEG1_LAYER1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const MPEG1_LAYER2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const MPEG1_LAYER3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_LAYER1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const MPEG2_OTHER = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
export function* mpeg(): MediaParser {
  let frames = 0,
    parameters = -1,
    first = true;
  for (;;) {
    const h = yield* read(4, true);
    if (h.length === 0) {
      if (frames < 2) fail();
      return 'audio/mpeg';
    }
    if (first && ascii(h, 0, 3) === 'ID3') {
      const version = byte(h, 3);
      if (version !== 3 && version !== 4) fail();
      const tail = yield* read(6),
        flags = byte(tail, 1),
        revision = byte(tail, 0);
      if (byte(tail, 0) === 255 || (flags & (version === 3 ? 31 : 15)) !== 0) fail();
      let size = 0;
      for (let i = 2; i < 6; i++) {
        const b = byte(tail, i);
        if (b & 128) fail();
        size = size * 128 + b;
      }
      yield* skip(size);
      if (version === 4 && (flags & 16) !== 0) {
        const footer = yield* read(10);
        if (
          ascii(footer, 0, 3) !== '3DI' ||
          byte(footer, 3) !== 4 ||
          byte(footer, 4) !== revision ||
          byte(footer, 5) !== flags
        )
          fail();
        let footerSize = 0;
        for (let i = 6; i < 10; i++) {
          const b = byte(footer, i);
          if (b & 128) fail();
          footerSize = footerSize * 128 + b;
        }
        if (footerSize !== size) fail();
      }
      first = false;
      continue;
    }
    first = false;
    if (ascii(h, 0, 3) === 'TAG') {
      if (frames < 2) fail();
      yield* skip(124);
      return 'audio/mpeg';
    }
    const b1 = byte(h, 1),
      b2 = byte(h, 2),
      b3 = byte(h, 3),
      version = (b1 >> 3) & 3,
      layer = (b1 >> 1) & 3,
      index = b2 >> 4,
      rateIndex = (b2 >> 2) & 3;
    if (
      byte(h, 0) !== 255 ||
      (b1 & 0xe0) !== 0xe0 ||
      version === 1 ||
      layer === 0 ||
      index === 0 ||
      index === 15 ||
      rateIndex === 3 ||
      (b3 & 3) === 2
    )
      fail();
    const rate =
      ([44100, 48000, 32000][rateIndex] ?? fail()) / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const table =
      version === 3
        ? layer === 3
          ? MPEG1_LAYER1
          : layer === 2
            ? MPEG1_LAYER2
            : MPEG1_LAYER3
        : layer === 3
          ? MPEG2_LAYER1
          : MPEG2_OTHER;
    const bitrate = (table[index] ?? fail()) * 1000,
      padding = (b2 >> 1) & 1;
    const size =
      layer === 3
        ? (Math.floor((12 * bitrate) / rate) + padding) * 4
        : Math.floor(((layer === 1 && version !== 3 ? 72 : 144) * bitrate) / rate) + padding;
    const p = version * 16 + layer * 4 + rateIndex;
    if (parameters !== -1 && parameters !== p) fail();
    parameters = p;
    if (size <= 4) fail();
    yield* skip(size - 4);
    frames = countStructure(frames, 1048576);
  }
}
