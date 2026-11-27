/**
 * What the tab host remembers of its tabs, through the real Home controller
 * ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §1): each tab comes back
 * as it was left after a visit to the other tab, and after a run view opened from the Runs screen is left with `Esc`; the memory goes with the
 * screen (`closeScreen`) (MVP-11 unit 8: the screen is Active | History, reached from the `/workflows` popup's `[h]`). `tab-host-memory.test.ts` is the model;
 * the ports and the clock are scripted and no database is opened.
 */
import type { RunSummaryRecord } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { buildHistoryRows } from '../../history/history-model.js';
import type { HistoryRead } from '../../history/history-source.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import type { HistoryPort } from './tab-host-history.js';

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
const ESC = { escape: true } as const;
const LEFT = { leftArrow: true } as const;
const RIGHT = { rightArrow: true } as const;
const DOWN = { downArrow: true } as const;
const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const FINISHED: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

const record = (index: number): RunSummaryRecord => {
  const at = new Date(NOW - index * 1_000).toISOString();
  return {
    id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
    workflowId: 'wf',
    status: FINISHED[index % 3] ?? 'completed',
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
};

/** This project has six finished runs; every project, twelve. */
const historyPort: HistoryPort = {
  read: (query): HistoryRead => ({
    query: { scope: query.scope, status: query.status, page: 0 },
    pinned: [],
    rows: buildHistoryRows({
      runs: Array.from({ length: query.scope === 'all' ? 12 : 6 }, (_, index) =>
        record(index),
      ).filter((run) => query.status === undefined || run.status === query.status),
      nowMs: NOW,
      pinnedRunIds: new Set(),
      workflowLabels: new Map([['wf', 'deploy']]),
    }).map((row) => ({ kind: 'run' as const, row })),
    hasPrev: false,
    hasNext: false,
  }),
  cost: () => ({ kind: 'text', text: '$0.01' }),
  loadDetail: () => Promise.resolve({ kind: 'missing' }),
};

function mount() {
  const deps: HomeControllerDeps = {
    startChat: vi.fn(() => new Promise<HomeChatSession>(() => {})),
    homeStore: { read: () => EMPTY },
    history: historyPort,
    hostedRuns: {
      snapshot: (): RunHostSnapshot => IDLE,
      cancel: () => true,
      close: () => Promise.resolve(),
    },
    schedule: () => () => {},
    now: () => 1_000,
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
  };
  return createHomeController(deps);
}

const hostOf = (c: HomeController) => {
  const screen = c.getSnapshot().screen;
  return screen?.kind === 'tab-host' ? screen.host : undefined;
};
const historyOf = (c: HomeController) => {
  const history = hostOf(c)?.history;
  if (history?.read === undefined) throw new Error('the History tab is in front and was read');
  return {
    scope: history.read.query.scope,
    status: history.read.query.status,
    focus: history.focus,
    cursor: history.cursor,
  };
};
const press = (c: HomeController, ...keys: readonly (string | object)[]): void => {
  for (const key of keys) {
    if (typeof key === 'string') c.handleKey(key, {});
    else c.handleKey('', key);
  }
};

describe('a tab comes back as it was left, after a visit to the other tab', () => {
  it('History: a, f, ↓, then ← and →, keeps the scope, the filter and the focused run', () => {
    const c = mount();
    expect(c.openScreen('tab-host', { tab: 'history' })).toBe(true);
    press(c, 'a', 'f', DOWN);
    const left = historyOf(c);
    expect(left).toMatchObject({ scope: 'all', cursor: 1 });
    expect(left.status).toBeDefined();
    expect(left.focus).toMatch(/^row:/u);

    press(c, LEFT);
    expect(hostOf(c)?.tab).toBe('active');
    press(c, RIGHT);
    expect(hostOf(c)?.tab).toBe('history');
    expect(historyOf(c)).toEqual(left);
  });

  it('a run view opened from the other tab and left with Esc finds History as it was left', () => {
    const c = mount();
    expect(c.openScreen('tab-host', { tab: 'history' })).toBe(true);
    press(c, 'a', DOWN);
    const left = historyOf(c);
    press(c, LEFT);
    expect(c.openScreen('run-view', { runId: 'run-0001', from: 'tab-host' })).toBe(true);
    expect(c.getSnapshot().screen?.kind).toBe('run-view');
    press(c, ESC);
    expect(hostOf(c)?.tab, 'back on the tab it came from').toBe('active');
    press(c, RIGHT);
    expect(historyOf(c)).toEqual(left);
  });
});

describe('the memory goes with the screen', () => {
  it('closing the screen forgets it: a Runs screen opened again starts History at its top', () => {
    const c = mount();
    expect(c.openScreen('tab-host', { tab: 'history' })).toBe(true);
    press(c, 'a', 'f', DOWN);
    expect(historyOf(c).scope).toBe('all');
    press(c, LEFT);
    press(c, ESC);
    expect(c.getSnapshot().screen, 'Esc closed the screen').toBeUndefined();

    expect(c.openScreen('tab-host', { tab: 'history' })).toBe(true);
    expect(historyOf(c)).toMatchObject({ scope: 'project', status: undefined, cursor: 0 });
    expect(hostOf(c)?.positions).toEqual({ active: 0, history: 0 });
  });
});
