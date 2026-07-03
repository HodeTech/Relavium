import { describe, expect, it } from 'vitest';

import {
  EMPTY_HISTORY,
  foldReverseSearchKey,
  historyNext,
  historyPrev,
  recordHistory,
  resetHistoryNav,
  reverseSearchMatchText,
  reverseSearchOlder,
  reverseSearchSetQuery,
  type InputHistory,
} from './input-history.js';

describe('InputHistory — Up/Down recall (2.5.D step 3)', () => {
  it('records submissions, skipping an empty line and a consecutive duplicate', () => {
    let h = recordHistory(EMPTY_HISTORY, 'first');
    expect(h.entries).toEqual(['first']);
    h = recordHistory(h, 'first'); // consecutive duplicate ⇒ not added
    expect(h.entries).toEqual(['first']);
    h = recordHistory(h, 'second');
    expect(h.entries).toEqual(['first', 'second']);
    h = recordHistory(h, ''); // an empty submit is not recorded
    expect(h.entries).toEqual(['first', 'second']);
  });

  it('recalls PREVIOUS (older) entries, saving the live draft, stopping at the oldest', () => {
    const base: InputHistory = { entries: ['a', 'b'], navIndex: null, draft: '' };
    const r1 = historyPrev(base, 'live-draft');
    expect(r1).toEqual({
      history: { entries: ['a', 'b'], navIndex: 1, draft: 'live-draft' },
      text: 'b',
    });
    const r2 = historyPrev(r1!.history, 'ignored');
    expect(r2).toEqual({
      history: { entries: ['a', 'b'], navIndex: 0, draft: 'live-draft' },
      text: 'a',
    });
    expect(historyPrev(r2!.history, 'ignored')).toBeNull(); // already at the oldest
    expect(historyPrev(EMPTY_HISTORY, 'x')).toBeNull(); // nothing to recall
  });

  it('recalls NEXT (newer) entries, restoring the draft past the newest, and is null when not navigating', () => {
    const nav: InputHistory = { entries: ['a', 'b'], navIndex: 0, draft: 'live-draft' };
    const r1 = historyNext(nav);
    expect(r1).toEqual({
      history: { entries: ['a', 'b'], navIndex: 1, draft: 'live-draft' },
      text: 'b',
    });
    const r2 = historyNext(r1!.history);
    expect(r2).toEqual({
      history: { entries: ['a', 'b'], navIndex: null, draft: 'live-draft' },
      text: 'live-draft',
    });
    expect(historyNext(r2!.history)).toBeNull(); // not navigating anymore
  });

  it('resetHistoryNav clears navigation (same reference when already not navigating)', () => {
    const nav: InputHistory = { entries: ['a'], navIndex: 0, draft: 'd' };
    expect(resetHistoryNav(nav)).toEqual({ entries: ['a'], navIndex: null, draft: '' });
    const clean: InputHistory = { entries: ['a'], navIndex: null, draft: '' };
    expect(resetHistoryNav(clean)).toBe(clean); // no-op ⇒ same reference
  });
});

describe('reverse-search (Ctrl+R) over the history (2.5.D step 3)', () => {
  const entries = ['foo', 'bar', 'foobar'];

  it('finds the NEWEST entry containing the query (case-insensitive); an empty query has no match', () => {
    expect(reverseSearchSetQuery(entries, 'foo')).toEqual({ query: 'foo', matchIndex: 2 }); // 'foobar' is newest
    expect(reverseSearchSetQuery(entries, 'BAR')).toEqual({ query: 'BAR', matchIndex: 2 }); // 'foobar' contains 'bar'
    expect(reverseSearchSetQuery(entries, 'zzz')).toEqual({ query: 'zzz', matchIndex: null }); // no match
    expect(reverseSearchSetQuery(entries, '')).toEqual({ query: '', matchIndex: null });
  });

  it('Ctrl+R again steps to the next OLDER match (a no-op at the oldest / no match)', () => {
    const first = reverseSearchSetQuery(entries, 'foo'); // matchIndex 2
    const older = reverseSearchOlder(entries, first);
    expect(older).toEqual({ query: 'foo', matchIndex: 0 }); // 'foo' at index 0
    expect(reverseSearchOlder(entries, older)).toBe(older); // no older 'foo' match ⇒ same reference
  });

  it('reverseSearchMatchText resolves the match, undefined when none', () => {
    expect(reverseSearchMatchText(entries, { query: 'foo', matchIndex: 2 })).toBe('foobar');
    expect(reverseSearchMatchText(entries, { query: 'zzz', matchIndex: null })).toBeUndefined();
  });

  it('foldReverseSearchKey: Esc/Ctrl-C closes, Enter accepts a match (else closes), Ctrl+R steps, edits query', () => {
    const state = { query: 'foo', matchIndex: 2 };
    expect(foldReverseSearchKey('', { escape: true }, state, entries)).toEqual({ kind: 'close' });
    expect(foldReverseSearchKey('c', { ctrl: true }, state, entries)).toEqual({ kind: 'close' });
    expect(foldReverseSearchKey('', { return: true }, state, entries)).toEqual({
      kind: 'accept',
      text: 'foobar',
    });
    expect(
      foldReverseSearchKey('', { return: true }, { query: 'zzz', matchIndex: null }, entries),
    ).toEqual({
      kind: 'close',
    }); // Enter with no match ⇒ cancel, keep the buffer
    expect(foldReverseSearchKey('r', { ctrl: true }, state, entries)).toEqual({
      kind: 'state',
      state: { query: 'foo', matchIndex: 0 },
    });
    expect(foldReverseSearchKey('o', {}, { query: 'fo', matchIndex: 2 }, entries)).toEqual({
      kind: 'state',
      state: { query: 'foo', matchIndex: 2 },
    });
    expect(
      foldReverseSearchKey('', { backspace: true }, { query: 'foo', matchIndex: 2 }, entries),
    ).toEqual({
      kind: 'state',
      state: { query: 'fo', matchIndex: 2 },
    });
  });
});
