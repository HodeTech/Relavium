/**
 * The Home popups' one scrub for a stored word ([MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4): a paragraph that does
 * not fit its rows ends in `…` between two words, never inside one (review round 1, O-13: a system prompt read `INP…`).
 */
import { describe, expect, it } from 'vitest';

import { wordCut } from './home-agents-popup.js';
import { endedWithEllipsis, storedParagraph } from './home-text.js';

describe('a paragraph cut to its rows', () => {
  it('ends in `…` after a whole word: the last row gives up the words that would leave the mark no room', () => {
    const text = 'review '.repeat(40);
    const rows = storedParagraph(text, 27, 3); // four words fill a row of 27 whole: the mark has no room after them
    expect(rows).toHaveLength(3);
    const last = rows.at(-1) ?? '';
    expect(last.endsWith('…')).toBe(true);
    expect(
      last
        .replace(/…$/u, '')
        .split(' ')
        .every((word) => word === 'review'),
    ).toBe(true);
    expect(last.length).toBeLessThanOrEqual(27);
  });

  it('keeps a line that already has room for the mark, and cuts a single word that is wider than the row', () => {
    expect(endedWithEllipsis('two words', 30)).toBe('two words…');
    expect(endedWithEllipsis('x'.repeat(40), 10)).toHaveLength(10);
  });

  it('is the text unchanged when it fits its rows', () => {
    expect(storedParagraph('one short line', 40, 4)).toEqual(['one short line']);
  });
});

describe('the head of a prompt the model cut', () => {
  it('drops the word the model’s cut fell inside, and keeps its mark', () => {
    expect(wordCut('You are a reviewer. INP…')).toBe('You are a reviewer.…');
    expect(wordCut('a complete text')).toBe('a complete text');
    expect(wordCut('oneword…')).toBe('oneword…');
  });
});
