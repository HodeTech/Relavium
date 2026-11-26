import { describe, expect, expectTypeOf, it } from 'vitest';

import { GLYPHS, speakerMarker, type SpeakerMarker } from './glyphs.js';
import { markYourTurn } from './transcript-guard.js';
import type { DisplayLine } from './viewport.js';

/**
 * The scoped security sitting of unit 7, an improvement: a row's `marker` is the host's own speaker marker, and it is typed as the two forms the
 * host draws (`›` and `>`), not as any string, so a producer that put another text there would not compile. The literals the type and
 * `markYourTurn` write are the glyph table's: this pins them to it, so the table cannot drift from the type.
 */
describe('the speaker marker is one of the two forms of the glyph table', () => {
  it('is typed as exactly those two forms, which the table spells', () => {
    // a union of two literals, not a string: an arbitrary string is not a marker
    expectTypeOf<SpeakerMarker>().toExtend<string>();
    expectTypeOf<string>().not.toExtend<SpeakerMarker>();
    expectTypeOf(speakerMarker(false)).toEqualTypeOf<SpeakerMarker>();
    expectTypeOf<DisplayLine['marker']>().toEqualTypeOf<SpeakerMarker | undefined>();
  });

  it('is what the table says for the person’s turn, with colour on and off', () => {
    expect(speakerMarker(false)).toBe(GLYPHS.yourTurn.glyph);
    expect(speakerMarker(true)).toBe(GLYPHS.yourTurn.ascii);
    const row: DisplayLine = { text: '> hello', style: 'user' };
    expect(markYourTurn(row, false).marker).toBe(GLYPHS.yourTurn.glyph);
    expect(markYourTurn(row, true).marker).toBe(GLYPHS.yourTurn.ascii);
    expect(markYourTurn(row, false).text).toBe(`${GLYPHS.yourTurn.glyph} hello`);
    expect(markYourTurn(row, true).text).toBe('> hello');
  });

  it('marks no row that does not start with the text form’s mark', () => {
    const row: DisplayLine = { text: 'hello', style: 'user' };
    expect(markYourTurn(row, false)).toBe(row);
    expect(markYourTurn(row, false).marker).toBeUndefined();
  });
});
