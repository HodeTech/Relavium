// A minimal PNG decoder: 8-bit, non-interlaced, colour types 2 (RGB), 6 (RGBA), 0 and 4 (grey) — what a browser screenshot is.
import { inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** The header and the concatenated image data of a PNG. @param {Buffer} buf */
function readChunks(buf) {
  if (SIGNATURE.some((byte, i) => buf[i] !== byte)) throw new Error('not a PNG');
  const header = { width: 0, height: 0, depth: 0, colourType: 0, interlace: 0 };
  const idat = [];
  let pos = 8;
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      Object.assign(header, {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colourType: data[9],
        interlace: data[12],
      });
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  return { header, data: Buffer.concat(idat) };
}

/** The Paeth predictor of PNG filter type 4. */
function paeth(a, b, c) {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** What a filter type adds to a byte from its neighbours: `a` left, `b` above, `c` above-left. */
function predict(filter, a, b, c) {
  switch (filter) {
    case 1:
      return a;
    case 2:
      return b;
    case 3:
      return (a + b) >> 1;
    case 4:
      return paeth(a, b, c);
    default:
      return 0;
  }
}

/** One scanline with its filter undone, in place in `cur`; `prev` is the line above (zeros for the first). */
function unfilterLine(filter, line, cur, prev, channels) {
  for (let x = 0; x < cur.length; x += 1) {
    const left = x >= channels;
    cur[x] =
      (line[x] +
        predict(filter, left ? cur[x - channels] : 0, prev[x], left ? prev[x - channels] : 0)) &
      255;
  }
}

/** @param {Buffer} buf @returns {{ width: number, height: number, rgb: Uint8Array }} rgb is width*height*3 */
export function decodePng(buf) {
  const { header, data } = readChunks(buf);
  const { width, height, depth, colourType, interlace } = header;
  if (depth !== 8 || interlace !== 0)
    throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const channels = CHANNELS[colourType];
  if (channels === undefined) throw new Error(`unsupported PNG colour type ${colourType}`);
  const raw = inflateSync(data);
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    unfilterLine(raw[start], raw.subarray(start + 1, start + 1 + stride), cur, prev, channels);
    prev = cur;
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const from = i * channels;
    for (let c = 0; c < 3; c += 1) rgb[i * 3 + c] = out[from + (channels >= 3 ? c : 0)];
  }
  return { width, height, rgb };
}
