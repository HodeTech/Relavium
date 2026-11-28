/**
 * A person's row is cut into the stretches that are drawn differently (`userRowPieces`): the mouse selection's highlight and the rest. A selection
 * is a range of code units of the row's text, and a range that starts at the very first unit (a drag from the left edge of a row) cuts the row at
 * 0, not at 1: the first piece is the selection's own first stretch and nothing before it is split off (MVP-11 unit 7, round 1: the mutation
 * sweep's tr010, where the clamp's floor `Math.max(0, at)` loosened to `Math.max(1, at)` survived). Moved in unit 9: the marker left the row's text
 * for the margin (`TranscriptRow`), so the pieces carry no marker and the function takes none; every row now starts at the content's first unit.
 */
import { describe, expect, it } from 'vitest';

import { userRowPieces } from './transcript-row.js';

const WORDS = 'continued words';

describe('a selection that starts at the first unit of a row', () => {
  it('is the first piece, whole: the row is cut once, where the selection ends', () => {
    expect(userRowPieces(WORDS, { start: 0, end: 4 })).toEqual([
      { text: 'cont', selected: true },
      { text: 'inued words', selected: false },
    ]);
  });

  it('that covers the whole row is one piece, selected', () => {
    expect(userRowPieces(WORDS, { start: 0, end: WORDS.length })).toEqual([
      { text: WORDS, selected: true },
    ]);
  });

  it('that starts before the row (a negative start) is clamped to its first unit, not past it', () => {
    expect(userRowPieces(WORDS, { start: -7, end: 4 })).toEqual([
      { text: 'cont', selected: true },
      { text: 'inued words', selected: false },
    ]);
  });

  it('an empty one at the first unit cuts nothing', () => {
    expect(userRowPieces(WORDS, { start: 0, end: 0 })).toEqual([{ text: WORDS, selected: false }]);
  });

  it('a one-unit row selected from its start is one selected piece', () => {
    expect(userRowPieces('a', { start: 0, end: 1 })).toEqual([{ text: 'a', selected: true }]);
  });
});

describe('a selection that ends past the row', () => {
  it('is clamped to the row’s end: the last piece runs to it and nothing is empty', () => {
    expect(userRowPieces(WORDS, { start: 10, end: 999 })).toEqual([
      { text: 'continued ', selected: false },
      { text: 'words', selected: true },
    ]);
  });
});
