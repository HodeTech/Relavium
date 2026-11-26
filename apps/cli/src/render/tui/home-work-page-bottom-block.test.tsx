/**
 * The block at the foot of the work page and the rows it is counted as (MVP-11 unit 7, round 2; `workBottomBlock` and `workListBudget` in
 * `home-work-page.tsx`): the list takes what the bottom block, the notice and the head leave, so a block counted as one row more or less than
 * it draws leaves a blank row under the list, pushes the last row of the block off the page, or draws the block a row too high or too low.
 * Each kind of block is pinned by its exact rows, then by the drawn page: `rows − 1` tall, the block's first row where its count puts it, its
 * last row (the hint, the palette's legend, the card's last line) the page's last, and the notice directly above it with one blank row over it.
 */
import { vi } from 'vitest';

// Ink draws colour only when the terminal supports it, and the test runs on none: the level is forced before ink is first loaded.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { EditorState } from './chat-input.js';
import { DOCKED_PLACEHOLDER } from './home-pages.js';
import { HomeView } from './home-view.js';
import { workBottomBlock, type BottomBlock } from './home-work-page.js';
import { buildPaletteEntries } from './palette-entries.js';
import { openPalette, type OpenPalette } from './palette-reducer.js';
import { PaletteAbovePrompt } from './palette-block.js';
import { chatPaletteRows } from './palette-view.js';

afterEach(cleanup);

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const SNAPSHOT: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [
    {
      sessionId: 'session-1',
      title: 'A session',
      agentSlug: 'chat',
      modelId: undefined,
      status: 'ended',
      updatedAt: new Date(NOW - 3_600_000).toISOString(),
      totalCostMicrocents: 0,
    },
  ],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 1, runs: 0 },
  isEmpty: false,
};
const HOSTED: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-live-0000', cancelling: false },
  last: undefined,
};
const editorOf = (text: string): EditorState => ({ text, cursor: text.length });
const lines = (count: number, label: string): string =>
  Array.from({ length: count }, (_, n) => `${label} ${String(n)}`).join('\n');
const palette = (count: number): OpenPalette =>
  openPalette(buildPaletteEntries('home', { hasKey: true }).slice(0, count), 'up');

/** What `workBottomBlock` is asked with when nothing is typed, nothing hosted and no palette is open. */
const BASE = {
  exitGuard: undefined,
  hostedRun: undefined,
  palette: undefined,
  paletteMaxRows: 0,
  editor: editorOf(''),
  cols: 80,
  rows: 24,
  color: false,
} as const;

describe('the docked prompt: its chrome and the editor’s rows', () => {
  const rowsFor = (text: string, rows = 24): number =>
    workBottomBlock({ ...BASE, rows, editor: editorOf(text) }).rows;

  it('a blank row, the prompt, the rule, the status line and the hint: five with an empty draft or one line', () => {
    expect(rowsFor('')).toBe(5);
    expect(rowsFor('one')).toBe(5);
  });

  it('every line of the draft is a row more', () => {
    expect(rowsFor('a\nb')).toBe(6);
    expect(rowsFor('a\nb\nc')).toBe(7);
  });

  it('a long draft is a window of at most the editor’s rows (8 at 80×24, 13 at 100×30), and the chrome is on top of them', () => {
    const ten = lines(10, 'line');
    expect(rowsFor(ten, 24)).toBe(8 + 4);
    expect(rowsFor(ten, 30)).toBe(10 + 4);
    expect(rowsFor(lines(40, 'line'), 30)).toBe(13 + 4);
  });
});

describe('the exit guard: a blank row and the card’s lines', () => {
  const guard = (
    phase: 'confirm' | 'stopping',
    hostedRun: RunHostSnapshot | undefined,
    color = false,
  ): number => workBottomBlock({ ...BASE, hostedRun, exitGuard: phase, color }).rows;

  it('asking about a live run is the blank row and three lines; stopping it is two lines; a card with no run to name is two', () => {
    expect(guard('confirm', HOSTED)).toBe(4);
    expect(guard('stopping', HOSTED)).toBe(3);
    expect(guard('confirm', undefined)).toBe(3);
  });

  it('with colour on it is the same card in the same rows', () => {
    expect(guard('confirm', HOSTED, true)).toBe(4);
    expect(guard('stopping', HOSTED, true)).toBe(3);
  });
});

describe('an open palette: the rows it counts are the rows it draws', () => {
  /** The rows the palette block really draws: its list, the prompt row with the query, the rule and the legend. */
  function drawnRows(open: OpenPalette, maxRows: number): number {
    const view = render(
      <PaletteAbovePrompt palette={open} maxRows={maxRows} ruleColumns={40} color={false} />,
    );
    const rows = (view.lastFrame() ?? '').split('\n').length;
    view.unmount();
    return rows;
  }

  it.each([1, 2, 3, 5, 8, 12])('%i entries, at a budget of 3, 4, 5, 8 and 12 rows', (count) => {
    const open = palette(count);
    for (const maxRows of [3, 4, 5, 8, 12])
      expect(
        workBottomBlock({ ...BASE, palette: open, paletteMaxRows: maxRows }).rows,
        `${String(count)} entries, ${String(maxRows)} rows`,
      ).toBe(drawnRows(open, maxRows));
  });

  it('three entries with room are the three, the prompt row, the rule and the legend', () => {
    expect(workBottomBlock({ ...BASE, palette: palette(3), paletteMaxRows: 8 }).rows).toBe(6);
  });

  it('a query that matches nothing is one line saying so, and the three rows under it', () => {
    const open = palette(3);
    const none: OpenPalette = { ...open, list: { ...open.list, rows: [] } };
    expect(workBottomBlock({ ...BASE, palette: none, paletteMaxRows: 8 }).rows).toBe(4);
    expect(drawnRows(none, 8)).toBe(4);
  });
});

describe('the block, the notice and the list on the drawn page', () => {
  interface Setup {
    readonly name: string;
    readonly text?: string;
    readonly palette?: OpenPalette;
    readonly guard?: 'confirm' | 'stopping';
    /** The text the block's first line holds when it is not blank, and the one the second does: how the block is told from the list above it. */
    readonly first: RegExp | '';
    readonly second: RegExp;
  }
  const SETUPS: readonly Setup[] = [
    { name: 'the docked prompt', first: '', second: /^> type a message/u },
    { name: 'a draft of three lines', text: 'a\nb\nc', first: '', second: /^> a$/u },
    // the window starts in the middle of the draft: its first row is the marker of the rows above it
    {
      name: 'a long draft, windowed',
      text: lines(14, 'draft'),
      first: '',
      second: /^\^ \d+ more$/u,
    },
    {
      name: 'the exit guard asking',
      guard: 'confirm',
      first: '',
      second: /^! A workflow run is executing/u,
    },
    {
      name: 'the exit guard stopping',
      guard: 'stopping',
      first: '',
      second: /^# Stopping the run/u,
    },
    { name: 'a palette of three', palette: palette(3), text: '/', first: /^\/|^>/u, second: /\S/u },
    { name: 'a palette of twelve', palette: palette(12), text: '/', first: /\S/u, second: /\S/u },
  ];

  function drawn(
    setup: Setup,
    size: readonly [number, number],
    notice?: string,
  ): { readonly page: readonly string[]; readonly bottom: BottomBlock } {
    const [cols, rows] = size;
    const editor = editorOf(setup.text ?? '');
    const view = render(
      <HomeView
        page="work"
        snapshot={SNAPSHOT}
        parkedRuns={[]}
        editor={editor}
        notice={notice}
        nowMs={NOW}
        cols={cols}
        rows={rows}
        color={false}
        alternateScreen
        {...(setup.guard === undefined ? {} : { exitGuard: setup.guard, hostedRun: HOSTED })}
        {...(setup.palette === undefined ? {} : { palette: setup.palette, paletteOpen: true })}
      />,
    );
    const page = (view.lastFrame() ?? '')
      .replace(SGR, '')
      .split('\n')
      .map((row) => row.trimEnd());
    view.unmount();
    const bottom = workBottomBlock({
      exitGuard: setup.guard,
      hostedRun: setup.guard === undefined ? undefined : HOSTED,
      palette: setup.palette,
      paletteMaxRows: setup.palette === undefined ? 0 : chatPaletteRows(rows, setup.palette.list),
      editor,
      cols,
      rows,
      color: false,
    });
    return { page, bottom };
  }

  describe.each([
    [80, 24],
    [100, 30],
  ] as const)('at %i×%i', (cols, rows) => {
    it.each(SETUPS)(
      '$name: the page is rows − 1 tall and the block fills its last rows',
      (setup) => {
        const { page, bottom } = drawn(setup, [cols, rows]);
        expect(page).toHaveLength(rows - 1);
        const top = page.length - bottom.rows;
        expect(page[page.length - 1], 'the page ends on the last row of the block').not.toBe('');
        expect(page[top]?.trim() ?? '', 'the first row of the block').toMatch(
          setup.first === '' ? /^$/u : setup.first,
        );
        expect(page[top + 1]?.trim() ?? '', 'the second row of the block').toMatch(setup.second);
        expect(page[0]?.trim(), 'the way back').toBe('↑ start page');
      },
    );

    it('a notice sits directly above the docked prompt, with one blank row over it, and the list is what is left', () => {
      const notice = 'First line of the notice\nSecond line';
      const { page, bottom } = drawn(
        SETUPS[0] ?? { name: '', first: '', second: /./u },
        [cols, rows],
        notice,
      );
      const top = page.length - bottom.rows;
      expect(page.slice(top - 2, top).map((row) => row.trim())).toEqual([
        'First line of the notice',
        'Second line',
      ]);
      expect(page[top - 3]?.trim(), 'the blank row over the notice').toBe('');
      expect(page.slice(1, 5).some((row) => row.includes('A session'))).toBe(true);
    });

    it('a long notice that pages ends in its footer, directly above the block', () => {
      const notice = lines(30, 'notice line');
      const { page, bottom } = drawn(
        SETUPS[0] ?? { name: '', first: '', second: /./u },
        [cols, rows],
        notice,
      );
      const top = page.length - bottom.rows;
      expect(page[top - 1]?.trim()).toMatch(/^Notice \d+–\d+ of 30/u);
      expect(page[top - 2]?.trim()).toMatch(/^notice line \d+$/u);
      const first = page.findIndex((row) => row.trim() === 'notice line 0');
      expect(first, 'the notice starts under a blank row').toBeGreaterThan(0);
      expect(page[first - 1]?.trim()).toBe('');
    });
  });
});

describe('the docked prompt draws its cursor only while it has the focus', () => {
  const INVERSE = `${String.fromCharCode(27)}[7m`;
  function promptLine(focused: boolean, text: string): string {
    const view = render(
      <HomeView
        page="work"
        snapshot={SNAPSHOT}
        parkedRuns={[]}
        editor={editorOf(text)}
        nowMs={NOW}
        cols={80}
        rows={24}
        color={false}
        alternateScreen
        {...(focused ? {} : { stripFocus: { kind: 'session', id: 'session-1' } })}
      />,
    );
    const frame = (view.lastFrame() ?? '').split('\n');
    view.unmount();
    const line = frame.find((row) =>
      row.replace(SGR, '').includes(text === '' ? DOCKED_PLACEHOLDER : text),
    );
    if (line === undefined) throw new Error('no prompt row');
    return line;
  }

  it('the inverse cursor cell is on the prompt row with no list row focused, and not with one focused', () => {
    expect(promptLine(true, 'draft')).toContain(INVERSE);
    expect(promptLine(false, 'draft')).not.toContain(INVERSE);
    expect(promptLine(true, '')).toContain(INVERSE);
    expect(promptLine(false, '')).not.toContain(INVERSE);
  });
});
