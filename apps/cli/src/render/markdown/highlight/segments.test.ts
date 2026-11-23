import { describe, expect, it } from 'vitest';

import { HighlightBudgetError, Segments } from './segments.js';

function runs(
  source: string,
  build: (out: Segments) => void,
): readonly (readonly [string, string])[] {
  const out = new Segments(source, 100);
  build(out);
  return out.finish().map((segment) => [segment.token, segment.text] as const);
}

describe('Segments', () => {
  it('classes the text between the cursor and `end`, and merges neighbours with one class', () => {
    expect(
      runs('abcdef', (out) => {
        out.to(2, 'keyword');
        out.to(4, 'keyword');
        out.to(5, 'string');
      }),
    ).toEqual([
      ['keyword', 'abcd'],
      ['string', 'e'],
      ['text', 'f'],
    ]);
  });

  it('fills the gap before a marked run with plain text', () => {
    expect(runs('abcdef', (out) => out.mark(2, 4, 'number'))).toEqual([
      ['text', 'ab'],
      ['number', 'cd'],
      ['text', 'ef'],
    ]);
  });

  it('can neither move backwards nor past the end, so the runs always join to the source', () => {
    expect(
      runs('abc', (out) => {
        out.to(2, 'keyword');
        out.to(1, 'string'); // behind the cursor: nothing
        out.to(-5, 'string');
        out.to(999, 'number'); // clamped to the end
      }),
    ).toEqual([
      ['keyword', 'ab'],
      ['number', 'c'],
    ]);
  });

  it('charges a lookahead for the characters it reads, and charges nothing to ask again inside or past it', () => {
    const out = new Segments('abc-xyz', 100);
    expect(out.find('-', 0)).toBe(3);
    expect(out.work).toBe(4); // read 'abc-'
    expect(out.find('-', 1)).toBe(3); // inside the span of the last search: free
    expect(out.find('-', 3)).toBe(3);
    expect(out.work).toBe(4);
    expect(out.find('q', 4)).toBe(-1);
    expect(out.work).toBe(7); // read to the end, once
    expect(out.find('q', 5)).toBe(-1); // past a search that found nothing: free
    expect(out.work).toBe(7);
  });

  it('finds the end of a line, or of the text', () => {
    const out = new Segments('ab\ncd', 100);
    expect(out.lineEnd(0)).toBe(2);
    expect(out.lineEnd(3)).toBe(5);
  });

  it('ignores an end that is not a number, so no run can be repeated', () => {
    const out = new Segments('abcdef', 100);
    out.to(2, 'keyword');
    out.to(Number.NaN, 'string');
    out.to(4, 'number');
    expect(out.finish().map((run) => run.text)).toEqual(['ab', 'cd', 'ef']);
  });

  it('keeps the cursor inside the text', () => {
    const out = new Segments('abc', 100);
    out.to(999, 'number');
    expect(out.position).toBe(3);
  });

  it('returns one plain run for text nobody classed, and none for no text', () => {
    expect(runs('abc', () => undefined)).toEqual([['text', 'abc']]);
    expect(runs('', () => undefined)).toEqual([]);
  });

  it('turns a scanner that stops advancing into an error instead of a hang', () => {
    const out = new Segments('abc', 5);
    expect(() => {
      for (let step = 0; step < 100; step++) out.tick(); // bounded, so a missing budget fails here and does not hang
    }).toThrow(HighlightBudgetError);
    expect(out.work).toBe(6);
  });
});
