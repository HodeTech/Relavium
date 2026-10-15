import {
  ascii,
  be16,
  be32,
  byte,
  countStructure,
  crc32,
  fail,
  le16,
  le32,
  read,
  skip,
  type MediaParser,
} from './media-verifier-reader.js';

// PNG 3, W3C: signature; critical ordering; CRC over chunk type and data.
export function* png(): MediaParser {
  if (ascii(yield* read(8)) !== '\x89PNG\r\n\x1a\n') fail();
  let header = false,
    palette = false,
    data = false,
    seenData = false,
    endedData = false,
    color = 0,
    paletteLimit = 256,
    count = 0;
  for (;;) {
    count = countStructure(count);
    const chunk = yield* read(8);
    const length = be32(chunk),
      type = ascii(chunk, 4);
    if (length > 25 * 1024 * 1024 || !/^[A-Za-z]{4}$/.test(type) || (byte(chunk, 6) & 32) !== 0)
      fail();
    let crc = crc32(0xffffffff, chunk.subarray(4));
    if (!header && type !== 'IHDR') fail();
    if (type === 'IHDR') {
      if (header || length !== 13) fail();
      const h = yield* read(13);
      crc = crc32(crc, h);
      const depth = byte(h, 8);
      color = byte(h, 9);
      paletteLimit = 2 ** depth;
      if (
        be32(h) === 0 ||
        be32(h) > 0x7fffffff ||
        be32(h, 4) === 0 ||
        be32(h, 4) > 0x7fffffff ||
        !(
          (color === 0 && [1, 2, 4, 8, 16].includes(depth)) ||
          (color === 2 && [8, 16].includes(depth)) ||
          (color === 3 && [1, 2, 4, 8].includes(depth)) ||
          ([4, 6].includes(color) && [8, 16].includes(depth))
        ) ||
        byte(h, 10) !== 0 ||
        byte(h, 11) !== 0 ||
        byte(h, 12) > 1
      )
        fail();
      header = true;
    } else {
      if (type === 'PLTE') {
        if (
          palette ||
          seenData ||
          length === 0 ||
          length > 768 ||
          (color === 3 && length / 3 > paletteLimit) ||
          length % 3 !== 0 ||
          [0, 4].includes(color)
        )
          fail();
        palette = true;
      }
      if (type === 'IDAT') {
        if (endedData || (color === 3 && !palette)) fail();
        seenData = true;
        if (length > 0) data = true;
      } else if (seenData) endedData = true;
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail();
      if (type === 'IEND' && (length !== 0 || !data)) fail();
      if ((type.charCodeAt(0) & 32) === 0 && !['PLTE', 'IDAT', 'IEND'].includes(type)) fail();
      let remaining = length;
      while (remaining > 0) {
        const n = Math.min(remaining, 4096);
        crc = crc32(crc, yield* read(n));
        remaining -= n;
      }
    }
    if (be32(yield* read(4)) !== (crc ^ 0xffffffff) >>> 0) fail();
    if (type === 'IEND') return 'image/png';
  }
}
// GIF89a blocks and sub-blocks; compressed LZW codewords are deliberately not decoded.
export function* gif(): MediaParser {
  const h = yield* read(13);
  const signature = ascii(h, 0, 6),
    width = le16(h, 6),
    height = le16(h, 8),
    packed = byte(h, 10);
  if (!['GIF87a', 'GIF89a'].includes(signature) || !width || !height) fail();
  const hasPalette = (packed & 128) !== 0;
  let images = 0,
    count = 0;
  if (hasPalette) yield* skip(3 * 2 ** ((packed & 7) + 1));
  for (;;) {
    count = countStructure(count);
    const marker = byte(yield* read(1), 0);
    if (marker === 0x3b) {
      if (images === 0) fail();
      return 'image/gif';
    }
    let image = false;
    if (marker === 0x2c) {
      const d = yield* read(9);
      const w = le16(d, 4),
        ht = le16(d, 6),
        flags = byte(d, 8);
      if (!w || !ht || le16(d) + w > width || le16(d, 2) + ht > height || (flags & 0x18) !== 0)
        fail();
      const local = (flags & 128) !== 0;
      if (!local && !hasPalette) fail();
      if (local) yield* skip(3 * 2 ** ((flags & 7) + 1));
      const code = byte(yield* read(1), 0);
      if (code < 2 || code > 8) fail();
      image = true;
    } else if (marker === 0x21) {
      const label = byte(yield* read(1), 0);
      if (![0xf9, 0xfe, 0x01, 0xff].includes(label)) fail();
      if (label === 0xf9) {
        const control = yield* read(6);
        if (byte(control, 0) !== 4 || (byte(control, 1) & 0xe0) !== 0 || byte(control, 5) !== 0)
          fail();
        continue;
      }
      if (label === 0xff || label === 0x01) {
        const n = byte(yield* read(1), 0);
        if (n !== (label === 0xff ? 11 : 12)) fail();
        yield* skip(n);
      }
    } else fail();
    let payload = false;
    for (;;) {
      count = countStructure(count);
      const n = byte(yield* read(1), 0);
      if (n === 0) break;
      payload = true;
      yield* skip(n);
    }
    if (image) {
      if (!payload) fail();
      images++;
    }
  }
}
// ITU-T T.81 Annex B. Finite SOF0/1/2 marker and scan framing, not entropy decoding.
export function* jpeg(): MediaParser {
  if (be16(yield* read(2)) !== 0xffd8) fail();
  let frame = false,
    scans = 0,
    entropy = false,
    count = 0,
    pending = 0;
  const components = new Set<number>();
  const quantizers = new Set<number>();
  const neededQuantizers = new Set<number>();
  const huffman = new Set<number>();
  let progressive = false;
  for (;;) {
    count = countStructure(count);
    let marker = pending;
    pending = 0;
    if (marker === 0) {
      if (byte(yield* read(1), 0) !== 255) fail();
      do {
        marker = byte(yield* read(1), 0);
      } while (marker === 255);
    }
    if (marker === 0xd9) {
      if (!frame || scans === 0 || !entropy) fail();
      return 'image/jpeg';
    }
    if (marker === 0xd8 || marker === 0 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7))
      fail();
    const size = be16(yield* read(2)) - 2;
    if (size < 0) fail();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || size < 6) fail();
      const h = yield* read(6),
        n = byte(h, 5);
      if (
        ![8, 12].includes(byte(h, 0)) ||
        (marker === 0xc0 && byte(h, 0) !== 8) ||
        !be16(h, 1) ||
        !be16(h, 3) ||
        n < 1 ||
        n > 4 ||
        size !== 6 + 3 * n
      )
        fail();
      for (let i = 0; i < n; i++) {
        const c = yield* read(3),
          id = byte(c, 0),
          sampling = byte(c, 1);
        if (
          components.has(id) ||
          !(sampling >> 4) ||
          !(sampling & 15) ||
          sampling >> 4 > 4 ||
          (sampling & 15) > 4 ||
          byte(c, 2) > 3
        )
          fail();
        components.add(id);
        neededQuantizers.add(byte(c, 2));
      }
      frame = true;
      progressive = marker === 0xc2;
    } else if (marker === 0xda) {
      if (!frame || size < 6) fail();
      const n = byte(yield* read(1), 0);
      if (n < 1 || n > components.size || size !== 4 + 2 * n) fail();
      const selected = new Set<number>();
      const scanTables: number[] = [];
      for (let i = 0; i < n; i++) {
        const c = yield* read(2),
          id = byte(c, 0),
          tables = byte(c, 1);
        if (!components.has(id) || selected.has(id) || tables >> 4 > 3 || (tables & 15) > 3) fail();
        selected.add(id);
        scanTables.push(tables);
      }
      const scan = yield* read(3);
      const first = byte(scan, 0),
        last = byte(scan, 1),
        successive = byte(scan, 2);
      if (
        first > last ||
        last > 63 ||
        successive >> 4 > 13 ||
        (successive & 15) > 13 ||
        (!progressive && (first !== 0 || last !== 63 || successive !== 0)) ||
        (progressive && ((first === 0 && last !== 0) || (first > 0 && n !== 1)))
      )
        fail();
      for (const q of neededQuantizers) if (!quantizers.has(q)) fail();
      for (const tables of scanTables) {
        if (first === 0 && !huffman.has(tables >> 4)) fail();
        if (last > 0 && !huffman.has(16 + (tables & 15))) fail();
      }
      scans++;
      let scanData = false;
      for (;;) {
        const b = byte(yield* read(1), 0);
        if (b !== 255) {
          scanData = true;
          continue;
        }
        let next = byte(yield* read(1), 0);
        while (next === 255) next = byte(yield* read(1), 0);
        if (next === 0) {
          scanData = true;
          continue;
        }
        if (next >= 0xd0 && next <= 0xd7) continue;
        pending = next;
        break;
      }
      if (!scanData) fail();
      entropy = true;
    } else if (marker === 0xdb) {
      let remaining = size;
      while (remaining > 0) {
        const info = byte(yield* read(1), 0),
          precision = info >> 4;
        if (precision > 1 || (info & 15) > 3) fail();
        const n = 64 * (precision + 1);
        remaining -= n + 1;
        if (remaining < 0) fail();
        const table = yield* read(n);
        for (let i = 0; i < n; i += precision + 1) {
          if ((precision === 0 ? byte(table, i) : be16(table, i)) === 0) fail();
        }
        quantizers.add(info & 15);
      }
    } else if (marker === 0xc4) {
      let remaining = size;
      while (remaining > 0) {
        const h = yield* read(17);
        const info = byte(h, 0);
        if (info >> 4 > 1 || (info & 15) > 3) fail();
        let n = 0;
        let slots = 1;
        for (let i = 1; i < 17; i++) {
          n += byte(h, i);
          slots = 2 * slots - byte(h, i);
          if (slots < 0) fail();
        }
        if (n === 0 || n > 256) fail();
        remaining -= 17 + n;
        if (remaining < 0) fail();
        yield* skip(n);
        huffman.add(info);
      }
    } else if (marker === 0xdd) {
      if (size !== 2) fail();
      yield* skip(2);
    } else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) yield* skip(size);
    else fail();
  }
}
// Google WebP RIFF container specification: static basic/extended images only.
export function* webp(): MediaParser {
  const h = yield* read(12);
  if (ascii(h, 0, 4) !== 'RIFF' || ascii(h, 8) !== 'WEBP') fail();
  let remaining = le32(h, 4) - 4;
  let image = false,
    extended = false,
    width = 0,
    height = 0,
    count = 0,
    alpha = false,
    alphaChunk = false,
    lossless = false,
    flags = 0;
  const metadata = new Set<string>();
  while (remaining > 0) {
    count = countStructure(count);
    if (remaining < 8) fail();
    const c = yield* read(8),
      type = ascii(c, 0, 4),
      size = le32(c, 4),
      padded = size + (size % 2);
    remaining -= 8;
    if (padded > remaining) fail();
    remaining -= padded;
    if (type === 'VP8X') {
      if (extended || image || count !== 1 || size !== 10) fail();
      const x = yield* read(10);
      flags = byte(x, 0);
      if ((flags & 0xc3) !== 0 || byte(x, 1) || byte(x, 2) || byte(x, 3)) fail();
      alpha = (flags & 16) !== 0;
      width = 1 + byte(x, 4) + byte(x, 5) * 256 + byte(x, 6) * 65536;
      height = 1 + byte(x, 7) + byte(x, 8) * 256 + byte(x, 9) * 65536;
      if (width * height > 0xffffffff) fail();
      extended = true;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (image) fail();
      const n = type === 'VP8 ' ? 10 : 5;
      if (size <= n) fail();
      const x = yield* read(n);
      let w = 0,
        ht = 0;
      if (type === 'VP8 ') {
        if ((byte(x, 0) & 1) !== 0 || ascii(x, 3, 6) !== '\x9d\x01\x2a') fail();
        const partition = (byte(x, 0) + byte(x, 1) * 256 + byte(x, 2) * 65536) >>> 5;
        if (partition === 0 || partition > size - 10 || (extended && alpha !== alphaChunk)) fail();
        w = le16(x, 6) & 0x3fff;
        ht = le16(x, 8) & 0x3fff;
      } else {
        lossless = true;
        if (alphaChunk) fail();
        if (byte(x, 0) !== 0x2f || (byte(x, 4) & 0xe0) !== 0) fail();
        w = 1 + byte(x, 1) + ((byte(x, 2) & 63) << 8);
        ht = 1 + (byte(x, 2) >> 6) + (byte(x, 3) << 2) + ((byte(x, 4) & 15) << 10);
      }
      if (!w || !ht || (extended && (width !== w || height !== ht))) fail();
      image = true;
      yield* skip(size - n);
    } else if (type === 'ALPH') {
      if (!extended || !alpha || image || alphaChunk || size < 2) fail();
      const alphaHeader = byte(yield* read(1), 0);
      if ((alphaHeader & 0xc0) !== 0 || (alphaHeader & 3) > 1 || ((alphaHeader >> 4) & 3) > 1)
        fail();
      alphaChunk = true;
      yield* skip(size - 1);
    } else if (['ICCP', 'EXIF', 'XMP '].includes(type)) {
      const flag = type === 'ICCP' ? 32 : type === 'EXIF' ? 8 : 4;
      if (
        !extended ||
        metadata.has(type) ||
        !(flags & flag) ||
        (type === 'ICCP' && image) ||
        (type !== 'ICCP' && !image)
      )
        fail();
      metadata.add(type);
      yield* skip(size);
    } else fail();
    if (size % 2 && byte(yield* read(1), 0) !== 0) fail();
  }
  if (!image) fail();
  if (
    extended &&
    ((!lossless && alpha !== alphaChunk) ||
      Boolean(flags & 32) !== metadata.has('ICCP') ||
      Boolean(flags & 8) !== metadata.has('EXIF') ||
      Boolean(flags & 4) !== metadata.has('XMP '))
  )
    fail();
  return 'image/webp';
}
