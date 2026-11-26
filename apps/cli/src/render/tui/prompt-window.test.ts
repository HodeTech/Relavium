import { describe, expect, it } from 'vitest';

import { PROMPT_WINDOW_MIN_ROWS, promptWindow, type PromptWindowLine } from './prompt-window.js';

/**
 * The window of a long draft (OB7-M3): the pure arithmetic behind `PromptEditor`'s `maxRows`. A draft that does not fit its bound is drawn as the
 * rows around the cursor, with a `▲ N more` / `▼ N more` marker in place of the first or last row when rows are hidden on that side; a draft that
 * fits is not windowed at all (`undefined`), so its drawing is the unbounded editor's, byte for byte.
 */
const identity = (text: string): string => text;

/** A draft of `count` lines, `line 1` .. `line N`, and the offset of the START of line `at` (1-based). */
const draft = (count: number): string =>
  Array.from({ length: count }, (_unused, index) => `line ${String(index + 1)}`).join('\n');
const startOf = (text: string, line: number): number =>
  text
    .split('\n')
    .slice(0, line - 1)
    .join('\n').length + (line > 1 ? 1 : 0);

const lineText = (line: PromptWindowLine): string =>
  line.kind === 'more'
    ? `${line.side === 'above' ? '^' : 'v'}${String(line.count)}`
    : `${line.row.before}${line.row.at === undefined ? '' : `[${line.row.at}]`}${line.row.after}`;
const texts = (lines: readonly PromptWindowLine[] | undefined): string[] =>
  (lines ?? []).map(lineText);

describe('a draft that fits the bound is not windowed', () => {
  it('answers undefined for a draft of exactly the bound, and for an empty one', () => {
    expect(promptWindow(draft(8), 0, 80, 8, identity)).toBeUndefined();
    expect(promptWindow('', 0, 80, 8, identity)).toBeUndefined();
    expect(promptWindow(draft(2), 3, 80, 8, identity)).toBeUndefined();
  });

  it('counts the rows a long line wraps to, not its lines', () => {
    // 100 characters at 20 columns are 5 rows: they fit a bound of 5 and do not fit 4
    expect(promptWindow('x'.repeat(100), 0, 20, 5, identity)).toBeUndefined();
    expect(promptWindow('x'.repeat(100), 0, 20, 4, identity)).toBeDefined();
  });
});

describe('a draft that does not fit is windowed around the cursor', () => {
  it('shows the end of a 30-line draft, with the cursor on its last row and a marker for the 23 above', () => {
    const text = draft(30);
    const lines = promptWindow(text, text.length, 80, 8, identity);
    expect(lines).toHaveLength(8);
    expect(texts(lines)).toEqual([
      '^23',
      'line 24',
      'line 25',
      'line 26',
      'line 27',
      'line 28',
      'line 29',
      'line 30[ ]',
    ]);
  });

  it('shows the start of the draft with a marker for what is below when the cursor is at the top', () => {
    const lines = promptWindow(draft(30), 0, 80, 8, identity);
    expect(texts(lines)).toEqual([
      '[l]ine 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'v23',
    ]);
  });

  it('follows the cursor up and down: the row it is on is always in the window and never on a marker', () => {
    const text = draft(30);
    for (let line = 1; line <= 30; line += 1) {
      for (const maxRows of [3, 4, 6, 8, 11]) {
        const lines = promptWindow(text, startOf(text, line), 80, maxRows, identity) ?? [];
        const at = lines.findIndex((entry) => entry.kind === 'row' && entry.row.at !== undefined);
        expect(at, `line ${String(line)}, ${String(maxRows)} rows`).toBeGreaterThanOrEqual(0);
        expect(lines).toHaveLength(Math.max(PROMPT_WINDOW_MIN_ROWS, maxRows));
        const row = lines[at];
        expect(row?.kind === 'row' ? row.row.before + row.row.at + row.row.after : '').toBe(
          `line ${String(line)}`,
        );
      }
    }
  });

  it('accounts for every row: those drawn plus those the markers stand for (each counts the row it replaced) are the whole draft', () => {
    const text = draft(30);
    for (const cursor of [0, startOf(text, 12), text.length]) {
      const lines = promptWindow(text, cursor, 80, 8, identity) ?? [];
      const drawn = lines.filter((line) => line.kind === 'row').length;
      const hidden = lines.reduce(
        (sum, line) => sum + (line.kind === 'more' ? line.count - 1 : 0),
        0,
      );
      expect(drawn + hidden + lines.filter((line) => line.kind === 'more').length).toBe(30);
    }
  });

  it('marks the first row of the draft only when it is in the window', () => {
    const text = draft(30);
    const top = promptWindow(text, 0, 80, 8, identity) ?? [];
    expect(top[0]?.kind === 'row' && top[0].row.first).toBe(true);
    const bottom = promptWindow(text, text.length, 80, 8, identity) ?? [];
    expect(bottom.some((line) => line.kind === 'row' && line.row.first)).toBe(false);
  });

  it('never has fewer than three lines, whatever the bound', () => {
    for (const maxRows of [0, 1, 2, -5, Number.NaN]) {
      const lines = promptWindow(draft(30), 40, 80, maxRows, identity) ?? [];
      expect(lines).toHaveLength(PROMPT_WINDOW_MIN_ROWS);
    }
  });

  it('windows a single very long line by its wrapped rows and keeps the cursor at its end in view', () => {
    const text = `${'a'.repeat(300)}END`;
    const lines = promptWindow(text, text.length, 40, 6, identity) ?? [];
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatchObject({ kind: 'more', side: 'above' });
    const last = lines.at(-1);
    expect(last?.kind === 'row' ? last.row.before : '').toMatch(/END$/u);
    expect(last?.kind === 'row' ? last.row.at : undefined).toBe(' ');
  });

  it('puts the cursor on the next row when the text fills its row exactly: the block is where the next character goes', () => {
    const text = `${'b'.repeat(40)}\nsecond line\nthird line\nfourth\nfifth\nsixth`;
    const lines = promptWindow(text, 40, 40, 4, identity) ?? [];
    const cursorRows = lines.filter((line) => line.kind === 'row' && line.row.at !== undefined);
    expect(cursorRows).toHaveLength(1);
  });

  it('draws no cursor when none is drawn (offset -1) and shows the end of the draft', () => {
    const lines = promptWindow(draft(30), -1, 80, 6, identity) ?? [];
    expect(lines.some((line) => line.kind === 'row' && line.row.at !== undefined)).toBe(false);
    expect(texts(lines).at(-1)).toBe('line 30');
  });

  it('keeps the cursor block visible as a space when the character under it is scrubbed away', () => {
    const drop = (text: string): string => text.split('Z').join('');
    const text = `${draft(30)}\nZ`;
    const lines = promptWindow(text, text.length - 1, 80, 6, drop) ?? [];
    expect(texts(lines).at(-1)).toBe('[ ]');
  });

  it('measures what is drawn: the scrub is applied before the rows are cut', () => {
    const drop = (text: string): string => text.split('ZZ').join('');
    const text = `${'ZZ'.repeat(200)}${'c'.repeat(30)}`;
    // the scrub removes 400 columns that were never drawn: unscrubbed they would be 11 rows at 40 columns, scrubbed the 30 visible characters are one row
    // (the cursor at the start, where the text is after it, and at the end, where it is before it: both segments are scrubbed)
    expect(promptWindow(text, 0, 40, 4, drop)).toBeUndefined();
    expect(promptWindow(text, text.length, 40, 4, drop)).toBeUndefined();
  });
});
