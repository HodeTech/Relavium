import './force-no-color.js';

import { Box, Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ReplCommand } from '../../commands/repl-commands.js';
import { openAtEndOfEachRow, plain, stylesOver } from './emphasis-test-kit.js';
import { settleFrames } from './harness-util.js';
import { HomeView } from './home-view.js';
import { MentionView } from './mention-view.js';
import { filterPaletteEntries, type PaletteEntry } from './palette-entries.js';
import type { PaletteList } from './palette-reducer.js';
import { PaletteView } from './palette-view.js';
import { SheetLinesView } from './sheet-lines-view.js';
import { INITIAL_SCROLL } from './scroll.js';
import type { SheetLine } from './sheet-frame.js';
import { TranscriptViewport } from './transcript-viewport.js';
import type { DisplayLine } from './viewport.js';

/**
 * The selected row of every list, with chalk OFF (`./force-no-color.js`: chalk's level is 0, as under `--no-color`, `FORCE_COLOR=0` and
 * `TERM=dumb`, where ink's own `bold` and `inverse` print nothing) and with the CLI's colour flag both ways ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §5, MVP-11 OD-6: "no colour" means colour only). The selection is the marker AND an inverse row: without colour a selected row is `>`
 * with inverse video, and the rows around it are neither bold nor inverse. The same bytes whatever the flag: nothing is gated.
 */
afterEach(cleanup);

const BOTH = [false, true] as const;

function frameOf(element: ReactElement): string {
  const view = render(element);
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}

const SELECTED = ['bold', 'inverse'];

/** Asserts `needle` is drawn selected in `frame` and each of `others` is drawn with neither bold nor inverse. */
function expectSelected(
  frame: string,
  needle: string,
  others: readonly string[],
  label: string,
): void {
  expect(stylesOver(frame, needle), `${label}: the selected row`).toEqual(SELECTED);
  for (const other of others) {
    const styles = stylesOver(frame, other) ?? [];
    expect(styles, `${label}: ${other}`).not.toContain('inverse');
    expect(styles, `${label}: ${other}`).not.toContain('bold');
  }
  expect(
    openAtEndOfEachRow(frame).every((open) => open.length === 0),
    `${label}: every row closes its styles`,
  ).toBe(true);
}

describe('with chalk off, ink’s own bold and inverse print nothing: the control', () => {
  it('a view that asked ink for them would show the selected row as plain text', () => {
    expect(frameOf(<Text inverse>row</Text>)).toBe('row');
    expect(frameOf(<Text bold>row</Text>)).toBe('row');
  });
});

describe('the / palette', () => {
  const command = (name: string, description: string): ReplCommand => ({
    name,
    label: name,
    description,
    effect: 'read',
    run: () => undefined,
  });
  const entry = (name: string, description: string): PaletteEntry => ({
    command: command(name, description),
    description,
    group: 'work',
    groupStart: false,
    enabled: true,
  });
  const ENTRIES = [entry('run', 'Run a workflow.'), entry('doctor', 'Check your setup.')];
  const list: PaletteList = {
    entries: ENTRIES,
    rows: filterPaletteEntries(ENTRIES, ''),
    layout: 'down',
  };

  it.each(BOTH)(
    'draws the highlighted entry inverse and bold, and the others plain (colour %s)',
    (color) => {
      const frame = frameOf(
        <PaletteView list={list} state={{ query: '', index: 1 }} color={color} />,
      );
      expectSelected(frame, '/doctor', ['/run'], `colour ${String(color)}`);
      // the entry's own words are inverse with it, but not bold
      expect(stylesOver(frame, 'Check your setup')).toEqual(['inverse']);
      expect(plain(frame)).toContain(
        color ? '› /doctor  Check your setup.' : '> /doctor  Check your setup.',
      );
    },
  );

  it('is the same bytes with colour on and off apart from the marker: the weight is not what colour switches', () => {
    const on = frameOf(<PaletteView list={list} state={{ query: '', index: 0 }} color />);
    const off = frameOf(<PaletteView list={list} state={{ query: '', index: 0 }} color={false} />);
    expect(on.replace('›', '>')).toBe(off);
  });
});

describe('the @ mention list', () => {
  const candidates = [
    { name: 'src', type: 'directory' as const, path: 'src' },
    { name: 'app.ts', type: 'file' as const, path: 'app.ts' },
  ];

  it.each(BOTH)(
    'draws the highlighted candidate inverse and bold, and the query echo bold (colour %s)',
    (color) => {
      const frame = frameOf(
        <MentionView
          state={{ dir: '', filter: 'a', candidates, selected: 1, loading: false }}
          color={color}
        />,
      );
      expectSelected(frame, 'app.ts', ['src/'], `colour ${String(color)}`);
      expect(stylesOver(frame, 'a')).toContain('bold');
    },
  );
});

describe('a sheet’s lines', () => {
  const lines: readonly SheetLine[] = [
    { kind: 'row', text: '  node, 1 argument' },
    {
      kind: 'selected',
      text: '› npm, 1 argument   [d] withdraw   2026-11-19',
      spans: [
        { from: 20, to: 23, role: 'danger' },
        { from: 35, to: 45, role: 'dim' },
      ],
    },
    {
      kind: 'row',
      text: 'Defined  │  › Permissions',
      spans: [
        { from: 0, to: 7, role: 'dim' },
        { from: 12, to: 25, role: 'strong', selected: true },
      ],
    },
  ];

  it.each(BOTH)(
    'draws the selected line, its key and the current tab as selected, and a plain line plain (colour %s)',
    (color) => {
      const frame = frameOf(<SheetLinesView lines={lines} color={color} />);
      expect(stylesOver(frame, 'npm, 1 argument')).toEqual(SELECTED);
      expect(stylesOver(frame, '[d]')?.filter((style) => style !== 'colour')).toEqual(SELECTED);
      // the dimmed value of a selected row is inverse with it, and dim only where there is colour to draw it with: not bold
      expect(stylesOver(frame, '2026-11-19')).not.toContain('bold');
      expect(stylesOver(frame, '2026-11-19')).toContain('inverse');
      expect(stylesOver(frame, 'node, 1 argument') ?? []).toEqual([]);
      expect(stylesOver(frame, 'Permissions')?.filter((style) => style !== 'colour')).toEqual(
        SELECTED,
      );
      expect(stylesOver(frame, 'Defined') ?? []).not.toContain('inverse');
      expect(openAtEndOfEachRow(frame).every((open) => open.length === 0)).toBe(true);
    },
  );
});

describe('the Home’s strip', () => {
  const UUID = '0b8f3a52-9d41-4c6e-8a07-5e2d1c9b7f64';
  const homeFrame = (color: boolean): string =>
    frameOf(
      <HomeView
        page="work" // the strip rows are the work page's (MVP-11 unit 7)
        snapshot={{
          failedRuns: [],
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRuns: [],
          totals: { attention: 1, sessions: 0, runs: 0 },
          isEmpty: false,
        }}
        editor={{ text: '', cursor: 0 }}
        nowMs={0}
        cols={100}
        rows={30}
        color={color}
        parkedRuns={[
          { runId: UUID, kind: 'approval', gates: 1 },
          { runId: 'other-run-id-0000', kind: 'approval', gates: 1 },
        ]}
        stripFocus={{ kind: 'run', id: UUID }}
      />,
    );

  it.each(BOTH)(
    'draws the focused parked row by the tinted rule (MVP-11 unit 7): bold with the colour flag on (its tint and `›` carry the rest, no inverse), bold and inverse with it off; the row beside it plain (colour %s)',
    (color) => {
      const frame = homeFrame(color);
      expect(stylesOver(frame, '0b8f3a5')?.filter((style) => style !== 'colour')).toEqual(
        color ? ['bold'] : SELECTED,
      );
      // the neighbour's row names its run by the first eight characters of its id (MVP-11 unit 7)
      const beside = stylesOver(frame, 'other-ru');
      expect(beside, 'the neighbour is drawn').toBeDefined();
      expect(beside ?? []).not.toContain('inverse');
      expect(beside ?? []).not.toContain('bold');
    },
  );
});

describe('the transcript’s mouse selection', () => {
  const rows: DisplayLine[] = Array.from({ length: 6 }, (_, index) => ({
    text: `row ${String(index)} of the reply`,
    style: 'assistant' as const,
  }));

  it.each(BOTH)(
    'is inverse with chalk off, over the selected cells and no others (colour %s)',
    async (color) => {
      const view = render(
        <Box flexDirection="column" height={6}>
          <TranscriptViewport
            lines={rows}
            color={color}
            scroll={INITIAL_SCROLL}
            selection={{ start: { line: 2, column: 4 }, end: { line: 2, column: 4 } }}
            onMeasure={() => undefined}
          />
        </Box>,
      );
      await settleFrames();
      const frame = view.lastFrame() ?? '';
      view.unmount();
      expect(stylesOver(frame, '2')).toEqual(['inverse']);
      expect(plain(frame)).toContain('row 2 of the reply');
      expect(stylesOver(frame, 'row 1') ?? []).toEqual([]);
    },
  );
});
