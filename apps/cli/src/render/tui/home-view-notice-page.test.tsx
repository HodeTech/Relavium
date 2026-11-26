/**
 * The page of a long notice the Home draws (MVP-11 unit 7, round 2; `home-view.tsx` hands `noticePage` to the layout on both pages): page 0 is
 * the first lines, page 1 the lines after them, each ending in its footer, `Notice 12–22 of 60`, which is one of the rows the notice takes. At
 * 80×24 the landing leaves a notice 12 rows (11 lines and the footer) and the work page, beside a list that keeps a session's rows, 12 too.
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
import { openPalette } from './palette-reducer.js';

afterEach(cleanup);

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const NOTICE = Array.from({ length: 60 }, (_, n) => `notice line number ${String(n)}`).join('\n');
const WITH_A_SESSION: HomeSnapshot = {
  attention: { failedRuns: [] },
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
const EMPTY: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};

function pageOf(page: 'start' | 'work', noticePage: number | undefined): readonly string[] {
  const view = render(
    <HomeView
      snapshot={WITH_A_SESSION}
      parkedRuns={[]}
      editor={{ text: '', cursor: 0 }}
      notice={NOTICE}
      {...(noticePage === undefined ? {} : { noticePage })}
      page={page}
      nowMs={NOW}
      cols={80}
      rows={24}
      color={false}
      alternateScreen
    />,
  );
  const rows = (view.lastFrame() ?? '')
    .replace(SGR, '')
    .split('\n')
    .map((row) => row.trim());
  view.unmount();
  return rows;
}

describe.each(['start', 'work'] as const)('the %s page', (page) => {
  it('page 0 (and no page) is the first lines of the notice and its footer', () => {
    for (const asked of [undefined, 0]) {
      const rows = pageOf(page, asked);
      expect(rows).toContain('notice line number 0');
      expect(rows).toContain('notice line number 10');
      expect(rows).not.toContain('notice line number 11');
      expect(rows).toContain('Notice 1–11 of 60 · PgUp/PgDn read');
    }
  });

  it('page 1 is the lines after them, and the footer says which', () => {
    const rows = pageOf(page, 1);
    expect(rows).not.toContain('notice line number 10');
    expect(rows).toContain('notice line number 11');
    expect(rows).toContain('notice line number 21');
    expect(rows).toContain('Notice 12–22 of 60 · PgUp/PgDn read');
  });
});

describe('what the landing leaves a notice', () => {
  /** The notice's rows on the landing (its lines and its footer), told by the footer: `Notice 1–N of 60` is N lines and the footer. */
  function noticeRows(
    size: readonly [number, number],
    over: { hosted?: boolean; palette?: boolean },
  ): number {
    const open = over.palette === true;
    const view = render(
      <HomeView
        snapshot={EMPTY}
        editor={open ? { text: '/', cursor: 1 } : { text: '', cursor: 0 }}
        notice={NOTICE}
        nowMs={NOW}
        cols={size[0]}
        rows={size[1]}
        color={false}
        alternateScreen
        {...(over.hosted === true ? { hostedRun: HOSTED } : {})}
        {...(open
          ? {
              palette: openPalette(
                buildPaletteEntries('home', { hasKey: true }).slice(0, 12),
                'down',
              ),
              paletteOpen: true,
            }
          : {})}
      />,
    );
    const frame = (view.lastFrame() ?? '').replace(SGR, '').split('\n');
    view.unmount();
    const footer = frame.map((row) => /Notice 1–(\d+) of 60/u.exec(row)?.[1]).find(Boolean);
    return Number(footer) + 1;
  }

  it.each([
    // [columns, rows, with nothing else, beside a hosted run's row, beside an open palette of twelve, both]
    [80, 24, 12, 11, 5, 4],
    [100, 30, 18, 17, 8, 7],
    [120, 40, 28, 27, 16, 15],
  ] as const)(
    'at %i×%i: %i rows; one less beside the hosted run’s row; the palette’s budget less beside an open palette',
    (cols, rows, plain, hosted, palette, both) => {
      const size = [cols, rows] as const;
      expect(noticeRows(size, {})).toBe(plain);
      expect(noticeRows(size, { hosted: true })).toBe(hosted);
      expect(noticeRows(size, { palette: true })).toBe(palette);
      expect(noticeRows(size, { hosted: true, palette: true })).toBe(both);
    },
  );
});
