import { describe, expect, it } from 'vitest';

import {
  exampleIsShown,
  HOME_BLOCK_ROWS,
  homeTopGap,
  LANDING_BLOCK_HEAD_ROWS,
  LANDING_FOOT_ROWS,
  LANDING_TITLE_ROWS,
  landingGapRows,
  landingNoticeRoom,
  landingRows,
  landingRowsAbovePrompt,
  landingTopGap,
  showsLandingBlock,
} from './home-layout.js';

/**
 * The landing's height, in ONE place (ADR-0146 §1; MVP-11 unit 7, H1): the banner's height used to be written three times (the view, the
 * notice's room and the banner itself), and the empty Home's new block, its one-line title, its notice, its hosted run's row and its prompt
 * are all counted here. The frames (`home-landing-frames.test.tsx`) hold the drawn rows to these numbers.
 */

describe('showsLandingBlock: the block is the EMPTY Home’s, and `show_banner = false` turns it into the title', () => {
  it.each([
    [undefined, true, true],
    [true, true, true],
    [false, true, false],
    // A Home that has something to continue draws the title whatever the setting says.
    [undefined, false, false],
    [true, false, false],
    [false, false, false],
  ] as const)('show_banner=%s, empty=%s ⇒ block %s', (setting, empty, block) => {
    expect(showsLandingBlock(setting, empty)).toBe(block);
  });
});

describe('exampleIsShown: the example is on screen exactly when it can be filled in', () => {
  it('shows on the empty Home with nothing typed, and nowhere else', () => {
    expect(exampleIsShown(true, '')).toBe(true);
    expect(exampleIsShown(false, '')).toBe(false); // a Home with a strip draws no example
    expect(exampleIsShown(true, 'a')).toBe(false);
    // A draft of one blank is a draft: the prompt draws it, not the example (the prompt shows the example only for an empty text).
    expect(exampleIsShown(true, ' ')).toBe(false);
  });
});

describe('landingRows: the height of the landing without its top gap', () => {
  it('the resting block is the twelve rows of the frames: five of head, two blank, the prompt and four under it', () => {
    expect(landingRows(true)).toBe(HOME_BLOCK_ROWS);
    expect(HOME_BLOCK_ROWS).toBe(12);
    expect(LANDING_BLOCK_HEAD_ROWS + 2 + 1 + LANDING_FOOT_ROWS).toBe(12);
  });

  it('the one-line title is seven rows: the title, a blank row, the prompt and the four under it', () => {
    expect(landingRows(false)).toBe(LANDING_TITLE_ROWS + 1 + 1 + LANDING_FOOT_ROWS);
    expect(landingRows(false)).toBe(7);
  });

  it('a hosted run’s row costs one row, a prompt of n lines costs n − 1 more', () => {
    expect(landingRows(true, { runRows: 1 })).toBe(13);
    expect(landingRows(true, { promptRows: 3 })).toBe(14);
    expect(landingRows(false, { runRows: 1, promptRows: 2 })).toBe(9);
  });

  it('a notice takes the place of the gap and brings a blank row above and below it: n rows cost n rows on the block and n + 1 on the title', () => {
    for (const n of [1, 2, 7, 11]) {
      expect(landingRows(true, { noticeRows: n }), `block, ${String(n)}`).toBe(12 + n);
      expect(landingRows(false, { noticeRows: n }), `title, ${String(n)}`).toBe(7 + n + 1);
    }
    expect(landingGapRows(true)).toBe(2);
    expect(landingGapRows(false)).toBe(1);
    expect(landingGapRows(true, 4)).toBe(6);
  });

  // The hosted run's row stands under the status line (MVP-11 unit 7, the study's frame 21): it is part of the prompt block, not of the rows
  // above the prompt, so the head and the prompt do not move for it.
  it('is the rows above the prompt, the prompt, the four under it and the hosted run’s row', () => {
    for (const block of [true, false])
      for (const parts of [{}, { runRows: 1 }, { noticeRows: 3 }, { promptRows: 4, runRows: 1 }]) {
        const prompt = 'promptRows' in parts ? parts.promptRows : 1;
        const run = 'runRows' in parts ? parts.runRows : 0;
        expect(landingRows(block, parts)).toBe(
          landingRowsAbovePrompt(block, parts) + prompt + LANDING_FOOT_ROWS + run,
        );
        expect(landingRowsAbovePrompt(block, parts), 'the run row is not above the prompt').toBe(
          landingRowsAbovePrompt(block, { ...parts, runRows: 0 }),
        );
      }
  });

  it('counts a value that is not a number, or not a whole one, as the least it can be', () => {
    expect(landingRows(true, { promptRows: Number.NaN, noticeRows: Number.NaN })).toBe(12);
    expect(landingRows(true, { promptRows: 0, runRows: -3 })).toBe(12);
    expect(landingRows(true, { promptRows: 2.9 })).toBe(13);
    expect(landingRows(true, { promptRows: Number.POSITIVE_INFINITY })).toBe(12);
  });
});

describe('landingNoticeRoom: what a notice may take, and the landing still short of the terminal', () => {
  it('is 11 rows on the block at 24 rows, and the landing with that notice is exactly rows − 1', () => {
    expect(landingNoticeRoom(24, true)).toBe(11);
    expect(landingRows(true, { noticeRows: 11 })).toBe(23);
  });

  it.each([true, false])(
    'is tight for every size, hosted run and prompt (block=%s): the landing with the room fits rows − 1 and with one row more does not',
    (block) => {
      for (let rows = 24; rows <= 80; rows += 1)
        for (const runRows of [0, 1])
          for (const promptRows of [1, 2, 4]) {
            const room = landingNoticeRoom(rows, block, { runRows, promptRows });
            const used = landingRows(block, { runRows, promptRows, noticeRows: room });
            const label = `${String(rows)} rows, run ${String(runRows)}, prompt ${String(promptRows)}`;
            expect(room, label).toBeGreaterThanOrEqual(2);
            if (room > 2) {
              expect(used, label).toBeLessThanOrEqual(rows - 1);
              expect(used + 1, label).toBeGreaterThan(rows - 1);
            }
          }
    },
  );

  it('is at least two rows when the terminal is too short to leave more, and for a size that is not a number', () => {
    expect(landingNoticeRoom(10, true)).toBe(2);
    expect(landingNoticeRoom(Number.NaN, true)).toBe(2);
    expect(landingNoticeRoom(Number.POSITIVE_INFINITY, false)).toBe(2);
  });
});

describe('landingTopGap: the gap gives way to anything else, and the landing stays short of the terminal', () => {
  it('is the frames’ gap on the block in the alternate screen: 3 rows at 24, 6 at 30, 11 at 40', () => {
    expect(landingTopGap(24, true, true)).toBe(3);
    expect(landingTopGap(30, true, true)).toBe(6);
    expect(landingTopGap(40, true, true)).toBe(11);
    for (const rows of [24, 30, 40])
      expect(landingTopGap(rows, true, true)).toBe(homeTopGap(rows, true));
  });

  it('is nothing inline (nothing blank is pushed into the scrollback), and nothing for the one-line title', () => {
    for (const rows of [24, 30, 40]) {
      expect(landingTopGap(rows, false, true), `inline ${String(rows)}`).toBe(0);
      expect(landingTopGap(rows, true, false), `title ${String(rows)}`).toBe(0);
    }
  });

  it('keeps gap + landing within rows − 1, whatever else is on screen, and never grows with another row of content', () => {
    for (let rows = 24; rows <= 60; rows += 1)
      for (const noticeRows of [0, 1, 5, 11, 30])
        for (const runRows of [0, 1])
          for (const promptRows of [1, 3, 10]) {
            const parts = { noticeRows, runRows, promptRows };
            const gap = landingTopGap(rows, true, true, parts);
            const label = `${String(rows)} rows ${JSON.stringify(parts)}`;
            expect(gap, label).toBeGreaterThanOrEqual(0);
            expect(gap, label).toBeLessThanOrEqual(homeTopGap(rows, true));
            // (a landing already taller than rows − 1 has no gap, and is no taller for it)
            if (landingRows(true, parts) <= rows - 1)
              expect(gap + landingRows(true, parts), label).toBeLessThanOrEqual(rows - 1);
            else expect(gap, label).toBe(0);
            expect(
              landingTopGap(rows, true, true, { ...parts, promptRows: promptRows + 1 }),
              label,
            ).toBeLessThanOrEqual(gap);
          }
  });

  it('is nothing for a size that is not a number', () => {
    expect(landingTopGap(Number.NaN, true, true)).toBe(0);
    expect(landingTopGap(Number.POSITIVE_INFINITY, true, true)).toBe(0);
  });
});
