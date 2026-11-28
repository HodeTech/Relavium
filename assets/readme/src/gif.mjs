// A small GIF89a encoder for screen-like images: one global palette (median cut over the colours the frames actually use),
// each frame stored as only the rectangle that changed from the previous one (the unchanged pixels transparent),
// LZW-compressed. Written here because nothing was to be installed; the images are flat colours and text, which this suits.

/** @param {{ width: number, height: number, rgb: Uint8Array }[]} images @returns {{ palette: Uint8Array, lookup: Map<number, number> }} */
function buildPalette(images, maxColours) {
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const { rgb } of images)
    for (let i = 0; i < rgb.length; i += 3) {
      const key = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  let boxes = [[...counts.entries()].map(([key, n]) => ({ key, n }))];
  const channel = (key, c) => (key >> (16 - 8 * c)) & 255;
  while (boxes.length < maxColours) {
    // split the box with the most pixels along its widest channel, at the weighted median
    let bestIndex = -1;
    let bestWeight = 0;
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      const weight = box.reduce((s, e) => s + e.n, 0);
      if (weight > bestWeight) {
        bestWeight = weight;
        bestIndex = index;
      }
    });
    if (bestIndex < 0) break;
    const box = boxes[bestIndex];
    let widest = 0;
    let widestRange = -1;
    for (let c = 0; c < 3; c += 1) {
      let lo = 255;
      let hi = 0;
      for (const e of box) {
        const v = channel(e.key, c);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > widestRange) {
        widestRange = hi - lo;
        widest = c;
      }
    }
    box.sort((a, b) => channel(a.key, widest) - channel(b.key, widest));
    const half = bestWeight / 2;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i += 1) {
      acc += box[i].n;
      cut = i + 1;
      if (acc >= half) break;
    }
    boxes.splice(bestIndex, 1, box.slice(0, cut), box.slice(cut));
  }
  const palette = new Uint8Array(256 * 3);
  /** @type {Map<number, number>} */
  const lookup = new Map();
  boxes.forEach((box, index) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let total = 0;
    for (const e of box) {
      r += channel(e.key, 0) * e.n;
      g += channel(e.key, 1) * e.n;
      b += channel(e.key, 2) * e.n;
      total += e.n;
    }
    palette[index * 3] = Math.round(r / total);
    palette[index * 3 + 1] = Math.round(g / total);
    palette[index * 3 + 2] = Math.round(b / total);
    for (const e of box) lookup.set(e.key, index);
  });
  return { palette, lookup };
}

function lzw(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = [];
  let bits = 0;
  let nbits = 0;
  let codeSize = minCodeSize + 1;
  const write = (code) => {
    bits |= code << nbits;
    nbits += codeSize;
    while (nbits >= 8) {
      out.push(bits & 255);
      bits >>= 8;
      nbits -= 8;
    }
  };
  let dict = new Map();
  let next = end + 1;
  write(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    write(prefix);
    if (next < 4096) {
      dict.set(key, next);
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
      next += 1;
    } else {
      write(clear);
      dict = new Map();
      next = end + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  write(prefix);
  write(end);
  if (nbits > 0) out.push(bits & 255);
  return out;
}

const u16 = (n) => [n & 255, (n >> 8) & 255];

/**
 * @param {{ width: number, height: number, rgb: Uint8Array }[]} images all the same size
 * @param {number[]} delaysMs how long each frame stays (rounded to 1/100 s)
 * @returns {Buffer}
 */
export function encodeGif(images, delaysMs) {
  const { width, height } = images[0];
  const { palette, lookup } = buildPalette(images, 255); // index 255 stays transparent
  const nearest = new Map();
  const indexOf = (key) => {
    const hit = lookup.get(key);
    if (hit !== undefined) return hit;
    const cached = nearest.get(key);
    if (cached !== undefined) return cached;
    const r = (key >> 16) & 255;
    const g = (key >> 8) & 255;
    const b = key & 255;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < 255; i += 1) {
      const d =
        (palette[i * 3] - r) ** 2 + (palette[i * 3 + 1] - g) ** 2 + (palette[i * 3 + 2] - b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    nearest.set(key, best);
    return best;
  };
  const indexed = images.map(({ rgb }) => {
    const idx = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i += 1)
      idx[i] = indexOf((rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2]);
    return idx;
  });
  const bytes = [];
  bytes.push(...Buffer.from('GIF89a'), ...u16(width), ...u16(height), 0xf7, 0, 0); // global table, 256 colours
  for (let i = 0; i < 256 * 3; i += 1) bytes.push(palette[i]);
  bytes.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0); // loop forever
  indexed.forEach((idx, f) => {
    let x0 = 0;
    let y0 = 0;
    let x1 = width - 1;
    let y1 = height - 1;
    let pixels = idx;
    let transparent = false;
    if (f > 0) {
      const prev = indexed[f - 1];
      x0 = width;
      y0 = height;
      x1 = -1;
      y1 = -1;
      for (let y = 0; y < height; y += 1)
        for (let x = 0; x < width; x += 1)
          if (idx[y * width + x] !== prev[y * width + x]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
      if (x1 < 0) {
        x0 = y0 = 0;
        x1 = y1 = 0; // identical frame: one transparent pixel keeps its delay
      }
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      pixels = new Uint8Array(w * h);
      for (let y = 0; y < h; y += 1)
        for (let x = 0; x < w; x += 1) {
          const v = idx[(y0 + y) * width + x0 + x];
          pixels[y * w + x] = v === prev[(y0 + y) * width + x0 + x] ? 255 : v;
        }
      transparent = true;
    } else {
      pixels = idx;
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const delay = Math.max(2, Math.round(delaysMs[f] / 10));
    bytes.push(0x21, 0xf9, 4, (1 << 2) | (transparent ? 1 : 0), ...u16(delay), 255, 0);
    bytes.push(0x2c, ...u16(x0), ...u16(y0), ...u16(w), ...u16(h), 0);
    bytes.push(8);
    const data = lzw(pixels, 8);
    for (let p = 0; p < data.length; p += 255) {
      const chunk = data.slice(p, p + 255);
      bytes.push(chunk.length, ...chunk);
    }
    bytes.push(0);
  });
  bytes.push(0x3b);
  return Buffer.from(bytes);
}
