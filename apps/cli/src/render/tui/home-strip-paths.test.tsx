import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { displayWidth } from './viewport.js';
import { withoutStyles } from './harness-util.js';
import { HomeView } from './home-view.js';
import { KEYS, mountHome } from './surface-matrix/home-host.js';
import type { Variant } from './surface-matrix/variants.js';

/**
 * The work page's session rows are ONE row each (MVP-11 unit 7, the maintainer's ruling: "this directory's" Home, the rows simplified): every
 * session the Home lists was opened in the directory the Home was opened in, so the directory line that stood under each session (ADR-0145 §8's
 * shortened path) says nothing and is gone. What stays pinned: no directory is drawn at all, from the roots or without them, so a stored
 * directory's text (a control character, a bidirectional override, a `~` that would read as the home) never reaches the frame.
 */
afterEach(cleanup);

const ROOTS = { cwd: '/work/project', home: '/home/me' } as const;
const ch = (code: number): string => String.fromCodePoint(code);

const session = (n: number, workingDir: string) => ({
  sessionId: `session-${String(n)}`,
  title: `Conversation ${String(n)}`,
  workingDir,
  agentSlug: 'chat',
  modelId: 'model',
  status: 'ended' as const,
  updatedAt: '2026-11-10T00:00:00.000Z',
  totalCostMicrocents: 0,
});

const snapshotOf = (...dirs: readonly string[]): HomeSnapshot => ({
  attention: { failedRuns: [] },
  recentSessions: dirs.map((dir, index) => session(index, dir)),
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: dirs.length, runs: 0 },
  isEmpty: false,
});

const DIRS = [
  '/work/project',
  '/work/project/packages/app',
  '/home/me/other',
  '/opt/shared/tools',
] as const;

function rowsOf(frame: string): string[] {
  return withoutStyles(frame)
    .split('\n')
    .map((line) => line.trim());
}

function homeFrame(
  snapshot: HomeSnapshot,
  paths: typeof ROOTS | undefined,
  cols = 100,
  rows = 30,
): string {
  const view = render(
    <HomeView
      page="work"
      snapshot={snapshot}
      editor={{ text: '', cursor: 0 }}
      nowMs={Date.parse('2026-11-10T01:00:00.000Z')}
      cols={cols}
      rows={rows}
      color
      {...(paths === undefined ? {} : { paths })}
    />,
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}

/** The rows of the Sessions section: from its title to the first row that is not one of its session rows. */
function sessionSection(rows: readonly string[]): readonly string[] {
  const title = rows.indexOf('Sessions');
  return title < 0 ? [] : rows.slice(title + 1, title + 1 + 4);
}

describe('the work page’s session rows', () => {
  it.each([
    ['given the roots', ROOTS],
    ['without the roots', undefined],
  ] as const)('are one row each, with no directory line under them (%s)', (_name, paths) => {
    const rows = rowsOf(homeFrame(snapshotOf(...DIRS), paths));
    expect(sessionSection(rows)).toEqual([
      'Conversation 0 · chat · 1h ago · $0.0000 known; usage unverified',
      'Conversation 1 · chat · 1h ago · $0.0000 known; usage unverified',
      'Conversation 2 · chat · 1h ago · $0.0000 known; usage unverified',
      'Conversation 3 · chat · 1h ago · $0.0000 known; usage unverified',
    ]);
    const text = rows.join('\n');
    for (const words of ['. (project root)', 'packages/app', '~/other', '/opt/shared', '/work/'])
      expect(text, words).not.toContain(words);
  });

  it.each([
    ['BEL', ch(0x07)],
    ['an SGR reset', `${ch(0x1b)}[0m`],
    ['NUL', ch(0)],
    ['a right-to-left override', ch(0x202e)],
    ['a left-to-right mark', ch(0x200e)],
  ])('never draw a stored directory, so %s in one never reaches the frame', (_name, junk) => {
    const frame = homeFrame(snapshotOf(`/work/project/${junk}~/x`), ROOTS);
    const rows = rowsOf(frame);
    expect(rows.join('\n')).not.toContain('~/x');
    expect(withoutStyles(frame)).not.toContain(junk);
  });

  it('never draws a row wider than the terminal, at 80 and 100 columns, whatever the directory', () => {
    const long = `/opt/${'a-very-long-directory/'.repeat(10)}end/here`;
    for (const cols of [80, 100]) {
      const frame = homeFrame(snapshotOf(long), ROOTS, cols, 24);
      for (const line of withoutStyles(frame).split('\n'))
        expect(displayWidth(line), line).toBeLessThanOrEqual(cols);
      expect(frame).not.toContain('end/here');
    }
  });

  it('the Home the host mounts draws them the same, from the roots it gives RootApp or without them', async () => {
    const variant: Variant = { renderer: 'alt', color: true, size: { cols: 100, rows: 30 } };
    for (const props of [{ paths: ROOTS }, {}]) {
      const home = mountHome(variant, { snapshot: snapshotOf(...DIRS), props });
      try {
        await home.settle();
        home.key(KEYS.down); // down to the work page, where the session rows are
        await home.settle();
        const rows = rowsOf(home.text());
        expect(rows.some((row) => row.includes('Conversation 0 · chat'))).toBe(true);
        expect(rows.join('\n')).not.toContain('~/other');
        expect(rows.join('\n')).not.toContain('/home/me/other');
      } finally {
        home.unmount();
      }
    }
  });
});
