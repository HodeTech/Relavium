/** Independently assembled contradictory identity declarations, outside the production parser. */
import { box, ebml, hex, join, mp4Video, textBytes } from './media-test-vectors.js';

interface IdentityVector {
  readonly name: string;
  readonly mimeType: 'video/webm' | 'video/mp4';
  readonly bytes: Uint8Array;
}

function track(fields: readonly Uint8Array[]): Uint8Array {
  return ebml('ae', join(...fields));
}
const dimensions = (): Uint8Array => ebml('e0', join(ebml('b0', hex('01')), ebml('ba', hex('01'))));
function webm(
  fields: readonly Uint8Array[],
  options: { readonly headers?: readonly Uint8Array[]; readonly emptyTracksFirst?: boolean } = {},
): Uint8Array {
  const tracks = ebml('1654ae6b', track(fields));
  return join(
    ebml('1a45dfa3', join(...(options.headers ?? [ebml('4282', textBytes('webm'))]))),
    ebml(
      '18538067',
      join(
        ebml('1f43b675', ebml('a3', hex('8100008000'))),
        ...(options.emptyTracksFirst === undefined
          ? [tracks]
          : options.emptyTracksFirst
            ? [ebml('1654ae6b', new Uint8Array()), tracks]
            : [tracks, ebml('1654ae6b', new Uint8Array())]),
      ),
    ),
  );
}
const normalFields = (): Uint8Array[] => [
  ebml('d7', hex('01')),
  ebml('83', hex('01')),
  ebml('86', textBytes('V_VP8')),
  dimensions(),
];
const codecVectors: readonly (readonly [string, readonly string[]])[] = [
  ['unknown then supported codec', ['V_BAD', 'V_VP8']],
  ['supported then unknown codec', ['V_VP8', 'V_BAD']],
  ['two supported codecs', ['V_VP9', 'V_VP8']],
  ['two supported codecs reversed', ['V_VP8', 'V_VP9']],
  ['identical codec repeated', ['V_VP8', 'V_VP8']],
];

/** Rewrite fixture boxes while recomputing ancestor sizes; no production verifier is consulted. */
function rewriteMp4(
  bytes: Uint8Array,
  replace: (name: string, payload: Uint8Array) => readonly Uint8Array[] | undefined,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const payload = bytes.subarray(offset + 8, offset + size);
    const replacement = replace(name, payload);
    if (replacement !== undefined) parts.push(...replacement);
    else if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(name))
      parts.push(box(name, rewriteMp4(payload, replace)));
    else parts.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return join(...parts);
}

export const ambiguousVideoIdentities: readonly IdentityVector[] = [
  ...codecVectors.map(([name, codecs]) => ({
    name: `WebM ${name}`,
    mimeType: 'video/webm' as const,
    bytes: webm([
      ebml('d7', hex('01')),
      ebml('83', hex('01')),
      ...codecs.map((codec) => ebml('86', textBytes(codec))),
      dimensions(),
    ]),
  })),
  ...[0x83, 0xd7].flatMap((id) =>
    [hex('0201'), hex('0102'), hex('0101')].map((values) => ({
      name: `WebM repeated ${id === 0x83 ? 'track type' : 'track number'} ${values.join('-')}`,
      mimeType: 'video/webm' as const,
      bytes: webm([
        ...(id === 0xd7 ? [] : [ebml('d7', hex('01'))]),
        ...(id === 0x83 ? [] : [ebml('83', hex('01'))]),
        ...Array.from(values).map((value) => ebml(id.toString(16), new Uint8Array([value]))),
        ebml('86', textBytes('V_VP8')),
        dimensions(),
      ]),
    })),
  ),
  ...['b0', 'ba'].map((id) => ({
    name: `WebM repeated ${id === 'b0' ? 'width' : 'height'}`,
    mimeType: 'video/webm' as const,
    bytes: webm([
      ...normalFields().slice(0, 3),
      ebml('e0', join(ebml('b0', hex('01')), ebml('ba', hex('01')), ebml(id, hex('02')))),
    ]),
  })),
  {
    name: 'WebM repeated Video container',
    mimeType: 'video/webm',
    bytes: webm([...normalFields(), dimensions()]),
  },
  {
    name: 'WebM repeated document identity',
    mimeType: 'video/webm',
    bytes: webm(normalFields(), {
      headers: [ebml('4282', textBytes('webm')), ebml('4282', textBytes('webm'))],
    }),
  },
  ...[true, false].map((emptyTracksFirst) => ({
    name: `WebM repeated Tracks container ${emptyTracksFirst ? 'before' : 'after'}`,
    mimeType: 'video/webm' as const,
    bytes: webm(normalFields(), { emptyTracksFirst }),
  })),
  ...[
    ['soun', 'vide'],
    ['vide', 'soun'],
    ['vide', 'vide'],
  ].map((handlers) => ({
    name: `MP4 repeated handler ${handlers.join('-')}`,
    mimeType: 'video/mp4' as const,
    bytes: rewriteMp4(mp4Video(), (name, payload) =>
      name === 'hdlr'
        ? handlers.map((handler) => {
            const copy = payload.slice();
            copy.set(textBytes(handler), 8);
            return box(name, copy);
          })
        : undefined,
    ),
  })),
  ...['tkhd', 'mdhd', 'mdia', 'minf', 'stbl', 'stsd'].map((duplicate) => ({
    name: `MP4 repeated ${duplicate}`,
    mimeType: 'video/mp4' as const,
    bytes: rewriteMp4(mp4Video(), (name, payload) =>
      name === duplicate ? [box(name, payload), box(name, payload)] : undefined,
    ),
  })),
  ...[true, false].map((unknownFirst) => ({
    name: `MP4 undeclared extra sample entry ${unknownFirst ? 'before' : 'after'}`,
    mimeType: 'video/mp4' as const,
    bytes: rewriteMp4(mp4Video(), (name, payload) => {
      if (name !== 'stsd') return undefined;
      const sample = payload.subarray(8),
        unknown = box('junk', hex('00'));
      return [
        box(
          name,
          payload.subarray(0, 8),
          ...(unknownFirst ? [unknown, sample] : [sample, unknown]),
        ),
      ];
    }),
  })),
];
