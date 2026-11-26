/**
 * The inline chat's intro (a resume banner, the `/clear` notice, a model-switch line) is word-wrapped to the terminal's width before it is printed
 * above the live region, so a row never runs past the edge (`emitIntro`'s `columns`). A width is a number of at least one column: a terminal that
 * reports exactly ONE column is a width like any other and is wrapped to it, while an absent width, zero, a negative one or a number that is not
 * one fall back to the 80 columns the wrap assumes (MVP-11 unit 7, round 1: the mutation sweep's ci022, where `columns >= 1` loosened to
 * `columns > 1` survived: at exactly one column the intro was printed unwrapped).
 */
import { describe, expect, it } from 'vitest';

import { emitIntro } from './chat-ink.js';

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

  it('a line that fits is written as it is, newline included', () => {
    expect(written('aaaa bbbb', 80)).toEqual(['aaaa bbbb\n']);
  });

  it('with no width, or none that is a width, it wraps to 80 columns: a short line is untouched, a longer one is cut at 80', () => {
    const short = 'aaaa bbbb cccc';
    const long = `${'a'.repeat(79)} ${'b'.repeat(10)}`;
    for (const columns of [undefined, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const label = `columns=${String(columns)}`;
      expect(written(short, columns), label).toEqual([`${short}\n`]);
      expect(written(long, columns), label).toEqual([`${'a'.repeat(79)}\n${'b'.repeat(10)}\n`]);
    }
  });
});
