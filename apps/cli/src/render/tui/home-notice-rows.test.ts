/**
 * How many rows a notice gets beside a draft on each page, and what the notice's own bounds are (MVP-11 unit 7, round 2; `home-notice.ts`).
 * The work page's room is what its list leaves under the way back once the docked prompt block (its four rows and the editor's), the notice's
 * blank row and the rows the list keeps for its sections are counted, never fewer than two: 16 at 80×24 with nothing to keep, 6 with all three
 * sections. The landing's room is what `landingNoticeRoom` leaves. A notice that does not fit pages and ends in a footer, which is one of its
 * rows. The notice is cut at 32,768 characters without splitting a surrogate pair, and the editor's rows count the cursor's cell.
 */
import { describe, expect, it } from 'vitest';

import type { EditorState } from './chat-input.js';
import { landingEditorRows, landingNoticeRoom } from './home-layout.js';
import {
  boundedNotice,
  homeContentColumns,
  homePromptRows,
  layoutHomeNotice,
  MAX_HOME_NOTICE_CHARS,
  type HomeNoticeOptions,
} from './home-notice.js';

const LONG = Array.from({ length: 60 }, (_, n) => `notice line number ${String(n)}`).join('\n');
const SHORT = 'a\nb';
const empty: EditorState = { text: '', cursor: 0 };
const draftOf = (lines: number): EditorState => ({
  text: Array.from({ length: lines }, (_, n) => `d${String(n)}`).join('\n'),
  cursor: 0,
});

function layout(over: Partial<HomeNoticeOptions> = {}) {
  const result = layoutHomeNotice({
    notice: LONG,
    editor: empty,
    cols: 80,
    rows: 24,
    showBanner: undefined,
    onLanding: false,
    hasSessions: false,
    ...over,
  });
  if (result === undefined) throw new Error('no layout');
  return result;
}

describe('the work page: what the list leaves under the way back', () => {
  it.each([
    // [sessions, recent runs, attention runs, the rows of the notice: its lines and its footer]
    [false, false, false, 16],
    [false, false, true, 13],
    [true, false, false, 12],
    [false, true, false, 12],
    [true, true, false, 9],
    [true, true, true, 6],
  ] as const)(
    '80×24, sessions %s, runs %s, Attention %s: %i rows (the list keeps the first row and the marker of each section)',
    (hasSessions, hasRecentRuns, hasAttentionRuns, rowCount) => {
      const shown = layout({ hasSessions, hasRecentRuns, hasAttentionRuns });
      expect(shown.rowCount).toBe(rowCount);
      expect(shown.lines).toHaveLength(rowCount - 1);
    },
  );

  it.each([
    [24, 16],
    [26, 17],
    [30, 21],
    [40, 31],
  ] as const)(
    'a taller terminal gives it the rows: %i rows, %i for the notice (nothing for the list to keep)',
    (rows, rowCount) => {
      expect(layout({ rows }).rowCount).toBe(rowCount);
    },
  );

  it('every line of the draft is a row less, up to the editor’s bound (8 at 80×24), and every reserved row too', () => {
    const all = { hasSessions: true, hasRecentRuns: true, hasAttentionRuns: true } as const;
    expect([1, 2, 3].map((lines) => layout({ ...all, editor: draftOf(lines) }).rowCount)).toEqual([
      6, 5, 4,
    ]);
    expect([1, 2, 5, 8, 9, 12].map((lines) => layout({ editor: draftOf(lines) }).rowCount)).toEqual(
      [16, 15, 12, 9, 9, 9],
    );
    expect([0, 1, 3].map((reservedRows) => layout({ reservedRows }).rowCount)).toEqual([
      16, 15, 13,
    ]);
  });

  it('never fewer than two rows, whatever is asked of the page', () => {
    expect(
      layout({ editor: draftOf(5), hasSessions: true, hasRecentRuns: true, hasAttentionRuns: true })
        .rowCount,
    ).toBe(2);
    expect(layout({ reservedRows: 20 }).rowCount).toBe(2);
  });
});

describe('the landing: what `landingNoticeRoom` leaves beside the prompt and the hosted run’s row', () => {
  it.each([
    [24, true],
    [24, false],
    [30, true],
    [40, false],
  ] as const)(
    '%i rows, the block %s: the room the landing’s own arithmetic gives, less the rows reserved',
    (rows, block) => {
      for (const lines of [1, 3, 14]) {
        for (const reservedRows of [0, 1, 3]) {
          const promptRows = Math.min(
            lines,
            landingEditorRows(rows, block, { runRows: reservedRows }),
          );
          const expected = Math.max(
            2,
            landingNoticeRoom(rows, block, { promptRows }) - reservedRows,
          );
          expect(
            layout({
              rows,
              showBanner: block,
              onLanding: true,
              editor: draftOf(lines),
              reservedRows,
            }).rowCount,
            `${String(lines)} lines, ${String(reservedRows)} reserved`,
          ).toBe(expected);
        }
      }
    },
  );

  it('the one-line title leaves the notice four rows more than the block', () => {
    for (const rows of [24, 30, 40])
      expect(layout({ rows, showBanner: false, onLanding: true }).rowCount).toBe(
        layout({ rows, showBanner: true, onLanding: true }).rowCount + 4,
      );
  });
});

describe('a notice that fits, and one that pages', () => {
  it('a short notice is its lines and no footer', () => {
    const shown = layout({ notice: SHORT });
    expect(shown.lines).toEqual(['a', 'b']);
    expect(shown.footer).toBeUndefined();
    expect(shown.rowCount).toBe(2);
    expect(shown.maxPage).toBe(0);
  });

  it('a notice of exactly the room is not paged: it is all its lines and no footer', () => {
    const room = layout().rowCount;
    const exact = Array.from({ length: room }, (_, n) => `line ${String(n)}`).join('\n');
    const shown = layout({ notice: exact });
    expect(shown.lines).toHaveLength(room);
    expect(shown.footer).toBeUndefined();
    const over = layout({ notice: `${exact}\nmore` });
    expect(over.lines).toHaveLength(room - 1);
    expect(over.footer).toBeDefined();
  });

  it('the pages are the room less the footer, and the footer says which rows of how many', () => {
    const pages = [0, 1, 2, 3].map((page) => layout({ page }));
    expect(pages.map((shown) => shown.footer)).toEqual([
      'Notice 1–15 of 60 · PgUp/PgDn read',
      'Notice 16–30 of 60 · PgUp/PgDn read',
      'Notice 31–45 of 60 · PgUp/PgDn read',
      'Notice 46–60 of 60 · PgUp/PgDn read',
    ]);
    expect(pages.map((shown) => shown.lines[0])).toEqual([
      'notice line number 0',
      'notice line number 15',
      'notice line number 30',
      'notice line number 45',
    ]);
    expect(pages.every((shown) => shown.maxPage === 3 && shown.rowCount === 16)).toBe(true);
  });

  it('a page that is not one is the nearest: below the first, past the last, a fraction or not a number', () => {
    expect(layout({ page: -1 }).page).toBe(0);
    expect(layout({ page: 99 }).page).toBe(3);
    expect(layout({ page: 1.5 }).page).toBe(0);
    expect(layout({ page: Number.NaN }).page).toBe(0);
    expect(layout({ page: Number.POSITIVE_INFINITY }).page).toBe(0);
  });

  it('no notice is no layout', () => {
    expect(
      layoutHomeNotice({
        notice: undefined,
        editor: empty,
        cols: 80,
        rows: 24,
        showBanner: undefined,
        onLanding: false,
        hasSessions: false,
      }),
    ).toBeUndefined();
  });
});

describe('the columns and the editor’s rows', () => {
  it('the content is the terminal less the left margin (6 below 100 columns, 8 from 100), at least one column, and a width that is not a number is left as it is', () => {
    expect(homeContentColumns(80)).toBe(74);
    expect(homeContentColumns(99)).toBe(93);
    expect(homeContentColumns(100)).toBe(92);
    expect(homeContentColumns(80.9)).toBe(74);
    expect(homeContentColumns(7)).toBe(1);
    expect(homeContentColumns(6)).toBe(1);
    expect(homeContentColumns(3)).toBe(1);
    expect(homeContentColumns(Number.NaN)).toBeNaN();
  });

  it('the cursor’s cell is a column of its own: at the end of a line that fills the row it takes another; on a letter it does not; with no cursor drawn it is counted', () => {
    // a lead of two columns and ten letters fill a row of twelve
    const row = (cursor: number): number => homePromptRows({ text: 'a'.repeat(10), cursor }, 12);
    expect(row(0)).toBe(1);
    expect(row(9)).toBe(1);
    expect(row(10)).toBe(2);
    expect(row(-1)).toBe(2);
  });

  it('a bound on the rows is floored and is never fewer than a window can have (three)', () => {
    const nine: EditorState = { text: Array.from({ length: 9 }, () => 'x').join('\n'), cursor: 0 };
    expect(homePromptRows(nine, 40)).toBe(9);
    expect(homePromptRows(nine, 40, 5.5)).toBe(5);
    expect(homePromptRows(nine, 40, 5)).toBe(5);
    expect(homePromptRows(nine, 40, 1)).toBe(3);
    expect(homePromptRows({ text: 'x', cursor: 0 }, 40, 1)).toBe(1);
  });
});

describe('a notice is cut at 32,768 characters, and never in the middle of a surrogate pair', () => {
  const PAIR = String.fromCodePoint(0x1f600);
  const N = MAX_HOME_NOTICE_CHARS;

  it('the bound is 32,768; a notice of exactly that is whole, one more is cut and says so', () => {
    expect(N).toBe(32_768);
    expect(boundedNotice('x'.repeat(N))).toBe('x'.repeat(N));
    expect(boundedNotice('x'.repeat(N - 1))).toBe('x'.repeat(N - 1));
    expect(boundedNotice('x'.repeat(N + 1))).toBe(`${'x'.repeat(N)}…`);
  });

  it('a pair that ends exactly at the bound is kept, one that would be cut in two goes whole', () => {
    expect(boundedNotice(`${'x'.repeat(N - 2)}${PAIR}tail`)).toBe(`${'x'.repeat(N - 2)}${PAIR}…`);
    expect(boundedNotice(`${'x'.repeat(N - 1)}${PAIR}tail`)).toBe(`${'x'.repeat(N - 1)}…`);
  });

  it('only a HIGH surrogate at the cut is half a pair: the first and the last of the range are, the characters either side of it are not', () => {
    const cut = (unit: number): string =>
      boundedNotice(`${'x'.repeat(N - 1)}${String.fromCharCode(unit)}z`);
    expect(cut(0xd800)).toBe(`${'x'.repeat(N - 1)}…`);
    expect(cut(0xdbff)).toBe(`${'x'.repeat(N - 1)}…`);
    expect(cut(0xd7ff)).toBe(`${'x'.repeat(N - 1)}${String.fromCharCode(0xd7ff)}…`);
    expect(cut(0xdc00)).toBe(`${'x'.repeat(N - 1)}${String.fromCharCode(0xdc00)}…`);
  });

  it('a low surrogate at the cut is not a pair that was split: only a high one is', () => {
    expect(boundedNotice(`${'x'.repeat(N - 1)}${PAIR.slice(1)}z`)).toBe(
      `${'x'.repeat(N - 1)}${PAIR.slice(1)}…`,
    );
  });
});
