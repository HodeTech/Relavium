/**
 * The exact arithmetic of `prompt-window.ts` (MVP-11 unit 7, round 2): `wrappedRowCount` (the width a column count that is not a number falls
 * back to, the floor of one column, the lead, the cursor's cell, a blank line is a row) and the window's fit check (a draft whose word-wrapped
 * rows are exactly the height is drawn whole).
 */
import { describe, expect, it } from 'vitest';

import { promptWindow, wrappedRowCount } from './prompt-window.js';

const same = (text: string): string => text;
const BEL = String.fromCharCode(7);

describe('wrappedRowCount', () => {
  it('a column count that is not a number is 80: a word of 80 columns is one row, 81 is two', () => {
    for (const columns of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(wrappedRowCount('x'.repeat(80), -1, 0, columns, same)).toBe(1);
      expect(wrappedRowCount('x'.repeat(81), -1, 0, columns, same)).toBe(2);
    }
  });
  it('a column count below one is one column, and a fraction is floored', () => {
    expect(wrappedRowCount('abc', -1, 0, 1, same)).toBe(3);
    expect(wrappedRowCount('abc', -1, 0, 0, same)).toBe(3);
    expect(wrappedRowCount('abc', -1, 0, -7, same)).toBe(3);
    expect(wrappedRowCount('abc', -1, 0, 1.9, same)).toBe(3);
    expect(wrappedRowCount('abcd', -1, 0, 2.9, same)).toBe(2);
  });
  it('the lead takes its columns off every logical line: whole columns, never fewer than none', () => {
    // 'a'*8 behind a lead of 2 is 10 columns: one row at 10, two at 9
    expect(wrappedRowCount('a'.repeat(8), -1, 2, 10, same)).toBe(1);
    expect(wrappedRowCount('a'.repeat(8), -1, 2, 9, same)).toBe(2);
    expect(wrappedRowCount('a'.repeat(8), -1, 2.9, 10, same)).toBe(1);
    expect(wrappedRowCount('a'.repeat(8), -1, 2.9, 9, same)).toBe(2);
    expect(wrappedRowCount('a'.repeat(10), -1, 0, 10, same)).toBe(1);
    expect(wrappedRowCount('a'.repeat(10), -1, -4, 10, same)).toBe(1);
    expect(wrappedRowCount('a'.repeat(10), -1, 0.5, 10, same)).toBe(1);
  });
  it('a blank line is a row of its own', () => {
    expect(wrappedRowCount('', -1, 0, 10, same)).toBe(1);
    expect(wrappedRowCount('\n\n', -1, 0, 10, same)).toBe(3);
    expect(wrappedRowCount('a\n\nb', -1, 2, 10, same)).toBe(3);
  });
  it('the cursor’s cell is a column of its own, a space when the scrub blanks the character under it', () => {
    const scrub = (text: string): string => text.replaceAll(BEL, '');
    // nine letters, then the cursor on a BEL (scrubbed to nothing, drawn as a space): ten columns
    const text = `${'a'.repeat(9)}${BEL}`;
    expect(wrappedRowCount(text, 9, 0, 10, scrub)).toBe(1);
    expect(wrappedRowCount(text, 9, 0, 9, scrub)).toBe(2);
    // with no cursor the BEL is gone: nine columns
    expect(wrappedRowCount(text, -1, 0, 9, scrub)).toBe(1);
  });
});

describe('promptWindow: a draft that fits as Ink draws it is drawn whole', () => {
  const lines = (count: number, width: number): string =>
    Array.from({ length: count }, () => 'a'.repeat(width)).join('\n');
  it('three rows of exactly the room in a window of three rows: no window', () => {
    // 3 logical lines of 18 columns behind a lead of 2: each is exactly the 20 columns of the row
    expect(promptWindow(lines(3, 18), -1, 18, 3, same, 2)).toBeUndefined();
  });
  it('one row more than the height is a window', () => {
    expect(promptWindow(lines(4, 18), -1, 18, 3, same, 2)).toBeDefined();
  });
  it('a line a column wider than the room wraps, and three such lines in three rows do not fit', () => {
    expect(promptWindow(lines(3, 19), -1, 18, 3, same, 2)).toBeDefined();
  });
});
