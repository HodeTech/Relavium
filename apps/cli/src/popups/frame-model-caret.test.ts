/**
 * Review round 3: the caret of a page of lines that overflows its page (unit 8 fix wave 2, P2-1). Its highlight is drawn wherever it
 * stands, as a highlight (the `selected` kind, which the painter styles), not only as the marker glyph; a page that fits, and a list whose rows
 * cannot act, draw no highlight on a line that cannot act.
 */
import { describe, expect, it } from 'vitest';

import { withGlyphForm } from '../render/tui/glyphs.js';
import { popupBody, type PopupContent, type PopupListRow } from './frame-model.js';

const GEOMETRY = { bodyRows: 8, listRows: 8, innerWidth: 60 } as const;

const line = (index: number): PopupListRow => ({
  id: `l${String(index)}`,
  label: `line ${String(index)}`,
  section: true,
  enabled: false,
});
const run = (index: number): PopupListRow => ({
  id: `run:${String(index)}`,
  label: `run ${String(index)}`,
});
const page = (...rows: PopupListRow[]): PopupContent => ({ kind: 'list', page: true, rows });

const drawn = (content: PopupContent, selected: number) =>
  withGlyphForm(false, () => popupBody(content, { selected, offset: 0 }, GEOMETRY).lines);

describe('the caret of a page of lines', () => {
  const overflowing = page(...Array.from({ length: 20 }, (_, at) => line(at)), run(0), run(1));

  it.each([3, 9, 15])(
    'a page that overflows draws the highlight on line %s, a line that cannot act: one row, in the highlight’s kind, led by the marker',
    (at) => {
      const lines = drawn(overflowing, at);
      const selected = lines.filter((entry) => entry.kind === 'selected');
      expect(selected).toHaveLength(1);
      expect(selected[0]?.text).toMatch(new RegExp(`^› line ${String(at)}\\b`, 'u'));
      expect(lines.filter((entry) => entry.text.startsWith('› '))).toHaveLength(1);
    },
  );

  it('a page that fits draws no highlight on its title (it opens with nothing highlighted)', () => {
    const fits = page(line(0), line(1), line(2), run(0), run(1));
    const lines = drawn(fits, 0);
    expect(lines.filter((entry) => entry.kind === 'selected')).toEqual([]);
    expect(lines.filter((entry) => entry.text.startsWith('›'))).toEqual([]);
    // A highlight on a run of the page that fits is the ordinary one.
    expect(drawn(fits, 3).filter((entry) => entry.kind === 'selected')).toHaveLength(1);
  });

  it('the boundary is the rows the page is drawn in: exactly that many lines fit (no highlight on the title), one more overflows (a highlight)', () => {
    const exactly = page(...Array.from({ length: 6 }, (_, at) => line(at)), run(0), run(1));
    const oneMore = page(...Array.from({ length: 7 }, (_, at) => line(at)), run(0), run(1));
    expect(GEOMETRY.bodyRows).toBe(8);
    expect(drawn(exactly, 0).filter((entry) => entry.kind === 'selected')).toEqual([]);
    expect(drawn(oneMore, 0).filter((entry) => entry.kind === 'selected')).toHaveLength(1);
  });

  it('a plain list of rows that cannot act draws no highlight either', () => {
    const none: PopupContent = { kind: 'list', rows: [line(0), line(1), line(2)] };
    expect(drawn(none, 0).filter((entry) => entry.kind === 'selected')).toEqual([]);
    // Longer than its page too: only a page of lines draws its highlight on a line that cannot act.
    const long: PopupContent = {
      kind: 'list',
      rows: Array.from({ length: 12 }, (_, at) => line(at)),
    };
    expect(drawn(long, 4).filter((entry) => entry.kind === 'selected')).toEqual([]);
  });
});
