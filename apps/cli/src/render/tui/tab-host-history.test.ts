/**
 * The History tab of the Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): its rows, its keys, the run detail it opens and the way back out of it. A pure model: no ink, no controller, no
 * database. The port is scripted (the paging rules and the cost fold are `history-source.test.ts`'s), so a test states exactly which runs
 * the page holds and which the pinned section; the detail is built through the real model from hand-made records.
 */
import type { RunDetailRecord, RunSummaryRecord, StepSummaryRecord } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { buildHistoryRows } from '../../history/history-model.js';
import type {
  HistoryCost,
  HistoryEntry,
  HistoryQuery,
  HistoryRead,
} from '../../history/history-source.js';
import { buildRunDetailModel } from '../../history/run-detail-model.js';
import type { RunDetailLoad, RunDetailRead } from '../../history/run-detail-source.js';
import type { ChatKey } from './chat-input.js';
import { legend } from './legend.js';
import { usableColumns } from './sheet-frame.js';
import {
  TAB_HOST_ROWS,
  enterTab,
  foldTabHostKey,
  freshTabMemory,
  tabHostLegendItems,
  tabHostLines,
  tabHostMemory,
  withHistoryLoad,
  type TabHostContext,
  type TabHostState,
  type TabHostStep,
} from './tab-host.js';
import { HISTORY_COST_CACHE_MAX } from '../../history/history-source.js';
import {
  HISTORY_HELD_NOTE,
  HISTORY_HELD_UNREAD,
  HISTORY_KEYS,
  HISTORY_LOADING,
  HISTORY_UNREADABLE,
  type HistoryPort,
} from './tab-host-history.js';
import { displayWidth } from './viewport.js';

const UP: ChatKey = { upArrow: true };
const DOWN: ChatKey = { downArrow: true };
const ENTER: ChatKey = { return: true };
const ESC: ChatKey = { escape: true };
const T0 = Date.parse('2026-11-23T10:00:00.000Z');
const NOW = T0 + 3 * 3_600_000;
const FINISHED: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

function summary(index: number, status: RunStatus, label = 'wf'): RunSummaryRecord {
  const at = new Date(T0 - index * 1000).toISOString();
  return {
    id: `${String(index).padStart(8, '0')}-0000-0000-0000-000000000000`,
    workflowId: label,
    status,
    executionMode: 'local',
    triggerType: 'manual',
    startedAt: at,
    completedAt: at,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: at,
    updatedAt: at,
  };
}

const rowsOf = (
  records: readonly RunSummaryRecord[],
  pinned = new Set<string>(),
  workflow = 'deploy',
): HistoryEntry[] =>
  buildHistoryRows({
    runs: records,
    nowMs: NOW,
    pinnedRunIds: pinned,
    workflowLabels: new Map([['wf', workflow]]),
  }).map((row): HistoryEntry => ({ kind: 'run', row }));

interface Script {
  readonly total?: number;
  readonly pinned?: readonly HistoryEntry[];
  /** Run ids whose cost reads as unreadable. */
  readonly unreadable?: ReadonlySet<string>;
  /** Run ids whose cost read throws (a fault that is not about the run: the source degrades a damaged log itself). */
  readonly costThrows?: ReadonlySet<string>;
  readonly detail?: RunDetailLoad;
}

/** A port over a scripted history: `total` finished runs (a status each in turn), twenty to a page. */
function scripted(script: Script = {}) {
  const records = Array.from({ length: script.total ?? 5 }, (_, index) =>
    summary(index, FINISHED[index % FINISHED.length] ?? 'completed'),
  );
  const reads: HistoryQuery[] = [];
  const costFor = vi.fn((id: string, finished: boolean): HistoryCost => {
    if (script.costThrows?.has(id) === true) throw new Error('PRIVATE-FAULT');
    if (!finished) return { kind: 'not-final' };
    return script.unreadable?.has(id) === true
      ? { kind: 'unreadable' }
      : { kind: 'text', text: '$0.0123' };
  });
  const loadDetail = vi.fn(() =>
    Promise.resolve<RunDetailLoad>(script.detail ?? { kind: 'missing' }),
  );
  const port: HistoryPort = {
    read: (query): HistoryRead => {
      reads.push(query);
      const listed = records.filter((r) => query.status === undefined || r.status === query.status);
      const last = Math.max(0, Math.ceil(listed.length / 20) - 1);
      const page = Math.max(0, Math.min(query.page, last));
      return {
        query: { scope: query.scope, status: query.status, page },
        pinned: script.pinned ?? [],
        rows: rowsOf(listed.slice(page * 20, page * 20 + 20)),
        hasPrev: page > 0,
        hasNext: page < last,
      };
    },
    cost: (row) => costFor(row.id, FINISHED.includes(row.status)),
    loadDetail,
  };
  return { port, reads, costFor, loadDetail, records };
}

function detailRead(
  over: {
    readonly held?: boolean;
    readonly events?: number;
    readonly workflow?: string;
  } = {},
): RunDetailRead {
  const at = new Date(T0).toISOString();
  const status: RunStatus = over.held === true ? 'running' : 'completed';
  const run: RunDetailRecord = {
    ...summary(0, status),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    outputJson: null,
    outputByteLength: null,
    errorJson: null,
    errorByteLength: null,
  };
  const steps: StepSummaryRecord[] = [
    {
      nodeId: 'build',
      nodeType: 'agent',
      status: 'completed',
      attemptNumber: 1,
      startedAt: at,
      completedAt: at,
      durationMs: 3100,
      costMicrocents: 0,
      inputTokens: 12,
      outputTokens: 4,
    },
  ];
  const model = buildRunDetailModel({
    run,
    steps,
    events: [],
    workflowSlug: over.workflow ?? 'deploy',
    terminalHeld: over.held === true,
  });
  return {
    runId: run.id,
    status,
    model,
    terminalHeld: over.held === true,
    heldUnread: false,
    events: Array.from({ length: over.events ?? 3 }, (_, seq) => ({
      seq,
      type: 'node:started' as const,
      nodeId: 'build',
    })),
    eventsComplete: true,
    skippedRows: 0,
  };
}

/** The History tab entered over a port, with the keys going through the tab host's own fold. */
function rig(script: Script = {}) {
  const fake = scripted(script);
  const context = (): TabHostContext => ({
    port: undefined,
    history: fake.port,
    now: 10_000,
    canArm: true,
  });
  let state: TabHostState = enterTab(freshTabMemory('history'), 'history', context());
  const press = (input: string, key: ChatKey = {}): TabHostStep => {
    const step = foldTabHostKey(state, input, key, context());
    if (step.kind !== 'close') state = step.state;
    return step;
  };
  return {
    ...fake,
    press,
    context,
    get state(): TabHostState {
      return state;
    },
    set state(next: TabHostState) {
      state = next;
    },
    cursor: (): number | undefined => state.history?.cursor,
    lines: (columns = 80, rows = 24) =>
      tabHostLines(state, { columns, terminalRows: rows }).map((line) => line.text),
    text: (columns = 80, rows = 24) =>
      tabHostLines(state, { columns, terminalRows: rows })
        .map((line) => line.text)
        .join('\n'),
  };
}

describe('the rows say what they are, in a glyph and a word', () => {
  it('draws a finished run with its status, short id, workflow, age and cost, and a pinned run with its pin word', () => {
    const [first] = rowsOf([summary(0, 'completed')], new Set([summary(0, 'completed').id]));
    const r = rig({ total: 3, pinned: first === undefined ? [] : [first] });
    const text = r.text();
    expect(text).toContain('Pinned (1)');
    expect(text).toContain('Runs');
    for (const word of ['✓ completed', '✗ failed', '⊘ cancelled', '★ pinned'])
      expect(text, word).toContain(word);
    // The first line of the page: the status word, the short id, the workflow, the age and the cost, in that order.
    expect(r.lines().find((line) => line.includes('✗ failed'))).toMatch(
      /^ {2}✗ failed {5}00000001 {2}deploy\s+3h ago {2}\$0\.0123$/u,
    );
    // The status line says the scope, the filter and the page in words.
    expect(text).toContain('this project · every finished run · page 1 (last)');
  });

  it('says `unreadable` for a run whose log cannot be read, and `missing` for a pin whose run is gone, instead of hiding either', () => {
    const damaged = summary(1, 'failed').id;
    const r = rig({
      total: 3,
      unreadable: new Set([damaged]),
      pinned: [{ kind: 'missing', label: 'no-such-run', pinRowid: 7 }],
    });
    const text = r.text();
    expect(text).toContain('? unreadable');
    expect(text).toContain('? missing');
    expect(text).toContain('no-such-run');
    // The damaged run keeps its row and its id.
    expect(r.lines().find((line) => line.includes('? unreadable'))).toContain('00000001');
    r.press('', DOWN);
    r.press('', DOWN);
    expect(r.text(), 'the line under the list says what happened to it').toContain(
      'its event log could not be read (it was failed)',
    );
  });

  it('draws a run that is not finished as `not final`, never as a price', () => {
    const live = rowsOf([summary(0, 'running')]);
    const r = rig({ total: 0, pinned: live });
    expect(r.text()).toContain('◐ running');
    expect(r.text()).toContain('not final');
    expect(r.text()).not.toMatch(/\$/u);
  });

  it('puts a sanitized label on the screen: a control sequence in a workflow name never reaches the terminal', () => {
    const hostile = rowsOf([summary(0, 'completed')], new Set(), 'dep\u001b[31mloy\u0007');
    const r = rig({ total: 0, pinned: hostile });
    const text = r.text();
    // eslint-disable-next-line no-control-regex -- the point of the assertion is the absence of control characters
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/u);
    expect(text).toContain('deploy');
  });

  it('says so when there is nothing to list, and when the tab cannot be read', () => {
    expect(rig({ total: 0 }).text()).toContain(
      'No finished run in this project yet. Run a workflow from the Defined tab.',
    );
    const none = enterTab(freshTabMemory('history'), 'history', { port: undefined, now: 0 });
    const drawn = tabHostLines(none, { columns: 80, terminalRows: 24 }).map((l) => l.text);
    expect(drawn.join('\n')).toContain(HISTORY_UNREADABLE);
    const broken = enterTab(freshTabMemory('history'), 'history', {
      port: undefined,
      history: {
        read: () => {
          throw new Error('PRIVATE');
        },
        cost: () => ({ kind: 'unreadable' }),
        loadDetail: () => Promise.reject(new Error('PRIVATE')),
      },
      now: 0,
    });
    const text = tabHostLines(broken, { columns: 80, terminalRows: 24 })
      .map((l) => l.text)
      .join('\n');
    expect(text).toContain(HISTORY_UNREADABLE);
    expect(text).not.toContain('PRIVATE');
  });
});

describe('Enter opens the run, Esc comes back, and Esc again closes the screen', () => {
  it('asks the host to load the run the cursor is on, shows that it is waiting, and shows the run when it arrives', () => {
    const detail = detailRead();
    const r = rig({ total: 4, detail: { kind: 'ready', detail } });
    r.press('', DOWN);
    const step = r.press('', ENTER);
    expect(step).toMatchObject({ kind: 'open-detail', runId: summary(1, 'failed').id });
    expect(r.text()).toContain(HISTORY_LOADING);
    expect(r.state.history?.detail?.phase).toBe('loading');

    r.state = withHistoryLoad(r.state, summary(1, 'failed').id, { kind: 'ready', detail });
    const text = r.text();
    expect(text).toContain('✓ completed');
    expect(text).toContain('deploy');
    expect(text).toContain('Nodes (1)');
    expect(text).toContain('✓ completed  build');
    expect(text).toContain('Events (3)');
    expect(text).toContain('#0  node:started build');
    expect(text, 'a run is read-only').toContain('Read-only');
  });

  it('puts a result for another run, or one that arrives after the person left, nowhere', () => {
    const r = rig({ total: 4 });
    r.press('', ENTER);
    const before = r.state;
    expect(withHistoryLoad(before, 'some-other-run', { kind: 'ready', detail: detailRead() })).toBe(
      before,
    );
    r.press('', ESC);
    const left = r.state;
    expect(
      withHistoryLoad(left, summary(0, 'completed').id, { kind: 'ready', detail: detailRead() }),
    ).toBe(left);
  });

  it('Esc goes back to the list on the row it came from, and a second Esc closes the screen', () => {
    const r = rig({ total: 4, detail: { kind: 'ready', detail: detailRead() } });
    r.press('', DOWN);
    r.press('', DOWN);
    const id = summary(2, 'cancelled').id;
    r.press('', ENTER);
    r.state = withHistoryLoad(r.state, id, { kind: 'ready', detail: detailRead() });
    expect(r.press('', ESC).kind, 'back is a state, not a close').toBe('state');
    expect(r.state.history?.detail).toBeUndefined();
    expect(r.cursor()).toBe(2);
    expect(r.text()).toContain('⊘ cancelled');
    expect(r.press('', ESC).kind).toBe('close');
  });

  it('Backspace goes back as Esc does, and Ctrl+C closes the screen from the detail', () => {
    const r = rig({ total: 2 });
    r.press('', ENTER);
    r.press('', { backspace: true });
    expect(r.state.history?.detail).toBeUndefined();
    r.press('', ENTER);
    expect(r.press('c', { ctrl: true }).kind).toBe('close');
  });

  it('says a run that is gone, and a log that cannot be read, in words, with the way back', () => {
    for (const [load, words] of [
      [{ kind: 'missing' }, 'not in the history any more'],
      [{ kind: 'unreadable' }, 'could not be read'],
    ] as const) {
      const r = rig({ total: 2 });
      r.press('', ENTER);
      r.state = withHistoryLoad(r.state, summary(0, 'completed').id, load);
      expect(r.text()).toContain(words);
      expect(tabHostLegendItems(r.state).at(-1)).toEqual(HISTORY_KEYS.back);
    }
  });

  it('a run whose end is held says `held` and never `in progress`', () => {
    const r = rig({ total: 2 });
    r.press('', ENTER);
    r.state = withHistoryLoad(r.state, summary(0, 'completed').id, {
      kind: 'ready',
      detail: detailRead({ held: true }),
    });
    const text = r.text();
    expect(text).toContain('◇ held');
    expect(text).toContain(HISTORY_HELD_NOTE.slice(0, 40));
    expect(text).not.toContain('in progress');
    expect(text).not.toContain('◐ running');
  });

  it('scrolls the detail with ↑ and ↓ and keeps the line it is on in view, however long the log', () => {
    const detail = detailRead({ events: 500 });
    const r = rig({ total: 2, detail: { kind: 'ready', detail } });
    r.press('', ENTER);
    r.state = withHistoryLoad(r.state, summary(0, 'completed').id, { kind: 'ready', detail });
    for (let index = 0; index < 200; index += 1) r.press('', DOWN);
    const lines = r.lines();
    expect(lines.length).toBeLessThanOrEqual(TAB_HOST_ROWS);
    expect(lines.some((line) => line.startsWith('› '))).toBe(true);
    // Head: 6 lines + the events heading, so the 200th ↓ is on event #192.
    expect(r.text()).toContain('#192');
    r.press('', { end: true });
    expect(r.text()).toContain('#499');
    r.press('', { home: true });
    expect(r.text()).toContain('deploy');
  });
});

describe('the run detail says what it could not read, and keeps what identifies the run', () => {
  /** The detail of run 0 opened over the list and handed `read`. */
  const opened = (read: RunDetailRead, script: Script = {}) => {
    const r = rig({ total: 3, ...script });
    r.press('', ENTER);
    r.state = withHistoryLoad(r.state, summary(0, 'completed').id, { kind: 'ready', detail: read });
    return r;
  };

  it('draws a notice for an outbox it could not read, for a log longer than the pages read, and for rows a newer version wrote', () => {
    const r = opened({ ...detailRead(), heldUnread: true, eventsComplete: false, skippedRows: 2 });
    const text = r.text();
    expect(text).toContain(HISTORY_HELD_UNREAD);
    expect(text).toContain('Only the first 3 events were read: the figures may be partial.');
    expect(text).toContain('2 rows were written by a newer version and skipped.');
    expect(text, 'the events heading says the count is a floor').toContain('Events (3+)');
    expect(r.lines().filter((line) => line.includes('Only the first'))).toHaveLength(1);
    // Each is a notice line, not a plain one.
    const kinds = tabHostLines(r.state, { columns: 80, terminalRows: 24 })
      .filter((line) => /Outbox unreadable|Only the first|newer version/u.test(line.text))
      .map((line) => line.kind);
    expect(kinds).toEqual(['notice', 'notice', 'notice']);
  });

  it('says `1 row was` for one skipped row, and draws none of the three notices for a log read whole', () => {
    const one = opened({ ...detailRead(), skippedRows: 1 });
    expect(one.text()).toContain('1 row was written by a newer version and skipped.');
    const clean = opened(detailRead()).text();
    expect(clean).not.toContain('Outbox unreadable');
    expect(clean).not.toContain('Only the first');
    expect(clean).not.toContain('newer version');
  });

  it('cuts the workflow’s name first at 78 columns: the short id and the pin mark stay on the heading', () => {
    const run = summary(0, 'completed');
    const pinned = rowsOf([run], new Set([run.id]));
    const long = `release-${'pipeline-'.repeat(12)}end`;
    const r = opened(detailRead({ workflow: long }), { pinned });
    const heading = r.lines().find((line) => line.includes('✓ completed'));
    if (heading === undefined) throw new Error('the heading was drawn');
    expect(displayWidth(heading)).toBeLessThanOrEqual(usableColumns(80));
    expect(heading, 'the name was cut, with a mark').toContain('…');
    expect(heading.endsWith('00000000  ★ pinned')).toBe(true);
    expect(heading).toContain('✓ completed  release-');
  });

  it('names the keys that work: a detail that is loading, missing or unreadable has nothing to scroll', () => {
    for (const phase of ['loading', 'missing', 'unreadable'] as const) {
      const r = rig({ total: 2 });
      r.press('', ENTER);
      if (phase !== 'loading')
        r.state = withHistoryLoad(r.state, summary(0, 'completed').id, { kind: phase });
      const items = legend(tabHostLegendItems(r.state));
      expect(items, phase).toBe('←/→ tab · Tab cycle · Esc back');
      expect(items).not.toContain('scroll');
    }
  });

  it('names Tab where the legend still fits the floor, and leaves it out of the two that would not', () => {
    const r = rig({ total: 3 });
    expect(legend(tabHostLegendItems(r.state)), 'the list is full').not.toContain('Tab cycle');
    const empty = rig({ total: 0 });
    expect(legend(tabHostLegendItems(empty.state))).toContain('Tab cycle');
    const detail = opened(detailRead());
    expect(legend(tabHostLegendItems(detail.state)), 'the detail is full').not.toContain(
      'Tab cycle',
    );
    for (const state of [r.state, empty.state, detail.state])
      expect(displayWidth(legend(tabHostLegendItems(state)))).toBeLessThanOrEqual(
        usableColumns(80),
      );
  });
});

describe('the keys of the list', () => {
  it('↓ at the end of a page reads the next one with the cursor on its first row, ↑ at the top the one before with the cursor at its end', () => {
    const r = rig({ total: 45 });
    for (let index = 0; index < 19; index += 1) r.press('', DOWN);
    expect(r.cursor()).toBe(19);
    expect(r.reads).toHaveLength(1);
    r.press('', DOWN);
    expect(r.reads.at(-1)).toMatchObject({ page: 1 });
    expect(r.cursor(), 'the first row of the next page').toBe(0);
    expect(r.state.history?.read?.query.page).toBe(1);
    r.press('', UP);
    expect(r.reads.at(-1)).toMatchObject({ page: 0 });
    expect(r.cursor(), 'the last row of the page before').toBe(19);
  });

  it('puts the first row of a page past the pinned section: the pinned rows stay above every page', () => {
    const pinned = rowsOf([summary(90, 'completed')], new Set([summary(90, 'completed').id]));
    const r = rig({ total: 45, pinned });
    expect(r.cursor(), 'the pinned run is the first entry').toBe(0);
    for (let index = 0; index < 20; index += 1) r.press('', DOWN);
    expect(r.cursor()).toBe(20);
    r.press('', DOWN);
    expect(r.state.history?.read?.query.page).toBe(1);
    expect(r.cursor(), 'one pinned entry, then the first row').toBe(1);
  });

  it('a widens the scope to every project and back, and f cycles the status filter, each from the first page', () => {
    const r = rig({ total: 30 });
    r.press('a');
    expect(r.reads.at(-1)).toEqual({ scope: 'all', status: undefined, page: 0 });
    expect(r.text()).toContain('all projects');
    r.press('a');
    expect(r.reads.at(-1)).toMatchObject({ scope: 'project' });
    const seen: (RunStatus | undefined)[] = [];
    for (let index = 0; index < 4; index += 1) {
      r.press('f');
      seen.push(r.reads.at(-1)?.status);
    }
    expect(seen).toEqual(['completed', 'failed', 'cancelled', undefined]);
    r.press('f');
    expect(r.text()).toContain('completed · page 1');
    expect(r.text()).not.toContain('✗ failed');
  });

  it('reads the cost of the rows near the cursor only, and again for none it already has', () => {
    const r = rig({ total: 60 });
    // Page 0 holds twenty rows, the cursor is on the first: ten rows below it have a cost, not all twenty.
    expect(r.costFor).toHaveBeenCalledTimes(11);
    for (let index = 0; index < 5; index += 1) r.press('', DOWN);
    expect(r.costFor, 'five rows scrolled, five more costs').toHaveBeenCalledTimes(16);
    r.press('', UP);
    expect(r.costFor, 'a row that was read is not read again').toHaveBeenCalledTimes(16);
  });

  it('keeps at most 500 costs, the oldest read going first, however many rows were scrolled over', () => {
    const r = rig({ total: 600 });
    for (let index = 0; index < 599; index += 1) r.press('', DOWN);
    expect(r.state.history?.read?.query.page, 'the walk reached the last page').toBe(29);
    expect(r.state.history?.costs.size, '600 rows were read, 500 are kept').toBe(
      HISTORY_COST_CACHE_MAX,
    );
    expect(
      r.state.history?.costs.has(summary(0, 'completed').id),
      'the first rows read went first',
    ).toBe(false);
    expect(r.state.history?.costs.has(summary(599, 'completed').id), 'the newest read stays').toBe(
      true,
    );
  });

  it('never throws out of a key for a cost that cannot be read for a reason that is not the run’s: the row draws `…` and the next key asks again', () => {
    const failing = summary(2, 'cancelled').id;
    const r = rig({ total: 5, costThrows: new Set([failing]) });
    expect(r.text(), 'opening the tab did not fail').toContain('page 1 (last)');
    expect(r.lines().filter((line) => line.includes('…')).length).toBeGreaterThan(0);
    const asked = r.costFor.mock.calls.filter(([id]) => id === failing).length;
    expect(() => r.press('', DOWN)).not.toThrow();
    expect(r.cursor()).toBe(1);
    expect(
      r.costFor.mock.calls.filter(([id]) => id === failing).length,
      'the run was asked about again',
    ).toBeGreaterThan(asked);
    expect(r.text()).not.toContain('PRIVATE');
  });

  it('keeps the cursor on the run it was on across a read, and remembers the position while the screen lives', () => {
    const r = rig({ total: 30 });
    r.press('f');
    r.press('', DOWN);
    r.press('', DOWN);
    const focus = r.state.history?.focus;
    const memory = tabHostMemory(r.state);
    expect(memory.history).toMatchObject({ scope: 'project', status: 'completed' });
    const back = enterTab(memory, 'history', r.context());
    expect(back.history?.focus).toBe(focus);
    expect(back.history?.cursor).toBe(2);
    expect(back.history?.read?.query.status).toBe('completed');
  });

  it('names exactly the keys it answers to, with the way out last', () => {
    const r = rig({ total: 3 });
    const items = tabHostLegendItems(r.state);
    expect(legend(items)).toBe(
      '←/→ tab · ↑/↓ move · Enter open · [p] pin · [a] all · [f] filter · Esc close',
    );
    expect(items.at(-1)).toEqual({ keys: 'Esc', verb: 'close' });
    r.press('a');
    expect(legend(tabHostLegendItems(r.state))).toContain('[a] here');
    // Each key named does what it says.
    expect(r.press('', DOWN).kind).toBe('state');
    expect(r.cursor()).toBe(1);
    expect(r.press('', ENTER).kind).toBe('open-detail');
    expect(r.press('', ESC).kind).toBe('state');
    expect(r.press('', ESC).kind).toBe('close');
    const history = r.state.history;
    if (history === undefined) throw new Error('the History tab was read');
    const inDetail: TabHostState = {
      ...r.state,
      history: { ...history, detail: { runId: 'x', phase: 'loading', cursor: 0 } },
    };
    expect(legend(tabHostLegendItems(inDetail))).toBe('←/→ tab · Tab cycle · Esc back');
  });

  it('a chord or a meta key moves nothing, and an unnamed key is nothing', () => {
    const r = rig({ total: 4 });
    r.press('', { downArrow: true, ctrl: true });
    r.press('', { downArrow: true, meta: true });
    expect(r.cursor()).toBe(0);
    for (const letter of ['x', 'r', 'd', ' ']) expect(r.press(letter).kind, letter).toBe('state');
    expect(r.cursor()).toBe(0);
  });
});

describe('the 80×24 budget', () => {
  it.each([
    [80, 24],
    [100, 30],
    [80, 40],
  ])(
    'at %s×%s, with 300 runs and a pinned section: at most 23 rows, none wider than the margin allows, the strip first, the cursor in view and the legend last',
    (columns, terminalRows) => {
      const pinned = rowsOf(
        Array.from({ length: 12 }, (_, index) => summary(500 + index, 'completed')),
        new Set(Array.from({ length: 12 }, (_, index) => summary(500 + index, 'completed').id)),
      );
      const r = rig({ total: 300, pinned });
      for (const presses of [0, 7, 23, 11]) {
        for (let index = 0; index < presses; index += 1) r.press('', DOWN);
        const lines = tabHostLines(r.state, { columns, terminalRows });
        expect(lines.length).toBeLessThanOrEqual(Math.min(TAB_HOST_ROWS, terminalRows - 1));
        for (const line of lines)
          expect(displayWidth(line.text)).toBeLessThanOrEqual(usableColumns(columns));
        expect(lines[0]?.text).toContain('▸ History');
        expect(lines.at(-1)?.kind).toBe('legend');
        expect(lines.some((line) => line.kind === 'selected')).toBe(true);
        expect(lines.at(-1)?.text, 'the way out is never cut').toMatch(/Esc close$/u);
      }
    },
  );

  it('keeps the legend whole at 80 columns, in the list and in the detail', () => {
    const r = rig({ total: 3, detail: { kind: 'ready', detail: detailRead() } });
    const legendLine = (): string => r.lines().at(-1) ?? '';
    expect(legendLine()).not.toContain('…');
    r.press('a');
    expect(legendLine(), 'the longer scope verb fits too').not.toContain('…');
    r.press('', ENTER);
    r.state = withHistoryLoad(r.state, summary(0, 'completed').id, {
      kind: 'ready',
      detail: detailRead(),
    });
    expect(legendLine()).toBe(
      '←/→ tab · ↑/↓ scroll · Enter open · [n] first failed · [p] pin · Esc back',
    );
    expect(displayWidth(legendLine()), 'the detail legend fits 80 columns').toBeLessThanOrEqual(
      usableColumns(80),
    );
  });

  it('draws the detail of a very long log in the same rows, and the enlarge line below the floor', () => {
    const detail = detailRead({ events: 5000 });
    const r = rig({ total: 2, detail: { kind: 'ready', detail } });
    r.press('', ENTER);
    r.state = withHistoryLoad(r.state, summary(0, 'completed').id, { kind: 'ready', detail });
    for (let index = 0; index < 1500; index += 1) r.press('', DOWN);
    const lines = tabHostLines(r.state, { columns: 80, terminalRows: 24 });
    expect(lines.length).toBeLessThanOrEqual(TAB_HOST_ROWS);
    expect(lines.at(-1)?.kind).toBe('legend');
    const small = tabHostLines(r.state, { columns: 79, terminalRows: 23 }).map((l) => l.text);
    expect(small.join('\n')).toContain('Enlarge the terminal');
  });
});
