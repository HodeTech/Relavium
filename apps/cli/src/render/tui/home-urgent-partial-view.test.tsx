/**
 * The same decision through the real `HomeView` (MVP-11 unit 7, round 2: correctness F1): the view hands the head the snapshot's true Attention
 * count beside the items it holds, so that a Home which read eight paused runs of ten leads with `↓ 10 need you` and a Home that read every
 * one of its runs keeps `↓ release-notes needs approval · +7 more need you`. `home-urgent-partial.test.ts` owns the decision itself.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { PARKED_RUNS_MAX, type ParkedRunRow } from './home-attention.js';
import { HomeView } from './home-view.js';

afterEach(cleanup);

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const parked: readonly ParkedRunRow[] = Array.from({ length: PARKED_RUNS_MAX }, (_, n) => ({
  runId: `p${String(n)}000000-0000-4000-8000-000000000000`,
  kind: 'approval' as const,
  gates: 1,
  workflow: `wf-${String(n)}`,
}));
const snapshotWith = (attention: number): HomeSnapshot => ({
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention, sessions: 0, runs: 0 },
  isEmpty: false,
});

function hint(attention: number): string {
  const view = render(
    <HomeView
      page="start"
      snapshot={snapshotWith(attention)}
      parkedRuns={parked}
      editor={{ text: '', cursor: 0 }}
      nowMs={NOW}
      cols={100}
      rows={40}
      color={false}
      alternateScreen
    />,
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return (
    frame
      .split('\n')
      .find((row) => row.includes('[Ctrl+C] exit'))
      ?.trim() ?? ''
  );
}

describe('page 1’s head, through the view', () => {
  it('ten attention items and eight read: the count of everything leads, the item read follows it, no `+N more`', () => {
    expect(hint(PARKED_RUNS_MAX + 2)).toBe(
      '[/] commands · ↓ 10 need you · wf-0 needs approval · [Ctrl+C] exit (twice)',
    );
  });

  it('every item read: the item leads, then the others, as the maintainer wrote it', () => {
    expect(hint(PARKED_RUNS_MAX)).toBe(
      '[/] commands · ↓ wf-0 needs approval · +7 more need you · [Ctrl+C] exit (twice)',
    );
  });
});
