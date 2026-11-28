// An independent GIF reader (spec LZW decoder, frame compositing) used to check the encoder: every decoded frame is compared with
// the PNG it came from. Usage: node gif-verify.mjs file.gif frames-dir-with-f0.png...
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';

/** What the decoder returns for the end code (the reader below is called by the top-level code, so this is declared first). */
const END = Symbol('end');

const [gifPath, dir] = process.argv.slice(2);
const b = readFileSync(gifPath);
let p = 6;
const width = b.readUInt16LE(p);
const height = b.readUInt16LE(p + 2);
const flags = b[p + 4];
p += 7;
const palette = b.subarray(p, p + 3 * (1 << ((flags & 7) + 1)));
p += palette.length;
let canvas = new Uint8Array(width * height * 3);
const frames = [];
let transparentIndex = -1;
let delay = 0;
while (p < b.length) {
  const block = b[p++];
  if (block === 0x3b) break;
  if (block === 0x21) {
    const label = b[p++];
    if (label === 0xf9) {
      const packed = b[p + 1];
      delay = b.readUInt16LE(p + 2);
      transparentIndex = packed & 1 ? b[p + 4] : -1;
    }
    while (b[p] !== 0) p += b[p] + 1;
    p += 1;
  } else if (block === 0x2c) {
    const x0 = b.readUInt16LE(p);
    const y0 = b.readUInt16LE(p + 2);
    const w = b.readUInt16LE(p + 4);
    const h = b.readUInt16LE(p + 6);
    p += 9;
    const min = b[p++];
    const data = [];
    while (b[p] !== 0) {
      data.push(...b.subarray(p + 1, p + 1 + b[p]));
      p += b[p] + 1;
    }
    p += 1;
    const idx = lzwDecode(data, min, w * h);
    for (let y = 0; y < h; y += 1)
      for (let x = 0; x < w; x += 1) {
        const v = idx[y * w + x];
        if (v === transparentIndex) continue;
        const o = ((y0 + y) * width + x0 + x) * 3;
        canvas[o] = palette[v * 3];
        canvas[o + 1] = palette[v * 3 + 1];
        canvas[o + 2] = palette[v * 3 + 2];
      }
    frames.push({ rgb: canvas.slice(), delay });
  }
}

/** The spec's LZW decoder state: a dictionary that grows, the code size that grows with it, and the entry before. */
function createDecoder(min) {
  const clear = 1 << min;
  const end = clear + 1;
  let dict = [];
  let prev;
  const state = { size: min + 1 };
  const reset = () => {
    dict = Array.from({ length: end + 1 }, (_, i) => (i < clear ? [i] : []));
    state.size = min + 1;
    prev = undefined;
  };
  reset();
  /** The entry a code stands for: undefined for a clear code (nothing to output), END for the end code. */
  state.take = (code) => {
    if (code === clear) return reset();
    if (code === end) return END;
    const entry = code < dict.length ? dict[code] : prev && [...prev, prev[0]];
    if (entry === undefined) throw new Error('bad code');
    if (prev !== undefined && dict.length < 4096) dict.push([...prev, entry[0]]);
    if (dict.length === 1 << state.size && state.size < 12) state.size += 1;
    prev = entry;
    return entry;
  };
  return state;
}

function lzwDecode(data, min, length) {
  const decoder = createDecoder(min);
  const out = [];
  let bits = 0;
  let nbits = 0;
  for (const byte of data) {
    bits |= byte << nbits;
    nbits += 8;
    while (nbits >= decoder.size) {
      const code = bits & ((1 << decoder.size) - 1);
      bits >>= decoder.size;
      nbits -= decoder.size;
      const entry = decoder.take(code);
      if (entry === END) return out;
      if (entry !== undefined) out.push(...entry);
    }
  }
  return out.slice(0, length);
}

let worst = 0;
let sum = 0;
frames.forEach((f, i) => {
  const png = decodePng(readFileSync(join(dir, `f${i}.png`)));
  let diff = 0;
  let max = 0;
  for (let k = 0; k < png.rgb.length; k += 3) {
    const d =
      Math.abs(png.rgb[k] - f.rgb[k]) +
      Math.abs(png.rgb[k + 1] - f.rgb[k + 1]) +
      Math.abs(png.rgb[k + 2] - f.rgb[k + 2]);
    diff += d;
    if (d > max) max = d;
  }
  const mean = diff / (png.rgb.length / 3);
  sum += mean;
  worst = Math.max(worst, mean);
  console.log(
    `frame ${String(i).padStart(2)} delay ${String(f.delay * 10).padStart(5)} ms  mean abs error ${mean.toFixed(3)}  worst pixel ${max}`,
  );
});
console.log(
  `${frames.length} frames; ${width}x${height}; mean error ${(sum / frames.length).toFixed(3)}; worst frame ${worst.toFixed(3)}`,
);
