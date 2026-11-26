/**
 * A person's row is cut into the stretches that are drawn differently (`userRowPieces`): the host's marker and the mouse selection's highlight.
 * A selection is a range of code units of the row's text, and a range that starts at the very first unit (a drag from the left edge of a
 * CONTINUATION row, which has no marker to share the cut) cuts the row at 0, not at 1: the first piece is the selection's own first stretch and
 * nothing before it is split off (MVP-11 unit 7, round 1: the mutation sweep's tr010, where the clamp's floor `Math.max(0, at)` loosened to
 * `Math.max(1, at)` survived, because every existing selection test starts on a row whose marker is one unit long and cuts at 1 itself).
 */
import { describe, expect, it } from 'vitest';

import { userRowPieces } from './transcript-row.js';

const WORDS = 'continued words';

describe('a selection that starts at the first unit of a row with no marker', () => {
  it('is the first piece, whole: the row is cut once, where the selection ends', () => {
    expect(userRowPieces(WORDS, undefined, { start: 0, end: 4 })).toEqual([
      { text: 'cont', marker: false, selected: true },
      { text: 'inued words', marker: false, selected: false },
    ]);
  });

  it('that covers the whole row is one piece, selected', () => {
    expect(userRowPieces(WORDS, undefined, { start: 0, end: WORDS.length })).toEqual([
      { text: WORDS, marker: false, selected: true },
    ]);
  });

  it('that starts before the row (a negative start) is clamped to its first unit, not past it', () => {
    expect(userRowPieces(WORDS, undefined, { start: -7, end: 4 })).toEqual([
      { text: 'cont', marker: false, selected: true },
      { text: 'inued words', marker: false, selected: false },
    ]);
  });

  it('an empty one at the first unit cuts nothing', () => {
    expect(userRowPieces(WORDS, undefined, { start: 0, end: 0 })).toEqual([
      { text: WORDS, marker: false, selected: false },
    ]);
  });

  it('a one-unit row selected from its start is one selected piece', () => {
    expect(userRowPieces('a', undefined, { start: 0, end: 1 })).toEqual([
      { text: 'a', marker: false, selected: true },
    ]);
  });
});

describe('a selection that ends past the row', () => {
  it('is clamped to the row’s end: the last piece runs to it and nothing is empty', () => {
    expect(userRowPieces(WORDS, undefined, { start: 10, end: 999 })).toEqual([
      { text: 'continued ', marker: false, selected: false },
      { text: 'words', marker: false, selected: true },
    ]);
  });
});
