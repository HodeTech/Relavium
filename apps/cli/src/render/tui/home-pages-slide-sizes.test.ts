/**
 * The shape of the Home's slide at EVERY terminal size, tiny ones included (MVP-11 unit 7, round 1: the mutation sweep's MU76). The product never
 * slides below its 80x24 floor, so the sizes under it were reached by no test, and the three comparisons that keep the offsets strictly
 * increasing (`offset > previous`, `offset < travel`, the first previous being 0) survived being loosened to `>=`, `<=` and a start of 1: at three
 * and four rows a loosened loop repeats an offset (a frame that does not move) or drops the first one. Rows 0 to 79 are walked, the sizes the
 * design names (24 and 30 rows) are written out, and the small ones are a table.
 *
 * What the numbers are: the window travels one page ({@link slideTravel}: `rows - 1`, the one rule of `frameRows`, never fewer than one row, and
 * nothing for a size that is not a number), in the frames of {@link slideOffsets} (a quarter of the travel further each, rounded up, a frame that
 * would repeat the one before it or reach the target early left out) and {@link slideFrames} (the same frames in reverse for a slide up).
 */
import { describe, expect, it } from 'vitest';

import { SLIDE_STEPS, slideFrames, slideOffsets, slideTravel } from './home-pages.js';

const SIZES = Array.from({ length: 80 }, (_unused, rows) => rows);

describe('slideOffsets keeps its documented shape at every size, tiny ones included', () => {
  it.each(SIZES)('rows=%i', (rows) => {
    const travel = slideTravel(rows);
    const offsets = slideOffsets(rows);
    expect(travel, 'one page: one row fewer than the terminal, never fewer than one').toBe(
      Math.max(1, rows - 1),
    );
    expect(offsets.at(-1), 'ends at the target').toBe(travel);
    expect(offsets[0], 'the first frame has moved').toBeGreaterThan(0);
    for (let n = 1; n < offsets.length; n += 1)
      expect(offsets[n] ?? 0, `frame ${String(n)} is further than the one before`).toBeGreaterThan(
        offsets[n - 1] ?? 0,
      );
    for (const offset of offsets.slice(0, -1))
      expect(offset, 'a frame between never reaches the target').toBeLessThan(travel);
    expect(offsets.length, 'at most three frames between and the arrival').toBeLessThanOrEqual(
      SLIDE_STEPS,
    );
  });

  it.each(SIZES)(
    'rows=%i: a slide up walks the same frames back and ends at the landing',
    (rows) => {
      const down = slideOffsets(rows);
      const up = slideFrames(rows, 'start');
      expect(slideFrames(rows, 'work'), 'down is the offsets themselves').toEqual(down);
      expect(up.length, 'as many frames as the way down').toBe(down.length);
      expect(up.at(-1), 'the arrival is the landing').toBe(0);
      expect(up.slice(0, -1), 'the frames between are the way down, reversed').toEqual(
        down.slice(0, -1).reverse(),
      );
    },
  );

  it('the sizes the design names: 6, 12, 18 and 23 at 24 rows; 8, 15, 22 and 29 at 30', () => {
    expect(slideOffsets(24)).toEqual([6, 12, 18, 23]);
    expect(slideOffsets(30)).toEqual([8, 15, 22, 29]);
    expect(slideFrames(24, 'start')).toEqual([18, 12, 6, 0]);
    expect(slideFrames(30, 'start')).toEqual([22, 15, 8, 0]);
  });

  it('the small sizes, written out: a travel too short for three distinct frames between keeps the ones it has', () => {
    const table: readonly (readonly [number, readonly number[]])[] = [
      [0, [1]],
      [1, [1]],
      [2, [1]],
      [3, [1, 2]],
      [4, [1, 2, 3]],
      [5, [1, 2, 3, 4]],
      [6, [2, 3, 4, 5]],
      [7, [2, 3, 5, 6]],
      [8, [2, 4, 6, 7]],
      [9, [2, 4, 6, 8]],
      [10, [3, 5, 7, 9]],
    ];
    for (const [rows, offsets] of table)
      expect(slideOffsets(rows), `rows=${String(rows)}`).toEqual(offsets);
  });

  it('a terminal of one or two rows, or a size below none, has one frame: there is no slide to show', () => {
    for (const rows of [-5, 0, 1, 2]) {
      expect(slideOffsets(rows), `rows=${String(rows)}`).toEqual([1]);
      expect(slideFrames(rows, 'work')).toHaveLength(1);
      expect(slideFrames(rows, 'start')).toEqual([0]);
    }
  });

  it('a fractional size is the whole rows it holds', () => {
    expect(slideTravel(24.9)).toBe(23);
    expect(slideOffsets(24.9)).toEqual(slideOffsets(24));
  });

  it('a size that is not a number travels nothing and slides nowhere', () => {
    for (const rows of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(slideTravel(rows)).toBe(0);
      expect(slideOffsets(rows)).toEqual([0]);
      expect(slideFrames(rows, 'start')).toEqual([0]);
      expect(slideFrames(rows, 'work')).toEqual([0]);
    }
  });
});
