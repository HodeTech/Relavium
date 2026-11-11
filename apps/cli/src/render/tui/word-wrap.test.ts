import { describe, expect, it } from 'vitest';

import { displayWidth, expandTabs, wrapText, wrapWords } from './viewport.js';

describe('transcript word wrapping and display tabs (MVP-2a)', () => {
  it('keeps words together and retains source whitespace in the displayed rows', () => {
    const source = 'hello world and a verylongtoken';
    const rows = wrapWords(source, 8);
    expect(rows.slice(0, 2)).toEqual(['hello ', 'world ']);
    expect(rows.join('')).toBe(source);
    expect(rows.every((row) => displayWidth(row) <= 8)).toBe(true);
    expect(wrapWords('abc def gh', 7)[0]).toBe('abc def');
  });

  it('expands tabs from the actual display column, including wide and combining text', () => {
    expect(expandTabs('a\tb\t')).toBe(`a${' '.repeat(7)}b${' '.repeat(7)}`);
    expect(expandTabs('中\tx\nq\t')).toBe(`中${' '.repeat(6)}x\nq${' '.repeat(7)}`);
    expect(expandTabs('e\u0301\tx')).toBe(`e\u0301${' '.repeat(7)}x`);
    expect(expandTabs('\tx', 2)).toBe(`${' '.repeat(6)}x`);
  });

  it('keeps wide/combining/ZWJ clusters whole and makes selection row widths truthful', () => {
    const source = '中 👩‍💻 e\u0301 words';
    for (const cols of [2, 3, 8, 80]) {
      const rows = wrapWords(source, cols);
      expect(rows.join('')).toBe(source);
      expect(rows.every((row) => displayWidth(row) <= cols)).toBe(true);
      expect(rows.some((row) => row.includes('👩‍💻'))).toBe(true);
    }
  });

  it('uses a terminating display fallback for an impossible glyph and suspends invalid widths', () => {
    expect(wrapWords('中a', 1)).toEqual(['?', 'a']);
    for (const cols of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(wrapWords('text', cols)).toEqual([]);
    }
    expect(wrapText('a\n\nb', 8)).toEqual(['a', '', 'b']);
  });

  it('hard-wraps a long unbroken token without searching the accumulated prefix', () => {
    const source = 'x'.repeat(200_000);
    const rows = wrapWords(source, 80);
    expect(rows).toHaveLength(2500);
    expect(rows.join('')).toBe(source);
  });

  it('measures expanded tabs before wrapping, including on rows with Unicode', () => {
    for (const source of ['a\tb', '中\t👩‍💻\tx', '\t\t']) {
      const rows = wrapText(source, 8);
      expect(rows.join('')).toBe(expandTabs(source));
      expect(rows.every((row) => displayWidth(row) <= 8)).toBe(true);
    }
  });
});
