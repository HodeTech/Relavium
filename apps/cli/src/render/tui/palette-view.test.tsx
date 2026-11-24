import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { CommandGroup, ReplCommand } from '../../commands/repl-commands.js';
import { filterPaletteEntries, type PaletteEntry } from './palette-entries.js';
import type { PaletteLayout, PaletteList } from './palette-reducer.js';
import { PaletteView } from './palette-view.js';

/**
 * The `/` palette as the terminal shows it ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3; the direction, the dim rows and the group gaps are MVP-11 Step 2.2, ADR-0145 §7): the lines of a palette whose entries all fit are the
 * ones it always drew (the literals below are those lines), and a palette given fewer rows than it has entries draws a window of them, with
 * a marker for the entries it hides, the highlighted entry always in it. In a chat the list is drawn bottom-up: the first entry is beside the
 * query line, the last at the top.
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const plain = (text: string): string => text.replace(new RegExp(`${ESC}\\[\\d+m`, 'gu'), '');

const LEGEND = '↑/↓ select · Enter run · Esc close';
/** With nothing to select or run, only the key that closes is named: a legend that listed `↑/↓` and `Enter` would list keys that do nothing. */
const NO_MATCH_LEGEND = 'Esc close';

const command = (name: string, description: string): ReplCommand => ({
  name,
  label: name,
  description,
  effect: 'read',
  run: () => undefined,
});
const entry = (
  name: string,
  description: string,
  over: { group?: CommandGroup; groupStart?: boolean; reason?: string } = {},
): PaletteEntry => ({
  command: command(name, description),
  description,
  group: over.group ?? 'work',
  groupStart: over.groupStart ?? false,
  enabled: over.reason === undefined,
  ...(over.reason === undefined ? {} : { reason: over.reason }),
});

const SHORT: readonly PaletteEntry[] = [
  entry('exit', 'End the chat session.'),
  entry('doctor', 'Check your setup.'),
  entry('models', 'Switch model (opens the catalog picker).'),
];
const MANY: readonly PaletteEntry[] = Array.from({ length: 14 }, (_, index) =>
  entry(`cmd${String(index)}`, `Does thing ${String(index)}.`),
);

/** The list a host builds for `query`: the entries as built and the rows the query leaves, once. */
const listOf = (
  entries: readonly PaletteEntry[],
  layout: PaletteLayout,
  query = '',
): PaletteList => ({ entries, rows: filterPaletteEntries(entries, query), layout });

function lines(
  entries: readonly PaletteEntry[],
  state: { query: string; index: number },
  maxRows?: number,
  layout: PaletteLayout = 'down',
): string[] {
  const view = render(
    <PaletteView
      list={listOf(entries, layout, state.query)}
      state={state}
      color
      {...(maxRows === undefined ? {} : { maxRows })}
    />,
  );
  return plain(view.lastFrame() ?? '').split('\n');
}

describe('a palette whose entries all fit', () => {
  const UNBOUNDED = [
    '',
    '/',
    '› /exit  End the chat session.',
    '  /doctor  Check your setup.',
    '  /models  Switch model (opens the catalog picker).',
    LEGEND,
  ];

  it('is drawn as it always was, with no bound given', () => {
    expect(lines(SHORT, { query: '', index: 0 })).toEqual(UNBOUNDED);
  });

  it.each([6, 7, 24, 100])('is drawn the same with %i rows to draw in', (maxRows) => {
    expect(lines(SHORT, { query: '', index: 0 }, maxRows)).toEqual(UNBOUNDED);
  });

  it('moves the highlight and filters on the name and the description, as it always did', () => {
    expect(lines(SHORT, { query: '', index: 2 }, 24)).toEqual([
      '',
      '/',
      '  /exit  End the chat session.',
      '  /doctor  Check your setup.',
      '› /models  Switch model (opens the catalog picker).',
      LEGEND,
    ]);
    expect(lines(SHORT, { query: 'catalog', index: 0 }, 24)).toEqual([
      '',
      '/catalog',
      '› /models  Switch model (opens the catalog picker).',
      LEGEND,
    ]);
    expect(lines(SHORT, { query: 'zzz', index: 0 }, 6)).toEqual([
      '',
      '/zzz',
      'no matching command',
      NO_MATCH_LEGEND,
    ]);
  });
});

describe('a palette with more entries than rows', () => {
  it('draws a window of the entries, the highlighted one in it, and says how many it hides', () => {
    // 9 rows: the gap, the query and the legend, and six lines of entries.
    const top = lines(MANY, { query: '', index: 0 }, 9);
    expect(top).toEqual([
      '',
      '/',
      '› /cmd0  Does thing 0.',
      '  /cmd1  Does thing 1.',
      '  /cmd2  Does thing 2.',
      '  /cmd3  Does thing 3.',
      '  /cmd4  Does thing 4.',
      '  ▼ 9 more',
      LEGEND,
    ]);
    const bottom = lines(MANY, { query: '', index: 13 }, 9);
    expect(bottom).toEqual([
      '',
      '/',
      '  ▲ 9 more',
      '  /cmd9  Does thing 9.',
      '  /cmd10  Does thing 10.',
      '  /cmd11  Does thing 11.',
      '  /cmd12  Does thing 12.',
      '› /cmd13  Does thing 13.',
      LEGEND,
    ]);
  });

  it('never draws more lines than the rows it was given, and the legend is always the last one', () => {
    for (const maxRows of [4, 5, 6, 9, 12, 16])
      for (const index of [0, 7, 13]) {
        const drawn = lines(MANY, { query: '', index }, maxRows);
        // The gap above the query is the frame's first line, so the frame is the palette's rows.
        expect(drawn.length, `${String(maxRows)} rows, entry ${String(index)}`).toBeLessThanOrEqual(
          maxRows,
        );
        expect(drawn.at(-1)).toBe(LEGEND);
        expect(
          drawn.some((line) => line.startsWith(`› /cmd${String(index)}  `)),
          `${String(maxRows)} rows: the highlighted entry ${String(index)} is drawn`,
        ).toBe(true);
      }
  });

  it('filters first and windows what matches', () => {
    // Five of the fourteen match `thing 1`: three rows of chrome and five of entries fit them, so there is no marker...
    expect(lines(MANY, { query: 'thing 1', index: 0 }, 8)).toEqual([
      '',
      '/thing 1',
      '› /cmd1  Does thing 1.',
      '  /cmd10  Does thing 10.',
      '  /cmd11  Does thing 11.',
      '  /cmd12  Does thing 12.',
      '  /cmd13  Does thing 13.',
      LEGEND,
    ]);
    // ...and with a row fewer the fifth is the one the marker stands on.
    expect(lines(MANY, { query: 'thing 1', index: 0 }, 7)).toEqual([
      '',
      '/thing 1',
      '› /cmd1  Does thing 1.',
      '  /cmd10  Does thing 10.',
      '  /cmd11  Does thing 11.',
      '  ▼ 2 more',
      LEGEND,
    ]);
  });
});

describe('a row that cannot act is drawn dim, with its reason in words (ADR-0145 §7.4)', () => {
  const WITH_DIM: readonly PaletteEntry[] = [
    entry('resume', 'Search saved conversations and continue one.', {
      reason: 'nothing to resume',
    }),
    entry('run', 'Pick a workflow, fill in its inputs and run it after confirmation.'),
    entry('clear', 'End this conversation and start a fresh session.', {
      reason: 'no conversation to clear',
    }),
  ];

  it('reads `unavailable · <reason>` in place of the description, so it reads without colour', () => {
    expect(lines(WITH_DIM, { query: '', index: 1 })).toEqual([
      '',
      '/',
      '  /resume  unavailable · nothing to resume',
      '› /run  Pick a workflow, fill in its inputs and run it after confirmation.',
      '  /clear  unavailable · no conversation to clear',
      LEGEND,
    ]);
  });

  it('keeps the dim row in its place and shows it highlighted when it is all that matched, still with its reason', () => {
    expect(lines(WITH_DIM, { query: 'clear', index: 0 }, 24)).toEqual([
      '',
      '/clear',
      '› /clear  unavailable · no conversation to clear',
      LEGEND,
    ]);
  });

  it('colours a dim row dim from its NAME on, keeps the words, and leaves an enabled row’s name undimmed (a no-colour terminal loses the colour, not the meaning)', () => {
    // An enabled row that is not highlighted, ahead of the dim ones: its description is dim too (every row's is), so what tells the rows
    // apart is the NAME: SGR 2 must open before a dim row's `/resume` and must not before an enabled row's `/doctor`.
    const list = [entry('doctor', 'Check your setup.'), ...WITH_DIM];
    const view = render(
      <PaletteView list={listOf(list, 'down')} state={{ query: '', index: 2 }} color />,
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('unavailable · nothing to resume');
    const before = (name: string): string => {
      const row = frame.split('\n').find((line) => line.includes(`/${name}`));
      if (row === undefined) throw new Error(`no row for /${name}`);
      return row.slice(0, row.indexOf(`/${name}`));
    };
    const DIM = `${ESC}[2m`;
    expect(before('resume'), 'the dim row is dim from its name').toContain(DIM);
    expect(before('clear'), 'and so is the other one').toContain(DIM);
    expect(before('doctor'), 'an enabled row’s name is not dim').not.toContain(DIM);
  });
});

describe('the groups are separated by a blank row when the rows allow, and run together when short (all or none)', () => {
  // Three groups: a b | c d | e. Two gaps.
  const GROUPED: readonly PaletteEntry[] = [
    entry('a', 'first', { groupStart: true }),
    entry('b', 'second'),
    entry('c', 'third', { groupStart: true }),
    entry('d', 'fourth'),
    entry('e', 'fifth', { groupStart: true }),
  ];

  it('draws every gap when every entry and every gap fits', () => {
    expect(lines(GROUPED, { query: '', index: 0 }, 11)).toEqual([
      '',
      '/',
      '› /a  first',
      '  /b  second',
      '',
      '  /c  third',
      '  /d  fourth',
      '',
      '  /e  fifth',
      LEGEND,
    ]);
  });

  it('gives the gaps up first, all of them: with one spare row (two gaps asked) it draws none, and every entry', () => {
    const run = [
      '',
      '/',
      '› /a  first',
      '  /b  second',
      '  /c  third',
      '  /d  fourth',
      '  /e  fifth',
      LEGEND,
    ];
    expect(lines(GROUPED, { query: '', index: 0 }, 9)).toEqual(run);
    expect(lines(GROUPED, { query: '', index: 0 }, 8)).toEqual(run);
  });

  it('never draws a gap for a typed query: a ranked list is not a grouped one', () => {
    const drawn = lines(GROUPED, { query: 'i', index: 0 }, 24);
    expect(drawn.length).toBeGreaterThan(3);
    // The first line is the palette's margin; a blank row anywhere after it would be a gap.
    expect(drawn.slice(1).filter((line) => line.trim() === '')).toEqual([]);
  });

  it('draws the last entry (the row that ends the list) whenever it is highlighted: a gap never costs an entry its row', () => {
    for (const maxRows of [6, 7, 8, 9, 10, 11]) {
      const drawn = lines(GROUPED, { query: '', index: 4 }, maxRows);
      expect(
        drawn.some((line) => line.startsWith('› /e  ')),
        `${String(maxRows)} rows`,
      ).toBe(true);
      expect(drawn.length).toBeLessThanOrEqual(maxRows);
    }
  });
});

describe('in a chat the list runs away from the prompt: the first entry is beside the query line', () => {
  it('draws the legend at the top, the entries reversed, and the query echo at the bottom', () => {
    expect(lines(SHORT, { query: '', index: 0 }, undefined, 'up')).toEqual([
      '',
      LEGEND,
      '  /models  Switch model (opens the catalog picker).',
      '  /doctor  Check your setup.',
      '› /exit  End the chat session.',
      '/',
    ]);
  });

  it('echoes the typed query on the bottom row, where the prompt is', () => {
    expect(lines(SHORT, { query: 'doc', index: 0 }, 24, 'up')).toEqual([
      '',
      LEGEND,
      '› /doctor  Check your setup.',
      '/doc',
    ]);
    expect(lines(SHORT, { query: 'zzz', index: 0 }, 24, 'up')).toEqual([
      '',
      NO_MATCH_LEGEND,
      'no matching command',
      '/zzz',
    ]);
  });

  it('points the markers the way the hidden entries lie on the screen: ▲ for the entries beyond the top, ▼ for those toward the prompt', () => {
    // 9 rows, entry 0 highlighted: the entries beyond the window are the LAST ones, at the top.
    expect(lines(MANY, { query: '', index: 0 }, 9, 'up')).toEqual([
      '',
      LEGEND,
      '  ▲ 9 more',
      '  /cmd4  Does thing 4.',
      '  /cmd3  Does thing 3.',
      '  /cmd2  Does thing 2.',
      '  /cmd1  Does thing 1.',
      '› /cmd0  Does thing 0.',
      '/',
    ]);
    // The last entry highlighted: the entries toward the prompt (the first ones) are hidden below the window.
    expect(lines(MANY, { query: '', index: 13 }, 9, 'up')).toEqual([
      '',
      LEGEND,
      '› /cmd13  Does thing 13.',
      '  /cmd12  Does thing 12.',
      '  /cmd11  Does thing 11.',
      '  /cmd10  Does thing 10.',
      '  /cmd9  Does thing 9.',
      '  ▼ 9 more',
      '/',
    ]);
  });

  it('never draws more lines than the rows it was given, and keeps the highlighted entry in the window', () => {
    for (const maxRows of [4, 6, 9, 12, 20])
      for (const index of [0, 7, 13]) {
        const drawn = lines(MANY, { query: '', index }, maxRows, 'up');
        expect(drawn.length, `${String(maxRows)} rows, entry ${String(index)}`).toBeLessThanOrEqual(
          Math.max(maxRows, 6),
        );
        expect(drawn[1]).toBe(LEGEND);
        expect(drawn.at(-1)).toBe('/');
        expect(drawn.some((line) => line.startsWith(`› /cmd${String(index)}  `))).toBe(true);
      }
  });

  it('draws the gaps between groups the same way, from the bottom', () => {
    const grouped: readonly PaletteEntry[] = [
      entry('a', 'first', { groupStart: true }),
      entry('b', 'second'),
      entry('c', 'third', { groupStart: true }),
    ];
    expect(lines(grouped, { query: '', index: 0 }, 24, 'up')).toEqual([
      '',
      LEGEND,
      '  /c  third',
      '',
      '  /b  second',
      '› /a  first',
      '/',
    ]);
  });
});
