/** Independently authored Vorbis I wire fixtures; no production-parser imports. */
import { oggFixturePage } from './media-opus-vectors.js';
import { hex, join, textBytes, uint32 } from './media-test-vectors.js';

export interface VorbisFixtureField {
  /** Absolute bit offset in the packet, including its seven-byte signature. */
  readonly bit: number;
  readonly width: number;
}
class PackedFields {
  readonly #bytes: number[] = [];
  readonly fields: Record<string, VorbisFixtureField> = {};
  #cursor = 0;
  write(name: string, width: number, value: number): void {
    this.fields[name] = { bit: this.#cursor + 56, width };
    for (let bit = 0; bit < width; bit++, this.#cursor++) {
      const at = Math.floor(this.#cursor / 8);
      this.#bytes[at] =
        (this.#bytes[at] ?? 0) + (Math.floor(value / 2 ** bit) % 2) * 2 ** (this.#cursor % 8);
    }
  }
  zeros(name: string, width: number): void {
    this.fields[name] = { bit: this.#cursor + 56, width };
    this.#cursor += width;
  }
  finish(): Uint8Array {
    return join(
      textBytes('\x05vorbis'),
      Uint8Array.from({ length: Math.ceil(this.#cursor / 8) }, (_, at) => this.#bytes[at] ?? 0),
    );
  }
}
export interface VorbisCodebookFixture {
  readonly dimensions?: number;
  readonly entries?: number;
  readonly sparse?: boolean;
  readonly lengths?: readonly (number | undefined)[];
  readonly initialLength?: number;
  readonly orderedRuns?: readonly number[];
  readonly lookup?: number;
  readonly valueBits?: number;
  /** Explicit count for type 1, independently supplied from the root equation. */
  readonly multiplicands?: number;
}
interface FloorClassFixture {
  readonly dimension?: number;
  readonly subclasses?: number;
  readonly masterbook?: number;
  readonly subclassBooks?: readonly number[];
}
export interface VorbisFloorFixture {
  readonly type?: number;
  readonly order?: number;
  readonly rate?: number;
  readonly barkSize?: number;
  readonly amplitudeBits?: number;
  readonly amplitudeOffset?: number;
  readonly books?: readonly number[];
  readonly partitions?: readonly number[];
  readonly classes?: readonly FloorClassFixture[];
  readonly multiplier?: number;
  readonly rangeBits?: number;
  readonly positions?: readonly number[];
}
export interface VorbisResidueFixture {
  readonly type?: number;
  readonly begin?: number;
  readonly end?: number;
  readonly partitionSize?: number;
  readonly classifications?: number;
  readonly classbook?: number;
  readonly cascades?: readonly number[];
  readonly books?: readonly number[];
}
export interface VorbisMappingFixture {
  readonly type?: number;
  readonly submaps?: number;
  readonly coupling?: readonly (readonly [number, number])[];
  readonly reserved?: number;
  readonly mux?: readonly number[];
  readonly times?: readonly number[];
  readonly floors?: readonly number[];
  readonly residues?: readonly number[];
}
export interface VorbisSetupFixtureOptions {
  readonly channels?: number;
  readonly books?: readonly VorbisCodebookFixture[];
  readonly times?: readonly number[];
  readonly floors?: readonly VorbisFloorFixture[];
  readonly residues?: readonly VorbisResidueFixture[];
  readonly mappings?: readonly VorbisMappingFixture[];
  readonly modes?: number;
  readonly windowType?: number;
  readonly transformType?: number;
  readonly modeMapping?: number;
  readonly framing?: number;
}
export interface VorbisSetupFixture {
  readonly packet: Uint8Array;
  readonly fields: Readonly<Record<string, VorbisFixtureField>>;
}

function writeCodebook(writer: PackedFields, index: number, book: VorbisCodebookFixture): void {
  const prefix = `book.${index}`,
    dimensions = book.dimensions ?? 1,
    entries = book.entries ?? 1,
    lookup = book.lookup ?? 0;
  writer.write(`${prefix}.sync`, 24, 0x564342);
  writer.write(`${prefix}.dimensions`, 16, dimensions);
  writer.write(`${prefix}.entries`, 24, entries);
  writer.write(`${prefix}.ordered`, 1, book.orderedRuns === undefined ? 0 : 1);
  if (book.orderedRuns === undefined) {
    writer.write(`${prefix}.sparse`, 1, book.sparse ? 1 : 0);
    for (let i = 0; i < entries; i++) {
      const length = book.lengths === undefined ? 1 : book.lengths[i];
      if (book.sparse) writer.write(`${prefix}.present.${i}`, 1, length === undefined ? 0 : 1);
      if (!book.sparse || length !== undefined)
        writer.write(`${prefix}.length.${i}`, 5, (length ?? 1) - 1);
    }
  } else {
    writer.write(`${prefix}.initial-length`, 5, (book.initialLength ?? 1) - 1);
    let assigned = 0;
    for (const [i, run] of book.orderedRuns.entries()) {
      const width = entries === assigned ? 0 : Math.floor(Math.log2(entries - assigned)) + 1;
      writer.write(`${prefix}.run.${i}`, width, run);
      assigned += run;
    }
  }
  writer.write(`${prefix}.lookup`, 4, lookup);
  if (lookup === 1 || lookup === 2) {
    writer.write(`${prefix}.minimum`, 32, 0);
    writer.write(`${prefix}.delta`, 32, 0);
    const width = book.valueBits ?? 1;
    writer.write(`${prefix}.value-bits`, 4, width - 1);
    writer.write(`${prefix}.sequence`, 1, 0);
    const count = book.multiplicands ?? (lookup === 1 ? 1 : entries * dimensions);
    writer.zeros(`${prefix}.multiplicands`, count * width);
  }
}
function writeFloor(writer: PackedFields, index: number, floor: VorbisFloorFixture): void {
  const prefix = `floor.${index}`,
    type = floor.type ?? 1;
  writer.write(`${prefix}.type`, 16, type);
  if (type === 0) {
    writer.write(`${prefix}.order`, 8, floor.order ?? 1);
    writer.write(`${prefix}.rate`, 16, floor.rate ?? 8000);
    writer.write(`${prefix}.bark-size`, 16, floor.barkSize ?? 8);
    writer.write(`${prefix}.amplitude-bits`, 6, floor.amplitudeBits ?? 1);
    writer.write(`${prefix}.amplitude-offset`, 8, floor.amplitudeOffset ?? 1);
    const books = floor.books ?? [0];
    writer.write(`${prefix}.book-count`, 4, books.length - 1);
    for (const [i, book] of books.entries()) writer.write(`${prefix}.book.${i}`, 8, book);
    return;
  }
  if (type !== 1) return;
  const partitions = floor.partitions ?? [];
  writer.write(`${prefix}.partitions`, 5, partitions.length);
  for (const [i, value] of partitions.entries()) writer.write(`${prefix}.partition.${i}`, 4, value);
  const maximumClass = Math.max(-1, ...partitions);
  for (let i = 0; i <= maximumClass; i++) {
    const current = floor.classes?.[i],
      subclasses = current?.subclasses ?? 0;
    writer.write(`${prefix}.class.${i}.dimension`, 3, (current?.dimension ?? 1) - 1);
    writer.write(`${prefix}.class.${i}.subclasses`, 2, subclasses);
    if (subclasses !== 0)
      writer.write(`${prefix}.class.${i}.masterbook`, 8, current?.masterbook ?? 0);
    for (let j = 0; j < 2 ** subclasses; j++)
      writer.write(`${prefix}.class.${i}.book.${j}`, 8, current?.subclassBooks?.[j] ?? 0);
  }
  writer.write(`${prefix}.multiplier`, 2, (floor.multiplier ?? 1) - 1);
  const rangeBits = floor.rangeBits ?? 0;
  writer.write(`${prefix}.range-bits`, 4, rangeBits);
  let position = 0;
  for (const current of partitions) {
    const dimension = floor.classes?.[current]?.dimension ?? 1;
    for (let i = 0; i < dimension; i++, position++)
      writer.write(
        `${prefix}.x.${position}`,
        rangeBits,
        floor.positions?.[position] ?? position + 1,
      );
  }
}
function writeResidue(writer: PackedFields, index: number, residue: VorbisResidueFixture): void {
  const prefix = `residue.${index}`,
    classifications = residue.classifications ?? 1;
  writer.write(`${prefix}.type`, 16, residue.type ?? 0);
  writer.write(`${prefix}.begin`, 24, residue.begin ?? 0);
  writer.write(`${prefix}.end`, 24, residue.end ?? 0);
  writer.write(`${prefix}.partition-size`, 24, (residue.partitionSize ?? 1) - 1);
  writer.write(`${prefix}.classifications`, 6, classifications - 1);
  writer.write(`${prefix}.classbook`, 8, residue.classbook ?? 0);
  let books = 0;
  for (let i = 0; i < classifications; i++) {
    const cascade = residue.cascades?.[i] ?? 0;
    writer.write(`${prefix}.cascade.${i}.low`, 3, cascade % 8);
    writer.write(`${prefix}.cascade.${i}.flag`, 1, cascade > 7 ? 1 : 0);
    if (cascade > 7) writer.write(`${prefix}.cascade.${i}.high`, 5, Math.floor(cascade / 8));
    books += cascade.toString(2).replaceAll('0', '').length;
  }
  for (let i = 0; i < books; i++) writer.write(`${prefix}.book.${i}`, 8, residue.books?.[i] ?? 0);
}
function writeMapping(
  writer: PackedFields,
  index: number,
  mapping: VorbisMappingFixture,
  channels: number,
): void {
  const prefix = `mapping.${index}`,
    submaps = mapping.submaps ?? 1;
  writer.write(`${prefix}.type`, 16, mapping.type ?? 0);
  writer.write(`${prefix}.submaps-present`, 1, submaps > 1 ? 1 : 0);
  if (submaps > 1) writer.write(`${prefix}.submaps`, 4, submaps - 1);
  writer.write(`${prefix}.coupling-present`, 1, mapping.coupling === undefined ? 0 : 1);
  if (mapping.coupling !== undefined) {
    writer.write(`${prefix}.coupling-steps`, 8, mapping.coupling.length - 1);
    const width = channels <= 1 ? 0 : Math.ceil(Math.log2(channels));
    for (const [i, [magnitude, angle]] of mapping.coupling.entries()) {
      writer.write(`${prefix}.magnitude.${i}`, width, magnitude);
      writer.write(`${prefix}.angle.${i}`, width, angle);
    }
  }
  writer.write(`${prefix}.reserved`, 2, mapping.reserved ?? 0);
  if (submaps > 1)
    for (let i = 0; i < channels; i++) writer.write(`${prefix}.mux.${i}`, 4, mapping.mux?.[i] ?? 0);
  for (let i = 0; i < submaps; i++) {
    writer.write(`${prefix}.time.${i}`, 8, mapping.times?.[i] ?? 0);
    writer.write(`${prefix}.floor.${i}`, 8, mapping.floors?.[i] ?? 0);
    writer.write(`${prefix}.residue.${i}`, 8, mapping.residues?.[i] ?? 0);
  }
}

/** Explicit field writer derived from the specification, with independent mutation coordinates. */
export function vorbisSetup(options: VorbisSetupFixtureOptions = {}): VorbisSetupFixture {
  const writer = new PackedFields(),
    books = options.books ?? [{}],
    times = options.times ?? [0],
    floors = options.floors ?? [{}],
    residues = options.residues ?? [{}],
    mappings = options.mappings ?? [{}],
    modes = options.modes ?? 1;
  writer.write('book-count', 8, books.length - 1);
  books.forEach((book, index) => writeCodebook(writer, index, book));
  writer.write('time-count', 6, times.length - 1);
  times.forEach((value, index) => writer.write(`time.${index}`, 16, value));
  writer.write('floor-count', 6, floors.length - 1);
  floors.forEach((floor, index) => writeFloor(writer, index, floor));
  writer.write('residue-count', 6, residues.length - 1);
  residues.forEach((residue, index) => writeResidue(writer, index, residue));
  writer.write('mapping-count', 6, mappings.length - 1);
  mappings.forEach((mapping, index) => writeMapping(writer, index, mapping, options.channels ?? 1));
  writer.write('mode-count', 6, modes - 1);
  for (let i = 0; i < modes; i++) {
    writer.write(`mode.${i}.block`, 1, 0);
    writer.write(`mode.${i}.window`, 16, options.windowType ?? 0);
    writer.write(`mode.${i}.transform`, 16, options.transformType ?? 0);
    writer.write(`mode.${i}.mapping`, 8, options.modeMapping ?? 0);
  }
  writer.write('framing', 1, options.framing ?? 1);
  return { packet: writer.finish(), fields: writer.fields };
}
export function vorbisField(fixture: VorbisSetupFixture, name: string): VorbisFixtureField {
  const field = fixture.fields[name];
  if (field === undefined) throw new Error(`Missing independent Vorbis fixture field: ${name}`);
  return field;
}
export function changeVorbisField(
  fixture: VorbisSetupFixture,
  name: string,
  value: number,
): Uint8Array {
  const packet = fixture.packet.slice(),
    field = vorbisField(fixture, name);
  for (let i = 0; i < field.width; i++) {
    const at = Math.floor((field.bit + i) / 8),
      mask = 2 ** ((field.bit + i) % 8);
    packet[at] = ((packet[at] ?? 0) & (255 - mask)) | ((Math.floor(value / 2 ** i) % 2) * mask);
  }
  return packet;
}
export function vorbisPages(
  setup: Uint8Array = vorbisSetup().packet,
  options: {
    readonly channels?: number;
    readonly pageSegments?: number;
    readonly audioPackets?: number;
  } = {},
): readonly Uint8Array[] {
  const identification = join(
      textBytes('\x01vorbis'),
      uint32(0, true),
      new Uint8Array([options.channels ?? 1]),
      uint32(8000, true),
      new Uint8Array(12),
      hex('6601'),
    ),
    comments = join(textBytes('\x03vorbis'), new Uint8Array(8), hex('01')),
    pages = [
      oggFixturePage(identification, [identification.length], 0, 2),
      oggFixturePage(comments, [comments.length], 1, 0),
    ],
    laces = [...new Array<number>(Math.floor(setup.length / 255)).fill(255), setup.length % 255],
    segments = options.pageSegments ?? 255;
  let offset = 0;
  for (let start = 0; start < laces.length; start += segments) {
    const pageLaces = laces.slice(start, start + segments),
      size = pageLaces.reduce((sum, length) => sum + length, 0);
    pages.push(
      oggFixturePage(
        setup.subarray(offset, offset + size),
        pageLaces,
        pages.length,
        start === 0 ? 0 : 1,
      ),
    );
    offset += size;
  }
  const audioPackets = options.audioPackets ?? 1;
  for (let i = 0; i < audioPackets; i++)
    pages.push(oggFixturePage(hex('00'), [1], pages.length, i === audioPackets - 1 ? 4 : 0));
  return pages;
}
export function vorbisContainer(
  setup: Uint8Array = vorbisSetup().packet,
  options: Parameters<typeof vorbisPages>[1] = {},
): Uint8Array {
  return join(...vorbisPages(setup, options));
}

/**
 * Preserve the reviewer's exact identification/comments and forty native audio
 * pages, including their granules. Only setup page sequence 2 is substituted.
 * Root independently decoded modes 1..8 with macOS afconvert on 2026-10-15;
 * their immutable body hashes are pinned in media-verifier-vorbis.test.ts.
 */
export function nativeVorbis(modes: number): Uint8Array {
  if (!Number.isInteger(modes) || modes < 1 || modes > 8)
    throw new Error('The native Vorbis fixture covers one through eight modes');
  const setup = vorbisSetup({ modes }).packet;
  return join(
    NATIVE_VALID_VORBIS.subarray(0, 102),
    oggFixturePage(setup, [setup.length], 2, 0),
    NATIVE_VALID_VORBIS.subarray(181),
  );
}

// The immutable native-valid 1,341-byte reviewer control is appended below by a
// byte-for-byte archive extraction, not regenerated by the field writer above.
// Source: docs/reviews/2026-10-15T15-43-44-pr-94-systematic-evidence.zip
// Member: minimal-valid-vorbis.ogg; companion: media-valid-vorbis.mjs.
// SHA-256: ca76917ac2aa3fd6eaf02c4169fae664d403fd9a8383750735c42bee84093727
// Native-valid result is historical reviewer evidence, not a new execution.
export const NATIVE_VALID_VORBIS = hex(
  '4f676753000200000000000000004f544731000000008ea755e7011e01766f726269730000000001401f0000000000000000' +
    '00000000000066014f676753000000000000000000004f54473101000000cb5932d8011003766f7262697300000000000000' +
    '00014f676753000000000000000000004f5447310200000094320b58013305766f7262697300424356010001000000000000' +
    '800000000000000000000000000000000000000000000000000000000000084f676753000000000000000000004f54473103' +
    '000000326cc3150101004f676753000020000000000000004f54473104000000d6fa83390101004f67675300004000000000' +
    '0000004f544731050000008f2e619e0101004f676753000060000000000000004f544731060000000a81d0590101004f6767' +
    '53000080000000000000004f544731070000008a9b65d50101004f6767530000a0000000000000004f544731080000001b62' +
    '062a0101004f6767530000c0000000000000004f5447310900000042b6e48d0101004f6767530000e0000000000000004f54' +
    '47310a000000c719554a0101004f676753000000010000000000004f5447310b000000b5b462350101004f67675300002001' +
    '0000000000004f5447310c000000512222190101004f676753000040010000000000004f5447310d00000008f6c0be010100' +
    '4f676753000060010000000000004f5447310e0000008d5971790101004f676753000080010000000000004f5447310f0000' +
    '000d43c4f50101004f6767530000a0010000000000004f54473110000000c17920a80101004f6767530000c0010000000000' +
    '004f5447311100000098adc20f0101004f6767530000e0010000000000004f544731120000001d0273c80101004f67675300' +
    '0000020000000000004f544731130000003cdd80540101004f676753000020020000000000004f54473114000000d84bc078' +
    '0101004f676753000040020000000000004f54473115000000819f22df0101004f676753000060020000000000004f544731' +
    '16000000043093180101004f676753000080020000000000004f54473117000000842a26940101004f6767530000a0020000' +
    '000000004f5447311800000015d3456b0101004f6767530000c0020000000000004f544731190000004c07a7cc0101004f67' +
    '67530000e0020000000000004f5447311a000000c9a8160b0101004f676753000000030000000000004f5447311b000000bb' +
    '0521740101004f676753000020030000000000004f5447311c0000005f9361580101004f676753000040030000000000004f' +
    '5447311d000000064783ff0101004f676753000060030000000000004f5447311e00000083e832380101004f676753000080' +
    '030000000000004f5447311f00000003f287b40101004f6767530000a0030000000000004f54473120000000c253ada80101' +
    '004f6767530000c0030000000000004f544731210000009b874f0f0101004f6767530000e0030000000000004f5447312200' +
    '00001e28fec80101004f676753000000040000000000004f544731230000002e0e44970101004f6767530000200400000000' +
    '00004f54473124000000ca9804bb0101004f676753000040040000000000004f54473125000000934ce61c0101004f676753' +
    '000060040000000000004f5447312600000016e357db0101004f676753000080040000000000004f5447312700000096f9e2' +
    '570101004f6767530000a0040000000000004f54473128000000070081a80101004f6767530000c0040000000000004f5447' +
    '31290000005ed4630f0101004f6767530004e0040000000000004f5447312a000000a410ad96010100',
);
