/**
 * The row accounting behind OB71 (unit 7, round 1), as arithmetic: the one rule of "one row short of the terminal" (`frameRows`), the most rows each
 * of the Home's prompts may take (`landingEditorRows`, `workEditorRows`), and the rows a draft takes as Ink draws it (`homePromptRows`, `wrappedRowCount`).
 * The drawn frames are `home-prompt-window-frames.test.tsx`'s; this pins the numbers they follow.
 */
import { describe, expect, it } from 'vitest';

import { chatFrameRows } from './chat-layout.js';
import { sanitizeInline } from './chat-projection.js';
import { glyphOf } from './glyphs.js';
import {
  frameRows,
  HOME_PROMPT_LEAD_COLUMNS,
  landingEditorRows,
  landingRows,
  landingTopGap,
} from './home-layout.js';
import { homePromptRows } from './home-notice.js';
import { workEditorRows, workListRows, slideTravel, WORK_LIST_MIN_ROWS } from './home-pages.js';
import { PROMPT_WINDOW_MIN_ROWS, wrappedRowCount } from './prompt-window.js';
import { displayWidth } from './viewport.js';

describe('frameRows: one row short of the terminal, written once', () => {
  it.each([
    [24, 23],
    [30, 29],
    [2, 1],
    [1, 1],
    [0, 1],
    [23.9, 22],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
  ])('%s rows ⇒ %s', (rows, frame) => {
    expect(frameRows(rows)).toBe(frame);
  });

  it('is the chat’s frame, the work page’s list budget and the slide’s travel: the same rule', () => {
    for (const rows of [24, 25, 30, 40, 80]) {
      expect(chatFrameRows(rows)).toBe(frameRows(rows));
      expect(slideTravel(rows)).toBe(frameRows(rows));
      expect(workListRows(rows, 5)).toBe(Math.max(0, frameRows(rows) - 2 - 5));
    }
  });
});

describe('landingEditorRows: what rows − 1 leaves the landing’s prompt', () => {
  it('is 12 rows with the block at 24 rows (a 12-line draft is drawn whole), 17 with the one-line title', () => {
    expect(landingEditorRows(24, true)).toBe(12);
    expect(landingEditorRows(24, false)).toBe(17);
    expect(landingEditorRows(30, true)).toBe(18);
  });

  it.each([true, false])(
    'the landing with a prompt of exactly that many rows is rows − 1, with and without a notice and a hosted run’s row (block=%s)',
    (block) => {
      for (let rows = 24; rows <= 60; rows += 1)
        for (const noticeRows of [0, 1, 2, 5])
          for (const runRows of [0, 1]) {
            const cap = landingEditorRows(rows, block, { noticeRows, runRows });
            const label = `${String(rows)} rows, notice ${String(noticeRows)}, run ${String(runRows)}`;
            expect(
              landingRows(block, { promptRows: cap, noticeRows, runRows }),
              label,
            ).toBeLessThanOrEqual(rows - 1);
            expect(
              landingRows(block, { promptRows: cap + 1, noticeRows, runRows }),
              label,
            ).toBeGreaterThan(rows - 1);
          }
    },
  );

  it('is never fewer than a window can have, even when a notice leaves no room', () => {
    expect(landingEditorRows(24, true, { noticeRows: 30 })).toBe(PROMPT_WINDOW_MIN_ROWS);
  });

  it('leaves the top gap its room at rest: a prompt at the bound has no gap (the frame is full), and one row less has one row of it', () => {
    const cap = landingEditorRows(24, true);
    expect(landingTopGap(24, true, true, { promptRows: cap })).toBe(0);
    expect(landingTopGap(24, true, true, { promptRows: cap - 1 })).toBe(1);
  });
});

describe('workEditorRows: what rows − 1 leaves the work page’s docked prompt beside its list’s least', () => {
  it('is 9 rows at 24 (a list of 8 beside it) and 15 at 30', () => {
    expect(workEditorRows(24)).toBe(9);
    expect(workEditorRows(30)).toBe(15);
    expect(workListRows(24, 4 + workEditorRows(24))).toBe(WORK_LIST_MIN_ROWS);
  });

  it('is never fewer than a window can have', () => {
    expect(workEditorRows(10)).toBe(PROMPT_WINDOW_MIN_ROWS);
  });
});

describe('homePromptRows: the rows a draft takes as Ink draws it', () => {
  const at = (text: string, columns = 74, cap?: number): number =>
    homePromptRows({ text, cursor: text.length }, columns, cap);

  it('is one row for nothing and for a line that fits, with the lead and the cursor cell counted', () => {
    expect(at('')).toBe(1);
    expect(at('x'.repeat(71))).toBe(1); // 2 lead + 71 + 1 cursor cell = 74
    expect(at('x'.repeat(72))).toBe(2); // the cursor cell wraps onto a row of its own
  });

  it('counts a word that does not fit the row onto the next, where a count of characters would not (prose takes more rows)', () => {
    // seven 39-character words, one to a row at 74 columns: 7 rows, where the characters (7 × 40 over 74) are 4.
    const words = Array(7).fill('x'.repeat(39)).join(' ');
    expect(at(words)).toBe(7);
  });

  it('is one row more per line of the draft and counts a blank line', () => {
    expect(at('a\nb\n\nc')).toBe(4);
  });

  it('with a bound is the window the editor draws: never more than the bound, never fewer than a window', () => {
    expect(at(Array(40).fill('x').join('\n'), 74, 12)).toBe(12);
    expect(at(Array(40).fill('x').join('\n'), 74, 1)).toBe(PROMPT_WINDOW_MIN_ROWS);
    expect(at('a\nb', 74, 12)).toBe(2);
  });

  it('counts the cell of a cursor that is not drawn too, so the count is never short', () => {
    expect(homePromptRows({ text: 'x'.repeat(72), cursor: -1 }, 74)).toBe(2);
  });
});

describe('the lead the Home’s prompts draw is two columns, in both glyph forms', () => {
  it('HOME_PROMPT_LEAD_COLUMNS is the glyph and its space', () => {
    for (const ascii of [false, true])
      expect(displayWidth(`${glyphOf('yourTurn', ascii)} `)).toBe(HOME_PROMPT_LEAD_COLUMNS);
  });
});

describe('wrappedRowCount: Ink’s word wrap over the whole draft', () => {
  const rows = (text: string, cursor: number, columns: number, lead = 2): number =>
    wrappedRowCount(text, cursor, lead, columns, sanitizeInline);

  it('draws nothing as one row with the cursor cell, and a cursor that is not drawn as one row too', () => {
    expect(rows('', 0, 20)).toBe(1);
    expect(rows('', -1, 20)).toBe(1);
  });

  it('breaks at spaces: 3 words of 8 characters in 20 columns are 3 rows with the lead (a hard wrap would be 2)', () => {
    expect(rows('aaaaaaaa bbbbbbbb cccccccc', -1, 20)).toBe(2);
    expect(rows('aaaaaaaaaa bbbbbbbbbb cccccccccc', -1, 20)).toBe(3);
  });

  it('hard-breaks a word wider than the row', () => {
    expect(rows('x'.repeat(100), -1, 20)).toBe(6);
  });

  it('measures the text as it is drawn: a control character is blanked by the scrub before it is measured', () => {
    expect(rows('a\u001b[2Jb', -1, 20)).toBe(1);
  });
});
