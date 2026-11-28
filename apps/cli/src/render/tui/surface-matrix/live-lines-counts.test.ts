/**
 * `liveLines` is the rows of a live frame: the screen's lines but the first `staticRows`, which Ink printed once through `<Static>` and never
 * redraws. The count is trusted only when it is a whole number of rows from one to every row on the screen; anything else is no count and excludes
 * nothing, so a surface can never hide a row of its live frame behind a bad number (MVP-11 unit 7, round 1: the mutation sweep's prop007, where
 * `rows > 0` loosened to `rows > 1` survived: ONE static row was not excluded). The other counts are
 * pinned by `static-rows-properties.test.tsx`; this walks every count around the edges of a small screen.
 */
import { describe, expect, it } from 'vitest';

import { liveLines, type Observation } from './properties.js';
import type { Variant } from './variants.js';

const INLINE_80: Variant = { renderer: 'inline', color: false, size: { cols: 80, rows: 24 } };

const LINES = ['header', 'one', 'two', 'three'];

const observed = (lines: readonly string[], staticRows?: number): Observation => ({
  variant: INLINE_80,
  lines,
  raw: lines.join('\n'),
  staticRows,
});

describe('liveLines excludes exactly the static rows it is told, when the count is a count', () => {
  it('one static row is excluded: a row printed once is not the live frame', () => {
    expect(liveLines(observed(LINES, 1))).toEqual(['one', 'two', 'three']);
  });

  it('every whole count from one to every row excludes that many rows from the top', () => {
    for (let count = 1; count <= LINES.length; count += 1)
      expect(liveLines(observed(LINES, count)), `count=${String(count)}`).toEqual(
        LINES.slice(count),
      );
  });

  it('no count, none, and a count past the screen exclude nothing', () => {
    expect(liveLines(observed(LINES))).toEqual(LINES);
    expect(liveLines(observed(LINES, 0))).toEqual(LINES);
    expect(liveLines(observed(LINES, LINES.length + 1))).toEqual(LINES);
  });

  it('a single line that is static leaves an empty live frame; a single line that is not, leaves itself', () => {
    expect(liveLines(observed(['only'], 1))).toEqual([]);
    expect(liveLines(observed(['only'], 0))).toEqual(['only']);
  });
});
