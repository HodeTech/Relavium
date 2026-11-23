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

/** Every string over {a, b} of length zero to `maxLength`, shortest first. */
function allBinaryStrings(maxLength: number): string[] {
  const out: string[] = [];
  for (let length = 0; length <= maxLength; length++) {
    for (let bits = 0; bits < 2 ** length; bits++) {
      out.push(Array.from({ length }, (_, i) => ((bits >> i) & 1 ? 'b' : 'a')).join(''));
    }
  }
  return out;
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

  it('reads each haystack unit exactly once, so the cost does not depend on the pattern', () => {
    // A pattern that defeats a naive search (a run of 'a' and a 'b' at the end, against a run of 'a') would make a
    // quadratic scan read the haystack again at every start. The read count pins one pass, without timing anything.
    const haystack = 'a'.repeat(2000);
    const needle = `${'a'.repeat(999)}b`;
    let reads = 0;
    const counted = {
      length: haystack.length,
      charCodeAt: (index: number): number => {
        reads++;
        return haystack.charCodeAt(index);
      },
    };
    scanLiteral(counted, needle, literalFailureTable(needle), () => false);
    expect(reads).toBe(haystack.length);
  });

  it('agrees with the retired indexOf loop on every binary haystack up to length ten', () => {
    // Exhaustive over {a, b}: periodic needles and overlapping occurrences are where a failure-table
    // fallback goes wrong, and random inputs over a wider alphabet rarely produce them.
    const mismatches: string[] = [];
    for (const haystack of allBinaryStrings(10)) {
      for (const needle of allBinaryStrings(6)) {
        if (needle.length === 0) continue;
        const expected = indexOfOccurrences(haystack, needle);
        const actual = kmpOccurrences(haystack, needle);
        if (JSON.stringify(actual) !== JSON.stringify(expected))
          mismatches.push(
            `${haystack} / ${needle}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`,
          );
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
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
