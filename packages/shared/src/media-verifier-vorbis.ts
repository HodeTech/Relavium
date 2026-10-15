import { MAX_MEDIA_OBJECT_BYTES } from './media-admission.js';
import { MediaInspectionMemory } from './media-inspection-memory.js';
import { byte, fail } from './media-verifier-reader.js';

// Vorbis I §§2, 3, 4.2.4, 6.2.1, 7.2.2, 8.6.1 and 9.2.3:
// https://www.xiph.org/vorbis/doc/Vorbis_I_spec.html
// Walk setup syntax to locate its framing bit. No Huffman tree, lookup vectors,
// floor curves, residue samples or audio are reconstructed or decoded here.
// Positive requests read at most 32 bits; negative requests discard an extent.
type BitParser<T = void> = Generator<number, T, number>;

function* bits(width: number): BitParser<number> {
  if (width === 0) return 0;
  return yield width;
}
function* discard(width: number): BitParser {
  if (width !== 0) yield -width;
}
function ilog(value: number): number {
  let width = 0;
  while (value > 0) {
    value = Math.floor(value / 2);
    width++;
  }
  return width;
}

/** Exact comparison without ever constructing a product larger than limit + 1. */
function powerFits(base: number, exponent: number, limit: number): boolean {
  let value = 1;
  while (exponent > 0) {
    if (exponent % 2 !== 0) {
      if (value > Math.floor(limit / base)) return false;
      value *= base;
    }
    exponent = Math.floor(exponent / 2);
    if (exponent > 0) base = base > Math.floor(limit / base) ? limit + 1 : base * base;
  }
  return value <= limit;
}
function lookupValues(entries: number, dimensions: number): number {
  // Unused zero-sized books are admitted by Xiph's setup reader. In particular,
  // lib/codebook.c consumes no type-1 multiplicands when dimensions is zero.
  if (entries === 0 || dimensions === 0) return 0;
  let low = 0,
    high = entries;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (powerFits(middle, dimensions, entries)) low = middle;
    else high = middle - 1;
  }
  return low;
}

interface Tables {
  readonly books: DataView;
  readonly partitions: Uint8Array;
  readonly dimensions: Uint8Array;
  readonly positions: DataView;
}
function tables(memory: MediaInspectionMemory): Tables {
  // One allocation, reused across all floors: 256*(2+4+1) + 31 + 16 + 65*2.
  const buffer = memory.allocate(1969);
  return {
    books: new DataView(buffer.buffer, buffer.byteOffset, 1792),
    partitions: buffer.subarray(1792, 1823),
    dimensions: buffer.subarray(1823, 1839),
    positions: new DataView(buffer.buffer, buffer.byteOffset + 1839, 130),
  };
}
function bookDimension(table: Tables, index: number): number {
  return table.books.getUint16(index * 7, true);
}
function bookEntries(table: Tables, index: number): number {
  return table.books.getUint32(index * 7 + 2, true);
}
function bookLookup(table: Tables, index: number): number {
  return table.books.getUint8(index * 7 + 6);
}
function* reference(count: number): BitParser<number> {
  const value = yield* bits(8);
  if (value >= count) fail();
  return value;
}

function* codewordLengths(entries: number): BitParser {
  if ((yield* bits(1)) === 0) {
    if ((yield* bits(1)) === 0) yield* discard(entries * 5);
    else {
      // Every iteration consumes a presence bit; no entry-sized retained list.
      for (let i = 0; i < entries; i++) if ((yield* bits(1)) !== 0) yield* discard(5);
    }
    return;
  }
  let length = (yield* bits(5)) + 1,
    remaining = entries;
  while (remaining > 0) {
    // A zero run is legal: it advances the length, not the entry cursor.
    // Xiph's lib/codebook.c restricts ordered lengths to 32 bits.
    if (length > 32) fail();
    const count = yield* bits(ilog(remaining));
    if (count > remaining) fail();
    remaining -= count;
    length++;
  }
}
function* codebooks(table: Tables): BitParser<number> {
  const count = (yield* bits(8)) + 1;
  for (let index = 0; index < count; index++) {
    if ((yield* bits(24)) !== 0x564342) fail();
    const dimensions = yield* bits(16),
      entries = yield* bits(24);
    table.books.setUint16(index * 7, dimensions, true);
    table.books.setUint32(index * 7 + 2, entries, true);
    yield* codewordLengths(entries);
    const lookup = yield* bits(4);
    if (lookup > 2) fail();
    table.books.setUint8(index * 7 + 6, lookup);
    if (lookup !== 0) {
      yield* discard(64); // The packed minimum/delta values do not affect framing.
      const width = (yield* bits(4)) + 1;
      yield* discard(1); // Sequence flag.
      const values = lookup === 1 ? lookupValues(entries, dimensions) : entries * dimensions;
      // At most (2**24-1)*(2**16-1)*16 < 2**44, exact in a JS number.
      // The byte feeder refuses any request impossible under the packet bound.
      yield* discard(values * width);
    }
  }
  return count;
}

function* floorZero(table: Tables, bookCount: number): BitParser {
  const order = yield* bits(8),
    rate = yield* bits(16),
    barkSize = yield* bits(16);
  if (order === 0 || rate === 0 || barkSize === 0) fail();
  yield* discard(14); // Amplitude bits and offset: 6 + 8.
  const count = (yield* bits(4)) + 1;
  for (let i = 0; i < count; i++) {
    const book = yield* reference(bookCount);
    if (bookLookup(table, book) === 0 || bookDimension(table, book) === 0) fail();
  }
}
function* floorOne(table: Tables, bookCount: number): BitParser {
  const partitions = yield* bits(5);
  let maximumClass = -1;
  for (let i = 0; i < partitions; i++) {
    const current = yield* bits(4);
    table.partitions[i] = current;
    maximumClass = Math.max(maximumClass, current);
  }
  for (let i = 0; i <= maximumClass; i++) {
    table.dimensions[i] = (yield* bits(3)) + 1;
    const subclasses = yield* bits(2);
    if (subclasses !== 0) yield* reference(bookCount);
    for (let j = 0; j < 2 ** subclasses; j++) {
      const encoded = yield* bits(8);
      // Encoded zero is the absent-book sentinel (-1), not reference zero.
      if (encoded !== 0 && encoded - 1 >= bookCount) fail();
    }
  }
  yield* discard(2); // Multiplier, encoded 0..3 for 1..4.
  const rangeBits = yield* bits(4);
  table.positions.setUint16(0, 0, true);
  table.positions.setUint16(2, 2 ** rangeBits, true);
  let values = 2;
  for (let i = 0; i < partitions; i++) {
    const dimension = byte(table.dimensions, byte(table.partitions, i));
    if (values + dimension > 65) fail();
    for (let j = 0; j < dimension; j++) {
      const value = yield* bits(rangeBits);
      for (let previous = 0; previous < values; previous++)
        if (table.positions.getUint16(previous * 2, true) === value) fail();
      table.positions.setUint16(values++ * 2, value, true);
    }
  }
}
function* floors(table: Tables, bookCount: number): BitParser<number> {
  const count = (yield* bits(6)) + 1;
  for (let i = 0; i < count; i++) {
    const type = yield* bits(16);
    if (type === 0) yield* floorZero(table, bookCount);
    else if (type === 1) yield* floorOne(table, bookCount);
    else fail();
  }
  return count;
}
function* residues(table: Tables, bookCount: number): BitParser<number> {
  const count = (yield* bits(6)) + 1;
  for (let i = 0; i < count; i++) {
    if ((yield* bits(16)) > 2) fail();
    yield* discard(72); // Begin/end/partition size, whose values do not change framing.
    const classifications = (yield* bits(6)) + 1,
      classbook = yield* reference(bookCount),
      dimensions = bookDimension(table, classbook);
    if (dimensions === 0 || !powerFits(classifications, dimensions, bookEntries(table, classbook)))
      fail();
    let books = 0;
    for (let j = 0; j < classifications; j++) {
      const low = yield* bits(3),
        high = (yield* bits(1)) === 0 ? 0 : yield* bits(5);
      let cascade = low + 8 * high;
      while (cascade > 0) {
        books += cascade % 2;
        cascade = Math.floor(cascade / 2);
      }
    }
    for (let j = 0; j < books; j++) {
      const book = yield* reference(bookCount);
      // §8.6.1 and Xiph lib/res0.c require a value mapping for pass books.
      // Its positive-dimension check applies to the classbook above, not here.
      if (bookLookup(table, book) === 0) fail();
    }
  }
  return count;
}
function* mappings(channels: number, floorCount: number, residueCount: number): BitParser<number> {
  const count = (yield* bits(6)) + 1;
  for (let i = 0; i < count; i++) {
    if ((yield* bits(16)) !== 0) fail();
    const submaps = (yield* bits(1)) === 0 ? 1 : (yield* bits(4)) + 1;
    if ((yield* bits(1)) !== 0) {
      const steps = (yield* bits(8)) + 1,
        width = ilog(channels - 1);
      for (let j = 0; j < steps; j++) {
        const magnitude = yield* bits(width),
          angle = yield* bits(width);
        if (magnitude === angle || magnitude >= channels || angle >= channels) fail();
      }
    }
    if ((yield* bits(2)) !== 0) fail();
    if (submaps > 1) for (let j = 0; j < channels; j++) if ((yield* bits(4)) >= submaps) fail();
    for (let j = 0; j < submaps; j++) {
      // §4.2.4 explicitly discards this byte; it is NOT the zero-only time list.
      yield* discard(8);
      yield* reference(floorCount);
      yield* reference(residueCount);
    }
  }
  return count;
}
function* setup(channels: number, table: Tables): BitParser {
  const bookCount = yield* codebooks(table),
    times = (yield* bits(6)) + 1;
  for (let i = 0; i < times; i++) if ((yield* bits(16)) !== 0) fail();
  const floorCount = yield* floors(table, bookCount),
    residueCount = yield* residues(table, bookCount),
    mappingCount = yield* mappings(channels, floorCount, residueCount),
    modes = (yield* bits(6)) + 1;
  for (let i = 0; i < modes; i++) {
    yield* discard(1); // Small/large block flag.
    if ((yield* bits(16)) !== 0 || (yield* bits(16)) !== 0) fail();
    yield* reference(mappingCount);
  }
  if ((yield* bits(1)) !== 1) fail();
}

/** Receives only bytes AFTER the seven-byte setup signature; owns no borrowed views. */
export class VorbisSetup {
  readonly #parser: BitParser;
  #step: IteratorResult<number, void>;
  #remaining = 0;
  #value = 0;
  #filled = 0;
  #consumed = 56;
  constructor(channels: number, memory: MediaInspectionMemory) {
    if (!Number.isInteger(channels) || channels < 1 || channels > 255) fail();
    this.#parser = setup(channels, tables(memory));
    this.#step = this.#parser.next();
    this.#request();
  }
  #request(): void {
    if (this.#step.done) return;
    const request = this.#step.value;
    if (
      !Number.isSafeInteger(request) ||
      request === 0 ||
      request > 32 ||
      Math.abs(request) > MAX_MEDIA_OBJECT_BYTES * 8 - this.#consumed
    )
      fail();
    this.#remaining = Math.abs(request);
    this.#value = 0;
    this.#filled = 0;
  }
  push(value: number): void {
    let available = 8;
    while (available > 0 && !this.#step.done) {
      const take = Math.min(available, this.#remaining),
        radix = 2 ** take;
      if (this.#step.value > 0) {
        this.#value += (value % radix) * 2 ** this.#filled;
        this.#filled += take;
      }
      value = Math.floor(value / radix);
      available -= take;
      this.#remaining -= take;
      this.#consumed += take;
      if (this.#remaining === 0) {
        this.#step = this.#parser.next(this.#value);
        this.#request();
      }
    }
    // Xiph's lib/info.c ends setup decode immediately after framing. Any packet
    // tail, including the current byte's remaining bits, is ignored here; Ogg
    // continues counting and checksumming every byte through packet/page EOF.
  }
  finish(): void {
    if (!this.#step.done) fail();
  }
}
