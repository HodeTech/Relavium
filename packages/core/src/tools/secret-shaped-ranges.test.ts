import { describe, expect, it } from 'vitest';

import { redactSecretShapedText, secretShapedRanges } from './bounding.js';

/**
 * `secretShapedRanges` locates, in the ORIGINAL text, what `redactSecretShapedText` masks, for a surface (the command card)
 * that shows the text itself and has to hide the same spans. Its contract is checked against the projection it describes.
 */
const SECRET = 'S3cr3tValue9Zq';
const KEYS = [
  'token',
  'password',
  'api_key',
  'PGPASSWORD',
  'client_secret',
  'secret',
  'access_key',
];

/** The text with each range replaced by the projection's mask. */
function replaced(text: string, ranges: readonly { start: number; end: number }[]): string {
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    out += text.slice(cursor, range.start) + '[redacted]';
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

const corpus: readonly string[] = [
  ...KEYS.flatMap((key) => [
    `${key}='${SECRET}'`,
    `${key}="${SECRET}"`,
    `${key}=${SECRET}`,
    `--${key}='${SECRET}'`,
    `--${key}=${SECRET}`,
    `{'${key}': '${SECRET}'}`,
    `{"${key}": "${SECRET}"}`,
    `${key}: '${SECRET}'`,
    `go ${key}=${SECRET} and then ${key}: ${SECRET}x tail`,
  ]),
  'secret=hunter2',
  'password=S3cr3tValue9Zq',
  '--api_key=abcd1234efgh5678ijkl',
  `Authorization: Bearer ${SECRET}${SECRET}`,
  `Authorization:   Bearer    ${SECRET}${SECRET} tail`,
  `postgres://user:${SECRET}@db.example/app`,
  `use sk-abcdefghijklmnop1234567890 then AKIAABCDEFGHIJKLMNOP ok`,
  `https://api.example/v1?sig=abcdefghijklmnopqrstuvwxyz&x=1`,
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz',
  'nothing secret here at all',
  'token=sk-abcdefghijklmnop1234567890 tail',
  `password=postgres://user:${SECRET}@db.example/app tail`,
  'secret=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz tail',
  'keep AKIAABCDEFGHIJKLMNOPAKIAABCDEFGHIJKLMNOP tail',
  'api-k\tey: abcd1234efgh5678ijkl',
  '',
];

describe('secretShapedRanges', () => {
  it('finds no range in a text the projection leaves alone, and none in an empty one', () => {
    for (const text of ['', 'git log --oneline -n 5', 'a b c', 'password', 'x='.repeat(40)]) {
      expect(redactSecretShapedText(text), text).toBe(text);
      expect(secretShapedRanges(text), text).toEqual([]);
    }
  });

  it('agrees with the projection on a corpus: the ranges replaced are its output, or the whole text is one range', () => {
    let exact = 0;
    let fallbacks = 0;
    for (const text of corpus) {
      const ranges = secretShapedRanges(text);
      const projected = redactSecretShapedText(text);
      // The scheme credential's own separating space is kept out of its range, so compare with the spaces collapsed.
      const same = replaced(text, ranges).replace(/\s+/g, ' ') === projected.replace(/\s+/g, ' ');
      if (same) {
        if (ranges.length > 0) exact += 1;
        continue;
      }
      // Where the ranges cannot reproduce the projection the whole text is masked: it may over-mask, never under-mask.
      fallbacks += 1;
      expect(ranges, text).toEqual([{ start: 0, end: text.length }]);
    }
    expect(exact, 'the corpus exercised the exact ranges').toBeGreaterThan(55);
    expect(fallbacks, 'and the fallback').toBeGreaterThan(0);
  });

  it('hides every secret of the corpus: no secret text is left outside the ranges', () => {
    for (const text of corpus) {
      const remaining = replaced(text, secretShapedRanges(text));
      expect(remaining, text).not.toContain(SECRET);
      expect(remaining, text).not.toContain('hunter2');
    }
  });

  it('returns sorted, in-bounds, non-empty and non-overlapping ranges', () => {
    for (const text of corpus) {
      const ranges = secretShapedRanges(text);
      let previousEnd = 0;
      for (const range of ranges) {
        expect(range.start, text).toBeGreaterThanOrEqual(previousEnd);
        expect(range.end, text).toBeGreaterThan(range.start);
        expect(range.end, text).toBeLessThanOrEqual(text.length);
        previousEnd = range.end;
      }
    }
  });

  it('reports ranges of the original text, with the key name and the value inside them', () => {
    const text = `psql password=${SECRET} -d app`;
    const ranges = secretShapedRanges(text);
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual([
      `password=${SECRET}`,
    ]);
    const joined = 'a sk-abcdefghijklmnop1234567890 b token=hunter2';
    expect(secretShapedRanges(joined).map((range) => joined.slice(range.start, range.end))).toEqual(
      ['sk-abcdefghijklmnop1234567890', 'token=hunter2'],
    );
  });

  it('keeps the whitespace before a scheme credential out of its range', () => {
    const text = `Authorization:   Bearer    ${SECRET}${SECRET} tail`;
    const hidden = secretShapedRanges(text).map((range) => text.slice(range.start, range.end));
    expect(hidden.join('|')).not.toContain(SECRET.slice(0, 4) + ' ');
    expect(hidden.at(-1)).toBe(`${SECRET}${SECRET}`);
    expect(hidden.every((piece) => !/^\s|\s$/.test(piece))).toBe(true);
  });

  it('counts UTF-16 offsets, around astral characters and a lone surrogate', () => {
    for (const around of ['😀 ', '\ud83d ', '\u{1F600}\u{1F601} ']) {
      const text = `${around}password=${SECRET} ${around}`;
      const ranges = secretShapedRanges(text);
      expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual([
        `password=${SECRET}`,
      ]);
      expect(replaced(text, ranges)).toBe(redactSecretShapedText(text));
    }
  });

  describe('where the first pass is not the projection, the whole text is one range', () => {
    it('for a header label an LF or TAB splits, which the projection joins before reading anything', () => {
      for (const text of [
        'api-k\tey: abcd1234efgh5678ijkl',
        `go Authori\nzation: Bearer ${SECRET}${SECRET} tail`,
      ]) {
        expect(redactSecretShapedText(text), text).not.toBe(text);
        expect(secretShapedRanges(text), text).toEqual([{ start: 0, end: text.length }]);
      }
    });

    it('for adjacent credentials the projection needs a second pass for, even with plain text around them', () => {
      const text = 'keep AKIAABCDEFGHIJKLMNOPAKIAABCDEFGHIJKLMNOP tail';
      expect(redactSecretShapedText(text)).toContain('keep');
      expect(secretShapedRanges(text)).toEqual([{ start: 0, end: text.length }]);
    });
  });

  it('answers a megabyte of text, with or without a secret, without throwing', () => {
    const filler = 'a'.repeat(1024 * 1024);
    expect(secretShapedRanges(filler)).toEqual([]);
    const text = `${filler} password=${SECRET}`;
    const ranges = secretShapedRanges(text);
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual([
      `password=${SECRET}`,
    ]);
  });
});
