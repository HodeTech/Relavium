import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { CommandGroup, ReplCommand } from '../../commands/repl-commands.js';
import { filterPaletteEntries, type PaletteEntry } from './palette-entries.js';
import type { PaletteLayout, PaletteList } from './palette-reducer.js';
import { PALETTE_NAME_COLUMN_MAX, PaletteView } from './palette-view.js';
import { displayWidth } from './viewport.js';

/**
 * OB7-L8 (the observation of unit 7's chat half): the palette drew `/cost  Show…` next to `/compact  Summarise…`, a description starting wherever its
 * name ended, while the frame it was designed from aligns them. The descriptions of the rows in view now start in ONE column: the widest NAME among
 * the entries the window draws (a name the window hides does not widen it), by display width, never more than {@link PALETTE_NAME_COLUMN_MAX}
 * columns (a name wider than that is cut with the host's `…`), in both layouts. A marker row and a gap row are not entries and are untouched.
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const plain = (text: string): string => text.replace(new RegExp(`${ESC}\\[[\\d;]*m`, 'gu'), '');

const entry = (
  name: string,
  description: string,
  over: { group?: CommandGroup; groupStart?: boolean; reason?: string } = {},
): PaletteEntry => {
  const command: ReplCommand = {
    name,
    label: name,
    description,
    effect: 'read',
    run: () => undefined,
  };
  return {
    command,
    description,
    group: over.group ?? 'work',
    groupStart: over.groupStart ?? false,
    enabled: over.reason === undefined,
    ...(over.reason === undefined ? {} : { reason: over.reason }),
  };
};

const listOf = (entries: readonly PaletteEntry[], layout: PaletteLayout): PaletteList => ({
  entries,
  rows: filterPaletteEntries(entries, ''),
  layout,
});

function drawn(
  entries: readonly PaletteEntry[],
  layout: PaletteLayout,
  index = 0,
  maxRows?: number,
): string[] {
  const view = render(
    <PaletteView
      list={listOf(entries, layout)}
      state={{ query: '', index }}
      color={false}
      {...(maxRows === undefined ? {} : { maxRows })}
    />,
  );
  return plain(view.lastFrame() ?? '').split('\n');
}

/** The display column where the words after a row's name start (the first non-space after the name's own text). */
function descriptionColumn(row: string, name: string): number {
  const at = row.indexOf(name);
  expect(at, row).toBeGreaterThanOrEqual(0);
  const after = row.slice(at + name.length);
  return displayWidth(row.slice(0, at + name.length)) + (after.length - after.trimStart().length);
}

const COMMANDS: readonly PaletteEntry[] = [
  entry('cost', 'What this chat has cost, per model.'),
  entry('compact', 'Summarise earlier turns to free context.'),
  entry('permissions', 'Remembered commands for this project.'),
  entry('trim', 'Drop the oldest turns from the context.'),
  entry('clear', 'End this conversation and start a fresh session.', {
    reason: 'no conversation to clear',
  }),
];
const NAMES = ['/cost', '/compact', '/permissions', '/trim', '/clear'];

describe.each(['down', 'up'] as const)('the description column of a %s palette', (layout) => {
  it('starts in one column for every row in view, the widest name plus two spaces', () => {
    const rows = drawn(COMMANDS, layout);
    const columns = NAMES.map((name) => {
      const row = rows.find((line) => line.includes(name));
      return descriptionColumn(row ?? '', name);
    });
    expect(new Set(columns), rows.join('\n')).toEqual(
      new Set([2 + displayWidth('/permissions') + 2]),
    );
  });

  it('reads the dim row’s reason in the same column, and a no-colour terminal loses nothing', () => {
    const rows = drawn(COMMANDS, layout);
    const dim = rows.find((line) => line.includes('/clear')) ?? '';
    expect(dim).toContain('unavailable · no conversation to clear');
    expect(descriptionColumn(dim, '/clear')).toBe(
      descriptionColumn(rows.find((l) => l.includes('/cost')) ?? '', '/cost'),
    );
  });

  it('does not widen the column for a name the window hides', () => {
    // 14 short names and one long one at the END of the list: a window on the first entries never draws it
    const many = [
      ...Array.from({ length: 14 }, (_unused, index) =>
        entry(`c${String(index)}`, `Does ${String(index)}.`),
      ),
      entry('permissions', 'Remembered commands.'),
    ];
    const top = layout === 'down' ? drawn(many, layout, 0, 9) : drawn(many, layout, 0, 12);
    const row = top.find((line) => line.includes('/c0')) ?? '';
    expect(
      top.some((line) => line.includes('/permissions')),
      top.join('\n'),
    ).toBe(false);
    expect(descriptionColumn(row, '/c0')).toBe(2 + displayWidth('/c0') + 2);
    // and it does when the window moves to it
    const bottom = layout === 'down' ? drawn(many, layout, 14, 9) : drawn(many, layout, 14, 12);
    const last = bottom.find((line) => line.includes('/permissions')) ?? '';
    expect(descriptionColumn(last, '/permissions')).toBe(2 + displayWidth('/permissions') + 2);
  });

  it('cuts a name wider than the column maximum with the host’s ellipsis and aligns the others to the maximum', () => {
    const long = '/an-unreasonably-long-command-name';
    const rows = drawn(
      [entry('an-unreasonably-long-command-name', 'Does a thing.'), entry('ok', 'Fine.')],
      layout,
    );
    const cutRow = rows.find((line) => line.includes('Does a thing.')) ?? '';
    const okRow = rows.find((line) => line.includes('/ok')) ?? '';
    const ELLIPSIS = String.fromCodePoint(0x2026);
    expect(cutRow).toContain(`${long.slice(0, PALETTE_NAME_COLUMN_MAX - 1)}${ELLIPSIS}  Does`);
    expect(cutRow).not.toContain(long);
    expect(descriptionColumn(okRow, '/ok')).toBe(descriptionColumn(cutRow, '…'));
    expect(descriptionColumn(okRow, '/ok')).toBe(2 + PALETTE_NAME_COLUMN_MAX + 2);
  });

  it('measures a name by display width: a wide character takes two columns', () => {
    const wide = String.fromCodePoint(0x65e5, 0x672c, 0x8a9e);
    const rows = drawn([entry(wide, 'Wide.'), entry('abcde', 'Plain.')], layout);
    const wideRow = rows.find((line) => line.includes('Wide.')) ?? '';
    const plainRow = rows.find((line) => line.includes('Plain.')) ?? '';
    // `/` and three ideographs are 7 columns (4 characters), `/abcde` is 6: the column is 7, the wider one by DISPLAY width, and both start in it
    expect(descriptionColumn(wideRow, `/${wide}`)).toBe(2 + 7 + 2);
    expect(descriptionColumn(plainRow, '/abcde')).toBe(2 + 7 + 2);
  });
});

describe('the rows that are not entries', () => {
  it('leaves the ▲/▼ marker and the gap rows as they were', () => {
    const grouped: readonly PaletteEntry[] = [
      ...Array.from({ length: 6 }, (_unused, index) =>
        entry(`g${String(index)}`, `Does ${String(index)}.`, { groupStart: index === 3 }),
      ),
    ];
    const rows = drawn(grouped, 'down', 0, 7);
    expect(
      rows.some((line) => /^ {2}[▼v] \d+ more$/u.test(line)),
      rows.join('\n'),
    ).toBe(true);
  });
});
