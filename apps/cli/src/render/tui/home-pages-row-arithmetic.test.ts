/**
 * The row arithmetic of the Home's two pages (MVP-11 unit 7, round 2; `home-pages.ts`): how far and by which frames the window slides between
 * them, the rows above the work page's list, the rows its list may take and the rows its docked editor may take. Each figure is the one the
 * module's own notes give (6, 12, 18 and 23 rows at 24 terminal rows, 8, 15, 22 and 29 at 30; a list of 17 rows at 80×24 and 22 at 100×30 beside
 * the resting block; an editor of 8 rows and 13) or the arithmetic that follows from them.
 */
import { describe, expect, it } from 'vitest';

import {
  slideFrames,
  slideOffsetAt,
  slideOffsets,
  slideTravel,
  workEditorRows,
  workHeadRows,
  workListRows,
} from './home-pages.js';

/** The rows of the docked prompt block at rest: a blank row, the prompt, the rule, the status line and the hint. */
const DOCKED_AT_REST = 5;

describe('the slide between the pages', () => {
  it.each([
    [24, 23, [6, 12, 18, 23]],
    [25, 24, [6, 12, 18, 24]],
    [30, 29, [8, 15, 22, 29]],
    [40, 39, [10, 20, 30, 39]],
    [10, 9, [3, 5, 7, 9]],
    [8, 7, [2, 4, 6, 7]],
    [5, 4, [1, 2, 3, 4]],
    [3, 2, [1, 2]],
    [2, 1, [1]],
    [0, 1, [1]],
  ] as const)(
    'at %i terminal rows the window travels %i rows, by frames at %j',
    (rows, travel, offsets) => {
      expect(slideTravel(rows)).toBe(travel);
      expect(slideOffsets(rows)).toEqual(offsets);
    },
  );

  it('a slide up is the same frames in reverse, ending at the landing; a slide down ends at the work page', () => {
    expect(slideFrames(24, 'work')).toEqual([6, 12, 18, 23]);
    expect(slideFrames(24, 'start')).toEqual([18, 12, 6, 0]);
    expect(slideFrames(3, 'start')).toEqual([1, 0]);
  });

  it('a size that is not a number travels nothing and arrives at once', () => {
    expect(slideTravel(Number.NaN)).toBe(0);
    expect(slideTravel(Number.POSITIVE_INFINITY)).toBe(0);
    expect(slideOffsets(Number.NaN)).toEqual([0]);
  });

  it('the offset of a frame: the frame that is on screen, and a frame past the last is the last (the arrival)', () => {
    expect(slideOffsetAt(24, undefined)).toBeUndefined();
    expect(slideOffsetAt(24, { to: 'work', frame: 0 })).toBe(6);
    expect(slideOffsetAt(24, { to: 'work', frame: 1 })).toBe(12);
    expect(slideOffsetAt(24, { to: 'work', frame: 1.9 })).toBe(12);
    expect(slideOffsetAt(24, { to: 'work', frame: 3 })).toBe(23);
    expect(slideOffsetAt(24, { to: 'work', frame: 99 })).toBe(23);
    expect(slideOffsetAt(24, { to: 'work', frame: -5 })).toBe(6);
    expect(slideOffsetAt(24, { to: 'start', frame: 0 })).toBe(18);
    expect(slideOffsetAt(24, { to: 'start', frame: 99 })).toBe(0);
  });
});

describe('the rows above the work page’s list', () => {
  it('the way back alone below 26 terminal rows (whitespace gives way before words), the way back and a blank row from 26', () => {
    expect(workHeadRows(24)).toBe(1);
    expect(workHeadRows(25)).toBe(1);
    expect(workHeadRows(26)).toBe(2);
    expect(workHeadRows(40)).toBe(2);
  });

  it('a size that is not a number has the way back alone', () => {
    expect(workHeadRows(Number.NaN)).toBe(1);
    expect(workHeadRows(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('the rows the work page’s list may take', () => {
  it('17 at 80×24 and 22 at 100×30 beside the resting block', () => {
    expect(workListRows(24, DOCKED_AT_REST)).toBe(17);
    expect(workListRows(30, DOCKED_AT_REST)).toBe(22);
  });

  it('every row of the bottom block is a row less, and a notice takes its lines and the blank row above it', () => {
    expect(workListRows(24, DOCKED_AT_REST + 1)).toBe(16);
    expect(workListRows(24, DOCKED_AT_REST, 1)).toBe(15);
    expect(workListRows(24, DOCKED_AT_REST, 2)).toBe(14);
    expect(workListRows(30, 7, 3)).toBe(16);
    expect(workListRows(30, DOCKED_AT_REST, 0)).toBe(22);
  });

  it('the blank row under the way back is a row of the head from 26 rows', () => {
    expect(workListRows(25, DOCKED_AT_REST)).toBe(18);
    expect(workListRows(26, DOCKED_AT_REST)).toBe(18);
  });

  it('never negative, and nothing for a size that is not a number', () => {
    expect(workListRows(8, DOCKED_AT_REST)).toBe(1);
    expect(workListRows(7, DOCKED_AT_REST)).toBe(0);
    expect(workListRows(24, 40, 9)).toBe(0);
    expect(workListRows(Number.NaN, DOCKED_AT_REST)).toBe(0);
    expect(workListRows(Number.POSITIVE_INFINITY, DOCKED_AT_REST)).toBe(0);
  });
});

describe('the rows the docked editor may take', () => {
  it.each([
    [24, 8],
    [25, 9],
    [26, 9],
    [30, 13],
    [40, 23],
  ] as const)(
    '%i terminal rows: %i (what the page leaves beside a list of ten rows)',
    (rows, editorRows) => {
      expect(workEditorRows(rows)).toBe(editorRows);
    },
  );

  it('never fewer than a window can have (three), whatever the terminal', () => {
    for (const rows of [0, 5, 10, 17, 18]) expect(workEditorRows(rows)).toBe(3);
    expect(workEditorRows(Number.NaN)).toBe(3);
  });
});
