/**
 * The selected look of the work page's rows (MVP-11 unit 7, the maintainer's ruling 8c): a row that carries a colour TINT (an Attention row:
 * a parked run amber, red once overdue; a failed run red; an unreadable run amber) is selected by `›` + bold + its tint, with NO inverse; a
 * plain row (a session, a run) keeps ADR-0145 §5's bold + inverse. Without colour no row carries a tint, so the tinted row is drawn by the
 * plain rule there (`>` + bold + inverse): the selection is never told by colour alone, and never by the marker alone (the prompt is `>` too).
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
import { tintedSelectionEmphasis } from './selectable-text.js';
import type { StripFocus } from './strip-focus.js';

afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const BOLD = `${ESC}[1m`;
const INVERSE = `${ESC}[7m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;
const ANY_COLOUR = new RegExp(`${ESC}\\[(?:3[0-7]|9[0-7])m`, 'u');
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
const sessionRow: HomeSessionRow = {
  sessionId: 'session-1',
  workingDir: '/work',
  title: 'Plan the launch',
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-26T11:00:00.000Z',
  totalCostMicrocents: 0,
};
const OVERDUE: ParkedRunRow = {
  runId: 'p1000000-0000-4000-8000-000000000000',
  kind: 'approval',
  gates: 1,
  workflow: 'release-notes',
  expiresAt: '2026-11-26T11:00:00.000Z',
};
const WAITING: ParkedRunRow = {
  ...OVERDUE,
  runId: 'p2000000-0000-4000-8000-000000000000',
  expiresAt: '2026-11-26T13:00:00.000Z',
};
const SNAPSHOT: HomeSnapshot = {
  attention: { failedRuns: [failedRun] },
  recentSessions: [sessionRow],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [{ runId: 'u1000000-0000-4000-8000-000000000000', reason: 'corrupt-row' }],
  totals: { attention: 4, sessions: 1, runs: 0 },
  isEmpty: false,
};

/** The drawn line (bytes, styles in) of the row that holds `words`, with `focus` on the work page. */
function lineOf(words: string, focus: StripFocus, color: boolean): string {
  const view = render(
    <HomeView
      page="work"
      snapshot={SNAPSHOT}
      parkedRuns={[OVERDUE, WAITING]}
      editor={{ text: '', cursor: 0 }}
      nowMs={NOW}
      cols={100}
      rows={30}
      color={color}
      alternateScreen
      stripFocus={focus}
    />,
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame.split('\n').find((line) => line.includes(words)) ?? '';
}

const run = (id: string): StripFocus => ({ kind: 'run', id });

describe('a tinted (Attention) row, focused, with colour', () => {
  it.each([
    ['an overdue parked run: red', OVERDUE.runId, 'p1000000', RED],
    ['a parked run with time: amber', WAITING.runId, 'p2000000', YELLOW],
    ['a failed run: red', failedRun.runId, 'f1000000', RED],
    ['an unreadable run: amber', 'u1000000-0000-4000-8000-000000000000', 'u1000000', YELLOW],
  ])('%s, `›` and bold, and no inverse', (_name, id, words, tint) => {
    const line = lineOf(words, run(id), true);
    expect(line).toContain(tint);
    expect(line).toContain(`${BOLD}› `);
    expect(line, 'no inverse: the selected row softens (the ruling)').not.toContain(INVERSE);
  });

  it('its unfocused neighbours carry their tint and no marker, no bold and no inverse', () => {
    const line = lineOf('p2000000', run(OVERDUE.runId), true);
    expect(line).toContain(YELLOW);
    expect(line).not.toContain('›');
    expect(line).not.toContain(BOLD);
    expect(line).not.toContain(INVERSE);
  });
});

describe('a plain row, focused, with colour', () => {
  it('a session keeps bold and inverse (ADR-0145 §5) and has no tint of its own', () => {
    const line = lineOf('Plan the launch', { kind: 'session', id: 'session-1' }, true);
    expect(line).toContain(`${BOLD}${INVERSE}› `);
    expect(line).not.toMatch(ANY_COLOUR);
  });
});

describe('without colour no row carries a tint, so a tinted row is drawn by the plain rule', () => {
  it.each([
    ['an overdue parked run', OVERDUE.runId, 'p1000000'],
    ['a failed run', failedRun.runId, 'f1000000'],
    ['an unreadable run', 'u1000000-0000-4000-8000-000000000000', 'u1000000'],
  ])('%s: `>`, bold and inverse, no colour: the marker, the bold, the glyph and the words say which row', (_name, id, words) => {
    const line = lineOf(words, run(id), false);
    expect(line).toContain(`${BOLD}${INVERSE}> `);
    expect(line).not.toMatch(ANY_COLOUR);
  }); // prettier-ignore
});

describe('the one helper that decides it', () => {
  it('bold alone for a selected tinted row with colour, bold and inverse without, nothing when not selected', () => {
    expect(tintedSelectionEmphasis(true, true)).toEqual(['bold']);
    expect(tintedSelectionEmphasis(true, false)).toEqual(['bold', 'inverse']);
    expect(tintedSelectionEmphasis(false, true)).toBeUndefined();
    expect(tintedSelectionEmphasis(undefined, false)).toBeUndefined();
  });
});
