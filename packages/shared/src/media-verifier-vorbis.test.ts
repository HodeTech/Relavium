import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MediaAdmissionError } from './media-admission.js';
import { MediaInspectionMemory } from './media-inspection-memory.js';
import { oggFixturePage } from './media-opus-vectors.js';
import { hex, join, textBytes } from './media-test-vectors.js';
import {
  changeVorbisField,
  nativeVorbis,
  NATIVE_VALID_VORBIS,
  vorbisContainer,
  vorbisField,
  vorbisPages,
  vorbisSetup,
  type VorbisSetupFixtureOptions,
} from './media-vorbis-vectors.js';
import { createMediaVerifier } from './media-verifier.js';
import { ogg } from './media-verifier-ogg.js';
import { oggCrc, oggCrcByte, ParserReader } from './media-verifier-reader.js';

function verify(bytes: Uint8Array, sizes: readonly number[] = [1, 7, 27, 255, 997]) {
  const verifier = createMediaVerifier('audio/ogg');
  for (let at = 0, index = 0; at < bytes.length; index++) {
    const size = sizes[index % sizes.length] ?? 1;
    verifier.push(bytes.subarray(at, at + size));
    at += size;
  }
  return verifier.finish();
}
function observe(bytes: Uint8Array, sizes: readonly number[]): unknown {
  try {
    return { status: 'fulfilled', value: verify(bytes, sizes) };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}
function refused(packet: Uint8Array, channels = 1, marker = 'MEDIA_VORBIS_SETUP_STRUCTURE'): void {
  // Recomputed page CRCs ensure setup fields, rather than damaged transport, cause refusal.
  expect(() => verify(vorbisContainer(packet, { channels })), marker).toThrowError(
    new MediaAdmissionError('invalid_format'),
  );
}

describe('Vorbis setup framing at the parsed bit boundary', () => {
  it('preserves the exact independently supplied native-valid reviewer control', () => {
    expect(NATIVE_VALID_VORBIS).toHaveLength(1341);
    expect(createHash('sha256').update(NATIVE_VALID_VORBIS).digest('hex')).toBe(
      'ca76917ac2aa3fd6eaf02c4169fae664d403fd9a8383750735c42bee84093727',
    );
    expect(observe(NATIVE_VALID_VORBIS, [1]), 'MEDIA_VORBIS_NATIVE_FRAMING').toMatchObject({
      status: 'fulfilled',
      value: { mimeType: 'audio/ogg', byteLength: 1341 },
    });
    const minimal = vorbisSetup();
    expect(vorbisField(minimal, 'framing').bit % 8).toBe(3);
    expect(minimal.packet.at(-1)).toBe(0x08);
    expect(nativeVorbis(1)).toEqual(NATIVE_VALID_VORBIS);
  });
  // Root's independent native decoding receipt: 1,120 samples, mono 8kHz for
  // every body. These tests pin those body identities; they make no native call.
  it.each([
    [1, 1341, 'ca76917ac2aa3fd6eaf02c4169fae664d403fd9a8383750735c42bee84093727'],
    [2, 1346, '4e60ea9300833486b83dc021266aea914f01507e598bd87c6c308ba1adb5c8e1'],
    [3, 1351, '05d4c6d701805e048c5f08c4410ac0128d574129faafed86ce313faf92a95e05'],
    [4, 1356, '53d17b53c7e3fa666730c193161c15c3ba4492eac24e4bf208156dc09138aafd'],
    [5, 1361, '9cd058f08065aa1e53a7916c3938c0b0e2570ab06aeefb9700df5d2402ddb4c5'],
    [6, 1367, 'fd55aa70d7d3034eaaf79733e8b92cc4df92735fcba6f8f3325dd5a0eafd9ab8'],
    [7, 1372, '370a971b4968680ef0a7a5e67ef60ed0b9d613f281619e1e8d8b5305d841c283'],
    [8, 1377, '4272f22a7905b34c6dc883ffb42b4f1f856f530e7a0a1f9d0a951875e3b69e00'],
  ] satisfies [number, number, string][])(
    'admits the independently native-decoded %i-mode body with its exact hash',
    (modes, byteLength, hash) => {
      const bytes = nativeVorbis(modes);
      expect(bytes).toHaveLength(byteLength);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
      expect(observe(bytes, [1]), 'MEDIA_VORBIS_NATIVE_FRAMING').toMatchObject({
        status: 'fulfilled',
        value: { mimeType: 'audio/ogg', byteLength },
      });
    },
  );
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('admits the real framing bit for %i modes', (modes) => {
    const fixture = vorbisSetup({ modes }),
      bytes = vorbisContainer(fixture.packet);
    expect(vorbisField(fixture, 'framing').bit % 8).toBe((modes + 2) % 8);
    for (let split = 0; split <= bytes.length; split++) {
      const verifier = createMediaVerifier('audio/ogg');
      verifier.push(bytes.subarray(0, split));
      verifier.push(bytes.subarray(split));
      expect(verifier.finish(), 'MEDIA_VORBIS_SETUP_FRAMING').toMatchObject({
        mimeType: 'audio/ogg',
        byteLength: bytes.length,
      });
    }
    // Appending a physical final byte with low bit one cannot replace the actual flag.
    refused(
      join(changeVorbisField(fixture, 'framing', 0), hex('01')),
      1,
      'MEDIA_VORBIS_SETUP_FRAMING',
    );
  });
  it.each([hex('00'), hex('01'), hex('80'), hex('ff'), hex('00ff0180')])(
    'admits post-framing packet tail %j',
    (tail) => {
      const bytes = vorbisContainer(join(vorbisSetup().packet, tail));
      expect(verify(bytes, [1]), 'MEDIA_VORBIS_SETUP_TAIL').toMatchObject({
        byteLength: bytes.length,
      });
      // The high bits of the byte containing the flag also are outside setup decode.
      const padded = vorbisSetup().packet.slice();
      padded[padded.length - 1] = (padded.at(-1) ?? 0) | 0xf0;
      expect(verify(vorbisContainer(padded)), 'MEDIA_VORBIS_SETUP_TAIL').toBeDefined();
    },
  );
  it('refuses every byte-truncated setup even when a complete next audio packet follows', () => {
    const packet = vorbisSetup().packet;
    for (let end = 0; end < packet.length; end++)
      refused(packet.subarray(0, end), 1, 'MEDIA_VORBIS_SETUP_TRUNCATION');
    refused(textBytes('\x05vorbis\x01'), 1, 'MEDIA_VORBIS_SETUP_TRUNCATION');
    const exactByte = vorbisSetup({ modes: 5 });
    expect(vorbisField(exactByte, 'framing').bit % 8).toBe(7);
    refused(changeVorbisField(exactByte, 'framing', 0), 1, 'MEDIA_VORBIS_SETUP_FRAMING');
  });
});

const validGrammars: readonly (readonly [string, VorbisSetupFixtureOptions])[] = [
  ['ordered zero run', { books: [{ entries: 4, orderedRuns: [0, 4] }] }],
  [
    'sparse singleton',
    { books: [{ entries: 3, sparse: true, lengths: [undefined, 1, undefined] }] },
  ],
  ['unused empty book', { books: [{}, { entries: 0, dimensions: 0 }] }],
  [
    'unused zero-dimension lookup1',
    { books: [{}, { dimensions: 0, lookup: 1, multiplicands: 0 }] },
  ],
  ['unused zero-entry lookup1', { books: [{}, { entries: 0, lookup: 1, multiplicands: 0 }] }],
  ['unused zero-entry ordered book', { books: [{}, { entries: 0, orderedRuns: [] }] }],
  ['unused zero-dimension lookup2', { books: [{}, { dimensions: 0, lookup: 2 }] }],
  [
    'lookup1 below exact cube',
    {
      books: [
        { entries: 7, dimensions: 3, lengths: [2, 3, 3, 3, 3, 3, 3], lookup: 1, multiplicands: 1 },
      ],
    },
  ],
  [
    'lookup1 exact cube',
    { books: [{ entries: 8, dimensions: 3, orderedRuns: [0, 0, 8], lookup: 1, multiplicands: 2 }] },
  ],
  [
    'lookup1 above exact cube',
    {
      books: [
        {
          entries: 9,
          dimensions: 3,
          lengths: [3, 3, 3, 3, 3, 3, 3, 4, 4],
          lookup: 1,
          multiplicands: 2,
        },
      ],
    },
  ],
  [
    'lookup1 maximum dimension',
    { books: [{}, { dimensions: 65535, lookup: 1, multiplicands: 1 }] },
  ],
  ['lookup2 payload', { books: [{ lookup: 2, dimensions: 3, valueBits: 16 }] }],
  ['floor0', { books: [{ lookup: 1 }], floors: [{ type: 0 }] }],
  [
    'floor1 subclasses and sentinel',
    {
      floors: [
        {
          partitions: [0],
          classes: [{ dimension: 2, subclasses: 1, subclassBooks: [0, 1] }],
          rangeBits: 3,
          positions: [1, 3],
        },
      ],
    },
  ],
  [
    'floor1 exactly 65 distinct X values',
    {
      floors: [
        {
          partitions: [0, 0, 0, 0, 0, 0, 0, 1],
          classes: [{ dimension: 8 }, { dimension: 7 }],
          rangeBits: 6,
        },
      ],
    },
  ],
  ['residue type1', { residues: [{ type: 1 }] }],
  ['residue type2', { residues: [{ type: 2 }] }],
  [
    'classification power equals phrasebook entries',
    {
      books: [{ entries: 8, dimensions: 3, orderedRuns: [0, 0, 8] }],
      residues: [{ classifications: 2 }],
    },
  ],
  [
    'oversized phrasebook remains compatible',
    {
      books: [{ entries: 9, dimensions: 3, lengths: [3, 3, 3, 3, 3, 3, 3, 4, 4] }],
      residues: [{ classifications: 2 }],
    },
  ],
  [
    'zero-dimensional mapped pass book follows Xiph header policy',
    { books: [{}, { dimensions: 0, lookup: 2 }], residues: [{ cascades: [1], books: [1] }] },
  ],
  [
    'all cascade levels and multiple classifications',
    {
      books: [{ entries: 2, lengths: [1, 1] }, { lookup: 1 }],
      residues: [{ classifications: 2, cascades: [0x89, 2], books: [1, 1, 1, 1] }],
    },
  ],
  [
    'coupling, mux, submaps and ignored time bytes',
    {
      channels: 3,
      mappings: [
        {
          submaps: 2,
          coupling: [
            [0, 2],
            [1, 2],
          ],
          mux: [0, 1, 0],
          times: [255, 1],
        },
      ],
    },
  ],
  ['maximum 64 modes', { modes: 64 }],
];
describe('Vorbis setup grammar and references', () => {
  it.each(validGrammars)('admits %s through independently checksummed pages', (_name, options) => {
    const bytes = vorbisContainer(vorbisSetup(options).packet, { channels: options.channels ?? 1 });
    expect(verify(bytes, [1]), 'MEDIA_VORBIS_SETUP_VARIANTS').toMatchObject({
      mimeType: 'audio/ogg',
      byteLength: bytes.length,
    });
  });
  it.each([
    ['book.0.sync', 0],
    ['book.0.lookup', 3],
    ['time.0', 1],
    ['floor.0.type', 2],
    ['residue.0.type', 3],
    ['residue.0.classbook', 1],
    ['mapping.0.type', 1],
    ['mapping.0.reserved', 1],
    ['mapping.0.floor.0', 1],
    ['mapping.0.residue.0', 1],
    ['mode.0.window', 1],
    ['mode.0.transform', 1],
    ['mode.0.mapping', 1],
  ] satisfies [string, number][])('refuses malformed field %s', (field, value) => {
    refused(changeVorbisField(vorbisSetup(), field, value));
  });
  it.each([
    ['ordered run exceeds entries', { books: [{ entries: 2, orderedRuns: [3] }] }],
    [
      'ordered length exceeds 32',
      { books: [{ orderedRuns: [...new Array<number>(32).fill(0), 1] }] },
    ],
    ['floor0 order zero', { books: [{ lookup: 1 }], floors: [{ type: 0, order: 0 }] }],
    ['floor0 rate zero', { books: [{ lookup: 1 }], floors: [{ type: 0, rate: 0 }] }],
    ['floor0 bark size zero', { books: [{ lookup: 1 }], floors: [{ type: 0, barkSize: 0 }] }],
    ['floor0 book reference', { books: [{ lookup: 1 }], floors: [{ type: 0, books: [1] }] }],
    ['floor0 unmapped book', { floors: [{ type: 0 }] }],
    [
      'floor0 zero-dimension book',
      { books: [{ dimensions: 0, lookup: 2 }], floors: [{ type: 0 }] },
    ],
    [
      'floor1 masterbook reference',
      { floors: [{ partitions: [0], classes: [{ subclasses: 1, masterbook: 1 }], rangeBits: 2 }] },
    ],
    [
      'floor1 subclass reference',
      { floors: [{ partitions: [0], classes: [{ subclassBooks: [2] }], rangeBits: 2 }] },
    ],
    [
      'floor1 duplicate implicit X',
      { floors: [{ partitions: [0], rangeBits: 2, positions: [0] }] },
    ],
    [
      'floor1 duplicate explicit X',
      {
        floors: [{ partitions: [0], classes: [{ dimension: 2 }], rangeBits: 2, positions: [1, 1] }],
      },
    ],
    [
      'floor1 zero-bit duplicate X',
      { floors: [{ partitions: [0], rangeBits: 0, positions: [0] }] },
    ],
    [
      'floor1 66 X values',
      {
        floors: [
          { partitions: [0, 0, 0, 0, 0, 0, 0, 0], classes: [{ dimension: 8 }], rangeBits: 7 },
        ],
      },
    ],
    ['residue impossible classbook', { residues: [{ classifications: 2 }] }],
    [
      'classification power exceeds phrasebook entries',
      {
        books: [{ entries: 7, dimensions: 3, lengths: [2, 3, 3, 3, 3, 3, 3] }],
        residues: [{ classifications: 2 }],
      },
    ],
    ['residue zero-dimensional classbook', { books: [{ dimensions: 0 }] }],
    ['residue book reference', { residues: [{ cascades: [1], books: [1] }] }],
    ['residue unmapped pass book', { residues: [{ cascades: [1], books: [0] }] }],
    ['mono coupling', { mappings: [{ coupling: [[0, 0]] }] }],
    ['equal coupling channels', { channels: 2, mappings: [{ coupling: [[1, 1]] }] }],
    ['out-of-range coupling channel', { channels: 3, mappings: [{ coupling: [[0, 3]] }] }],
    ['mux outside submaps', { channels: 2, mappings: [{ submaps: 2, mux: [0, 2] }] }],
  ] satisfies [string, VorbisSetupFixtureOptions][])(
    'refuses %s',
    (_name, options: VorbisSetupFixtureOptions) => {
      refused(vorbisSetup(options).packet, options.channels ?? 1);
    },
  );
  it('refuses oversized declared tables without allocating or iterating their extents', () => {
    // One compressed ordered run declares the maximum book, followed by a lookup
    // extent that cannot fit in 25MiB. The writer deliberately supplies no values.
    const impossible = vorbisSetup({
      books: [
        {
          entries: 0xffffff,
          dimensions: 65535,
          orderedRuns: [0xffffff],
          lookup: 2,
          valueBits: 16,
          multiplicands: 0,
        },
      ],
    });
    refused(impossible.packet, 1, 'MEDIA_VORBIS_SETUP_EXTENT_BOUND');
    const pages = vorbisPages(
        join(impossible.packet, new Uint8Array(300 - impossible.packet.length)),
      ),
      verifier = createMediaVerifier('audio/ogg');
    for (const page of pages.slice(0, 2)) verifier.push(page);
    const setupPage = pages[2];
    if (setupPage === undefined) throw new Error('Missing oversized-extent setup page');
    // Feed only the first full lace. The complete physical page, packet end and
    // finish() are deliberately absent, so EOF cannot mask loss of this guard.
    const firstLaceEnd = 27 + (setupPage[26] ?? 0) + 255;
    expect(
      () => verifier.push(setupPage.subarray(0, firstLaceEnd)),
      'MEDIA_VORBIS_SETUP_EXTENT_BOUND',
    ).toThrowError(new MediaAdmissionError('invalid_format'));
    // A tiny packet promising millions of sparse/dense entries fails at packet EOF.
    refused(
      changeVorbisField(vorbisSetup(), 'book.0.entries', 0xffffff),
      1,
      'MEDIA_VORBIS_SETUP_TRUNCATION',
    );
  });
  it('requires the entire lookup payload before reading later setup fields', () => {
    const fixture = vorbisSetup({ books: [{}, { lookup: 2, dimensions: 40000, valueBits: 16 }] }),
      values = vorbisField(fixture, 'book.1.multiplicands'),
      lastRequiredByte = Math.floor((values.bit + values.width - 1) / 8);
    refused(fixture.packet.subarray(0, lastRequiredByte), 1, 'MEDIA_VORBIS_SETUP_TRUNCATION');
  });
});

describe('Vorbis/Ogg transport and scratch ownership', () => {
  it.each([255, 65025])('admits an exact %i-byte setup with a zero terminating lace', (size) => {
    const packet = vorbisSetup().packet,
      setup = join(packet, new Uint8Array(size - packet.length).fill(255)),
      pages = vorbisPages(setup, { pageSegments: 1 });
    const terminating = pages.at(-2);
    expect(terminating?.subarray(26)).toEqual(new Uint8Array([1, 0]));
    expect(terminating?.[5]).toBe(1);
    expect(verify(join(...pages), [1, 255, 27]), 'MEDIA_VORBIS_SETUP_CONTINUATION').toBeDefined();
  });
  it('keeps partial fields across laces, pages and external one-byte chunks', () => {
    const packet = vorbisSetup({ modes: 64 }).packet;
    expect(packet.length).toBeGreaterThan(255);
    const bytes = join(...vorbisPages(packet, { pageSegments: 1 }));
    expect(verify(bytes, [1]), 'MEDIA_VORBIS_SETUP_CONTINUATION').toMatchObject({
      byteLength: bytes.length,
    });
  });
  it('skips a setup lookup larger than 64KiB using the one allocation authority', () => {
    const packet = vorbisSetup({
      books: [{}, { lookup: 2, dimensions: 40000, valueBits: 16 }],
    }).packet;
    expect(packet.length).toBeGreaterThan(65536);
    const bytes = vorbisContainer(packet),
      retained: Uint8Array[] = [],
      memory = new MediaInspectionMemory((buffer) => retained.push(buffer)),
      parser = new ParserReader(ogg(memory), memory);
    for (let at = 0; at < bytes.length; at += 997) parser.push(bytes.subarray(at, at + 997));
    expect(parser.finish()).toBe('audio/ogg');
    expect(
      retained.reduce((sum, buffer) => sum + buffer.byteLength, 0),
      'MEDIA_VORBIS_SETUP_SCRATCH',
    ).toBe(6352);
    expect(
      retained.reduce((sum, buffer) => sum + buffer.buffer.byteLength, 0),
      'MEDIA_VORBIS_SETUP_SCRATCH',
    ).toBeLessThanOrEqual(65536);
  });
  it('reuses the same tables at all format-defined top-level counts', () => {
    const packet = vorbisSetup({
      books: [{}, ...Array.from({ length: 255 }, () => ({ entries: 0, dimensions: 0 }))],
      times: new Array<number>(64).fill(0),
      floors: Array.from({ length: 64 }, () => ({})),
      residues: Array.from({ length: 64 }, () => ({})),
      mappings: Array.from({ length: 64 }, () => ({})),
      modes: 64,
    }).packet;
    const retained: Uint8Array[] = [],
      memory = new MediaInspectionMemory((buffer) => retained.push(buffer)),
      parser = new ParserReader(ogg(memory), memory);
    for (const page of vorbisPages(packet)) parser.push(page);
    expect(parser.finish()).toBe('audio/ogg');
    expect(
      retained.reduce((sum, buffer) => sum + buffer.byteLength, 0),
      'MEDIA_VORBIS_SETUP_SCRATCH',
    ).toBe(6352);
  });
  it('retains checksums, sequencing, continuation, EOS, comments and audio requirements', () => {
    const packet = join(vorbisSetup().packet, hex('00ff01')),
      pages = vorbisPages(packet),
      identification = pages[0],
      comments = pages[1],
      setup = pages[2],
      audio = pages[3];
    if (
      identification === undefined ||
      comments === undefined ||
      setup === undefined ||
      audio === undefined
    )
      throw new Error('Missing independent Vorbis page');
    const damagedTail = setup.slice();
    damagedTail[damagedTail.length - 1] = 3;
    for (const bytes of [
      join(identification, comments, damagedTail, audio),
      join(identification, comments, oggFixturePage(packet, [packet.length], 7, 0), audio),
      join(identification, comments, oggFixturePage(packet, [packet.length], 2, 1), audio),
      join(identification, comments, oggFixturePage(packet, [packet.length], 2, 4)),
      join(identification, comments, setup),
      join(identification, comments, setup, audio.subarray(0, -1)),
      join(identification, comments, setup, audio, hex('00')),
      join(identification, comments, setup, oggFixturePage(hex('01'), [1], 3, 4)),
      join(identification, comments, setup, oggFixturePage(hex(''), [0], 3, 4)),
    ])
      expect(() => verify(bytes), 'MEDIA_VORBIS_CONTAINER_GUARDS').toThrow(MediaAdmissionError);
    const invalidComments = join(textBytes('\x03vorbis'), new Uint8Array(8), hex('00'));
    expect(
      () =>
        verify(
          join(
            identification,
            oggFixturePage(invalidComments, [invalidComments.length], 1, 0),
            setup,
            audio,
          ),
        ),
      'MEDIA_VORBIS_COMMENT_FRAME',
    ).toThrow(MediaAdmissionError);
  });
  it('checks the actual continued setup tail through the final zero lace', () => {
    const packet = vorbisSetup().packet,
      pages = vorbisPages(join(packet, new Uint8Array(255 - packet.length)), { pageSegments: 1 }),
      continued = pages[3];
    if (continued === undefined) throw new Error('Missing zero-lace continuation page');
    const wrongFlags = oggFixturePage(new Uint8Array(), [0], 3, 0),
      changed = pages.map((page, index) => (index === 3 ? wrongFlags : page));
    expect(() => verify(join(...changed)), 'MEDIA_VORBIS_SETUP_CONTINUATION').toThrow(
      MediaAdmissionError,
    );
  });
  it('uses scalar Ogg CRC updates without changing the independently stored checksum', () => {
    const page = vorbisPages()[0];
    if (page === undefined) throw new Error('Missing Vorbis identification page');
    let crc = 0;
    for (let i = 0; i < page.length; i++)
      crc = oggCrcByte(crc, i >= 22 && i <= 25 ? 0 : (page[i] ?? 0));
    expect(crc, 'MEDIA_OGG_HEADER_CRC').toBe(
      new DataView(page.buffer, page.byteOffset, page.byteLength).getUint32(22, true),
    );
    const withoutChecksum = page.slice();
    withoutChecksum.fill(0, 22, 26);
    expect(oggCrc(0, withoutChecksum)).toBe(crc);
  });
});
