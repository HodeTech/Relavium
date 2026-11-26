/**
 * Which row of the prompt carries its glyph, and the width a windowed draft is cut to (MVP-11 unit 7, round 2; `prompt-view.tsx`):
 *
 * - only the FIRST row of the draft has the glyph; every other row hangs under the text with spaces, whatever the length of the line before it
 *   (the rows are keyed by their start offset, and a row whose key came out 0 would be taken for the first: a first line of one character, or
 *   an empty one, put the glyph on the second row), and a window that has scrolled past the first row has the glyph on none of its rows;
 * - a windowed draft is cut to the host's columns LESS the lead's (the rows are measured where they are drawn, behind the glyph), so lines that
 *   fit the whole row but not the room behind the lead wrap, and a window of that many rows is drawn; an absent width is 80.
 */
import './force-color.js';

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { PromptEditor } from './prompt-view.js';

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');
/** The rows of a drawn frame with the styling taken out and the trailing blanks trimmed. */
const rowsOf = (frame: string | undefined): readonly string[] =>
  (frame ?? '')
    .replace(SGR, '')
    .split('\n')
    .map((row) => row.trimEnd());

function draw(
  text: string,
  cursor: number,
  bound?: { readonly columns?: number; readonly maxRows: number },
): readonly string[] {
  const view = render(
    <PromptEditor
      editor={{ text, cursor }}
      color={false}
      {...(bound === undefined ? {} : { maxRows: bound.maxRows })}
      {...(bound?.columns === undefined ? {} : { columns: bound.columns })}
    />,
  );
  const rows = rowsOf(view.lastFrame());
  view.unmount();
  return rows;
}
const lines = (count: number, width: number): string =>
  Array.from({ length: count }, () => 'a'.repeat(width)).join('\n');

describe('only the first row of the draft carries the glyph', () => {
  it('a first line of one character: the second row hangs under it, it is not a first row', () => {
    expect(draw('a\nb', 3)).toEqual(['> a', '  b']);
  });

  it('the cursor on the first character of the first line: the second row still hangs under it', () => {
    expect(draw('a\nb', 0)).toEqual(['> a', '  b']);
    expect(draw('xab\nc', 0)).toEqual(['> xab', '  c']);
    expect(draw('xab\nc', 1)).toEqual(['> xab', '  c']);
  });

  it('an empty first line: the second row hangs under it', () => {
    expect(draw('\nb', 2)).toEqual(['>', '  b']);
  });

  it('three lines of different lengths, the cursor on the last', () => {
    expect(draw('ab\nc\n\nlast', 9)).toEqual(['> ab', '  c', '', '  last']);
  });

  const NINE = Array.from({ length: 9 }, (_, n) => `L${String(n)}`).join('\n');
  it('a window that starts at the first row has the glyph on it, and one that has scrolled past it has the glyph on none', () => {
    // the marker is in its plain form (`v`): there is no colour
    expect(draw(NINE, 0, { maxRows: 3, columns: 20 })).toEqual(['> L0', '  L1', '  v 7 more']);
    const scrolled = draw(NINE, NINE.length, { maxRows: 3, columns: 20 });
    expect(scrolled).toHaveLength(3);
    expect(scrolled.filter((row) => row.startsWith('>'))).toEqual([]);
    expect(scrolled.slice(1)).toEqual(['  L7', '  L8']);
  });
});

describe('a windowed draft is cut to the columns less the lead', () => {
  const text = (count: number, width: number): string => lines(count, width);

  it('three lines that fill the room behind the lead exactly (18 of 20 columns, a lead of 2) are three rows: no window', () => {
    expect(draw(text(3, 17), -1, { maxRows: 3, columns: 20 }).join('\n')).not.toMatch(/more/u);
  });

  it('three lines of 19 columns do not fit behind the lead (they wrap to six rows): drawn as a window of three', () => {
    const rows = draw(text(3, 19), -1, { maxRows: 3, columns: 20 });
    expect(rows.join('\n')).toMatch(/more/u);
    expect(rows).toHaveLength(3);
  });

  it('an absent width is 80: three lines of 78 fit behind the lead, of 79 do not', () => {
    expect(draw(text(3, 78), -1, { maxRows: 3 }).join('\n')).not.toMatch(/more/u);
    expect(draw(text(3, 79), -1, { maxRows: 3 }).join('\n')).toMatch(/more/u);
  });
});
