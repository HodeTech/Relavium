/**
 * The Active tab of the Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4). Two halves. The first is the pure model: every class of run drawn with a glyph and a word, the "N more" row, what a key
 * does (and what it refuses), and that the cursor follows a run. The second drives the real Home controller over a scripted poll and clock:
 * the tab reads when it is entered and again only when the change token moved, a paused row opens its gate card and `Esc` returns to the tab
 * on the same row, the poll reads nothing while the card is open, and closing, leaving the tab and tearing the Home down leave no timer.
 */
import type { RunSummaryRecord } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { classifyActiveRuns, type ActiveRow } from '../../history/active-model.js';
import type { ActiveRead } from '../../history/active-source.js';
import { createChangeProbe } from '../../history/change-probe.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { ChatKey } from './chat-input.js';
import {
  createHomeController,
  type HomeActivePort,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import { usableColumns } from './sheet-frame.js';
import {
  TAB_HOST_ROWS,
  enterTab,
  foldTabHostKey,
  freshTabMemory,
  tabHostLegend,
  tabHostLegendText,
  tabHostLines,
  tabHostMemory,
  withActiveRead,
  type TabHostContext,
  type TabHostState,
  type TabHostStep,
} from './tab-host.js';
import {
  ACTIVE_EMPTY,
  ACTIVE_EMPTY_ALL,
  ACTIVE_FOCUS_LEFT,
  ACTIVE_FRESHNESS,
  ACTIVE_HELD_UNREAD,
  ACTIVE_KEYS,
  ACTIVE_LOADING,
  ACTIVE_SCOPE_WORDS,
  ACTIVE_SELECT_FIRST,
  ACTIVE_STALE_READ,
  ACTIVE_UNREADABLE,
  activeDisplayOrder,
  activeGroupOf,
} from './tab-host-active.js';
import { displayWidth } from './viewport.js';

const HERE = '/work/here';
const THERE = '/work/there';
const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const TTL = 60_000;

/** The Home's question for a media park, as the controller is handed it. */
type MediaQuestion = (runId: string) => Promise<string | undefined>;

const UP: ChatKey = { upArrow: true };
const DOWN: ChatKey = { downArrow: true };
const ENTER: ChatKey = { return: true };
const ESC: ChatKey = { escape: true };

function run(
  id: string,
  status: RunStatus,
  over: Partial<RunSummaryRecord> = {},
): RunSummaryRecord {
  return {
    id,
    workflowId: 'wf',
    status,
    executionMode: 'local',
    triggerType: 'manual',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: new Date(NOW - 5_000).toISOString(),
    updatedAt: new Date(NOW - 5_000).toISOString(),
    projectRoot: HERE,
    ...over,
  };
}

/** The nine kinds of row the tab can show, each with an id of its own: the model's classification of real summaries. */
const IDS = {
  hosted: 'hostrun1',
  other: 'otherrun',
  pending: 'pendrun1',
  gate: 'gaterun1',
  media: 'mediarun',
  unknown: 'unknownr',
  elsewhere: 'elserun1',
  stalled: 'stallrun',
  held: 'heldrun1',
} as const;

function classify(
  runs: readonly RunSummaryRecord[],
  over: Partial<Parameters<typeof classifyActiveRuns>[0]> = {},
): ActiveRow[] {
  return classifyActiveRuns({
    runs,
    leases: new Map(),
    currentProjectRoot: HERE,
    outboxHeldRunIds: new Set(),
    nowMs: NOW,
    leaseTtlMs: TTL,
    ...over,
  });
}

const EVERY_CLASS: ActiveRow[] = classify(
  [
    run(IDS.hosted, 'running'),
    run(IDS.other, 'running'),
    run(IDS.pending, 'pending'),
    run(IDS.gate, 'paused'),
    run(IDS.media, 'paused'),
    run(IDS.unknown, 'paused'),
    run(IDS.elsewhere, 'paused', { projectRoot: THERE }),
    run(IDS.stalled, 'running', { createdAt: new Date(NOW - 5 * TTL).toISOString() }),
    run(IDS.held, 'running'),
  ],
  {
    hostedRunId: IDS.hosted,
    outboxHeldRunIds: new Set([IDS.held]),
    pendingGateCounts: new Map([
      [IDS.gate, 1],
      [IDS.media, 0],
    ]),
  },
);

const read = (rows: readonly ActiveRow[], over: Partial<ActiveRead> = {}): ActiveRead => ({
  rows,
  more: [],
  heldUnread: false,
  ...over,
});

const ROWS = 23;
const SIZE = { columns: 80, terminalRows: 24 };
const textOf = (state: TabHostState, geometry = SIZE): string[] =>
  tabHostLines(state, geometry).map((line) => line.text);
const lineWith = (lines: readonly string[], needle: string): string =>
  lines.find((line) => line.includes(needle)) ?? '';

/**
 * The Active tab over `last`, with the keys going through the tab host's own fold. The tab lists THIS directory's runs by default (OD-24 D4); the
 * classes of run below include another project's, so the rig widens to `[a] all` first unless a test says `scope: 'project'`
 * (`tab-host-active-scope.test.ts` owns the scope itself).
 */
function rig(last: ActiveRead | null = read(EVERY_CLASS), scope: 'all' | 'project' = 'all') {
  // `null` is a tab entered before any read; `undefined` would take the default.
  const context = (over: Partial<TabHostContext> = {}): TabHostContext => ({
    now: 0,
    active: { last: last ?? undefined },
    ...over,
  });
  let state: TabHostState = enterTab(freshTabMemory('active'), 'active', context());
  const press = (input: string, key: ChatKey = {}): TabHostStep => {
    const step = foldTabHostKey(state, input, key, context());
    if (step.kind !== 'close') state = step.state;
    return step;
  };
  if (scope === 'all') press('a');
  return {
    press,
    context,
    get state(): TabHostState {
      return state;
    },
    set state(next: TabHostState) {
      state = next;
    },
  };
}
const active = (state: TabHostState) => {
  if (state.active === undefined) throw new Error('the Active tab holds no state');
  return state.active;
};
const focusedId = (state: TabHostState): string | undefined => active(state).focus;

/**
 * `↓` until the run `id` is the focused one, a bounded walk: a state that never gets there (a scope that did not recompute, a default that listed
 * every directory) fails with the run it was looking for instead of looping at full speed (review round 1, D08/D09).
 */
function walkTo(
  r: {
    readonly press: (input: string, key?: ChatKey) => TabHostStep;
    readonly state: TabHostState;
  },
  id: string,
): void {
  for (let step = 0; step < 100; step += 1) {
    if (focusedId(r.state) === id) return;
    r.press('', DOWN);
  }
  throw new Error(`the run ${id} was never focused (focus: ${String(focusedId(r.state))})`);
}

describe('every class of run is drawn with a glyph and a word', () => {
  const lines = textOf(rig().state);

  it.each([
    [IDS.hosted, '◐', 'running', 'this Home'],
    [IDS.other, '◐', 'running', 'running in another process'],
    [IDS.pending, '○', 'pending', 'running in another process'],
    [IDS.gate, '‖', 'paused', 'gate waiting here'],
    [IDS.media, '‖', 'paused', 'waiting for a media job'],
    [IDS.unknown, '‖', 'paused', 'gate state not read'],
    [IDS.elsewhere, '‖', 'paused', 'another project'],
    [IDS.stalled, '⚠', 'stalled', 'settled by the next start'],
    [IDS.held, '◇', 'held', 'terminal held in the outbox'],
  ])('%s: %s %s, and says why (%s)', (id, glyph, word, why) => {
    const line = lineWith(lines, id);
    expect(line, `a row for ${id}`).not.toBe('');
    expect(line).toContain(`${glyph} ${word}`);
    expect(line).toContain(why);
  });

  it('lists the groups in the order running, paused, stalled, held', () => {
    const groups = active(rig().state).rows.map(activeGroupOf);
    const order = ['running', 'paused', 'stalled', 'held'];
    const indexes = groups.map((group) => order.indexOf(group));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(groups)).toEqual(new Set(order));
  });

  it('a damaged log says `gate state not read` and never "media job"', () => {
    const line = lineWith(lines, IDS.unknown);
    expect(line).toContain('gate state not read');
    expect(line).not.toContain('media job');
    expect(lineWith(lines, IDS.media)).toContain('media job');
  });

  it('puts the leg this Home runs under running, whatever the database says of its status', () => {
    const [row] = classify([run(IDS.hosted, 'paused')], { hostedRunId: IDS.hosted });
    if (row === undefined) throw new Error('unreachable');
    expect(activeGroupOf(row)).toBe('running');
  });

  it('fits 23 rows and the usable width at 80×24 and on a wide terminal, and below 80×24 is the one line that says to enlarge', () => {
    for (const geometry of [SIZE, { columns: 200, terminalRows: 60 }]) {
      const drawn = textOf(rig().state, geometry);
      expect(drawn.length).toBeLessThanOrEqual(TAB_HOST_ROWS);
      for (const line of drawn)
        expect(displayWidth(line), line).toBeLessThanOrEqual(usableColumns(geometry.columns));
    }
    const small = textOf(rig().state, { columns: 60, terminalRows: 20 });
    expect(small[0]).toBe('Enlarge the terminal.');
    expect(small.join('\n')).not.toContain(IDS.hosted);
    expect(ROWS).toBe(TAB_HOST_ROWS);
  });

  it('draws the freshness note under the list until a message or a warning takes its place', () => {
    // The note says what is listed first (this directory's runs, or every project's) and then how fresh the list is.
    expect(textOf(rig(undefined, 'project').state)).toContain(
      `${ACTIVE_SCOPE_WORDS.project} · ${ACTIVE_FRESHNESS}`,
    );
    expect(textOf(rig().state)).toContain(`${ACTIVE_SCOPE_WORDS.all} · ${ACTIVE_FRESHNESS}`);
    const warned = rig(read(EVERY_CLASS, { heldUnread: true }));
    expect(textOf(warned.state)).toContain(ACTIVE_HELD_UNREAD);
    expect(textOf(warned.state).join('\n')).not.toContain(ACTIVE_FRESHNESS);
  });
});

describe('the "N more" row', () => {
  const more = read(EVERY_CLASS, {
    more: [
      { status: 'running', count: 37, atLeast: false },
      { status: 'paused', count: 200, atLeast: true },
    ],
  });

  it('says how many runs lie past the rows kept, per status, and says `+` when the count stopped at a page', () => {
    const lines = textOf(rig(more).state);
    expect(lines).toContain('… 37 more running not listed');
    expect(lines).toContain('… 200+ more paused not listed');
  });

  it('is absent when nothing lies past the rows', () => {
    expect(textOf(rig().state).join('\n')).not.toContain('not listed');
  });

  it('is drawn with an empty list too, and the list still fits 23 rows with the markers and a long list', () => {
    const empty = textOf(rig(read([], { more: more.more }), 'project').state);
    expect(empty).toContain(ACTIVE_EMPTY);
    expect(empty).toContain('… 37 more running not listed');
    expect(textOf(rig(read([]), 'all').state)).toContain(ACTIVE_EMPTY_ALL);
    const many = classify(
      Array.from({ length: 60 }, (_, index) =>
        run(`many${String(index).padStart(4, '0')}`, 'running'),
      ),
    );
    const drawn = textOf(rig(read(many, { more: more.more })).state);
    expect(drawn.length).toBeLessThanOrEqual(TAB_HOST_ROWS);
    expect(drawn).toContain('… 37 more running not listed');
    expect(drawn.some((line) => line.startsWith('› '))).toBe(true);
  });
});

describe('what a key does', () => {
  it('↑ and ↓ move the cursor and stop at the ends', () => {
    const r = rig();
    const last = active(r.state).rows.length - 1;
    r.press('', UP);
    expect(active(r.state).cursor).toBe(0);
    for (let i = 0; i < last + 3; i += 1) r.press('', DOWN);
    expect(active(r.state).cursor).toBe(last);
  });

  it('Enter on the leg this Home hosts asks for its view, with that run’s id', () => {
    const r = rig();
    const step = r.press('', ENTER);
    expect(step).toMatchObject({ kind: 'open-view', runId: IDS.hosted });
  });

  it('Enter on a run paused at a gate in this project asks for its gate card, and for nothing else', () => {
    const r = rig();
    walkTo(r, IDS.gate);
    expect(r.press('', ENTER)).toMatchObject({ kind: 'open-gate', runId: IDS.gate });
  });

  describe('a media park whose log shows a job in flight', () => {
    const continuable = (): ActiveRow[] =>
      classify([run(IDS.media, 'paused')], {
        pendingGateCounts: new Map([[IDS.media, 0]]),
        pendingMediaJobCounts: new Map([[IDS.media, 1]]),
      });

    it('Enter asks for the same open request as a gate park (the host re-reads the run and asks the question), with that run`s id', () => {
      const r = rig(read(continuable()));
      expect(focusedId(r.state)).toBe(IDS.media);
      expect(r.press('', ENTER)).toMatchObject({ kind: 'open-gate', runId: IDS.media });
      expect(active(r.state).message, 'no read-only message: it acts').toBeUndefined();
    });

    it('says under the list that Enter asks whether to continue it, and keeps the row`s own words', () => {
      const drawn = textOf(rig(read(continuable())).state);
      expect(drawn.join('\n')).toContain('Enter asks whether to continue it here');
      expect(lineWith(drawn, IDS.media)).toContain('waiting for a media job');
      expect(drawn.join('\n')).not.toContain('nothing to decide here');
    });

    it('is read-only again with a count of zero: the tab never offers a continue it cannot tell the engine will accept', () => {
      const rows = classify([run(IDS.media, 'paused')], {
        pendingGateCounts: new Map([[IDS.media, 0]]),
        pendingMediaJobCounts: new Map([[IDS.media, 0]]),
      });
      const r = rig(read(rows));
      expect(r.press('', ENTER).kind).toBe('state');
      expect(active(r.state).message ?? '').toMatch(/^Read-only: /u);
      expect(textOf(r.state).join('\n')).toContain('nothing to decide here');
    });
  });

  it.each([IDS.other, IDS.pending, IDS.media, IDS.unknown, IDS.elsewhere, IDS.stalled, IDS.held])(
    'Enter on %s opens nothing: it says the row is read-only, and why',
    (id) => {
      const r = rig();
      walkTo(r, id);
      const step = r.press('', ENTER);
      expect(step.kind).toBe('state');
      const message = active(r.state).message ?? '';
      expect(message).toMatch(/^Read-only: /u);
      expect(textOf(r.state)).toContain(message);
    },
  );

  it('keeps what to do on screen at 80 columns for a run paused in another project, however long that project’s path is: the path comes last', () => {
    const long = `/work/${'a-deep-directory/'.repeat(6)}project`;
    const rows = classify([run(IDS.elsewhere, 'paused', { projectRoot: long })]);
    const r = rig(read(rows));
    const line = lineWith(textOf(r.state), 'answer it from there');
    expect(line.startsWith('Paused in another project: answer it from there')).toBe(true);
    expect(displayWidth(line)).toBeLessThanOrEqual(78);
    // The sentence is longer than the line, so the cut is real: what the clip took is the end of the path, not the sentence's action.
    expect(line.endsWith('…'), 'the line was cut').toBe(true);
    expect(line, 'the whole path did not fit').not.toContain(long);
  });

  it('says there is no cross-process cancel for a run another process owns', () => {
    const r = rig();
    walkTo(r, IDS.other);
    expect(textOf(r.state).join('\n')).toContain('no cross-process cancel');
  });

  it('a message goes with the next key', () => {
    const r = rig();
    walkTo(r, IDS.other);
    r.press('', ENTER);
    expect(active(r.state).message).toBeDefined();
    r.press('', UP);
    expect(active(r.state).message).toBeUndefined();
  });

  it('a chord or a letter is nothing: no run is cancelled, retried or edited from here', () => {
    const r = rig();
    const before = r.state;
    for (const [input, key] of [
      ['c', {}],
      ['r', {}],
      ['x', {}],
      ['d', {}],
      ['', { return: true, ctrl: true }],
      ['', { return: true, meta: true }],
      ['', { downArrow: true, ctrl: true }],
    ] as const) {
      const step = r.press(input, key);
      expect(step.kind, `${input} ${JSON.stringify(key)}`).toBe('state');
    }
    expect(r.state).toEqual(before);
  });

  it('`A` (Caps Lock on) widens and narrows the scope as `a` does; a chord with it is nothing (review round 1, D02)', () => {
    const r = rig(undefined, 'project');
    expect(active(r.state).scope).toBe('project');
    r.press('A');
    expect(active(r.state).scope).toBe('all');
    r.press('A');
    expect(active(r.state).scope).toBe('project');
    r.press('a', { ctrl: true });
    r.press('a', { meta: true });
    expect(active(r.state).scope, 'a chord is never `a`').toBe('project');
  });

  it('`a` before a read has landed, or where there is nothing to read, changes nothing: there is no list to widen (review round 1, D03)', () => {
    const loading = rig(null, 'project');
    expect(active(loading.state).phase).toBe('loading');
    loading.press('a');
    loading.press('A');
    expect(active(loading.state).scope).toBe('project');
    const none = enterTab(freshTabMemory('active'), 'active', { now: 0 });
    expect(active(none).phase).toBe('unreadable');
    const step = foldTabHostKey(none, 'a', {}, { now: 0 });
    if (step.kind === 'close') throw new Error('`a` closed the screen');
    expect(active(step.state).scope).toBe('project');
  });

  it('an Enter with no row makes no step', () => {
    const r = rig(read([]));
    expect(r.press('', ENTER).kind).toBe('state');
  });

  it('presses every key the legend names, and each does what it says', () => {
    const r = rig();
    const { items } = tabHostLegend(r.state);
    expect(items).toContain(ACTIVE_KEYS.select);
    expect(items).toContain(ACTIVE_KEYS.open);
    const before = active(r.state).cursor;
    r.press('', DOWN);
    expect(active(r.state).cursor, `${ACTIVE_KEYS.select.keys} ${ACTIVE_KEYS.select.verb}`).toBe(
      before + 1,
    );
    r.press('', UP);
    expect(r.press('', ENTER).kind, `${ACTIVE_KEYS.open.keys} ${ACTIVE_KEYS.open.verb}`).not.toBe(
      'close',
    );
  });

  it('names no key it does not answer to: an empty list offers neither select nor open, and the way out is last', () => {
    // The Runs screen's way out says where it goes (OD-24). `Tab` is a key of the screen and not an item of its legend: with two tabs `←/→ tab` says it.
    const full = tabHostLegendText(rig(undefined, 'project').state);
    expect(full).toBe('←/→ tab · ↑/↓ select · Enter open · [a] all · Esc / [Ctrl+C] back to Home');
    const wide = tabHostLegendText(rig().state);
    expect(wide).toBe('←/→ tab · ↑/↓ select · Enter open · [a] here · Esc / [Ctrl+C] back to Home');
    const empty = tabHostLegendText(rig(read([]), 'project').state);
    expect(empty).toBe('←/→ tab · [a] all · Esc / [Ctrl+C] back to Home');
    const loading = tabHostLegendText(rig(null).state);
    expect(loading).toBe('←/→ tab · Esc / [Ctrl+C] back to Home');
  });
});

describe('Esc and Ctrl+C at the Active tab', () => {
  it('Esc closes the screen from the list, like every tab with nothing open', () => {
    expect(rig().press('', ESC)).toEqual({ kind: 'close' });
  });

  it('Ctrl+C closes it too, and cancels nothing', () => {
    expect(rig().press('c', { ctrl: true })).toEqual({ kind: 'close' });
  });
});

describe('the cursor follows the run', () => {
  it('stays on its run when a newer read moves it down the list', () => {
    const r = rig();
    walkTo(r, IDS.gate);
    const before = active(r.state).cursor;
    const shuffled = [
      ...classify([run('newcome1', 'running'), run('newcome2', 'running')], {}),
      ...EVERY_CLASS,
    ];
    const next = withActiveRead(r.state, read(shuffled));
    expect(focusedId(next)).toBe(IDS.gate);
    expect(active(next).cursor).toBeGreaterThan(before);
    expect(active(next).rows[active(next).cursor]?.runId).toBe(IDS.gate);
  });

  it('keeps its position, inside the rows, when the run left the list, and selects nothing', () => {
    const r = rig();
    walkTo(r, IDS.held);
    const without = EVERY_CLASS.filter((row) => row.runId !== IDS.held);
    const next = withActiveRead(r.state, read(without));
    expect(active(next).cursor).toBe(without.length - 1);
    // The row that now stands at the old number is NOT the run the person had selected: nothing is selected until a key says so.
    expect(active(next).focus).toBeUndefined();
    expect(active(next).message).toBe(ACTIVE_FOCUS_LEFT);
    const emptied = withActiveRead(r.state, read([]));
    expect(active(emptied).cursor).toBe(0);
    expect(active(emptied).focus).toBeUndefined();
    expect(
      active(emptied).message,
      'an empty list says it is empty, not that a run left',
    ).toBeUndefined();
  });

  it('never opens the card of the neighbour that took the place of the run that left (ADR-0140 §2)', () => {
    const order = activeDisplayOrder(EVERY_CLASS);
    const gateAt = order.findIndex((row) => row.runId === IDS.gate);
    const above = order[gateAt - 1];
    if (above === undefined) throw new Error('the gate row has no row above it in this fixture');
    const r = rig();
    walkTo(r, above.runId);
    // The run under the cursor ends; the gate row below it moves up and now stands at the very number the cursor is on.
    r.state = withActiveRead(r.state, read(EVERY_CLASS.filter((row) => row.runId !== above.runId)));
    expect(
      active(r.state).rows[active(r.state).cursor]?.runId,
      'the precondition: the gate row is the neighbour',
    ).toBe(IDS.gate);
    const step = r.press('', ENTER);
    expect(step, 'Enter asks the host to open nothing').toMatchObject({ kind: 'state' });
    expect(active(r.state).message).toBe(ACTIVE_SELECT_FIRST);
    // Once a key has chosen the gate row on purpose, Enter opens it.
    r.press('', UP);
    r.press('', DOWN);
    expect(focusedId(r.state)).toBe(IDS.gate);
    expect(r.press('', ENTER)).toMatchObject({ kind: 'open-gate', runId: IDS.gate });
  });

  it('draws no selected row while nothing is selected, and the first arrow selects one, even at an end', () => {
    const r = rig();
    walkTo(r, IDS.held);
    r.state = withActiveRead(r.state, read(EVERY_CLASS.filter((row) => row.runId !== IDS.held)));
    const lines = tabHostLines(r.state, SIZE);
    expect(
      lines.some((line) => line.kind === 'selected'),
      'no pointer on a run nobody chose',
    ).toBe(false);
    expect(lines.map((line) => line.text).join('\n')).toContain(ACTIVE_FOCUS_LEFT);
    // The cursor is at the last row; ↓ cannot move it, and still selects.
    r.press('', DOWN);
    expect(focusedId(r.state)).toBe(active(r.state).rows.at(-1)?.runId);
    expect(active(r.state).message).toBeUndefined();
    expect(tabHostLines(r.state, SIZE).some((line) => line.kind === 'selected')).toBe(true);
  });

  it('keeps nothing selected through further reads until a key selects, and says why only once', () => {
    const r = rig();
    walkTo(r, IDS.held);
    const without = EVERY_CLASS.filter((row) => row.runId !== IDS.held);
    r.state = withActiveRead(r.state, read(without));
    r.press('', ENTER); // "No run is selected": the key's own sentence
    r.state = withActiveRead(r.state, read(without));
    expect(focusedId(r.state)).toBeUndefined();
    expect(active(r.state).message, 'the key’s sentence is not overwritten by every tick').toBe(
      ACTIVE_SELECT_FIRST,
    );
  });

  it('is remembered by the tab host as a row and as a run, and the tab is entered there again', () => {
    const r = rig();
    walkTo(r, IDS.gate);
    const memory = tabHostMemory(r.state);
    expect(memory.positions.active).toBe(active(r.state).cursor);
    expect(memory.activeFocus).toBe(IDS.gate);
    const back = enterTab(memory, 'active', r.context());
    expect(active(back).focus).toBe(IDS.gate);
    // The focus wins over the row number when the list has changed since.
    const reordered = enterTab(memory, 'active', {
      ...r.context(),
      active: { last: read([...classify([run('newcome1', 'running')]), ...EVERY_CLASS]) },
    });
    expect(active(reordered).focus).toBe(IDS.gate);
  });
});

describe('before a read, and when there is none', () => {
  it('says it is reading until the first read, and names no key but the tab’s', () => {
    const r = rig(null);
    expect(textOf(r.state)).toContain(ACTIVE_LOADING);
    expect(active(r.state).phase).toBe('loading');
    const loaded = withActiveRead(r.state, read(EVERY_CLASS));
    expect(active(loaded).phase).toBe('ready');
    expect(textOf(loaded)).not.toContain(ACTIVE_LOADING);
  });

  it('says it cannot be read when nothing feeds the tab, and when the first read failed', () => {
    const none = enterTab(freshTabMemory('active'), 'active', { now: 0 });
    expect(textOf(none)).toContain(ACTIVE_UNREADABLE);
    expect(active(none).phase).toBe('unreadable');
  });

  it('a later failure keeps the list and says it is the last one read; the next good read takes the sentence back', async () => {
    const { withActiveFailure } = await import('./tab-host.js');
    const r = rig();
    const failed = withActiveFailure(r.state);
    expect(textOf(failed)).toContain(ACTIVE_STALE_READ);
    expect(textOf(failed).join('\n')).toContain(IDS.hosted);
    expect(withActiveFailure(failed), 'the same object, so a failing poll does not repaint').toBe(
      failed,
    );
    const recovered = withActiveRead(failed, read(EVERY_CLASS));
    expect(textOf(recovered)).not.toContain(ACTIVE_STALE_READ);
    const never = withActiveFailure(rig(null).state);
    expect(textOf(never)).toContain(ACTIVE_UNREADABLE);
  });
});

// ---- Through the real Home controller -------------------------------------------------------------------------------------------

const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const GATE_RUN: RunGates = {
  runId: IDS.gate,
  workflowId: 'wf',
  gates: [
    {
      runId: IDS.gate,
      gateId: 'g1',
      nodeId: 'review-step',
      gateType: 'approval',
      message: 'Ship the release?',
      accepts: ['approved', 'rejected'],
    },
  ],
  budgetGates: [],
  degraded: false,
};
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const tabHostOf = (c: HomeController) => {
  const screen = c.getSnapshot().screen;
  return screen?.kind === 'tab-host' ? screen.host : undefined;
};
const activeOf = (c: HomeController) => tabHostOf(c)?.active;

interface Options {
  readonly current?: ActiveRead;
  readonly withActive?: boolean;
  readonly parked?: (runId: string) => RunGates | undefined;
  readonly readFails?: boolean;
  /** The Home's question for a media park (`runMediaContinue`): absent means the Home has none wired. */
  readonly continueMedia?: (runId: string) => Promise<string | undefined>;
  /** What the run host says now (default: no leg). */
  readonly host?: () => RunHostSnapshot;
}

/** A Home with a scripted poll, a scripted clock and scripted timers: nothing sleeps and no operator home is read. */
function mount(options: Options = {}) {
  let clock = 1_000;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 1;
  const state = {
    current: options.current ?? read(EVERY_CLASS),
    closed: false,
    readFails: options.readFails === true,
  };
  const probe = createChangeProbe(() => 1);
  const reads = vi.fn((): Promise<ActiveRead> => {
    if (state.readFails) return Promise.reject(new Error('could not read'));
    return Promise.resolve(state.current);
  });
  const active: HomeActivePort = {
    token: probe.token,
    read: reads,
    isClosed: () => state.closed,
  };
  const onExit = vi.fn();
  const deps: HomeControllerDeps = {
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => EMPTY },
    ...(options.withActive === false ? {} : { active }),
    hostedRuns: {
      snapshot: options.host ?? ((): RunHostSnapshot => IDLE),
      cancel: () => true,
      close: () => Promise.resolve(),
    },
    ...(options.continueMedia === undefined ? {} : { continueMedia: options.continueMedia }),
    gateCards: {
      list: () => [],
      read: options.parked ?? ((runId: string) => (runId === IDS.gate ? GATE_RUN : undefined)),
      resume: () => Promise.reject(new Error('nothing is answered here')),
    },
    schedule: (callback, delayMs) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: clock + delayMs, callback });
      return () => {
        timers.delete(id);
      };
    },
    now: () => clock,
    onExit,
    onError: (cause) => {
      throw cause;
    },
  };
  const controller = createHomeController(deps);
  return {
    controller,
    state,
    probe,
    reads,
    onExit,
    timers: (): number => timers.size,
    /** Move the clock and fire every timer that falls due, then let the poll's promises settle. */
    advance: async (ms: number): Promise<void> => {
      const end = clock + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        clock = Math.max(clock, due[1].at);
        due[1].callback();
        await flush();
      }
      clock = end;
    },
  };
}
type Home = ReturnType<typeof mount>;

const openActive = async (home: Home): Promise<void> => {
  expect(home.controller.openScreen('tab-host', { tab: 'active' })).toBe(true);
  await flush();
};
/** Move the cursor onto the run `id` with real keys. */
const moveTo = (home: Home, id: string): void => {
  for (let i = 0; i < 20 && activeOf(home.controller)?.focus !== id; i += 1)
    home.controller.handleKey('', DOWN);
  expect(activeOf(home.controller)?.focus).toBe(id);
};
const POLL = 1_500;

describe('the controller reads the tab when it is entered, and again only when something moved', () => {
  it('shows the rows after one read at the start, and does not read again while the token is the same', async () => {
    const home = mount();
    await openActive(home);
    expect(home.reads).toHaveBeenCalledTimes(1);
    expect(activeOf(home.controller)?.phase).toBe('ready');
    // This directory's runs: the one paused in another project waits behind `[a] all` (OD-24 D4).
    expect(activeOf(home.controller)?.rows).toHaveLength(EVERY_CLASS.length - 1);
    home.controller.handleKey('a', {});
    expect(activeOf(home.controller)?.rows).toHaveLength(EVERY_CLASS.length);
    expect(home.reads, 'the scope changes what is drawn, and reads nothing').toHaveBeenCalledTimes(
      1,
    );
    await home.advance(POLL * 10);
    expect(home.reads, 'ten ticks and nothing moved').toHaveBeenCalledTimes(1);
  });

  it('reads again at the next tick after the in-process generation moves, and paints the newer rows', async () => {
    const home = mount();
    await openActive(home);
    home.state.current = read(EVERY_CLASS.slice(0, 3));
    home.probe.bump();
    await home.advance(POLL);
    expect(home.reads).toHaveBeenCalledTimes(2);
    expect(activeOf(home.controller)?.rows).toHaveLength(3);
  });

  it('opens on the last read it kept, at once, and reads again', async () => {
    const home = mount();
    await openActive(home);
    home.controller.handleKey('', ESC);
    expect(home.controller.getSnapshot().screen).toBeUndefined();
    expect(home.controller.openScreen('tab-host', { tab: 'active' })).toBe(true);
    expect(activeOf(home.controller)?.phase, 'before the new read has landed').toBe('ready');
    await flush();
    expect(home.reads).toHaveBeenCalledTimes(2);
  });

  it('with nothing wired it says the tab cannot be read, and reads nothing', async () => {
    const home = mount({ withActive: false });
    await openActive(home);
    expect(activeOf(home.controller)?.phase).toBe('unreadable');
    await home.advance(POLL * 3);
    expect(home.reads).not.toHaveBeenCalled();
    expect(home.timers()).toBe(0);
  });

  it('a read that fails says so: the tab cannot be read, and then the list stays when a later read fails', async () => {
    const home = mount({ readFails: true });
    await openActive(home);
    expect(activeOf(home.controller)?.phase).toBe('unreadable');
    home.state.readFails = false;
    await home.advance(POLL);
    expect(activeOf(home.controller)?.phase, 'the same token reads again after a failure').toBe(
      'ready',
    );
    home.state.readFails = true;
    home.probe.bump();
    await home.advance(POLL);
    expect(activeOf(home.controller)?.rows).toHaveLength(EVERY_CLASS.length - 1);
    expect(activeOf(home.controller)?.message).toBe(ACTIVE_STALE_READ);
  });

  it('is told the terminal is below 80×24 and reads nothing until it is not', async () => {
    const home = mount();
    home.controller.setTerminalSize(60, 20);
    await openActive(home);
    home.probe.bump();
    await home.advance(POLL * 3);
    expect(home.reads).not.toHaveBeenCalled();
    home.controller.setTerminalSize(100, 30);
    await home.advance(POLL);
    expect(home.reads).toHaveBeenCalledTimes(1);
  });

  it('reads nothing once the database is closed, and leaves no timer', async () => {
    const home = mount();
    await openActive(home);
    home.state.closed = true;
    home.probe.bump();
    await home.advance(POLL * 3);
    expect(home.reads).toHaveBeenCalledTimes(1);
    expect(home.timers()).toBe(0);
  });
});

describe('a paused row opens its gate card, and Esc returns to the tab on the same row', () => {
  it('Enter on the paused row opens the card; Esc puts the tab host back on that row, and the poll reads again', async () => {
    const home = mount();
    await openActive(home);
    moveTo(home, IDS.gate);
    const row = activeOf(home.controller)?.cursor;
    home.controller.handleKey('', ENTER);
    const screen = home.controller.getSnapshot().screen;
    expect(screen?.kind).toBe('gate-card');
    expect(screen?.kind === 'gate-card' && screen.runId).toBe(IDS.gate);
    expect(screen?.kind === 'gate-card' && screen.from).toBe('tab-host');
    expect(
      screen?.kind === 'gate-card' && screen.back,
      'a card opened from a browser returns to the browser',
    ).toBe('landing');
    home.controller.handleKey('', ESC);
    expect(home.controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(tabHostOf(home.controller)?.tab).toBe('active');
    expect(activeOf(home.controller)?.cursor).toBe(row);
    expect(activeOf(home.controller)?.focus).toBe(IDS.gate);
    await flush();
    expect(home.reads, 'the tab reads again when it is back').toHaveBeenCalledTimes(2);
  });

  it('reads nothing while the card is open, whatever the token does, and leaves no timer behind', async () => {
    const home = mount();
    await openActive(home);
    moveTo(home, IDS.gate);
    home.controller.handleKey('', ENTER);
    expect(home.controller.getSnapshot().screen?.kind).toBe('gate-card');
    expect(home.timers(), 'the card holds no poll').toBe(0);
    home.probe.bump();
    await home.advance(POLL * 5);
    expect(home.reads).toHaveBeenCalledTimes(1);
  });

  it('the tab keeps following its run when the list changed while the card was open', async () => {
    const home = mount();
    await openActive(home);
    moveTo(home, IDS.gate);
    home.controller.handleKey('', ENTER);
    home.state.current = read([
      ...classify([run('newcome1', 'running'), run('newcome2', 'running')]),
      ...EVERY_CLASS,
    ]);
    home.probe.bump();
    home.controller.handleKey('', ESC);
    await flush();
    expect(activeOf(home.controller)?.focus).toBe(IDS.gate);
  });

  it('Ctrl+C on the card closes the card and the tab host with it, and the poll', async () => {
    const home = mount();
    await openActive(home);
    moveTo(home, IDS.gate);
    home.controller.handleKey('', ENTER);
    home.controller.handleKey('c', { ctrl: true });
    expect(home.controller.getSnapshot().screen).toBeUndefined();
    expect(home.timers()).toBe(0);
  });

  it('a run that is not parked any more says so on the tab, and the tab stays', async () => {
    const home = mount({ parked: () => undefined });
    await openActive(home);
    moveTo(home, IDS.gate);
    home.controller.handleKey('', ENTER);
    expect(home.controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(activeOf(home.controller)?.message).toContain(
      'Not parked in this directory any more: run ',
    );
    expect(
      home.controller.getSnapshot().notice,
      'where the person is looking, not behind the screen',
    ).toBeUndefined();
  });

  it('a run that was parked with no gate left says where to look, on the tab', async () => {
    const home = mount({ parked: () => ({ ...GATE_RUN, gates: [] }) });
    await openActive(home);
    moveTo(home, IDS.gate);
    home.controller.handleKey('', ENTER);
    expect(activeOf(home.controller)?.message).toContain('No gate to decide here: ');
  });
});

describe('a media park opens a question, not a card, and Esc returns to the tab on the same row', () => {
  const MEDIA_RUN: RunGates = {
    runId: IDS.media,
    workflowId: 'wf',
    gates: [],
    budgetGates: [],
    pendingMediaJobNodeIds: ['paint'],
    degraded: false,
  };
  const rows = classify([run(IDS.media, 'paused')], {
    pendingGateCounts: new Map([[IDS.media, 0]]),
    pendingMediaJobCounts: new Map([[IDS.media, 1]]),
  });
  const parked = (runId: string): RunGates | undefined =>
    runId === IDS.media ? MEDIA_RUN : undefined;
  const RUNNING: RunHostSnapshot = {
    launching: false,
    active: { leg: 'resume', runId: IDS.media, cancelling: false },
    last: undefined,
  };

  it('Enter asks about THAT run once and opens no gate card; a No (or Esc) says nothing and changes nothing', async () => {
    const ask = vi.fn<MediaQuestion>(() => Promise.resolve(undefined));
    const home = mount({ current: read(rows), parked, continueMedia: ask });
    await openActive(home);
    const before = activeOf(home.controller);
    home.controller.handleKey('', ENTER);
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(IDS.media);
    const screen = home.controller.getSnapshot().screen;
    expect(screen?.kind, 'no gate card: it is a question').toBe('tab-host');
    expect(activeOf(home.controller)?.message, 'a No says nothing').toBeUndefined();
    expect(home.controller.getSnapshot().notice).toBeUndefined();
    expect(activeOf(home.controller)?.cursor).toBe(before?.cursor);
    expect(home.controller.getSnapshot().nativeActionBusy, 'the keyboard is given back').toBe(
      false,
    );
  });

  it('a Yes that started the leg puts its run view in front, from the tab, and Esc comes back to the same row', async () => {
    let started = false;
    const ask = vi.fn<MediaQuestion>(() => {
      started = true;
      return Promise.resolve(`Continuing run ${IDS.media}. It runs in the background.`);
    });
    const home = mount({
      current: read(rows),
      parked,
      continueMedia: ask,
      host: () => (started ? RUNNING : IDLE),
    });
    await openActive(home);
    home.controller.handleKey('', ENTER);
    await flush();
    const screen = home.controller.getSnapshot().screen;
    expect(screen).toMatchObject({ kind: 'run-view', runId: IDS.media, from: 'tab-host' });
    home.controller.handleKey('', ESC);
    expect(home.controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(activeOf(home.controller)?.focus).toBe(IDS.media);
  });

  it('a refusal (another leg is executing) is the tab`s message row, and no view opens', async () => {
    const busy = 'A run is already executing: other-run.';
    const home = mount({
      current: read(rows),
      parked,
      continueMedia: () => Promise.resolve(busy),
      host: () => ({ ...IDLE, active: { leg: 'start', runId: 'other-run', cancelling: false } }),
    });
    await openActive(home);
    home.controller.handleKey('', ENTER);
    await flush();
    expect(home.controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(activeOf(home.controller)?.message).toBe(busy);
  });

  it('with no question wired the run says so on the tab, in words that are not the dead end', async () => {
    const home = mount({ current: read(rows), parked });
    await openActive(home);
    home.controller.handleKey('', ENTER);
    expect(activeOf(home.controller)?.message).toContain('Continuing a run is unavailable');
    expect(activeOf(home.controller)?.message).not.toContain('No gate to decide here');
  });

  it('a run that is read with no gate and no job in flight keeps the dead end`s words, and asks nothing', async () => {
    const ask = vi.fn<MediaQuestion>(() => Promise.resolve(undefined));
    const home = mount({
      current: read(rows),
      parked: (runId) =>
        runId === IDS.media ? { ...MEDIA_RUN, pendingMediaJobNodeIds: [] } : undefined,
      continueMedia: ask,
    });
    await openActive(home);
    home.controller.handleKey('', ENTER);
    expect(ask).not.toHaveBeenCalled();
    expect(activeOf(home.controller)?.message).toContain('No gate to decide here: ');
  });

  it('a run the log shows with a gate beside its job is the gate card`s, never the question', async () => {
    const ask = vi.fn<MediaQuestion>(() => Promise.resolve(undefined));
    const home = mount({
      current: read(rows),
      parked: (runId) =>
        runId === IDS.media ? { ...GATE_RUN, runId, pendingMediaJobNodeIds: ['paint'] } : undefined,
      continueMedia: ask,
    });
    await openActive(home);
    home.controller.handleKey('', ENTER);
    expect(ask).not.toHaveBeenCalled();
    expect(home.controller.getSnapshot().screen?.kind).toBe('gate-card');
  });
});

describe('a card that cannot open says why, and keeps the remedy on the row at 80 columns however long the run id is', () => {
  const LONG = 'a1b2c3d4-0000-4000-8000-0000000000aa';
  const rows = classify([run(LONG, 'paused')], { pendingGateCounts: new Map([[LONG, 1]]) });

  it.each([
    [
      'could not be read',
      (): RunGates | undefined => {
        throw new Error('PRIVATE');
      },
      'The Active tab of /workflows shows what the run waits for.',
    ],
    [
      'is gone',
      (): RunGates | undefined => undefined,
      'Not parked in this directory any more: run ',
    ],
    [
      'has no gate to decide',
      (): RunGates | undefined => ({ ...GATE_RUN, runId: LONG, gates: [] }),
      'No gate to decide here: see what it waits for in /workflows (run ',
    ],
  ])(
    '%s: the sentence starts with what to do, and the id is what a clip takes',
    async (_why, parked, lead) => {
      const home = mount({ current: read(rows), parked });
      await openActive(home);
      home.controller.handleKey('', ENTER);
      expect(home.controller.getSnapshot().screen?.kind).toBe('tab-host');
      const host = tabHostOf(home.controller);
      if (host === undefined) throw new Error('the tab host is not open');
      const line = lineWith(textOf(host), lead.slice(0, 20));
      expect(line.startsWith(lead), 'the remedy is the start of the row').toBe(true);
      expect(displayWidth(line)).toBeLessThanOrEqual(78);
      expect(line).not.toContain('PRIVATE');
      // The id is the part of the sentence that comes last: the message carries it whole, and a clip takes it, never the remedy.
      expect(activeOf(home.controller)?.message).toContain(LONG);
    },
  );
});

describe('the hosted leg’s row reopens its view, and Esc returns to the tab on the same row', () => {
  it('Enter on it puts the run view of that run in front, and Esc brings the tab back on its row', async () => {
    const home = mount();
    await openActive(home);
    moveTo(home, IDS.hosted);
    home.controller.handleKey('', ENTER);
    const screen = home.controller.getSnapshot().screen;
    expect(screen?.kind).toBe('run-view');
    expect(screen?.kind === 'run-view' && screen.runId).toBe(IDS.hosted);
    expect(screen?.kind === 'run-view' && screen.from).toBe('tab-host');
    expect(home.timers(), 'a run view holds no poll').toBe(0);
    home.controller.handleKey('', ESC);
    expect(home.controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(activeOf(home.controller)?.focus).toBe(IDS.hosted);
  });
});

describe('a read-only row opens nothing', () => {
  it('Enter on another process’s run leaves the tab as it is, with the reason on the tab', async () => {
    const home = mount();
    await openActive(home);
    moveTo(home, IDS.other);
    home.controller.handleKey('', ENTER);
    expect(home.controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(activeOf(home.controller)?.message).toMatch(/^Read-only: /u);
  });
});

describe('closing, leaving the tab and tearing the Home down leave no timer', () => {
  it('Esc at the list closes the screen and clears the poll’s timer', async () => {
    const home = mount();
    await openActive(home);
    expect(home.timers(), 'one timer while the tab is in front').toBe(1);
    home.controller.handleKey('', ESC);
    expect(home.controller.getSnapshot().screen).toBeUndefined();
    expect(home.timers()).toBe(0);
    await home.advance(POLL * 10);
    expect(home.reads).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+C closes it the same way', async () => {
    const home = mount();
    await openActive(home);
    home.controller.handleKey('c', { ctrl: true });
    expect(home.controller.getSnapshot().screen).toBeUndefined();
    expect(home.timers()).toBe(0);
  });

  it('moving to another tab stops the poll, and coming back starts it with a read at once', async () => {
    const home = mount();
    await openActive(home);
    home.controller.handleKey('', { rightArrow: true });
    expect(tabHostOf(home.controller)?.tab).toBe('history');
    expect(home.timers()).toBe(0);
    home.probe.bump();
    await home.advance(POLL * 3);
    expect(home.reads).toHaveBeenCalledTimes(1);
    home.controller.handleKey('', { leftArrow: true });
    await flush();
    expect(home.reads).toHaveBeenCalledTimes(2);
    expect(home.timers()).toBe(1);
  });

  it('the Home ending (a signal) clears the timer, and a read still in flight is not painted', async () => {
    const home = mount();
    await openActive(home);
    expect(home.timers()).toBe(1);
    await home.controller.teardownActive();
    expect(home.timers()).toBe(0);
    const before = home.reads.mock.calls.length;
    home.probe.bump();
    await home.advance(POLL * 3);
    expect(home.reads.mock.calls).toHaveLength(before);
  });

  it('a read that lands after the screen closed paints nothing', async () => {
    let finish: (value: ActiveRead) => void = () => undefined;
    const home = mount();
    home.reads.mockImplementationOnce(
      () =>
        new Promise<ActiveRead>((resolve) => {
          finish = resolve;
        }),
    );
    home.controller.openScreen('tab-host', { tab: 'active' });
    expect(activeOf(home.controller)?.phase).toBe('loading');
    home.controller.handleKey('', ESC);
    finish(read(EVERY_CLASS));
    await flush();
    expect(home.controller.getSnapshot().screen).toBeUndefined();
  });
});

describe('the keys of the tab host still work around it', () => {
  it('the tab bar draws Active in front with the rows below it, in at most 23 rows, through a real controller', async () => {
    const home = mount();
    await openActive(home);
    const host = tabHostOf(home.controller);
    if (host === undefined) throw new Error('no tab host');
    const drawn = textOf(host);
    expect(drawn.length).toBeLessThanOrEqual(TAB_HOST_ROWS);
    expect(drawn[0]).toContain('› Active');
    expect(drawn.join('\n')).toContain(IDS.hosted);
  });
});
