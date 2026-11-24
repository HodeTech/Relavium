import { beforeEach, describe, expect, it, vi } from 'vitest';

import { layoutHomeNotice, MAX_HOME_NOTICE_CHARS } from './home-notice.js';
import { wrapWords } from './viewport.js';

/**
 * The layout of a notice is rebuilt on every frame, and its wrapped rows depend on the text and the width alone (MVP-11 Step 2 review round 2,
 * U4): the wrap of wide characters at the cap took about 400 ms, once per frame. The last wrap is kept per (text, columns), and what a frame
 * gets back for the same notice at the same width is the rows it already had. A new file.
 */
vi.mock('./viewport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./viewport.js')>();
  return { ...actual, wrapWords: vi.fn(actual.wrapWords) };
});

const options = {
  editor: { text: '', cursor: 0 },
  cols: 40,
  rows: 40,
  keyless: false,
  showBanner: false,
  isEmpty: false,
  hasSessions: false,
};
const wrapCalls = (): number => vi.mocked(wrapWords).mock.calls.length;

beforeEach(() => {
  vi.mocked(wrapWords).mockClear();
  // A notice no test below uses, so the one-entry cache holds none of theirs when a test starts.
  layoutHomeNotice({ ...options, notice: `unrelated ${String(Math.random())}` });
  vi.mocked(wrapWords).mockClear();
});

describe('the layout of a notice that has not changed', () => {
  it('wraps it once, however many frames ask', () => {
    const notice = '漢字 and some words that wrap at forty columns, over several rows of a notice.';
    const first = layoutHomeNotice({ ...options, notice });
    const afterFirst = wrapCalls();
    expect(afterFirst, 'the first frame wraps it').toBeGreaterThan(0);
    for (let frame = 0; frame < 50; frame += 1)
      expect(layoutHomeNotice({ ...options, notice })).toEqual(first);
    expect(wrapCalls(), 'the other fifty frames wrap nothing').toBe(afterFirst);
  });

  it('is laid out afresh for another text and for another width, and for the first text again after them', () => {
    const notice = 'a notice that wraps at forty columns, over several rows of text, for a while';
    layoutHomeNotice({ ...options, notice });
    const afterFirst = wrapCalls();
    layoutHomeNotice({ ...options, notice: `${notice}!` });
    const afterText = wrapCalls();
    expect(afterText, 'another text is wrapped').toBeGreaterThan(afterFirst);
    layoutHomeNotice({ ...options, cols: 41, notice: `${notice}!` });
    const afterWidth = wrapCalls();
    expect(afterWidth, 'another width is wrapped').toBeGreaterThan(afterText);
    layoutHomeNotice({ ...options, cols: 41, notice: `${notice}!` });
    expect(wrapCalls(), 'the same again is not').toBe(afterWidth);
    layoutHomeNotice({ ...options, notice });
    expect(wrapCalls(), 'a one-entry cache: the first text is wrapped again').toBeGreaterThan(
      afterWidth,
    );
  });

  it('gives the right rows for the width it was asked at, whatever it was asked at before', () => {
    const notice = 'one two three four five six seven eight nine ten eleven twelve';
    const wide = layoutHomeNotice({ ...options, cols: 60, notice })?.lines;
    const narrow = layoutHomeNotice({ ...options, cols: 20, notice })?.lines;
    expect(narrow?.length).toBeGreaterThan(wide?.length ?? 0);
    expect(layoutHomeNotice({ ...options, cols: 60, notice })?.lines).toEqual(wide);
    expect(narrow?.every((row) => row.length <= 20)).toBe(true);
  });

  it('keys the cache by the bounded text, so a longer notice holds no more than the bound', () => {
    const base = 'y'.repeat(MAX_HOME_NOTICE_CHARS);
    layoutHomeNotice({ ...options, notice: `${base}tail one` });
    const afterFirst = wrapCalls();
    // Everything past the bound is cut before it is wrapped, so a notice that differs only there is the same notice to the layout.
    layoutHomeNotice({ ...options, notice: `${base}another tail` });
    expect(wrapCalls()).toBe(afterFirst);
  });
});
