import { describe, expect, it } from 'vitest';
import { literalFailureTable, scanLiteral } from './literal-search.js';

/** The retired search: native `indexOf` retried one position later. It is the oracle the matcher must reproduce. */
function indexOfOccurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    found.push(at);
    from = at + 1;
  }
  return found;
}

function kmpOccurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  scanLiteral(haystack, needle, literalFailureTable(needle), (start) => {
    found.push(start);
    return false;
  });
  return found;
}

/** A small deterministic generator, so every run tests the same inputs. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('literalFailureTable', () => {
  it('computes the longest proper border of every prefix', () => {
    expect(Array.from(literalFailureTable('ababaca'))).toEqual([0, 0, 1, 2, 3, 0, 1]);
    expect(Array.from(literalFailureTable('aaaa'))).toEqual([0, 1, 2, 3]);
    expect(Array.from(literalFailureTable('abc'))).toEqual([0, 0, 0]);
  });
});

describe('scanLiteral', () => {
  it('reports overlapping occurrences in increasing order', () => {
    expect(kmpOccurrences('aaaa', 'aa')).toEqual([0, 1, 2]);
    expect(kmpOccurrences('abababa', 'aba')).toEqual([0, 2, 4]);
  });

  it('matches code units, as indexOf does, so a lone surrogate finds its half of a pair', () => {
    const haystack = 'x😀y';
    const half = '\uD83D';
    expect(kmpOccurrences(haystack, half)).toEqual(indexOfOccurrences(haystack, half));
    expect(kmpOccurrences(haystack, '😀')).toEqual([1]);
  });

  it('stops at the first occurrence the callback accepts', () => {
    const seen: number[] = [];
    scanLiteral('aaaaa', 'a', literalFailureTable('a'), (start) => {
      seen.push(start);
      return start === 2;
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  it('finds nothing when the needle is longer than the haystack or the haystack is empty', () => {
    expect(kmpOccurrences('ab', 'abc')).toEqual([]);
    expect(kmpOccurrences('', 'a')).toEqual([]);
  });

  it('agrees with the retired indexOf loop on seeded random inputs', () => {
    const next = generator(20261123);
    const alphabet = ['a', 'b', 'A', 'ı', '\uD83D'];
    const pick = (length: number): string =>
      Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)] ?? 'a').join('');
    for (let trial = 0; trial < 3000; trial++) {
      const haystack = pick(Math.floor(next() * 48));
      const needle = pick(1 + Math.floor(next() * 7));
      expect(kmpOccurrences(haystack, needle), `${JSON.stringify({ haystack, needle })}`).toEqual(
        indexOfOccurrences(haystack, needle),
      );
    }
  });
});
