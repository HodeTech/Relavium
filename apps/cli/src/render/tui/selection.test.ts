import { describe, expect, it } from 'vitest';

import {
  isCollapsed,
  lineSpan,
  normalizeSelection,
  selectionText,
  type SelectionRange,
} from './selection.js';
import { sliceDisplayColumns } from './viewport.js';

/**
 * The pure selection state machine (2.6.F Step 6). Columns are DISPLAY CELLS, not character indices — the terminal
 * reports the cell a click landed on, and a CJK glyph or emoji occupies two of them. Getting that wrong silently
 * copies the wrong text, which is worse than copying nothing.
 */

const cell = (line: number, column: number): { line: number; column: number } => ({ line, column });
const range = (a: [number, number], b: [number, number]): SelectionRange =>
  normalizeSelection({ anchor: cell(...a), focus: cell(...b) });

describe('normalizeSelection + isCollapsed', () => {
  it('a plain CLICK is collapsed — it selects nothing and copies nothing (but still clears a prior selection)', () => {
    expect(isCollapsed({ anchor: cell(3, 5), focus: cell(3, 5) })).toBe(true);
    expect(isCollapsed({ anchor: cell(3, 5), focus: cell(3, 6) })).toBe(false);
  });

  it('puts a BACKWARD drag (up, or leftward on one line) into document order', () => {
    expect(normalizeSelection({ anchor: cell(5, 2), focus: cell(1, 9) })).toEqual({
      start: cell(1, 9),
      end: cell(5, 2),
    });
    expect(normalizeSelection({ anchor: cell(2, 9), focus: cell(2, 3) })).toEqual({
      start: cell(2, 3),
      end: cell(2, 9),
    });
  });

  it('leaves a forward drag alone', () => {
    expect(normalizeSelection({ anchor: cell(1, 0), focus: cell(4, 7) })).toEqual({
      start: cell(1, 0),
      end: cell(4, 7),
    });
  });
});

describe('lineSpan — what is highlighted on each row', () => {
  it('a line outside the selection has no span', () => {
    const r = range([2, 1], [4, 3]);
    expect(lineSpan(1, r)).toBeUndefined();
    expect(lineSpan(5, r)).toBeUndefined();
  });

  it('a single-line selection is [from, end+1) — the end cell is INCLUSIVE, as in every terminal', () => {
    expect(lineSpan(2, range([2, 3], [2, 6]))).toEqual({ from: 3, to: 7 });
  });

  it('the FIRST line runs to the end of the row (open-ended), the LAST from column 0', () => {
    const r = range([2, 4], [4, 2]);
    expect(lineSpan(2, r)).toEqual({ from: 4, to: undefined }); // to end of row
    expect(lineSpan(3, r)).toEqual({ from: 0, to: undefined }); // whole row
    expect(lineSpan(4, r)).toEqual({ from: 0, to: 3 });
  });
});

describe('sliceDisplayColumns — width-aware, the reason columns are cells', () => {
  it('slices ASCII like String.slice', () => {
    expect(sliceDisplayColumns('hello world', 0, 5)).toBe('hello');
    expect(sliceDisplayColumns('hello world', 6, 11)).toBe('world');
    expect(sliceDisplayColumns('hello', 3, 3)).toBe('');
  });

  it('takes the WHOLE wide character when either of its two cells is selected', () => {
    // 日 and 本 are 2 cells each: columns 0-1 and 2-3.
    expect(sliceDisplayColumns('日本語', 0, 1)).toBe('日'); // clicked its left half
    expect(sliceDisplayColumns('日本語', 1, 2)).toBe('日'); // clicked its right half
    expect(sliceDisplayColumns('日本語', 0, 4)).toBe('日本');
    expect(sliceDisplayColumns('日本語', 2, 6)).toBe('本語');
  });

  it('an emoji cluster (ZWJ / flag / keycap) is atomic — never split down the middle', () => {
    expect(sliceDisplayColumns('a👍b', 1, 2)).toBe('👍');
    expect(sliceDisplayColumns('a👍b', 0, 3)).toBe('a👍');
    expect(sliceDisplayColumns('👩‍👩‍👧b', 0, 1)).toBe('👩‍👩‍👧'); // one grapheme, 2 cells
  });

  it('a zero-width combining mark rides its base — it is never orphaned onto a base it does not modify', () => {
    const eAcute = 'é'; // e + COMBINING ACUTE
    expect(sliceDisplayColumns(`x${eAcute}y`, 1, 2)).toBe(eAcute); // the mark comes with its `e`
    expect(sliceDisplayColumns(`x${eAcute}y`, 0, 1)).toBe('x'); // …and never with the `x` before it
  });

  it('truncates past the end of the row rather than throwing (a drag beyond a short line)', () => {
    expect(sliceDisplayColumns('hi', 0, 999)).toBe('hi');
    expect(sliceDisplayColumns('hi', 5, 999)).toBe('');
  });
});

describe('selectionText — what lands on the clipboard', () => {
  const lines = ['first line', 'second line', 'third line', '日本語です'];

  it('a single-line selection copies exactly the highlighted cells', () => {
    expect(selectionText(lines, range([0, 0], [0, 4]))).toBe('first');
    expect(selectionText(lines, range([1, 7], [1, 10]))).toBe('line');
  });

  it('a multi-line selection copies first-partial, whole-middle, last-partial — `\\n`-joined', () => {
    expect(selectionText(lines, range([0, 6], [2, 4]))).toBe('line\nsecond line\nthird');
  });

  it('a backward drag copies the same text as the forward one', () => {
    expect(selectionText(lines, range([2, 4], [0, 6]))).toBe('line\nsecond line\nthird');
  });

  it('copies wide characters whole, by CELL', () => {
    expect(selectionText(lines, range([3, 0], [3, 3]))).toBe('日本'); // cells 0..3 ⇒ two glyphs
  });

  it('a selection that outruns the transcript copies what still exists (never throws)', () => {
    expect(selectionText(lines, range([2, 0], [9, 0]))).toBe('third line\n日本語です');
    expect(selectionText([], range([0, 0], [3, 3]))).toBe('');
  });

  it('a collapsed selection copies a single cell — the caller decides not to copy at all', () => {
    // `isCollapsed` is the guard; `selectionText` is total, so it must still behave on the degenerate range.
    expect(selectionText(lines, range([0, 0], [0, 0]))).toBe('f');
  });
});
