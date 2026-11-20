import { describe, expect, it } from 'vitest';

import { SHEET_MAX_COLUMNS, clipLine, flushRow, usableColumns, windowBody } from './sheet-frame.js';
import { displayWidth } from './viewport.js';

/** The pure frame a sheet is drawn on (ADR-0137 §5): width, clipping, a flush row, and the window of a long list. */
describe('usableColumns', () => {
  it('leaves a margin on each side, never less than one column, and never wider than the cap', () => {
    expect(usableColumns(80)).toBe(78);
    expect(usableColumns(1)).toBe(1);
    expect(usableColumns(0)).toBe(1);
    expect(usableColumns(200)).toBe(SHEET_MAX_COLUMNS);
    expect(usableColumns(SHEET_MAX_COLUMNS + 2)).toBe(SHEET_MAX_COLUMNS);
    expect(usableColumns(SHEET_MAX_COLUMNS + 1)).toBe(SHEET_MAX_COLUMNS - 1);
  });
});

describe('clipLine', () => {
  it('leaves a line that fits whole and cuts one that does not with an ellipsis within the width', () => {
    expect(clipLine('abc', 5)).toBe('abc');
    expect(clipLine('abcdefghij', 5)).toBe('abcd…');
    expect(clipLine('abc', 1)).toBe('a');
  });

  it('never counts a wide character that straddles the cut over the width (CJK, an emoji sequence)', () => {
    const samples = [
      '日本語のコマンド '.repeat(20),
      'a日b本c語'.repeat(30),
      '👨‍👩‍👧‍👦 family '.repeat(25),
      '🙂🙃'.repeat(100),
      'x'.repeat(200),
    ];
    let checked = 0;
    for (const text of samples) {
      for (let width = 2; width <= 100; width += 1) {
        const clipped = clipLine(text, width);
        expect(
          displayWidth(clipped),
          `${text.slice(0, 6)}… at ${String(width)}`,
        ).toBeLessThanOrEqual(width);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(400);
  });
});

describe('flushRow', () => {
  it('puts the right-hand value flush to the edge, the label clipped first', () => {
    const row = flushRow('  npm, 1 argument', '2026-11-19 12:00Z', 78);
    expect(displayWidth(row)).toBe(78);
    expect(row.endsWith('2026-11-19 12:00Z')).toBe(true);
    const clipped = flushRow(`  ${'p'.repeat(100)}`, '2026-11-19 12:00Z', 78);
    expect(displayWidth(clipped)).toBe(78);
    expect(clipped).toContain('…');
    expect(clipped.endsWith('2026-11-19 12:00Z')).toBe(true);
  });

  it('drops the value rather than squeezing a label that would keep fewer than twelve columns', () => {
    const row = flushRow('  npm, 1 argument', 'x'.repeat(70), 78);
    expect(row).toBe('  npm, 1 argument');
  });

  it('has no right-hand value to place, and is just a clipped line', () => {
    expect(flushRow('abc', '', 10)).toBe('abc');
    expect(flushRow('abcdefghijkl', '', 6)).toBe('abcde…');
  });
});

describe('windowBody', () => {
  it('shows everything that fits, and otherwise a window of the asked height around the cursor', () => {
    expect(windowBody(5, 2, 8)).toEqual({ start: 0, end: 5 });
    expect(windowBody(30, 0, 8)).toEqual({ start: 0, end: 8 });
    expect(windowBody(30, 29, 8)).toEqual({ start: 22, end: 30 });
    expect(windowBody(30, 15, 8)).toEqual({ start: 12, end: 20 });
  });

  it('keeps the cursor off both end lines of the window, so a marker never covers it, whenever a marker is needed', () => {
    for (const total of [9, 12, 30, 100]) {
      for (const height of [3, 5, 8]) {
        for (let cursor = 0; cursor < total; cursor += 1) {
          const { start, end } = windowBody(total, cursor, height);
          expect(end - start, `${String(total)}/${String(height)}/${String(cursor)}`).toBe(height);
          const top = start > 0 ? 1 : 0;
          const bottom = end < total ? 1 : 0;
          expect(cursor).toBeGreaterThanOrEqual(start + top);
          expect(cursor).toBeLessThan(end - bottom);
        }
      }
    }
  });
});
