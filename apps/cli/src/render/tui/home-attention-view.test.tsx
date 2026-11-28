/**
 * An Attention row of a parked run, as the landing draws it
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3): the colour it reinforces its words with (an
 * overdue gate is red, as the strip's own gate rows are, and every other parked run is yellow), and what the hint bar says `Enter` does on an
 * input gate, whose card takes no typed value. The words themselves are `home-attention.test.ts`'s and `home-gate-card.test.tsx`'s, with
 * colour off; this file turns the colour on, so it is the one that can tell the two rows apart by their escape codes.
 */
import { vi } from 'vitest';

// Ink draws colour only when the terminal supports it, and the test runs on none: the level is forced before ink is first loaded.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { ParkedRunRow } from './home-attention.js';
import { HomeView } from './home-view.js';

const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';

function frameOf(
  parkedRuns: readonly ParkedRunRow[],
  options: { readonly focus?: string; readonly color?: boolean } = {},
): string {
  // The Attention rows are the work page's (MVP-11 unit 7).
  const view = render(
    <HomeView
      page="work"
      snapshot={EMPTY}
      editor={{ text: '', cursor: 0 }}
      nowMs={0}
      cols={80}
      rows={24}
      color={options.color ?? true}
      parkedRuns={parkedRuns}
      stripFocus={options.focus === undefined ? undefined : { kind: 'run', id: options.focus }}
    />,
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}
const lineOf = (frame: string, runId: string): string =>
  frame.split('\n').find((line) => line.includes(runId)) ?? '';

describe('the colour of an Attention row', () => {
  const OVERDUE: ParkedRunRow = {
    runId: 'late-run',
    kind: 'approval',
    gates: 1,
    workflow: 'deploy',
    expiresAt: '1969-12-31T23:00:00.000Z',
  };
  const WAITING: ParkedRunRow = {
    runId: 'fresh-run',
    kind: 'approval',
    gates: 1,
    workflow: 'deploy',
    expiresAt: '1970-01-01T01:00:00.000Z',
  };

  it('draws an overdue run red and one that still has time yellow, and both say their state in words', () => {
    const frame = frameOf([OVERDUE, WAITING]);
    // the work page is left-hung at the Home's margin, so at 80 columns the second id gives up its end (`fresh-r…`) to keep its words
    const late = lineOf(frame, 'late-run');
    const fresh = lineOf(frame, 'fresh-r');
    expect(late).toContain(RED);
    expect(late).not.toContain(YELLOW);
    expect(late).toContain('expired');
    expect(fresh).toContain(YELLOW);
    expect(fresh).not.toContain(RED);
    expect(fresh).toContain('expires in 1h');
  });

  it('says the same with colour off, in the same words', () => {
    const frame = frameOf([OVERDUE, WAITING], { color: false });
    // Bold still draws (the heading), but no row carries a colour.
    // eslint-disable-next-line no-control-regex -- the assertion is that no colour code survives
    expect(frame).not.toMatch(/\u001b\[(?:3[0-7]|9[0-7])m/u);
    expect(lineOf(frame, 'late-run')).toContain('expired');
    expect(lineOf(frame, 'fresh-r')).toContain('expires in 1h');
  });
});

describe('the hint bar on a focused input gate', () => {
  const hint = (frame: string): string =>
    frame.split('\n').find((line) => line.includes('Esc start page')) ?? '';

  it('says `Enter` shows how to answer it, where a gate that a key answers says it opens (MVP-11 unit 7: the row’s old cue, now the hint’s)', () => {
    const input = frameOf([{ runId: 'in-run', kind: 'input', gates: 1 }], {
      focus: 'in-run',
      color: false,
    });
    expect(hint(input)).toContain(
      '↑/↓ select · Enter show how to answer · type to chat · Esc start page',
    );
    expect(hint(input).length, 'it fits 80 columns').toBeLessThanOrEqual(80);
    const approval = frameOf([{ runId: 'ap-run', kind: 'approval', gates: 1 }], {
      focus: 'ap-run',
      color: false,
    });
    expect(hint(approval)).toContain('↑/↓ select · Enter open · type to chat · Esc start page');
  });
});
