/**
 * The strip's rows that `Enter` can open ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §6), drawn: a failed run and a recent run take the `>` marker and say what `Enter` does, and whichever row is focused is always one of the
 * rows drawn, whatever the strip holds at 80×24 (the row budget of ADR-0122 stands: the focused row and the prompt never leave the screen).
 */
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { ParkedRunRow } from './home-attention.js';
import { HomeView } from './home-view.js';
import { layoutHomeNotice } from './home-notice.js';
import { focusAt, stepFocus, stripReach, stripRows, type StripFocus } from './strip-focus.js';

const runRow = (id: string, status: HomeRunRow['status']): HomeRunRow => ({
  runId: `run-${id}`,
  workflowSlug: `wf-${id}`,
  status,
  createdAt: '2026-11-23T00:00:00.000Z',
  startedAt: undefined,
  completedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});
const sessionRow = (n: number): HomeSessionRow => ({
  sessionId: `session-${String(n)}`,
  workingDir: `/work/${String(n)}`,
  title: `Conversation ${String(n)}`,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});

/**
 * A frame as the eye reads it. The prompt's cursor cell is written as the SGR pair `ESC[7m` `ESC[27m` when colour is off (it was invisible there
 * under `--no-color`, `FORCE_COLOR=0` and `TERM=dumb`: MVP-11 Step 2 review C4), and a row that ends in it is not trimmed any more, so the
 * pins below read the frame without the sequences and with the trailing blanks the old, cursorless frame never had.
 */
const SGR = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'gu');
const plain = (frame: string): string =>
  frame
    .replace(SGR, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');

const indexes = (count: number): readonly number[] => Array.from({ length: count }, (_, n) => n);

/** The strip is the work page (MVP-11 unit 7): `page` is the one the frame is drawn on, the work page unless a test asks for the landing. */
function draw(
  snapshot: HomeSnapshot,
  parked: readonly ParkedRunRow[],
  stripFocus: StripFocus | undefined,
  size = { cols: 80, rows: 24 },
  page: 'start' | 'work' = 'work',
): string {
  const view = render(
    <HomeView
      page={page}
      snapshot={snapshot}
      editor={{ text: '', cursor: 0 }}
      nowMs={Date.parse('2026-11-23T01:00:00.000Z')}
      cols={size.cols}
      rows={size.rows}
      color={false}
      parkedRuns={parked}
      stripFocus={stripFocus}
    />,
  );
  const frame = plain(view.lastFrame() ?? '');
  view.unmount();
  return frame;
}

const SMALL: HomeSnapshot = {
  attention: { failedRuns: [runRow('f1', 'failed')] },
  recentSessions: [sessionRow(1)],
  recentRuns: [runRow('r1', 'completed')],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 1, sessions: 1, runs: 1 },
  isEmpty: false,
};

describe('a failed run and a recent run are rows the focus can stand on', () => {
  it('a failed run takes the marker, and the hint bar says Enter opens the run', () => {
    const rows = stripRows([], SMALL);
    const frame = draw(SMALL, [], focusAt(rows, 0));
    expect(frame).toContain('> x wf-f1');
    expect(frame).toContain('↑/↓ select · Enter open the run · type to chat · Esc start page');
    expect(frame).not.toContain('Enter resume');
  });

  it('a recent run takes the marker too, with the same words on the bar', () => {
    const rows = stripRows([], SMALL);
    const frame = draw(SMALL, [], focusAt(rows, 2));
    expect(frame).toContain('> wf-r1');
    expect(frame).not.toContain('> x');
    expect(frame).toContain('Enter open the run');
  });

  it('with nothing focused, no row has a marker and the bar says how to reach the rows', () => {
    // On the landing (MVP-11 unit 7) no row is drawn at all, and the hint's indicator is the way down to them.
    const frame = draw(SMALL, [], undefined, { cols: 80, rows: 24 }, 'start');
    expect(frame).not.toContain('> x');
    expect(frame).not.toContain('Enter open the run');
    expect(frame).toContain('↓ 1 needs you · 1 session · 1 run');
    // On the work page with the docked prompt focused, no row has a marker either.
    expect(draw(SMALL, [], undefined)).not.toMatch(/^ *> (x |wf-|Conversation)/mu);
  });

  it('a session keeps its own words, and a parked run its own', () => {
    const parked: ParkedRunRow[] = [{ runId: 'run-p1', kind: 'approval', gates: 1 }];
    const rows = stripRows(parked, SMALL);
    expect(draw(SMALL, parked, focusAt(rows, 2))).toContain(
      '↑/↓ select session · Enter resume · type to chat · Esc start page',
    );
    expect(draw(SMALL, parked, focusAt(rows, 0))).toContain('Enter open the gate');
  });

  it('a run whose log could not be read is not a row the focus names: its row stays a display row', () => {
    const snapshot: HomeSnapshot = {
      ...SMALL,
      attention: { failedRuns: [runRow('u1', 'failed')] },
      unreadableRuns: [{ runId: 'run-u1', reason: 'corrupt-row' }],
    };
    expect(stripRows([], snapshot).map((row) => row.id)).toEqual(['session-1', 'run-r1']);
    expect(draw(snapshot, [], undefined)).toContain('event log unreadable');
  });
});

describe('the focused row is always one of the rows drawn, at 80×24, with a full strip', () => {
  const parked: ParkedRunRow[] = indexes(8).map((n) => ({
    runId: `run-p${String(n)}`,
    kind: 'approval',
    gates: 1,
  }));
  const full: HomeSnapshot = {
    attention: {
      failedRuns: indexes(8).map((n) => runRow(`f${String(n)}`, 'failed')),
    },
    recentSessions: indexes(8).map(sessionRow),
    recentRuns: indexes(8).map((n) => runRow(`r${String(n)}`, 'completed')),
    recentAgents: [],
    unreadableRuns: [],
    totals: { attention: 16, sessions: 8, runs: 8 },
    isEmpty: false,
  };
  const rows = stripRows(parked, full);

  it('lists 32 rows in the strip order', () => {
    expect(rows).toHaveLength(32);
    expect(rows.map((row) => row.role)).toEqual([
      ...Array<string>(8).fill('parked'),
      ...Array<string>(8).fill('failed'),
      ...Array<string>(8).fill('session'),
      ...Array<string>(8).fill('recent'),
    ]);
  });

  /** What the focused row's own line starts with, after the marker. */
  const lineStart = (index: number): string => {
    const row = rows[index];
    if (row === undefined) throw new Error(`no row ${String(index)}`);
    if (row.role === 'parked') return `> || ${row.id}`;
    if (row.role === 'failed') return `> x wf-${row.id.slice('run-'.length)}`;
    if (row.role === 'session') return `> Conversation ${row.id.slice('session-'.length)}`;
    return `> wf-${row.id.slice('run-'.length)}`;
  };

  it.each(indexes(32))(
    'draws the row at index %i when it is focused, with the prompt and the bar, in 24 rows',
    (index) => {
      const frame = draw(full, parked, focusAt(rows, index));
      expect(frame, `row ${String(index)} is on screen`).toContain(lineStart(index));
      expect(frame.split('\n').length, 'the strip keeps to the terminal').toBeLessThanOrEqual(24);
      expect(frame, 'the docked prompt is still there').toMatch(
        /^ *> type a message, or \/ for commands$/mu,
      );
      expect(frame).toContain('Esc start page');
    },
  );
});

describe('the focused row is drawn when a long notice takes most of the screen', () => {
  const parked: ParkedRunRow[] = indexes(3).map((n) => ({
    runId: `run-p${String(n)}`,
    kind: 'approval',
    gates: 1,
  }));
  const snapshot: HomeSnapshot = {
    attention: { failedRuns: indexes(2).map((n) => runRow(`f${String(n)}`, 'failed')) },
    recentSessions: indexes(2).map(sessionRow),
    recentRuns: indexes(2).map((n) => runRow(`r${String(n)}`, 'completed')),
    recentAgents: [],
    unreadableRuns: [],
    totals: { attention: 5, sessions: 2, runs: 2 },
    isEmpty: false,
  };
  const rows = stripRows(parked, snapshot);
  const notice = indexes(16)
    .map((n) => `report line ${String(n + 1)}`)
    .join('\n');
  const needle = [
    '> || run-p0',
    '> || run-p1',
    '> || run-p2',
    '> x wf-f0',
    '> x wf-f1',
    '> Conversation 0',
    '> Conversation 1',
    '> wf-r0',
    '> wf-r1',
  ];

  it.each(indexes(9))(
    'draws the row at index %i, one of nine, beside a 16-line notice, in 24 rows',
    (index) => {
      const view = render(
        <HomeView
          page="work"
          snapshot={snapshot}
          editor={{ text: '', cursor: 0 }}
          nowMs={Date.parse('2026-11-23T01:00:00.000Z')}
          cols={80}
          rows={24}
          color={false}
          parkedRuns={parked}
          stripFocus={focusAt(rows, index)}
          notice={notice}
        />,
      );
      const frame = plain(view.lastFrame() ?? '');
      view.unmount();
      expect(frame).toContain(needle[index] ?? '');
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    },
  );
});

describe('every row `↓` can reach is drawn beside a long notice', () => {
  const notice = indexes(16)
    .map((n) => `report line ${String(n + 1)}`)
    .join('\n');
  const marker = (row: { readonly role: string; readonly id: string }): string => {
    if (row.role === 'parked') return `> || ${row.id}`;
    if (row.role === 'session') return `> Conversation ${row.id.slice('session-'.length)}`;
    return row.role === 'failed'
      ? `> x wf-${row.id.slice('run-'.length)}`
      : `> wf-${row.id.slice('run-'.length)}`;
  };
  const strips: readonly (readonly [string, HomeSnapshot, readonly ParkedRunRow[]])[] = [
    [
      'a failed run and a session',
      {
        attention: { failedRuns: [runRow('f1', 'failed')] },
        recentSessions: [sessionRow(1)],
        recentRuns: [],
        recentAgents: [],
        unreadableRuns: [],
        totals: { attention: 1, sessions: 1, runs: 0 },
        isEmpty: false,
      },
      [],
    ],
    [
      'a failed run alone',
      {
        attention: { failedRuns: [runRow('f1', 'failed')] },
        recentSessions: [],
        recentRuns: [],
        recentAgents: [],
        unreadableRuns: [],
        totals: { attention: 1, sessions: 0, runs: 0 },
        isEmpty: false,
      },
      [],
    ],
    [
      'a recent run alone',
      {
        attention: { failedRuns: [] },
        recentSessions: [],
        recentRuns: [runRow('r1', 'completed')],
        recentAgents: [],
        unreadableRuns: [],
        totals: { attention: 0, sessions: 0, runs: 1 },
        isEmpty: false,
      },
      [],
    ],
    [
      'a session and a recent run',
      {
        attention: { failedRuns: [] },
        recentSessions: [sessionRow(1)],
        recentRuns: [runRow('r1', 'completed')],
        recentAgents: [],
        unreadableRuns: [],
        totals: { attention: 0, sessions: 1, runs: 1 },
        isEmpty: false,
      },
      [],
    ],
    [
      'two failed runs, two sessions and two recent runs',
      {
        attention: {
          failedRuns: [runRow('f1', 'failed'), runRow('f2', 'failed')],
        },
        recentSessions: [sessionRow(1), sessionRow(2)],
        recentRuns: [runRow('r1', 'completed'), runRow('r2', 'completed')],
        recentAgents: [],
        unreadableRuns: [],
        totals: { attention: 2, sessions: 2, runs: 2 },
        isEmpty: false,
      },
      [],
    ],
  ];

  it.each(strips)(
    'with %s, `↓` walks the whole strip and the focused row is drawn at each step, in 24 rows',
    (_name, snapshot, parked) => {
      const rows = stripRows(parked, snapshot);
      let focus: StripFocus | undefined;
      for (let step = 0; step < rows.length; step += 1) {
        focus = stepFocus(rows, focus, 1);
        const row = rows.find((candidate) => candidate.id === focus?.id);
        expect(row, 'the walk stays on the list').toBeDefined();
        if (row === undefined) return;
        const view = render(
          <HomeView
            page="work"
            snapshot={snapshot}
            editor={{ text: '', cursor: 0 }}
            nowMs={Date.parse('2026-11-23T01:00:00.000Z')}
            cols={80}
            rows={24}
            color={false}
            parkedRuns={parked}
            stripFocus={focus}
            notice={notice}
          />,
        );
        const frame = plain(view.lastFrame() ?? '');
        view.unmount();
        expect(frame, `${row.id} is drawn`).toContain(marker(row));
        expect(frame.split('\n').length).toBeLessThanOrEqual(24);
      }
    },
  );

  it('the notice leaves the Attention rows three rows for a failed run, as for a parked one, and a recent run alone four', () => {
    const longNotice = indexes(60)
      .map((n) => `report line ${String(n + 1)}`)
      .join('\n');
    const base = {
      notice: longNotice,
      editor: { text: '', cursor: 0 },
      cols: 80,
      rows: 24,
      showBanner: false,
      onLanding: false,
      hasSessions: false,
    } as const;
    const rowsOf = (over: object): number | undefined =>
      layoutHomeNotice({ ...base, ...over })?.rowCount;
    const plain = rowsOf({});
    const attention = rowsOf({ hasAttentionRuns: true });
    const recent = rowsOf({ hasRecentRuns: true });
    expect(plain).toBeDefined();
    expect((plain ?? 0) - (attention ?? 0)).toBe(3);
    expect((plain ?? 0) - (recent ?? 0)).toBe(3); // the work page's Runs section: its two headings and its row
  });

  it('stripReach names what the strip lists that `↓` can focus', () => {
    const none: HomeSnapshot = {
      attention: { failedRuns: [] },
      recentSessions: [sessionRow(1)],
      recentRuns: [],
      recentAgents: [],
      unreadableRuns: [],
      totals: { attention: 0, sessions: 0, runs: 0 },
      isEmpty: false,
    };
    expect(stripReach([], none)).toEqual({ hasAttentionRuns: false, hasRecentRuns: false });
    expect(
      stripReach([{ runId: 'run-p', kind: 'approval', gates: 1 }], none).hasAttentionRuns,
    ).toBe(true);
    expect(
      stripReach([], { ...none, attention: { failedRuns: [runRow('f', 'failed')] } })
        .hasAttentionRuns,
    ).toBe(true);
    expect(
      stripReach([], {
        ...none,
        attention: { failedRuns: [runRow('u', 'failed')] },
        unreadableRuns: [{ runId: 'run-u', reason: 'corrupt-row' }],
      }).hasAttentionRuns,
      'an unreadable run is a display row',
    ).toBe(false);
    expect(stripReach([], { ...none, recentRuns: [runRow('r', 'completed')] }).hasRecentRuns).toBe(
      true,
    );
  });
});
