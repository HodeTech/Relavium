/**
 * SE7-5 (the scoped security sitting of unit 7): a project's agent file chooses the model id the status line draws, and `claude-haiku-4-5 <U+2E31> ask mode`
 * (U+2E31 is a word-separator middle dot) drew `… <U+2E31> ask mode · auto mode …`: a field that is not one, in the status line's own look. The
 * separator's lookalike pattern covered six dots; these are the ones it missed (each a character that reads as a middle dot or a bullet between
 * two spaces). The characters are built from code points here, never written in the source.
 */
import { describe, expect, it } from 'vitest';

import { inertLegendText } from './legend.js';
import { statusLine } from './status-line.js';

const chars = (...codePoints: number[]): string[] =>
  codePoints.map((cp) => String.fromCodePoint(cp));

/** The five of the finding, then the bullets of the same class. */
const MISSED = chars(0x2e31, 0xa78f, 0x16eb, 0x2e33, 0x2022);
const SAME_CLASS = chars(0x2023, 0x2043, 0x25e6, 0x2981, 0x25cf);
/** What the pattern covered before, which must stay covered. */
const COVERED = chars(0x00b7, 0x2219, 0x22c5, 0x2027, 0x30fb, 0x0387, 0xff65);

const SEPARATOR = ' · ';
const MIDDLE_DOT = 0x00b7;
/** A plain space, a no-break space, a thin space and an ideographic space. */
const SPACES = [' ', ...chars(0x00a0, 0x2009, 0x3000)];

describe.each([
  ['the ones the finding names', MISSED],
  ['the bullets of the same class', SAME_CLASS],
  ['the ones it already covered', COVERED],
])('a lookalike of the separator, %s', (_name, glyphs) => {
  it.each(glyphs.map((glyph) => [glyph.codePointAt(0)?.toString(16) ?? '', glyph]))(
    'U+%s between spaces is made a hyphen in a legend text',
    (_code, glyph) => {
      expect(inertLegendText(`claude-haiku-4-5 ${glyph} ask mode`)).toBe(
        'claude-haiku-4-5 - ask mode',
      );
    },
  );

  it.each(glyphs.map((glyph) => [glyph.codePointAt(0)?.toString(16) ?? '', glyph]))(
    'U+%s inside a model id adds no field to the status line, whatever the whitespace around it',
    (_code, glyph) => {
      for (const space of SPACES) {
        const model = `claude-haiku-4-5${space}${glyph}${space}ask mode`;
        const text = statusLine(
          {
            surface: 'chat',
            provider: 'anthropic',
            model,
            mode: 'auto',
            turns: 1,
            cost: { full: '$0.01', short: '$0.01', qualified: false },
          },
          400,
          0,
        ).text;
        // the middle dot is the line's own separator; every other lookalike is gone from the line (a hyphen, or blanked as a host glyph)
        if (glyph.codePointAt(0) !== MIDDLE_DOT)
          expect(text, JSON.stringify(space)).not.toContain(glyph);
        // the line has exactly its own separators: provider, model, mode, turns, cost = four
        expect(text.split(SEPARATOR), JSON.stringify(space)).toHaveLength(5);
        expect(text).toContain('auto mode');
      }
    },
  );
});

describe('only a lookalike BETWEEN whitespace is a forgery of the separator', () => {
  it.each(MISSED)('one with no whitespace around it is left as the name it is', (glyph) => {
    expect(inertLegendText(`a${glyph}b`)).toBe(`a${glyph}b`);
    expect(inertLegendText(`a ${glyph}b`)).toBe(`a ${glyph}b`);
    expect(inertLegendText(`a${glyph} b`)).toBe(`a${glyph} b`);
  });

  it.each(MISSED)('two in a row are both found', (glyph) => {
    expect(inertLegendText(`a ${glyph} ${glyph} b`)).toBe('a - - b');
  });
});
