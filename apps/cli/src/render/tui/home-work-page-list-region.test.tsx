/**
 * The work page's list region (MVP-11 unit 7, round 2; `home-work-page.tsx`): a row that is cut is cut to exactly the room behind its indent and
 * marker, so it fills the width the page has (a row narrower than that gives up columns the person could have read); a section whose rows were
 * counted but not all loaded says how many are left, even when it is one (`▼ 1 more · /resume`: the one row cannot be drawn, so the marker
 * stays and says where it is); and a page with Attention alone has no `Continue` heading and no blank row for it.
 */
import { vi } from 'vitest';

// Ink draws colour only when the terminal supports it, and the test runs on none: the level is forced before ink is first loaded.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { ParkedRunRow } from './home-attention.js';
import { HomeView } from './home-view.js';
import { displayWidth } from './viewport.js';

afterEach(cleanup);

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const run = (n: number, slug: string = `wf-${String(n)}`): HomeRunRow => ({
  runId: `run-${String(n)}-0000-4000-8000-000000000000`,
  workflowSlug: slug,
  status: 'completed',
  createdAt: ago(n * 30 + 5),
  startedAt: ago(n * 30 + 5),
  completedAt: ago(n * 30),
  totalCostMicrocents: 0,
});
const session = (n: number, title: string): HomeSessionRow => ({
  sessionId: `session-${String(n)}`,
  title,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: ago(n * 10),
  totalCostMicrocents: 0,
});
const snapshotOf = (over: Partial<HomeSnapshot>): HomeSnapshot => ({
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: false,
  ...over,
});
const parked = (n: number, workflow: string): ParkedRunRow => ({
  runId: `p${String(n)}-0000-4000-8000-000000000000`,
  kind: 'approval',
  gates: 1,
  workflow,
});

/** The work page as drawn, row by row, the styling taken out and the trailing blanks trimmed. */
function pageOf(
  snapshot: HomeSnapshot,
  parkedRuns: readonly ParkedRunRow[],
  size: readonly [number, number],
): readonly string[] {
  const view = render(
    <HomeView
      page="work"
      snapshot={snapshot}
      parkedRuns={parkedRuns}
      editor={{ text: '', cursor: 0 }}
      nowMs={NOW}
      cols={size[0]}
      rows={size[1]}
      color={false}
      alternateScreen
    />,
  );
  const rows = (view.lastFrame() ?? '')
    .replace(SGR, '')
    .split('\n')
    .map((row) => row.trimEnd());
  view.unmount();
  return rows;
}

describe('a row that is cut fills the width of the page', () => {
  it.each([
    [80, 24],
    [100, 30],
  ] as const)(
    'at %i×%i: a session titled longer than any row ends at the last column',
    (cols, rows) => {
      // a session's title is bounded by the row alone (a run's workflow is bounded to 40 columns on any row), so the cut row is the room exactly
      const page = pageOf(
        snapshotOf({
          recentSessions: [session(1, 'S'.repeat(150))],
          totals: { attention: 0, sessions: 1, runs: 0 },
        }),
        [],
        [cols, rows],
      );
      const row = page.find((line) => line.includes('SSS'));
      expect(row).toBeDefined();
      expect(displayWidth(row ?? '')).toBe(cols);
    },
  );
});

describe('a section whose rows were counted and not all loaded', () => {
  it('says it when ONE is left: `▼ 1 more` and where the row is, for the sessions and for the runs', () => {
    const page = pageOf(
      snapshotOf({
        recentSessions: [1, 2, 3].map((n) => session(n, `Session ${String(n)}`)),
        recentRuns: [1, 2, 3].map((n) => run(n)),
        totals: { attention: 0, sessions: 4, runs: 4 },
      }),
      [],
      [100, 30],
    );
    expect(page.map((row) => row.trim())).toContain('v 1 more · /resume');
    expect(page.map((row) => row.trim())).toContain('v 1 more · /workflows');
  });
});

describe('Attention alone', () => {
  it('has no `Continue` heading, and no blank row where it would stand', () => {
    const page = pageOf(
      snapshotOf({ totals: { attention: 2, sessions: 0, runs: 0 } }),
      [parked(1, 'release'), parked(2, 'nightly')],
      [80, 24],
    );
    expect(page.map((row) => row.trim())).not.toContain('Continue');
    expect(page[1]?.trim()).toBe('Attention required');
    expect(page[2]).toContain('release');
    expect(page[3]).toContain('nightly');
    expect(page[4]?.trim(), 'the rows after the section are blank, not a heading').toBe('');
  });
});
