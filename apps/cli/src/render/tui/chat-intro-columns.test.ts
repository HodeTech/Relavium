/**
 * The inline chat's intro (a resume banner, the `/clear` notice, a model-switch line) is word-wrapped to the terminal's width before it is printed
 * above the live region, so a row never runs past the edge (`emitIntro`'s `columns`). A width is a number of at least one column: a terminal that
 * reports exactly ONE column is a width like any other and is wrapped to it, while an absent width, zero, a negative one or a number that is not
 * one fall back to the 80 columns the wrap assumes (MVP-11 unit 7, round 1: the mutation sweep's ci022, where `columns >= 1` loosened to
 * `columns > 1` survived: at exactly one column the intro was printed unwrapped).
 */
import { describe, expect, it } from 'vitest';

import { chatGrid } from './chat-grid.js';
import { emitIntro } from './chat-ink.js';

/**
 * The intro stands in the content column of the grid (unit 9): `columns` is the terminal's, the rows are wrapped at the content column's width
 * (68 at 80 columns, 84 at 100) and begin `margin` columns from the left edge (6 at 80, 8 from 100). A terminal too narrow for a margin gives it up
 * first, so at one column the intro is as it was.
 */
const gap = (columns: number): string => ' '.repeat(chatGrid(columns).margin);

/** What the inline renderer writes above the live region for `intro` at `columns`. */
function written(intro: string, columns: number | undefined): string[] {
  const outs: string[] = [];
  emitIntro(intro, false, {
    notice: () => undefined,
    writeOut: (text) => void outs.push(text),
    ...(columns === undefined ? {} : { columns }),
  });
  return outs;
}

describe('the inline intro is wrapped to a width of at least one column', () => {
  it('at exactly one column every character is a row of its own', () => {
    expect(written('abc', 1)).toEqual(['a\nb\nc\n']);
  });

  it('at an ordinary width it wraps at the word that does not fit, without the space the break fell on', () => {
    expect(written('aaaa bbbb', 5)).toEqual(['aaaa\nbbbb\n']);
  });

  it('a line that fits is written as it is, in the content column, newline included', () => {
    expect(written('aaaa bbbb', 80)).toEqual([`${gap(80)}aaaa bbbb\n`]);
    expect(written('aaaa bbbb', 100)).toEqual([`${gap(100)}aaaa bbbb\n`]);
  });

  it('wraps at the content column, not at the terminal: 68 columns of text at 80, 84 at 100, with the margin on every row', () => {
    for (const columns of [80, 100, 120]) {
      const grid = chatGrid(columns);
      const text = `${'a'.repeat(grid.content - 1)} ${'b'.repeat(10)}`;
      expect(written(text, columns), `${String(columns)} columns`).toEqual([
        `${gap(columns)}${'a'.repeat(grid.content - 1)}\n${gap(columns)}${'b'.repeat(10)}\n`,
      ]);
      // exactly the content column's width fits the row
      const fits = `${'a'.repeat(grid.content - 2)} b`;
      expect(written(fits, columns), `${String(columns)} columns, fits`).toEqual([
        `${gap(columns)}${fits}\n`,
      ]);
    }
  });

  it('keeps a blank line of the intro blank (no trailing spaces) and the margin on the rows of the others', () => {
    expect(written('aaaa\n\nbbbb', 80)).toEqual([`${gap(80)}aaaa\n\n${gap(80)}bbbb\n`]);
  });

  it('with no width, or none that is a width, it is the 80-column grid: a short line is untouched, a longer one is cut at its 68 columns of text', () => {
    const short = 'aaaa bbbb cccc';
    const long = `${'a'.repeat(67)} ${'b'.repeat(10)}`;
    for (const columns of [undefined, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const label = `columns=${String(columns)}`;
      expect(written(short, columns), label).toEqual([`${gap(80)}${short}\n`]);
      expect(written(long, columns), label).toEqual([
        `${gap(80)}${'a'.repeat(67)}\n${gap(80)}${'b'.repeat(10)}\n`,
      ]);
    }
  });
});
