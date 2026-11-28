// A minimal PNG decoder: 8-bit, non-interlaced, colour types 2 (RGB), 6 (RGBA), 0 and 4 (grey) — what a browser screenshot is.
import { inflateSync } from 'node:zlib';

/** @param {Buffer} buf @returns {{ width: number, height: number, rgb: Uint8Array }} rgb is width*height*3 */
export function decodePng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) if (buf[i] !== sig[i]) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  if (depth !== 8 || interlace !== 0)
    throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  if (channels === undefined) throw new Error(`unsupported PNG colour type ${colourType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    if (channels >= 3) {
      rgb[i * 3] = out[i * channels];
      rgb[i * 3 + 1] = out[i * channels + 1];
      rgb[i * 3 + 2] = out[i * channels + 2];
    } else rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = out[i * channels];
  }
  return { width, height, rgb };
}
