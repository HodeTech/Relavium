import { describe, expect, it } from 'vitest';
import { parseInline } from './inline.js';
import { isWordAt, isWordBefore, isWordCodePoint } from './unicode-word.js';

describe('Unicode intraword delimiters', () => {
  it('keeps underscores between supplementary letters, numbers and mixed scripts', () => {
    for (const value of [
      '𝑥_𝑦_𝑧',
      '𐐀_𐐀_𐐀',
      '𝑥__𝑦__𝑧',
      '𐐀__𐐀__𐐀',
      'a_𝑦_z',
      '𝑥__a__𐐀',
      '𝟘_1_𝟚',
      'a__b__c',
      '𝑥___𝑦___𝑧',
    ]) {
      expect(parseInline(value)).toEqual([{ text: value }]);
    }
  });

  it('still permits matched emphasis and preserves escaped punctuation', () => {
    expect(parseInline('𝑥 _𝑦_ 𐐀')).toEqual([
      { text: '𝑥 ' },
      { text: '𝑦', emphasis: true },
      { text: ' 𐐀' },
    ]);
    expect(parseInline('𐐀 __𝑦__ 𝑧')).toEqual([
      { text: '𐐀 ' },
      { text: '𝑦', strong: true },
      { text: ' 𝑧' },
    ]);
    expect(parseInline('𝑥\\_𝑦\\_𝑧')).toEqual([{ text: '𝑥_𝑦_𝑧' }]);
    expect(parseInline('𝑥_𝑦')).toEqual([{ text: '𝑥_𝑦' }]);
    expect(parseInline('_text 𝑥__𝑦__𝑧 text_')).toEqual([
      { text: 'text 𝑥__𝑦__𝑧 text', emphasis: true },
    ]);
    const long = '𝑥_'.repeat(5_000) + '𝑦';
    expect(parseInline(long)).toEqual([{ text: long }]);
  });

  it('classifies only one adjacent code point and rejects unpaired surrogates', () => {
    expect(isWordBefore('𝑥_', 2)).toBe(true);
    expect(isWordAt('_𐐀', 1)).toBe(true);
    expect(isWordAt('_𝟘', 1)).toBe(true);
    expect(isWordBefore('a!_', 2)).toBe(false);
    expect(isWordAt('_!a', 1)).toBe(false);
    expect(isWordCodePoint('\ud835')).toBe(false);
    expect(isWordAt('', 0)).toBe(false);
    expect(isWordBefore('', 0)).toBe(false);
  });
});
