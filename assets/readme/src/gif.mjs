// A small GIF89a encoder for screen-like images: one global palette (median cut over the colours the frames actually use),
// each frame stored as only the rectangle that changed from the previous one (the unchanged pixels transparent),
// LZW-compressed. Written here because nothing was to be installed; the images are flat colours and text, which this suits.

const TRANSPARENT = 255; // the palette keeps this index for "unchanged from the frame before"

/** @typedef {{ width: number, height: number, rgb: Uint8Array }} Image */
/** @typedef {{ key: number, n: number }} Colour */

const channelOf = (key, c) => (key >> (16 - 8 * c)) & 255;
const rgbKey = (rgb, i) => (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
const u16 = (n) => [n & 255, (n >> 8) & 255];
const weightOf = (box) => box.reduce((sum, e) => sum + e.n, 0);

/** How many pixels each colour has, over all the images. @param {Image[]} images @returns {Colour[]} */
function countColours(images) {
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const { rgb } of images)
    for (let i = 0; i < rgb.length; i += 3) {
      const key = rgbKey(rgb, i);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  return [...counts.entries()].map(([key, n]) => ({ key, n }));
}

/** The box with the most pixels that can still be split (two colours or more), or `undefined`. @param {Colour[][]} boxes */
function heaviestSplittable(boxes) {
  let best;
  let bestWeight = 0;
  boxes.forEach((box, index) => {
    const weight = box.length < 2 ? 0 : weightOf(box);
    if (weight > bestWeight) {
      bestWeight = weight;
      best = { index, weight };
    }
  });
  return best;
}

/** The channel (0 red, 1 green, 2 blue) along which a box's colours spread most. @param {Colour[]} box */
function widestChannel(box) {
  let widest = 0;
  let widestRange = -1;
  for (let c = 0; c < 3; c += 1) {
    const values = box.map((e) => channelOf(e.key, c));
    const range = Math.max(...values) - Math.min(...values);
    if (range > widestRange) {
      widestRange = range;
      widest = c;
    }
  }
  return widest;
}

/** Splits a box at the weighted median of its widest channel. @param {Colour[]} box @param {number} weight */
function splitBox(box, weight) {
  const channel = widestChannel(box);
  box.sort((a, b) => channelOf(a.key, channel) - channelOf(b.key, channel));
  let accumulated = 0;
  let cut = 1;
  for (let i = 0; i < box.length - 1; i += 1) {
    accumulated += box[i].n;
    cut = i + 1;
    if (accumulated >= weight / 2) break;
  }
  return [box.slice(0, cut), box.slice(cut)];
}

/** The pixel-weighted average colour of a box. @param {Colour[]} box */
function averageColour(box) {
  const total = weightOf(box);
  return [0, 1, 2].map((c) =>
    Math.round(box.reduce((sum, e) => sum + channelOf(e.key, c) * e.n, 0) / total),
  );
}

/** @param {Image[]} images @returns {{ palette: Uint8Array, lookup: Map<number, number> }} */
function buildPalette(images, maxColours) {
  let boxes = [countColours(images)];
  while (boxes.length < maxColours) {
    // split the box with the most pixels along its widest channel, at the weighted median
    const target = heaviestSplittable(boxes);
    if (target === undefined) break;
    boxes.splice(target.index, 1, ...splitBox(boxes[target.index], target.weight));
  }
  const palette = new Uint8Array(256 * 3);
  /** @type {Map<number, number>} */
  const lookup = new Map();
  boxes.forEach((box, index) => {
    palette.set(averageColour(box), index * 3);
    for (const e of box) lookup.set(e.key, index);
  });
  return { palette, lookup };
}

/** A colour -> palette index function: the exact entry when there is one, else the nearest (cached). */
function indexer({ palette, lookup }) {
  const nearest = new Map();
  const nearestIndex = (key) => {
    const [r, g, b] = [0, 1, 2].map((c) => channelOf(key, c));
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < TRANSPARENT; i += 1) {
      const d =
        (palette[i * 3] - r) ** 2 + (palette[i * 3 + 1] - g) ** 2 + (palette[i * 3 + 2] - b) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    return best;
  };
  return (key) => {
    const hit = lookup.get(key) ?? nearest.get(key);
    if (hit !== undefined) return hit;
    const found = nearestIndex(key);
    nearest.set(key, found);
    return found;
  };
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

/** The smallest rectangle that holds every pixel that differs from the frame before; one pixel when none does. */
function changedRect(idx, prev, width, height) {
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      if (idx[y * width + x] === prev[y * width + x]) continue;
      [x0, x1] = [Math.min(x0, x), Math.max(x1, x)];
      [y0, y1] = [Math.min(y0, y), Math.max(y1, y)];
    }
  if (x1 < 0) return { x0: 0, y0: 0, w: 1, h: 1 }; // identical frame: one transparent pixel keeps its delay
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The rectangle's pixels, with those that did not change from the frame before set to the transparent index. */
function cropChanged(idx, prev, width, { x0, y0, w, h }) {
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const at = (y0 + y) * width + x0 + x;
      pixels[y * w + x] = idx[at] === prev[at] ? TRANSPARENT : idx[at];
    }
  return pixels;
}

/** One frame: its graphic control block (delay, transparency), its image descriptor and its LZW data in sub-blocks of 255 bytes. */
function frameBytes(pixels, rect, delayMs, transparent) {
  const delay = Math.max(2, Math.round(delayMs / 10));
  const bytes = [
    ...[0x21, 0xf9, 4, (1 << 2) | (transparent ? 1 : 0), ...u16(delay), TRANSPARENT, 0],
    ...[0x2c, ...u16(rect.x0), ...u16(rect.y0), ...u16(rect.w), ...u16(rect.h), 0],
    8,
  ];
  const data = lzw(pixels, 8);
  for (let p = 0; p < data.length; p += 255) {
    const chunk = data.slice(p, p + 255);
    bytes.push(chunk.length, ...chunk);
  }
  bytes.push(0);
  return bytes;
}

/**
 * @param {Image[]} images all the same size
 * @param {number[]} delaysMs how long each frame stays (rounded to 1/100 s)
 * @returns {Buffer}
 */
export function encodeGif(images, delaysMs) {
  const { width, height } = images[0];
  const { palette, lookup } = buildPalette(images, TRANSPARENT);
  const indexOf = indexer({ palette, lookup });
  const indexed = images.map(({ rgb }) => {
    const idx = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i += 1) idx[i] = indexOf(rgbKey(rgb, i * 3));
    return idx;
  });
  const bytes = [
    ...Buffer.from('GIF89a'),
    ...[...u16(width), ...u16(height), 0xf7, 0, 0], // global table, 256 colours
    ...palette,
    ...[0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0], // loop forever
  ];
  indexed.forEach((idx, f) => {
    if (f === 0) {
      bytes.push(...frameBytes(idx, { x0: 0, y0: 0, w: width, h: height }, delaysMs[f], false));
      return;
    }
    const rect = changedRect(idx, indexed[f - 1], width, height);
    bytes.push(
      ...frameBytes(cropChanged(idx, indexed[f - 1], width, rect), rect, delaysMs[f], true),
    );
  });
  bytes.push(0x3b);
  return Buffer.from(bytes);
}
