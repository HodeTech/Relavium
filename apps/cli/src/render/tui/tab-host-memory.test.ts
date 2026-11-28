/**
 * What the tab host remembers of each tab while ANOTHER tab is in front
 * ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §1: each tab keeps its
 * position for the life of the screen). The memory used to be built from the tab in front alone, so a move to another tab kept every cursor
 * (the positions travel with every state) but forgot the History tab's scope, status filter and focused run, and the Active tab's focused run.
 * This file moves between tabs through the tab host's own key fold and asks each tab how it comes back. The model only: no controller, no
 * Ink, no database; `home-tab-memory.test.ts` is the same through the Home controller.
 */
import type { RunSummaryRecord } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { classifyActiveRuns } from '../../history/active-model.js';
import { buildHistoryRows } from '../../history/history-model.js';
import type { HistoryRead } from '../../history/history-source.js';
import type { ChatKey } from './chat-input.js';
import {
  enterTab,
  foldTabHostKey,
  freshTabMemory,
  tabHostMemory,
  type TabHostContext,
  type TabHostState,
  type TabHostStep,
  type TabId,
} from './tab-host.js';
import type { HistoryPort } from './tab-host-history.js';

const LEFT: ChatKey = { leftArrow: true };
const RIGHT: ChatKey = { rightArrow: true };
const DOWN: ChatKey = { downArrow: true };

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const HERE = '/work/here';
const FINISHED: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

const runRecord = (index: number, status: RunStatus): RunSummaryRecord => {
  const at = new Date(NOW - index * 1_000).toISOString();
  return {
    id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
    workflowId: 'wf',
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
    projectRoot: HERE,
  };
};

/** A History port over two lists the test can change: this project's six runs and, in every project, six more. */
function historyOver() {
  const lists: { project: RunSummaryRecord[]; all: RunSummaryRecord[] } = {
    project: Array.from({ length: 6 }, (_, index) =>
      runRecord(index, FINISHED[index % 3] ?? 'completed'),
    ),
    all: Array.from({ length: 12 }, (_, index) =>
      runRecord(index, FINISHED[index % 3] ?? 'completed'),
    ),
  };
  const port: HistoryPort = {
    read: (query): HistoryRead => {
      const listed = lists[query.scope].filter(
        (record) => query.status === undefined || record.status === query.status,
      );
      return {
        query: { scope: query.scope, status: query.status, page: 0 },
        pinned: [],
        rows: buildHistoryRows({
          runs: listed,
          nowMs: NOW,
          pinnedRunIds: new Set(),
          workflowLabels: new Map([['wf', 'deploy']]),
        }).map((row) => ({ kind: 'run' as const, row })),
        hasPrev: false,
        hasNext: false,
      };
    },
    cost: () => ({ kind: 'text', text: '$0.01' }),
    loadDetail: () => Promise.resolve({ kind: 'missing' }),
  };
  return {
    port,
    /** A run newer than every other, in both lists: it is listed first from the next read on. */
    addNewest: (): void => {
      const newest = runRecord(-1, 'completed');
      lists.project = [newest, ...lists.project];
      lists.all = [newest, ...lists.all];
    },
  };
}

const activeRows = (ids: readonly string[]) =>
  classifyActiveRuns({
    // The first id is the newest run: the tab lists newest first, so the list reads in the order the ids are given.
    runs: ids.map((id, index) => ({ ...runRecord(index, 'running'), id })),
    leases: new Map(),
    currentProjectRoot: HERE,
    outboxHeldRunIds: new Set(),
    nowMs: NOW,
    leaseTtlMs: 60_000,
  });

/** The Runs screen on `tab`, both tabs fed, with the keys going through the screen's own fold. */
function rig(tab: TabId = 'history') {
  const history = historyOver();
  let activeIds = ['run-a', 'run-b', 'run-c', 'run-d'];
  const context = (): TabHostContext => ({
    active: { last: { rows: activeRows(activeIds), more: [], heldUnread: false } },
    history: history.port,
    now: 10_000,
  });
  let state: TabHostState = enterTab(freshTabMemory(tab), tab, context());
  const press = (input: string, key: ChatKey = {}): TabHostStep => {
    const step = foldTabHostKey(state, input, key, context());
    if (step.kind !== 'close') state = step.state;
    return step;
  };
  return {
    press,
    context,
    addNewestRun: history.addNewest,
    setActive: (ids: readonly string[]): void => {
      activeIds = [...ids];
    },
    get state(): TabHostState {
      return state;
    },
  };
}
type Rig = ReturnType<typeof rig>;

const historyOf = (r: Rig) => {
  const tab = r.state.history;
  if (tab?.read === undefined) throw new Error('the History tab was read');
  return tab;
};
/** What the History tab shows of its position: the scope, the filter, the focused run and the row the cursor is on. */
const historyPosition = (r: Rig) => {
  const tab = historyOf(r);
  return {
    scope: tab.read?.query.scope,
    status: tab.read?.query.status,
    focus: tab.focus,
    cursor: tab.cursor,
  };
};

describe('the History tab keeps its scope, its filter and its focused run while another tab is in front', () => {
  it('a, f, then ↓, then → and ←: the scope, the filter and the focused run are as they were left', () => {
    const r = rig('history');
    expect(historyPosition(r)).toMatchObject({ scope: 'project', status: undefined, cursor: 0 });
    r.press('a');
    r.press('f');
    r.press('', DOWN);
    const left = historyPosition(r);
    expect(left.scope).toBe('all');
    expect(left.status, 'the filter moved off every finished run').toBeDefined();
    expect(left.cursor).toBe(1);
    expect(left.focus).toMatch(/^row:/u);

    r.press('', LEFT);
    expect(r.state.tab).toBe('active');
    r.press('', RIGHT);
    expect(r.state.tab).toBe('history');
    expect(historyPosition(r), 'the tab came back as it was left').toEqual(left);
  });

  it('the focused run is kept by identity: a run that appeared meanwhile moves the row, not the focus', () => {
    const r = rig('history');
    r.press('a');
    r.press('', DOWN);
    r.press('', DOWN);
    const left = historyPosition(r);
    r.press('', LEFT);
    r.addNewestRun();
    r.press('', RIGHT);
    const back = historyPosition(r);
    expect(back.scope).toBe('all');
    expect(back.focus, 'the same run').toBe(left.focus);
    expect(back.cursor, 'one row further down: the new run is above it').toBe(left.cursor + 1);
  });

  it('survives a visit to the other tab, and the second visit as well', () => {
    const r = rig('history');
    r.press('f');
    r.press('', DOWN);
    const left = historyPosition(r);
    for (const key of [LEFT, LEFT, RIGHT, RIGHT, RIGHT]) r.press('', key);
    expect(r.state.tab).toBe('history');
    expect(historyPosition(r)).toEqual(left);
    r.press('', LEFT);
    r.press('', RIGHT);
    expect(historyPosition(r)).toEqual(left);
  });

  it('is in the memory of a state whose front tab is another one, and is not invented when History was never read', () => {
    const r = rig('history');
    r.press('a');
    r.press('', LEFT);
    expect(tabHostMemory(r.state).history).toMatchObject({ scope: 'all', status: undefined });
    expect(r.state.history, 'History is not in front').toBeUndefined();

    const never = rig('active');
    expect(tabHostMemory(never.state).history, 'History was never entered').toBeUndefined();
  });

  it('is also what a screen opened from the tab host brings back: the memory is read from the state in front', () => {
    const r = rig('history');
    r.press('a');
    r.press('', DOWN);
    const left = historyPosition(r);
    r.press('', LEFT);
    // The Home keeps `tabHostMemory(state)` while a run view is in front, and enters the tab it came from again with it.
    const memory = tabHostMemory(r.state);
    const back = enterTab(memory, 'active', r.context());
    const again = enterTab(tabHostMemory(back), 'history', r.context());
    expect(again.history?.read?.query.scope).toBe('all');
    expect(again.history?.focus).toBe(left.focus);
  });
});

describe('the Active tab keeps the run its cursor was on while another tab is in front', () => {
  it('↓, then → and ←: the same run is focused, though the list changed meanwhile', () => {
    const r = rig('active');
    r.press('', DOWN);
    r.press('', DOWN);
    const focus = r.state.active?.focus;
    expect(focus).toBe('run-c');
    r.press('', RIGHT);
    expect(r.state.tab).toBe('history');
    r.setActive(['run-new', 'run-a', 'run-b', 'run-c', 'run-d']);
    r.press('', LEFT);
    expect(r.state.tab).toBe('active');
    expect(r.state.active?.focus, 'by identity, not by row number').toBe('run-c');
    expect(r.state.active?.cursor).toBe(3);
  });

  it('survives a visit to the other tab', () => {
    const r = rig('active');
    r.press('', DOWN);
    for (const key of [RIGHT, RIGHT, LEFT, LEFT]) r.press('', key);
    expect(r.state.tab).toBe('active');
    expect(r.state.active?.focus).toBe('run-b');
  });
});

describe('the Active tab keeps its scope while the other tab is in front (OD-24 D4)', () => {
  it('`[a] all`, then → and ←: the tab is still listing every project, and the memory says so', () => {
    const r = rig('active');
    r.press('a');
    expect(r.state.active?.scope).toBe('all');
    r.press('', RIGHT);
    expect(tabHostMemory(r.state).activeScope).toBe('all');
    r.press('', LEFT);
    expect(r.state.active?.scope).toBe('all');
    r.press('a');
    expect(r.state.active?.scope, '`[a]` again narrows it').toBe('project');
    r.press('', RIGHT);
    expect(tabHostMemory(r.state).activeScope, 'the default is not stored').toBeUndefined();
  });

  it('is dropped with the memory: a screen opened again starts on this directory', () => {
    const r = rig('active');
    r.press('a');
    r.press('', RIGHT);
    const reopened = enterTab(freshTabMemory('active'), 'active', r.context());
    expect(reopened.active?.scope).toBe('project');
  });
});

describe('a memory that is dropped is dropped whole', () => {
  it('a fresh memory holds nothing of a tab host that was closed', () => {
    const r = rig('history');
    r.press('a');
    r.press('', DOWN);
    r.press('', RIGHT);
    expect(tabHostMemory(r.state).history).toBeDefined();
    // `closeScreen` replaces the memory with a fresh one, and a tab host entered with it starts every tab at its top.
    const reopened = enterTab(freshTabMemory('history'), 'history', r.context());
    expect(reopened.kept).toBeUndefined();
    expect(reopened.history?.read?.query.scope).toBe('project');
    expect(reopened.history?.cursor).toBe(0);
  });
});
