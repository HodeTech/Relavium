/**
 * The id a run's row ends with is DIM on the work page (MVP-11 unit 7, round 2: the spec says the first eight characters of the id come last and
 * dim, and no row dimmed them). With colour on every row of a run at rest ends with `ESC[2m` + the id + `ESC[22m` (a parked, a failed, an
 * unreadable and a recent run alike); a SELECTED row is drawn whole in its selected look (a dimmed stretch inside bold would contradict it); with
 * colour off nothing is dim (the documented contract of `dimProps`: no colour or dim ANSI under `NO_COLOR`), and the words never change.
 * Read from the drawn bytes of the real `HomeView`.
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
import type { StripFocus } from './strip-focus.js';

afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const DIM = `${ESC}[2m`;
const UNDIM = `${ESC}[22m`;
const NOW = Date.parse('2026-11-26T12:00:00.000Z');

const failedRun: HomeRunRow = {
  runId: 'f1000000-0000-4000-8000-000000000000',
  workflowSlug: 'nightly',
  status: 'failed',
  createdAt: '2026-11-26T10:00:00.000Z',
  startedAt: undefined,
  completedAt: '2026-11-26T10:00:00.000Z',
  totalCostMicrocents: 0,
};
const doneRun: HomeRunRow = {
  ...failedRun,
  runId: 'c1000000-0000-4000-8000-000000000000',
  workflowSlug: 'report',
  status: 'completed',
};
const sessionRow: HomeSessionRow = {
  sessionId: 'session-1',
  title: 'Plan the launch',
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-26T11:00:00.000Z',
  totalCostMicrocents: 0,
};
const PARKED: ParkedRunRow = {
  runId: 'p1000000-0000-4000-8000-000000000000',
  kind: 'approval',
  gates: 1,
  workflow: 'release-notes',
  expiresAt: '2026-11-26T13:00:00.000Z',
};
const BROKEN_ID = 'u1000000-0000-4000-8000-000000000000';
const SNAPSHOT: HomeSnapshot = {
  failedRuns: [failedRun],
  recentSessions: [sessionRow],
  recentRuns: [doneRun],
  recentAgents: [],
  unreadableRuns: [{ runId: BROKEN_ID, reason: 'corrupt-row' }],
  totals: { attention: 3, sessions: 1, runs: 1 },
  isEmpty: false,
};

/** The drawn line (bytes, styles in) of the row that holds `words`. */
function lineOf(words: string, color: boolean, focus?: StripFocus): string {
  const view = render(
    <HomeView
      page="work"
      snapshot={SNAPSHOT}
      parkedRuns={[PARKED]}
      editor={{ text: '', cursor: 0 }}
      nowMs={NOW}
      cols={100}
      rows={30}
      color={color}
      alternateScreen
      {...(focus === undefined ? {} : { stripFocus: focus })}
    />,
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame.split('\n').find((line) => line.includes(words)) ?? '';
}

const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu');
const plain = (line: string): string => line.replace(SGR, '').trim();

const ROWS = [
  ['a parked run', 'release-notes', 'p1000000'],
  ['a failed run', 'nightly', 'f1000000'],
  ['an unreadable run', 'cannot be read', 'u1000000'],
  ['a recent run', 'report', 'c1000000'],
] as const;

describe('with colour, the id of a row at rest is dim and last', () => {
  it.each(ROWS)('%s', (_name, words, id) => {
    const line = lineOf(words, true);
    expect(line).toContain(`${DIM}${id}${UNDIM}`);
    expect(line.split(DIM), 'exactly one dim stretch on the row').toHaveLength(2);
    expect(plain(line).endsWith(` · ${id}`), plain(line)).toBe(true);
    // what precedes it is not dim
    expect(line.slice(0, line.indexOf(`${DIM}${id}`))).not.toContain(DIM);
  });

  it('a session row has no id, so nothing on it is dim', () => {
    expect(lineOf('Plan the launch', true)).not.toContain(DIM);
  });
});

describe('a SELECTED row is drawn whole in its selected look: no dim inside it', () => {
  it.each([
    ['a parked run', 'p1000000', { kind: 'run', id: PARKED.runId }],
    ['a failed run', 'f1000000', { kind: 'run', id: failedRun.runId }],
    ['an unreadable run', 'u1000000', { kind: 'run', id: BROKEN_ID }],
    ['a recent run', 'c1000000', { kind: 'run', id: doneRun.runId }],
  ] as const)('%s', (_name, id, focus) => {
    const line = lineOf(id, true, focus);
    expect(line).toContain(id);
    expect(line).not.toContain(DIM);
  });
});

describe('without colour nothing is dim, and the words are the same', () => {
  it.each(ROWS)('%s', (_name, words, id) => {
    const line = lineOf(words, false);
    expect(line).not.toContain(DIM);
    expect(plain(line).endsWith(` · ${id}`), plain(line)).toBe(true);
    // the same words from the name on (the lead glyph is the form's: `‖` or `||`)
    const from = (text: string): string => text.slice(text.indexOf(words));
    expect(from(plain(line))).toBe(from(plain(lineOf(words, true))));
  });
});
