import { describe, expect, it } from 'vitest';

import { withGlyphForm } from './glyphs.js';
import { callListView, type CallListEntry } from './tool-review-screen.js';
import { displayWidth } from './viewport.js';

/**
 * The details list lines its tool names up in one column in both glyph forms ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §5). Without colour the plain forms are `ok` (two columns), `x`, `/` and `?` (one): the status cell is padded to the widest of them, as
 * every status table of the CLI does, so the path no longer starts at column 18 on a `/` row and 19 on an `ok` row.
 */
const ENTRIES: readonly CallListEntry[] = (
  ['success', 'failure', 'denied', 'unknown', 'running'] as const
).map((outcome, index) => ({
  callId: `call-${String(index)}`,
  toolId: 'edit_file',
  outcome,
  target: `src/file${String(index)}.ts`,
}));

/** Where the tool name starts in each row of the list: the column the status cell leaves. */
function toolColumns(ascii: boolean): number[] {
  const view = withGlyphForm(ascii, () =>
    callListView({ calls: ENTRIES, selected: 2, columns: 80, terminalRows: 24 }),
  );
  expect(view.rows).toHaveLength(ENTRIES.length);
  return view.rows.map((row) => {
    const at = row.text.indexOf('edit_file');
    expect(at, row.text).toBeGreaterThan(0);
    return displayWidth(row.text.slice(0, at));
  });
}

describe('the details list’s status column', () => {
  it('starts every tool name in the same column with colour off (the plain forms, `ok` being two columns)', () => {
    const columns = toolColumns(true);
    expect(new Set(columns), columns.join(', ')).toEqual(new Set([columns[0]]));
    // marker, space, a two-column cell, space: the tool starts at column 5
    expect(columns[0]).toBe(5);
  });

  it('starts every tool name in the same column with colour on (one column for every glyph)', () => {
    const columns = toolColumns(false);
    expect(new Set(columns), columns.join(', ')).toEqual(new Set([columns[0]]));
    expect(columns[0]).toBe(4);
  });

  it('keeps each row inside the width of the list in both forms, and starts the targets in one column too', () => {
    for (const ascii of [true, false]) {
      const view = withGlyphForm(ascii, () =>
        callListView({ calls: ENTRIES, selected: 0, columns: 80, terminalRows: 24 }),
      );
      const targets = view.rows.map((row) =>
        displayWidth(row.text.slice(0, row.text.indexOf('src/'))),
      );
      expect(new Set(targets), targets.join(', ')).toEqual(new Set([targets[0]]));
      for (const row of view.rows) expect(displayWidth(row.text)).toBeLessThanOrEqual(78);
    }
  });
});
