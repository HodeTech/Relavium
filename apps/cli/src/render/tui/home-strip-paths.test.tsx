import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { displayWidth } from './viewport.js';
import { withoutStyles } from './harness-util.js';
import { HomeView } from './home-view.js';
import { mountHome } from './surface-matrix/home-host.js';
import type { Variant } from './surface-matrix/variants.js';

/**
 * The Home strip's session row names its directory as the rest of the CLI does ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §8): project-relative, from `~`, the project itself in words, and whole where it is outside both. The row is cut at the FRONT to the room it
 * has, because the end of a path is what tells one directory from another; cut at the right it kept `/Users/someone/Documents/Pro…` for every
 * session of the machine.
 */
afterEach(cleanup);

const ROOTS = { cwd: '/work/project', home: '/home/me' } as const;

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
  attention: { gates: [], failedRuns: [] },
  recentSessions: dirs.map((dir, index) => session(index, dir)),
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
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
      snapshot={snapshot}
      editor={{ text: '', cursor: 0 }}
      nowMs={0}
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

describe('the Home strip’s session rows', () => {
  it('name the directory in the words of the notation, in the four places a session can be', () => {
    const rows = rowsOf(homeFrame(snapshotOf(...DIRS), ROOTS));
    expect(rows).toContain('. (project root)');
    expect(rows).toContain('packages/app');
    expect(rows).toContain('~/other');
    expect(rows).toContain('/opt/shared/tools');
    expect(rows.join('\n')).not.toContain('/work/project/packages');
  });

  it('draw the directory as it was stored when the Home is not given the roots', () => {
    const rows = rowsOf(homeFrame(snapshotOf(...DIRS), undefined));
    for (const dir of DIRS) expect(rows, dir).toContain(dir);
  });

  it('cut a long directory at the front, keep its end, and never draw a row wider than the terminal', () => {
    const long = `/opt/${'a-very-long-directory/'.repeat(10)}end/here`;
    for (const cols of [80, 100]) {
      const frame = homeFrame(snapshotOf(long), ROOTS, cols, 24);
      const hint = rowsOf(frame).find((row) => row.endsWith('end/here')) ?? '';
      expect(hint.startsWith('…'), hint).toBe(true);
      // The row under a session is drawn indented by its section and its own margin; the whole line fits the width given.
      const line =
        withoutStyles(frame)
          .split('\n')
          .find((row) => row.endsWith('end/here')) ?? '';
      expect(displayWidth(line), line).toBeLessThanOrEqual(cols);
    }
  });

  it('shorten BEFORE they make the text safe: a control character inside the project’s own name does not forge a project-relative path', () => {
    const rows = rowsOf(homeFrame(snapshotOf('/work/pro\u0007ject/x'), ROOTS));
    expect(rows).toContain('/work/project/x');
    expect(rows).not.toContain('x');
  });

  it.each([
    ['BEL', '\u0007'],
    ['an SGR reset', '\u001b[0m'],
    ['NUL', '\u0000'],
    ['a right-to-left override', '\u202e'],
    ['a left-to-right mark', '\u200e'],
  ])('never let %s in front of a `~` folder of the project read as the home', (_name, junk) => {
    const rows = rowsOf(homeFrame(snapshotOf(`/work/project/${junk}~/x`), ROOTS));
    expect(rows).toContain('./~/x');
    expect(rows).not.toContain('~/x');
  });

  it('are shortened by the Home the host mounts, from the roots it gives RootApp', async () => {
    const variant: Variant = { renderer: 'alt', color: true, size: { cols: 100, rows: 30 } };
    const withRoots = mountHome(variant, {
      snapshot: snapshotOf(...DIRS),
      props: { paths: ROOTS },
    });
    try {
      await withRoots.settle();
      expect(rowsOf(withRoots.text())).toContain('. (project root)');
      expect(rowsOf(withRoots.text())).toContain('~/other');
    } finally {
      withRoots.unmount();
    }
    const bare = mountHome(variant, { snapshot: snapshotOf(...DIRS) });
    try {
      await bare.settle();
      expect(rowsOf(bare.text())).toContain('/home/me/other');
    } finally {
      bare.unmount();
    }
  });
});
