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
import { usableColumns } from './sheet-frame.js';
import {
  TAB_HOST_ROWS,
  enterHistoryAtDetail,
  enterTab,
  foldTabHostKey,
  freshTabMemory,
  tabHostLegend,
  tabHostLegendText,
  tabHostLines,
  tabHostMemory,
  withHistoryLoad,
  type TabHostContext,
  type TabHostState,
  type TabHostStep,
} from './tab-host.js';
import { HISTORY_COST_CACHE_MAX } from '../../history/history-source.js';
import {
  HISTORY_BODY_ROOM_MAX,
  HISTORY_COST_FAULT,
  HISTORY_COST_REACH,
  HISTORY_EMPTY_PAGE,
  HISTORY_HELD_NOTE,
  HISTORY_HINT,
  HISTORY_HINT_MORE,
  HISTORY_HELD_UNREAD,
  HISTORY_KEYS,
  HISTORY_LOADING,
  HISTORY_UNREADABLE,
  type HistoryPort,
} from './tab-host-history.js';
import type { PinPort } from './tab-host-pin.js';
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
  /**
   * The run ids the PIN STORE holds (the store, not the page). Given, the port answers `isRunPinned` from it and the context carries a pin
   * port that writes to it, so a run of another directory can be pinned without being on the page.
   */
  readonly pinStore?: Set<string>;
  /** `isRunPinned` throws: the pin store could not be read. */
  readonly pinStoreThrows?: boolean;
}

/** A pin port over a set of run ids, answering as the real store does (`already-pinned` for a second pin of one run). */
function pinPortOver(store: Set<string>): PinPort {
  return {
    pinWorkflow: () => 'pinned',
    unpinWorkflow: () => false,
    pinRun: (runId) => {
      if (store.has(runId)) return 'already-pinned';
      store.add(runId);
      return 'pinned';
    },
    unpinRun: (runId) => store.delete(runId),
    unpinRow: () => false,
  };
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
    ...(script.pinStore === undefined
      ? {}
      : {
          isRunPinned: (runId: string): boolean => {
            if (script.pinStoreThrows === true) throw new Error('PRIVATE-PIN-FAULT');
            return script.pinStore?.has(runId) === true;
          },
        }),
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
    stepsComplete: true,
    skippedRows: 0,
  };
}

/** The History tab entered over a port, with the keys going through the tab host's own fold. */
function rig(script: Script = {}) {
  const fake = scripted(script);
  const context = (): TabHostContext => ({
    port: undefined,
    history: fake.port,
    ...(script.pinStore === undefined ? {} : { pins: pinPortOver(script.pinStore) }),
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
    expect(text).toContain('? missing');
    expect(text).toContain('no-such-run');
    // The damaged run keeps its row, its id and ITS OWN status (it failed); `unreadable` is said once, where its cost would be.
    const row = r.lines().find((line) => line.includes('00000001'));
    expect(row).toMatch(/^ {2}✗ failed {5}00000001 /u);
    expect(row).toMatch(/ago\s+unreadable$/u);
    expect(row?.match(/unreadable/gu), 'said once, not twice').toHaveLength(1);
    expect(text).not.toContain('? unreadable');
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
    expect(text, 'no run is changed here, and p says that it only marks one').toContain(
      'No run is changed here; [p] only marks one.',
    );
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
      expect(tabHostLegend(r.state).exit).toBe(HISTORY_KEYS.back);
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

  it('keeps the remedy of a held end on screen at 80 columns: the explanation is what a narrow terminal cuts', () => {
    const r = rig({ total: 2 });
    r.press('', ENTER);
    r.state = withHistoryLoad(r.state, summary(0, 'completed').id, {
      kind: 'ready',
      detail: detailRead({ held: true }),
    });
    const note = r.lines(80).find((line) => line.includes('Its end is held in the outbox'));
    expect(note, 'the note is drawn').toBeDefined();
    expect(note).toContain('relavium status shows what to do.');
    expect(displayWidth(note ?? '')).toBeLessThanOrEqual(78);
    // The note is longer than the line, so the cut is real: what is drawn ends in the cut, and the cut took the explanation, which comes last.
    expect(note?.endsWith('…'), 'the line was cut').toBe(true);
    expect(note, 'the explanation is what the margin took').not.toContain('The run is over');
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
    // The remedy is a row of its own, so a narrow terminal cannot cut it off the end of the sentence before it.
    expect(r.lines(80)).toContain('  relavium logs shows the rest.');
    // Each is a notice line, not a plain one.
    const kinds = tabHostLines(r.state, { columns: 80, terminalRows: 24 })
      .filter((line) => /Outbox unreadable|Only the first|newer version/u.test(line.text))
      .map((line) => line.kind);
    expect(kinds).toEqual(['notice', 'notice', 'notice']);
  });

  it('says the node table is the first 5000 steps when the attempt rows were cut, as one notice row, and says nothing for a list read whole (PR #102 review: P3)', () => {
    const cut = opened({ ...detailRead(), stepsComplete: false });
    const row = 'Only the first 5000 steps were read: the node table may be partial.';
    expect(cut.text()).toContain(row);
    expect(cut.lines().filter((line) => line.includes('Only the first'))).toHaveLength(1);
    const kinds = tabHostLines(cut.state, { columns: 80, terminalRows: 24 })
      .filter((line) => line.text.includes('Only the first'))
      .map((line) => line.kind);
    expect(kinds).toEqual(['notice']);
    expect(opened(detailRead()).text()).not.toContain('steps were read');
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
      const items = tabHostLegendText(r.state);
      expect(items, phase).toBe('←/→ tab · Tab cycle · [Ctrl+C] close · Esc back');
      expect(items).not.toContain('scroll');
    }
  });

  it('names Tab where the legend still fits the floor, and leaves it out of the two that would not', () => {
    const r = rig({ total: 3 });
    expect(tabHostLegendText(r.state), 'the list is full').not.toContain('Tab cycle');
    const empty = rig({ total: 0 });
    expect(tabHostLegendText(empty.state)).toContain('Tab cycle');
    const detail = opened(detailRead());
    expect(tabHostLegendText(detail.state), 'the detail is full').not.toContain('Tab cycle');
    for (const state of [r.state, empty.state, detail.state])
      expect(displayWidth(tabHostLegendText(state))).toBeLessThanOrEqual(usableColumns(80));
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
    // Page 0 holds twenty rows and the cursor is on the first: the rows within the reach have a cost, the last two of the page do not yet.
    expect(r.costFor).toHaveBeenCalledTimes(HISTORY_COST_REACH + 1);
    expect(HISTORY_COST_REACH + 1, 'the page is longer than the reach').toBeLessThan(20);
    r.press('', DOWN);
    expect(r.costFor, 'one row scrolled, one more cost').toHaveBeenCalledTimes(
      HISTORY_COST_REACH + 2,
    );
    r.press('', DOWN);
    expect(r.costFor, 'two rows scrolled, the whole page is read').toHaveBeenCalledTimes(20);
    r.press('', UP);
    expect(r.costFor, 'a row that was read is not read again').toHaveBeenCalledTimes(20);
  });

  describe('a drawn row always has its cost', () => {
    /** The run rows the list draws (not the strip, a heading, a marker or the line under the list). */
    const drawnRuns = (r: ReturnType<typeof rig>, columns = 80, terminalRows = 24) =>
      tabHostLines(r.state, { columns, terminalRows }).filter(
        (line) =>
          (line.kind === 'row' || line.kind === 'selected') && /\d{8} {2}\S/u.test(line.text),
      );
    const withoutCost = (r: ReturnType<typeof rig>) =>
      drawnRuns(r).filter((line) => !line.text.includes('$0.0123'));

    it('opening the tab, after End, after PgDn and PgUp, and at every step down a page, with and without a pinned section', () => {
      for (const pinnedCount of [0, 12]) {
        const pinned = rowsOf(
          Array.from({ length: pinnedCount }, (_, index) => summary(500 + index, 'completed')),
          new Set(
            Array.from({ length: pinnedCount }, (_, index) => summary(500 + index, 'completed').id),
          ),
        );
        const r = rig({ total: 100, pinned });
        const where = `${String(pinnedCount)} pinned`;
        expect(drawnRuns(r).length, `${where}: the list is drawn`).toBeGreaterThan(10);
        expect(withoutCost(r), `${where}: opening the tab`).toEqual([]);
        r.press('', { end: true });
        expect(drawnRuns(r).length, `${where}: End draws the list`).toBeGreaterThan(10);
        expect(withoutCost(r), `${where}: after End`).toEqual([]);
        r.press('', { home: true });
        r.press('', { pageDown: true });
        expect(withoutCost(r), `${where}: after PgDn`).toEqual([]);
        r.press('', { pageUp: true });
        expect(withoutCost(r), `${where}: after PgUp`).toEqual([]);
        r.press('', { home: true });
        for (let step = 0; step < pinnedCount + 20; step += 1) {
          r.press('', DOWN);
          expect(withoutCost(r), `${where}: after ${String(step + 1)} ↓`).toEqual([]);
        }
      }
    });

    it('holds at a terminal of any height, because the list never draws more rows than the reach covers', () => {
      const r = rig({ total: 100 });
      for (const rows of [24, 40, 80]) {
        expect(drawnRuns(r, 80, rows).length).toBeLessThanOrEqual(HISTORY_COST_REACH + 1);
        expect(drawnRuns(r, 80, rows).length, `${String(rows)} rows`).toBeGreaterThan(10);
      }
      // The reach is derived from the room the tab host gives the body (the strip, its rule and the legend are the other three rows), so the
      // two cannot drift apart: the tab host's budget is what this module's room is cut from.
      expect(HISTORY_BODY_ROOM_MAX).toBe(TAB_HOST_ROWS - 3);
    });
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

  it('never throws out of a key for a cost that cannot be read for a reason that is not the run’s: that row says so without blaming the log, the rows after it are still read, and the next key tries it again', () => {
    const failing = summary(2, 'cancelled').id;
    const throws = new Set([failing]);
    const r = rig({ total: 5, costThrows: throws });
    expect(r.text(), 'opening the tab did not fail').toContain('page 1 (last)');
    const asked = (): number => r.costFor.mock.calls.filter(([id]) => id === failing).length;
    expect(asked(), 'the run was asked about once, when the tab was entered').toBe(1);
    const rowOf = (index: number): string | undefined =>
      r.lines().find((line) => line.includes(String(index).padStart(8, '0')));
    // The faulting run keeps its own status (nothing is known against its log) and says in its cost slot that the cost was not read; the
    // two rows after it carry their cost: one run's fault does not leave the rest of the window without a figure.
    expect(rowOf(2)).toMatch(/^ {2}⊘ cancelled {2}00000002 {2}deploy\s+3h ago {2}not read$/u);
    expect(rowOf(3)).toContain('$0.0123');
    expect(rowOf(4)).toContain('$0.0123');
    expect(r.text(), 'no row is left reading `…`').not.toContain('…');
    r.press('', DOWN);
    r.press('', DOWN);
    expect(r.cursor()).toBe(2);
    expect(r.text(), 'the line under the list says what happened, and what to do').toContain(
      HISTORY_COST_FAULT,
    );
    expect(r.text(), 'a fault of the moment is not the log’s verdict').not.toContain(
      'event log could not be read',
    );
    for (let key = 0; key < 2; key += 1) expect(() => r.press('', DOWN)).not.toThrow();
    expect(r.cursor()).toBe(4);
    expect(asked(), 'every key asked about the run again').toBe(5);
    expect(
      r.costFor.mock.calls.filter(([id]) => id !== failing),
      'and no other run was asked about twice',
    ).toHaveLength(4);
    expect(r.text()).not.toContain('PRIVATE');
    // The fault passes: the next key reads the cost, and the row shows it.
    throws.delete(failing);
    r.press('', { upArrow: true });
    expect(rowOf(2)).toContain('$0.0123');
    expect(r.text()).not.toContain('not read');
  });

  it('a key that moves nothing asks again for a cost that could not be read: on a one-row list, ↑ and ↓ are such keys, and the one that succeeds shows the cost', () => {
    const only = summary(0, 'completed').id;
    const throws = new Set([only]);
    const r = rig({ total: 1, costThrows: throws });
    const asked = (): number => r.costFor.mock.calls.filter(([id]) => id === only).length;
    expect(asked(), 'asked once, when the tab was entered').toBe(1);
    expect(r.text(), 'the fault line says how to retry').toContain(HISTORY_COST_FAULT);
    r.press('', UP);
    expect(r.cursor()).toBe(0);
    expect(asked(), 'a key that moved nothing asked again').toBe(2);
    expect(r.text()).toContain(HISTORY_COST_FAULT);
    throws.delete(only);
    r.press('', DOWN);
    expect(asked()).toBe(3);
    expect(r.text(), 'the cost shows once the read succeeds').toContain('$0.0123');
    expect(r.text()).not.toContain(HISTORY_COST_FAULT);
  });

  it('a letter with Caps Lock on is the same key: P, A and F act as p, a and f on the list, and P and N on the detail', () => {
    const pins = {
      pinWorkflow: vi.fn(() => 'pinned' as const),
      unpinWorkflow: vi.fn(() => true),
      pinRun: vi.fn(() => 'pinned' as const),
      unpinRun: vi.fn(() => true),
      unpinRow: vi.fn(() => true),
    };
    const fake = scripted({ total: 30, detail: { kind: 'ready', detail: detailRead() } });
    const context = (): TabHostContext => ({
      port: undefined,
      history: fake.port,
      pins,
      now: 10_000,
      canArm: true,
    });
    let state: TabHostState = enterTab(freshTabMemory('history'), 'history', context());
    const press = (input: string, key: ChatKey = {}): void => {
      const step = foldTabHostKey(state, input, key, context());
      if (step.kind !== 'close') state = step.state;
    };
    press('P');
    expect(pins.pinRun, 'P pinned the run').toHaveBeenCalledWith(summary(0, 'completed').id);
    press('A');
    expect(fake.reads.at(-1), 'A widened the scope').toMatchObject({ scope: 'all', page: 0 });
    press('F');
    expect(fake.reads.at(-1), 'F cycled the filter').toMatchObject({ status: 'completed' });
    press('', ENTER);
    state = withHistoryLoad(state, summary(0, 'completed').id, {
      kind: 'ready',
      detail: detailRead(),
    });
    press('P');
    expect(pins.pinRun, 'P on the detail pinned too').toHaveBeenCalledTimes(2);
    press('N');
    expect(state.history?.detail?.message, 'N on the detail looked for a failed node').toBe(
      'No node of this run ended failed.',
    );
  });

  it('draws `unreadable` in the cost slot of a run whose log cannot be read, never a bare dash', () => {
    const damaged = summary(1, 'failed').id;
    const r = rig({ total: 3, unreadable: new Set([damaged]) });
    expect(r.lines().find((line) => line.includes('00000001'))).toMatch(/ago\s+unreadable$/u);
    expect(r.text()).not.toContain('—');
  });

  it('drops the cost shown least recently when the cache is full: a pinned run above every page stays, whoever scrolls past it', () => {
    // The pinned run sits at the top of every page, so its cost is looked at again at the start of each one. It was the first cost read,
    // so a map that dropped the oldest read would lose it as soon as 500 other runs were read; one that drops the least recently shown
    // keeps it for as long as it is on screen.
    const pinnedRun = summary(9_000, 'completed');
    const pinned = rowsOf([pinnedRun], new Set([pinnedRun.id]));
    const r = rig({ total: 600, pinned });
    for (let index = 0; index < 599; index += 1) r.press('', DOWN);
    expect(r.state.history?.read?.query.page, 'the walk reached the last page').toBe(29);
    expect(r.state.history?.costs.size, '600 rows and the pinned run were read, 500 are kept').toBe(
      HISTORY_COST_CACHE_MAX,
    );
    expect(
      r.state.history?.costs.has(pinnedRun.id),
      'the pinned run was shown again and again, so it stayed',
    ).toBe(true);
    // Kept, not read again: a map that dropped it while it was not in view (it is only in the window at the top of a page) would ask the
    // port for it once more at the next page, and the cost would be read twice.
    expect(
      r.costFor.mock.calls.filter(([id]) => id === pinnedRun.id),
      'the pinned run’s cost was read once for the whole walk',
    ).toHaveLength(1);
    expect(
      r.state.history?.costs.has(summary(0, 'completed').id),
      'a run shown once, long ago, went',
    ).toBe(false);
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
    expect(tabHostLegendText(r.state)).toBe(
      '←/→ tab · ↑/↓ move · Enter open · [p] pin · [a] all · [f] filter · Esc close',
    );
    expect(tabHostLegend(r.state).exit).toMatchObject({
      keys: 'Esc',
      verb: 'close',
      class: 'close',
    });
    r.press('a');
    expect(tabHostLegendText(r.state)).toContain('[a] here');
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
      history: { ...history, detail: { runId: 'x', phase: 'loading', cursor: 0, pinned: false } },
    };
    expect(tabHostLegendText(inDetail)).toBe('←/→ tab · Tab cycle · [Ctrl+C] close · Esc back');
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

describe('the pin state of a run belongs to the detail and the pin store, not to the page (a run of another directory)', () => {
  /** A run the page of this project does not list (another directory's, reached from the strip), whose detail is `ready`. */
  const FOREIGN = 'ffffffff-0000-0000-0000-000000000000';
  function foreignDetail(script: Script) {
    const r = rig({ total: 2, ...script });
    r.state = enterHistoryAtDetail(freshTabMemory('history'), r.context(), FOREIGN);
    r.state = withHistoryLoad(r.state, FOREIGN, { kind: 'ready', detail: detailRead() });
    return r;
  }
  const message = (r: ReturnType<typeof rig>): string | undefined =>
    r.state.history?.detail?.message;

  it('shows `★ pinned` for a pinned run the page does not list, and `p` unpins it, then pins it again', () => {
    const store = new Set([FOREIGN]);
    const r = foreignDetail({ pinStore: store });
    expect(r.text(), 'the header says it is pinned').toContain('★ pinned');
    r.press('p');
    expect(store.has(FOREIGN), 'the store lost the pin').toBe(false);
    expect(message(r)).toBe('Unpinned ffffffff.');
    expect(r.text()).not.toContain('★ pinned');
    r.press('p');
    expect(store.has(FOREIGN)).toBe(true);
    expect(message(r)).toBe('Pinned ffffffff.');
    expect(r.text()).toContain('★ pinned');
  });

  it('shows no star for an unpinned foreign run and pins it on the first `p`', () => {
    const store = new Set<string>();
    const r = foreignDetail({ pinStore: store });
    expect(r.text()).not.toContain('★ pinned');
    r.press('p');
    expect([...store]).toEqual([FOREIGN]);
    expect(r.text()).toContain('★ pinned');
  });

  it('asks the store when the key is pressed, so a pin another process removed or made meanwhile is not toggled blind', () => {
    const store = new Set([FOREIGN]);
    const r = foreignDetail({ pinStore: store });
    store.delete(FOREIGN); // another process unpinned it after the detail opened
    r.press('p');
    expect(store.has(FOREIGN), 'it pins: it was not pinned any more').toBe(true);
    expect(message(r)).toBe('Pinned ffffffff.');
  });

  it('falls back to what the detail knew when the pin store cannot be read, and says nothing of the fault', () => {
    const r = foreignDetail({ pinStore: new Set<string>(), pinStoreThrows: true });
    r.press('p');
    expect(message(r)).toBe('Pinned ffffffff.');
    expect(r.text()).not.toContain('PRIVATE-PIN-FAULT');
  });
});

describe('a page can be short, or empty, and still not be the last (the store is read 200 raw rows at a time)', () => {
  /** A port whose first page holds `first` finished runs and says more lies past it; the second page holds one run and is the last. */
  function pagedPort(first: number) {
    const fake = scripted({ total: 0 });
    const reads: number[] = [];
    const port: HistoryPort = {
      ...fake.port,
      read: (query): HistoryRead => {
        reads.push(query.page);
        const rows =
          query.page === 0
            ? rowsOf(Array.from({ length: first }, (_, index) => summary(index, 'completed')))
            : rowsOf([summary(99, 'failed')]);
        return {
          query: { scope: query.scope, status: query.status, page: query.page },
          pinned: [],
          rows,
          hasPrev: query.page > 0,
          hasNext: query.page === 0,
        };
      },
    };
    const context = (): TabHostContext => ({
      port: undefined,
      history: port,
      now: 10_000,
      canArm: true,
    });
    let state: TabHostState = enterTab(freshTabMemory('history'), 'history', context());
    const press = (input: string, key: ChatKey = {}): TabHostStep => {
      const step = foldTabHostKey(state, input, key, context());
      if (step.kind !== 'close') state = step.state;
      return step;
    };
    const text = (): string =>
      tabHostLines(state, { columns: 80, terminalRows: 24 })
        .map((line) => line.text)
        .join('\n');
    return { press, text, reads, state: (): TabHostState => state };
  }

  it('an empty first page with more behind it says so and names the key, instead of "No finished run", and `↓` reads the next page', () => {
    const r = pagedPort(0);
    expect(r.text()).toContain(HISTORY_EMPTY_PAGE);
    expect(r.text()).not.toContain('No finished run in this project yet');
    expect(r.text(), 'the status line does not claim the page is the last').not.toContain('(last)');
    const legendLine = r.text().split('\n').at(-1) ?? '';
    expect(legendLine, 'the legend names the keys that walk it').toContain('↑/↓ move');
    r.press('', DOWN);
    expect(r.reads).toEqual([0, 1]);
    expect(r.text()).toContain('00000099');
    expect(r.text()).not.toContain(HISTORY_EMPTY_PAGE);
  });

  it('a short page with more behind it says `↓ at the end reads the next page` where a full page would show a marker, and `↓` at the end reads it', () => {
    const r = pagedPort(3);
    expect(r.text()).toContain(HISTORY_HINT_MORE);
    expect(r.text()).not.toContain(HISTORY_HINT);
    r.press('', DOWN);
    r.press('', DOWN);
    expect(r.reads, 'not yet: the cursor is on the third row').toEqual([0]);
    r.press('', DOWN);
    expect(r.reads, 'at the end the next page is read').toEqual([0, 1]);
  });

  it('the last page keeps the plain hint, and an empty last page says "No finished run"', () => {
    const fake = rig({ total: 3 });
    expect(fake.text()).toContain(HISTORY_HINT);
    expect(fake.text()).not.toContain(HISTORY_HINT_MORE);
    const none = rig({ total: 0 });
    expect(none.text()).toContain('No finished run in this project yet');
    expect(none.text().split('\n').at(-1)).not.toContain('↑/↓');
  });
});
