import { describe, expect, it } from 'vitest';
import { MediaAdmissionError } from './media-admission.js';
import { MediaInspectionMemory } from './media-inspection-memory.js';
import {
  malformedOpusComments,
  oggFixturePage,
  opusPages,
  opusTags,
  paddedOpus,
} from './media-opus-vectors.js';
import { hex, join, textBytes, uint32, VORBIS } from './media-test-vectors.js';
import { createMediaVerifier } from './media-verifier.js';
import { ogg } from './media-verifier-ogg.js';
import { ParserReader } from './media-verifier-reader.js';

function verify(parts: readonly Uint8Array[], mime = 'audio/opus'): unknown {
  try {
    const verifier = createMediaVerifier(mime);
    for (const part of parts) verifier.push(part);
    return { status: 'fulfilled', value: verifier.finish() };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}
function fragments(bytes: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const parts: Uint8Array[] = [new Uint8Array()];
  for (let at = 0, index = 0; at < bytes.length; index++) {
    const size = sizes[index % sizes.length] ?? 1;
    parts.push(bytes.subarray(at, at + size), new Uint8Array());
    at += size;
  }
  return parts;
}
const positives: readonly (readonly [string, Uint8Array])[] = [
  ['no tail', paddedOpus(new Uint8Array())],
  ['one zero', paddedOpus(new Uint8Array(1))],
  ['512 zeros', paddedOpus()],
  ...[0x00, 0x01, 0x02, 0x80, 0xff].map((first): [string, Uint8Array] => [
    `binary first ${first}`,
    paddedOpus(new Uint8Array([first, 255, 0, 128, 3])),
  ]),
  ['exact 255 packet', join(...opusPages(opusTags(new Uint8Array(239), new Uint8Array(), [])))],
];
describe('RFC 7845 OpusTags tails', () => {
  it.each(positives)(
    'MEDIA_OPUS_TAGS_TAIL: %s survives all small splits and boundary patterns',
    (_name, bytes) => {
      for (const mime of ['audio/opus', 'audio/ogg']) {
        const expected = {
          status: 'fulfilled',
          value: { mimeType: 'audio/opus', byteLength: bytes.length },
        };
        for (let split = 0; split <= bytes.length; split++)
          expect(
            verify([bytes.subarray(0, split), bytes.subarray(split)], mime),
            'MEDIA_OPUS_TAGS_TAIL',
          ).toMatchObject(expected);
        for (const sizes of [[1], [7, 8, 4, 27, 255, 1]])
          expect(verify(fragments(bytes, sizes), mime), 'MEDIA_OPUS_TAGS_TAIL').toMatchObject(
            expected,
          );
      }
    },
  );
  it.each([65025, 70000])(
    'MEDIA_OPUS_TAGS_CONTINUATION: %i-byte packet uses bounded inspection across pages',
    (size) => {
      const tags = opusTags(new Uint8Array(size - 16).fill(255), new Uint8Array(), []);
      const pages = opusPages(tags);
      expect(pages).toHaveLength(4);
      // At exactly 255 full laces, a continued page containing the zero terminator is required.
      if (size === 65025) expect(pages[2]?.subarray(26)).toEqual(new Uint8Array([1, 0]));
      const bytes = join(...pages);
      expect(
        verify(fragments(bytes, [1, 997, 255, 4096])),
        'MEDIA_OPUS_TAGS_CONTINUATION',
      ).toMatchObject({ status: 'fulfilled', value: { byteLength: bytes.length } });
      const retained: Uint8Array[] = [];
      const memory = new MediaInspectionMemory((buffer) => retained.push(buffer));
      const parser = new ParserReader(ogg(memory), memory);
      for (const part of fragments(bytes, [997])) parser.push(part);
      expect(parser.finish()).toBe('audio/opus');
      expect(
        retained.reduce((sum, buffer) => sum + buffer.buffer.byteLength, 0),
        'MEDIA_OPUS_TAGS_SCRATCH',
      ).toBeLessThanOrEqual(65536);
    },
  );
});

const malformedTags: readonly (readonly [string, Uint8Array])[] = [
  ['vendor length missing', textBytes('OpusTags')],
  ['vendor length truncated', join(textBytes('OpusTags'), hex('000000'))],
  ['vendor exceeds packet', join(textBytes('OpusTags'), uint32(100, true), hex('0000000000'))],
  ['comment count missing', join(textBytes('OpusTags'), uint32(0, true))],
  ['comment count truncated', join(textBytes('OpusTags'), uint32(0, true), hex('000000'))],
  [
    'comment exceeds packet',
    join(textBytes('OpusTags'), uint32(0, true), uint32(1, true), uint32(20, true), hex('00ff01')),
  ],
  ['missing comment length', join(textBytes('OpusTags'), uint32(0, true), uint32(1, true))],
  ['comment count ceiling', join(textBytes('OpusTags'), uint32(0, true), uint32(65537, true))],
  ['wrong signature', join(textBytes('FakeTags'), opusTags(hex('ff')).subarray(8))],
];
it.each(malformedTags)('Opus required framing still refuses: %s', (_name, tags) => {
  const bytes = join(...opusPages(tags));
  for (let split = 0; split <= bytes.length; split++) {
    const result = verify([bytes.subarray(0, split), bytes.subarray(split)]);
    expect(result, 'MEDIA_OPUS_REQUIRED_FRAMING').toMatchObject({
      status: 'rejected',
      reason: { code: _name === 'comment count ceiling' ? 'inspection_limit' : 'invalid_format' },
    });
  }
});
it('Opus padding retains CRC, sequence, continuation, EOS, truncation and trailing-byte refusal', () => {
  const pages = opusPages(opusTags(hex('00ff01')));
  const head = pages[0],
    tags = pages[1],
    audio = pages[2];
  if (head === undefined || tags === undefined || audio === undefined)
    throw new Error('Missing independent fixture page');
  const badCrc = tags.slice();
  badCrc[badCrc.length - 1] = 9;
  const tagsBody = opusTags(hex('00ff01'));
  for (const bytes of [
    malformedOpusComments(),
    join(head, badCrc, audio),
    join(head, oggFixturePage(tagsBody, [tagsBody.length], 7, 0), audio),
    join(head, oggFixturePage(tagsBody, [tagsBody.length], 1, 1), audio),
    join(head, oggFixturePage(tagsBody, [tagsBody.length], 1, 4)),
    join(head, tags),
    join(head, tags.subarray(0, -1)),
    join(head, tags, audio.subarray(0, -1)),
    join(head, tags, audio, hex('00')),
  ]) {
    for (const sizes of [[1], [27, 255, 8]])
      expect(verify(fragments(bytes, sizes)), 'MEDIA_OPUS_CONTAINER_GUARDS').toMatchObject({
        status: 'rejected',
        reason: { code: 'invalid_format' },
      });
  }
});
it.each([hex(''), hex('00'), hex('0100')])(
  'Vorbis comment framing remains exactly one byte: %j',
  (framing) => {
    const identification = hex('01766f72626973000000000144ac0000000000000000000000000000b801');
    const comments = join(textBytes('\x03vorbis'), new Uint8Array(8), framing);
    const bytes = join(
      oggFixturePage(identification, [identification.length], 0, 2),
      oggFixturePage(comments, [comments.length], 1, 0),
      oggFixturePage(textBytes('\x05vorbis\x01'), [8], 2, 0),
      oggFixturePage(hex('00'), [1], 3, 4),
    );
    expect(verify(fragments(bytes, [1]), 'audio/ogg'), 'MEDIA_VORBIS_COMMENT_FRAME').toMatchObject({
      status: 'rejected',
      reason: { code: 'invalid_format' },
    });
    expect(verify([VORBIS], 'audio/ogg')).toMatchObject({ status: 'fulfilled' });
    expect(verify([VORBIS])).toMatchObject({
      status: 'rejected',
      reason: new MediaAdmissionError('invalid_format'),
    });
  },
);
