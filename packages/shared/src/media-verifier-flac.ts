import {
  ascii,
  be16,
  byte,
  countStructure,
  fail,
  read,
  skip,
  type MediaParser,
  type ReadStep,
} from './media-verifier-reader.js';
function checksum(crc: number, value: number, width: number, polynomial: number): number {
  crc ^= value << (width - 8);
  for (let i = 0; i < 8; i++)
    crc = ((crc << 1) ^ (crc & (1 << (width - 1)) ? polynomial : 0)) & ((1 << width) - 1);
  return crc;
}
/** RFC 9639 framing parser. Skips coded samples, never reconstructs PCM. */
class FrameBits {
  crc = 0;
  #value = 0;
  #remaining = 0;
  add(value: number): void {
    this.crc = checksum(this.crc, value, 16, 0x8005);
  }
  *bits(n: number): Generator<ReadStep, number, Uint8Array> {
    let value = 0;
    while (n > 0) {
      if (this.#remaining === 0) {
        this.#value = byte(yield* read(1), 0);
        this.add(this.#value);
        this.#remaining = 8;
      }
      const take = Math.min(n, this.#remaining);
      this.#remaining -= take;
      n -= take;
      value = value * 2 ** take + ((this.#value >> this.#remaining) & ((1 << take) - 1));
    }
    return value;
  }
  *discard(n: number): Generator<ReadStep, void, Uint8Array> {
    while (n > 0) {
      const take = Math.min(n, 24);
      yield* this.bits(take);
      n -= take;
    }
  }
  *unary(maximum = 25 * 1024 * 1024 * 8): Generator<ReadStep, number, Uint8Array> {
    let n = 0;
    while ((yield* this.bits(1)) === 0) {
      if (++n > maximum) fail();
    }
    return n;
  }
  *align(): Generator<ReadStep, void, Uint8Array> {
    if (this.#remaining > 0 && (yield* this.bits(this.#remaining)) !== 0) fail();
  }
}
function* residual(
  bits: FrameBits,
  block: number,
  order: number,
): Generator<ReadStep, void, Uint8Array> {
  const method = yield* bits.bits(2);
  if (method > 1) fail();
  const partitions = 2 ** (yield* bits.bits(4));
  if (block % partitions !== 0 || block / partitions < order) fail();
  for (let p = 0; p < partitions; p++) {
    const parameter = yield* bits.bits(method + 4),
      samples = block / partitions - (p === 0 ? order : 0);
    if (parameter === (1 << (method + 4)) - 1) {
      yield* bits.discard((yield* bits.bits(5)) * samples);
    } else
      for (let i = 0; i < samples; i++) {
        yield* bits.unary();
        yield* bits.discard(parameter);
      }
  }
}
export function* flac(): MediaParser {
  if (ascii(yield* read(4)) !== 'fLaC') fail();
  let metadata = 0,
    last = false,
    channels = 0,
    depth = 0,
    rate = 0,
    total = 0,
    minBlock = 0,
    maxBlock = 0;
  while (!last) {
    metadata = countStructure(metadata);
    const h = yield* read(4),
      type = byte(h, 0) & 127,
      length = byte(h, 1) * 65536 + be16(h, 2);
    last = (byte(h, 0) & 128) !== 0;
    if (metadata === 1) {
      if (type !== 0 || length !== 34) fail();
      const s = yield* read(34);
      minBlock = be16(s);
      maxBlock = be16(s, 2);
      rate = byte(s, 10) * 4096 + byte(s, 11) * 16 + (byte(s, 12) >> 4);
      channels = ((byte(s, 12) >> 1) & 7) + 1;
      depth = ((byte(s, 12) & 1) << 4) + (byte(s, 13) >> 4) + 1;
      total =
        (byte(s, 13) & 15) * 4294967296 +
        byte(s, 14) * 16777216 +
        byte(s, 15) * 65536 +
        be16(s, 16);
      if (minBlock < 16 || maxBlock < minBlock || !rate || depth < 4 || depth > 32) fail();
    } else {
      if (type === 0 || type === 127) fail();
      yield* skip(length);
    }
  }
  let frames = 0,
    samples = 0,
    strategy = -1,
    previousBlock = 0,
    fixedBlock = 0;
  for (;;) {
    const h = yield* read(4, true);
    if (h.length === 0) {
      if (frames === 0 || (total !== 0 && total !== samples)) fail();
      return 'audio/flac';
    }
    const b1 = byte(h, 1),
      blockCode = byte(h, 2) >> 4,
      rateCode = byte(h, 2) & 15,
      channelCode = byte(h, 3) >> 4,
      depthCode = (byte(h, 3) >> 1) & 7;
    if (
      byte(h, 0) !== 255 ||
      (b1 & 0xfe) !== 0xf8 ||
      blockCode === 0 ||
      rateCode === 15 ||
      channelCode > 10 ||
      depthCode === 3 ||
      (byte(h, 3) & 1) !== 0
    )
      fail();
    const currentStrategy = b1 & 1;
    if (strategy !== -1 && strategy !== currentStrategy) fail();
    strategy = currentStrategy;
    // RFC 9639 §§8.2/9.1: only a successor proves the CRC-complete prior frame
    // nonfinal. Keep the final/singleton minimum exception, including blocks 1..15.
    if (previousBlock !== 0) {
      if (previousBlock < minBlock) fail();
      if (strategy === 0) {
        if (fixedBlock === 0) fixedBlock = previousBlock;
        else if (previousBlock !== fixedBlock) fail();
      }
    }
    const bits = new FrameBits();
    let crc8 = 0;
    for (const b of h) {
      bits.add(b);
      crc8 = checksum(crc8, b, 8, 7);
    }
    const nextByte = function* (): Generator<ReadStep, number, Uint8Array> {
      const b = byte(yield* read(1), 0);
      bits.add(b);
      crc8 = checksum(crc8, b, 8, 7);
      return b;
    };
    const first = yield* nextByte();
    let number = first,
      continuations = 0;
    if (first >= 128) {
      let mask = 128;
      while (first & mask) {
        continuations++;
        mask >>= 1;
      }
      if (continuations < 2 || continuations > 7) fail();
      number = first & (mask - 1);
      for (let i = 1; i < continuations; i++) {
        const b = yield* nextByte();
        if ((b & 192) !== 128) fail();
        number = number * 64 + (b & 63);
      }
      if (number < 2 ** (continuations === 2 ? 7 : 5 * continuations - 4)) fail();
    }
    if (number !== (strategy === 0 ? frames : samples)) fail();
    let block =
      blockCode === 1
        ? 192
        : blockCode <= 5
          ? 144 * 2 ** blockCode
          : blockCode >= 8
            ? 256 * 2 ** (blockCode - 8)
            : 0;
    if (blockCode === 6) block = 1 + (yield* nextByte());
    if (blockCode === 7) block = 1 + 256 * (yield* nextByte()) + (yield* nextByte());
    let sampleRate =
      [rate, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000][
        rateCode
      ] ?? 0;
    if (rateCode === 12) sampleRate = 1000 * (yield* nextByte());
    if (rateCode === 13 || rateCode === 14)
      sampleRate = (256 * (yield* nextByte()) + (yield* nextByte())) * (rateCode === 14 ? 10 : 1);
    const frameDepth = [depth, 8, 12, 0, 16, 20, 24, 32][depthCode] ?? 0,
      frameChannels = channelCode <= 7 ? channelCode + 1 : 2;
    if (
      !block ||
      block > maxBlock ||
      sampleRate !== rate ||
      frameDepth !== depth ||
      frameChannels !== channels
    )
      fail();
    // A fixed final block may be shorter, never larger; a successor will also
    // require this candidate to equal the nominal size if it proves nonfinal.
    if (strategy === 0 && fixedBlock !== 0 && block > fixedBlock) fail();
    const stored = byte(yield* read(1), 0);
    if (stored !== crc8) fail();
    bits.add(stored);
    for (let channel = 0; channel < channels; channel++) {
      if ((yield* bits.bits(1)) !== 0) fail();
      const type = yield* bits.bits(6),
        wasted = yield* bits.bits(1);
      let sampleBits =
        depth +
        ((channelCode === 8 && channel === 1) ||
        (channelCode === 9 && channel === 0) ||
        (channelCode === 10 && channel === 1)
          ? 1
          : 0);
      if (wasted) sampleBits -= 1 + (yield* bits.unary(sampleBits));
      if (sampleBits <= 0) fail();
      if (type === 0) yield* bits.discard(sampleBits);
      else if (type === 1) yield* bits.discard(sampleBits * block);
      else if ((type >= 8 && type <= 12) || type >= 32) {
        const order = type >= 32 ? (type & 31) + 1 : type - 8;
        if (order > block) fail();
        yield* bits.discard(sampleBits * order);
        if (type >= 32) {
          const precision = yield* bits.bits(4);
          if (precision === 15) fail();
          if ((yield* bits.bits(5)) >= 16) fail();
          yield* bits.discard((precision + 1) * order);
        }
        yield* residual(bits, block, order);
      } else fail();
    }
    yield* bits.align();
    if (be16(yield* read(2)) !== bits.crc) fail();
    previousBlock = block;
    samples += block;
    frames = countStructure(frames, 1048576);
  }
}
