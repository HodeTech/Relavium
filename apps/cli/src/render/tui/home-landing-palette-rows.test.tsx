/**
 * The landing's palette block and the rows it takes (MVP-11 unit 7, round 2; `home-view.tsx`'s `landingPaletteRows`, `landingPaletteFill` and
 * `paletteExtra`): the palette opens BELOW the prompt row, and nothing above the prompt row moves when it opens or closes; the rule is under the
 * prompt row and the list under the rule with no blank row between its lines; in the alternate screen the legend stands on the page's last row
 * (the blank rows that keep it there are between the list and the legend), and inline the block is only as tall as it is; and the page is never
 * taller than the terminal less its last row. A notice that was on screen before the palette opened gives the palette the rows it is budgeted.
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
import { HomeView } from './home-view.js';
import { buildPaletteEntries } from './palette-entries.js';
import { openPalette, type OpenPalette } from './palette-reducer.js';

afterEach(cleanup);

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const palette = (count: number): OpenPalette =>
  openPalette(buildPaletteEntries('home', { hasKey: true }).slice(0, count), 'down');
const NO_MATCH: OpenPalette = { ...palette(3), list: { ...palette(3).list, rows: [] } };
const SIZES = [
  [80, 24],
  [100, 30],
  [120, 40],
] as const;

const HOSTED: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-live-0000', cancelling: false },
  last: undefined,
};

interface Draw {
  readonly hosted?: boolean;
  readonly palette?: OpenPalette;
  readonly notice?: string;
  readonly alternateScreen?: boolean;
  readonly showBanner?: boolean;
}

function pageOf(size: readonly [number, number], over: Draw): readonly string[] {
  const open = over.palette !== undefined;
  const view = render(
    <HomeView
      snapshot={EMPTY}
      editor={open ? { text: '/', cursor: 1 } : { text: '', cursor: 0 }}
      notice={over.notice}
      nowMs={NOW}
      cols={size[0]}
      rows={size[1]}
      color={false}
      alternateScreen={over.alternateScreen ?? true}
      showBanner={over.showBanner ?? true}
      {...(over.hosted === true ? { hostedRun: HOSTED } : {})}
      {...(over.palette === undefined ? {} : { palette: over.palette, paletteOpen: true })}
    />,
  );
  const lines = (view.lastFrame() ?? '')
    .replace(SGR, '')
    .split('\n')
    .map((row) => row.trimEnd());
  view.unmount();
  return lines;
}

/** The index of the prompt row: the row with the example when nothing is typed, the one with the query when the palette is open. */
const promptRowOf = (page: readonly string[]): number =>
  page.findIndex((row) => /^\s+> (e\.g\.|\/)/u.test(row));

describe.each(SIZES)('at %i×%i in the alternate screen', (cols, rows) => {
  const size = [cols, rows] as const;

  it.each([
    ['three entries', palette(3)],
    ['twelve entries', palette(12)],
    ['a query that matches nothing', NO_MATCH],
  ] as const)(
    '%s: nothing above the prompt row moves, the rule is under it, the legend is the page’s last row',
    (_name, open) => {
      const rest = pageOf(size, {});
      const shown = pageOf(size, { palette: open });
      const at = promptRowOf(shown);
      expect(at, 'the prompt row').toBe(promptRowOf(rest));
      expect(shown.slice(0, at)).toEqual(rest.slice(0, at));
      // the test terminal is 100 columns wide: a rule drawn for more ends in an ellipsis
      expect(shown[at + 1]?.trim(), 'the rule').toMatch(/^[-─]{10,}…?$/u);
      expect(shown).toHaveLength(rows - 1);
      expect(shown[shown.length - 1]?.trim(), 'the legend').toMatch(/Esc close$/u);
    },
  );

  it('the list’s lines follow the rule with no blank row among them, and the blank rows that keep the legend on the last row are after the list', () => {
    const shown = pageOf(size, { palette: palette(3) });
    const at = promptRowOf(shown);
    const list = shown.slice(at + 2, at + 5);
    expect(list.map((row) => /\/[a-z]+/u.exec(row)?.[0])).toEqual([
      '/resume',
      '/run',
      '/workflows',
    ]);
    expect(shown.slice(at + 5, -1).every((row) => row === '')).toBe(true);
  });

  it('a long list is a window of at most half the terminal, and the rows it does not show are counted by its marker', () => {
    const shown = pageOf(size, { palette: palette(12) });
    const at = promptRowOf(shown);
    const block = shown.slice(at + 2);
    expect(shown.length - at).toBeLessThanOrEqual(Math.floor(rows / 2) + 1);
    const entries = block.filter((row) => /^\s+(> )?\/[a-z]+ /u.test(row)).length;
    const hidden = Number(
      block.map((row) => /^\s+v (\d+) more$/u.exec(row)?.[1]).find(Boolean) ?? 0,
    );
    expect(entries + hidden).toBe(12);
  });

  it('a notice that was on screen gives the palette the rows it is budgeted: its list keeps its rows, and the notice is the one that is paged shorter', () => {
    const notice = Array.from({ length: 40 }, (_, n) => `notice line ${String(n)}`).join('\n');
    const bare = pageOf(size, { palette: palette(12) });
    const shown = pageOf(size, { palette: palette(12), notice });
    expect(shown).toHaveLength(rows - 1);
    expect(shown[shown.length - 1]?.trim()).toMatch(/Esc close$/u);
    // the blank row that keeps the legend on the last row is slack, so it is the list (its entries and its marker) that keeps its rows
    const listLines = (page: readonly string[]): number =>
      page.filter((row) => /^\s+(> )?\/[a-z]+ |^\s+v \d+ more$/u.test(row)).length;
    expect(listLines(shown), 'the palette’s list, entries and marker').toBe(listLines(bare));
    const noticeRowsOf = (page: readonly string[]): number =>
      page.filter((row) => /^\s+(notice line \d+|Notice \d+–\d+ of 40.*)$/u.test(row)).length;
    expect(noticeRowsOf(shown)).toBeGreaterThan(0);
    expect(noticeRowsOf(shown)).toBeLessThan(noticeRowsOf(pageOf(size, { notice })));
  });
});

describe.each(SIZES)('at %i×%i beside a hosted run’s row', (cols, rows) => {
  const size = [cols, rows] as const;

  it('the run’s row is counted as at rest when the palette opens: the head does not move, and the legend is still the last row', () => {
    const rest = pageOf(size, { hosted: true });
    const shown = pageOf(size, { hosted: true, palette: palette(3) });
    const at = promptRowOf(shown);
    expect(at).toBe(promptRowOf(rest));
    expect(shown.slice(0, at)).toEqual(rest.slice(0, at));
    expect(shown).toHaveLength(rows - 1);
    expect(shown[shown.length - 1]?.trim()).toMatch(/Esc close$/u);
    expect(rest.some((row) => /run-live\s+·\s+running/u.test(row))).toBe(true);
    expect(shown.some((row) => /run-live\s+·\s+running/u.test(row))).toBe(false);
  });
});

describe('inline, where nothing blank is pushed into the terminal’s scrollback', () => {
  it('the block is only as tall as it is: the legend follows the list at once', () => {
    const shown = pageOf([80, 24], { palette: palette(3), alternateScreen: false });
    const at = promptRowOf(shown);
    expect(shown).toHaveLength(at + 2 + 3 + 1);
    expect(shown[shown.length - 1]?.trim()).toMatch(/Esc close$/u);
    expect(shown.slice(at + 2).some((row) => row === '')).toBe(false);
  });
});

describe('the one-line title in place of the block', () => {
  it('the palette opens below the prompt row there too, and the legend is the last row', () => {
    const shown = pageOf([80, 24], { palette: palette(3), showBanner: false });
    const at = promptRowOf(shown);
    expect(at).toBeGreaterThan(0);
    expect(shown).toHaveLength(23);
    expect(shown[shown.length - 1]?.trim()).toMatch(/Esc close$/u);
  });
});
