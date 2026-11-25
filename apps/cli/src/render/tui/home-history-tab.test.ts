/**
 * The History tab through the real Home controller ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): what `Enter` asks of the host (the detail is loaded asynchronously, because the terminal outbox is a file), that the
 * result lands only on the detail it was asked for and is still waiting for, that a fault that is not about the run leaves the list with a
 * sentence instead of ending the Home, and that `p` reaches the pin port the Home was given. `tab-host-history.test.ts` owns the model; the
 * run host and the clock are scripted and no database is opened.
 */
import type { RunSummaryRecord } from '@relavium/db';
import { describe, expect, it, vi } from 'vitest';

import { buildHistoryRows } from '../../history/history-model.js';
import type { HistoryRead } from '../../history/history-source.js';
import type { RunDetailLoad } from '../../history/run-detail-source.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import type { HistoryPort } from './tab-host-history.js';
import type { PinPort } from './tab-host-pin.js';

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const T0 = Date.parse('2026-11-23T10:00:00.000Z');

const RUN = '0a1b2c3d-0000-4000-8000-000000000001';

const record: RunSummaryRecord = {
  id: RUN,
  workflowId: 'wf',
  status: 'completed',
  executionMode: 'local',
  triggerType: 'manual',
  startedAt: new Date(T0).toISOString(),
  completedAt: new Date(T0).toISOString(),
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  createdAt: new Date(T0).toISOString(),
  updatedAt: new Date(T0).toISOString(),
};

const readOf = (): HistoryRead => ({
  query: { scope: 'project', status: undefined, page: 0 },
  pinned: [],
  rows: buildHistoryRows({
    runs: [record],
    nowMs: T0 + 60_000,
    pinnedRunIds: new Set(),
    workflowLabels: new Map([['wf', 'deploy']]),
  }).map((row) => ({ kind: 'run' as const, row })),
  hasPrev: false,
  hasNext: false,
});

/** A Home whose History tab reads a one-run list and whose detail loads are resolved by the test, in the order it chooses. */
function mount() {
  const loads: {
    readonly runId: string;
    readonly resolve: (load: RunDetailLoad) => void;
    readonly reject: (cause: unknown) => void;
  }[] = [];
  const history: HistoryPort = {
    read: () => readOf(),
    cost: () => ({ kind: 'text', text: '$0.01' }),
    loadDetail: (runId) =>
      new Promise<RunDetailLoad>((resolve, reject) => {
        loads.push({ runId, resolve, reject });
      }),
  };
  const pinRun = vi.fn((): 'pinned' => 'pinned');
  const pins: PinPort = {
    pinWorkflow: () => 'pinned',
    unpinWorkflow: () => true,
    pinRun,
    unpinRun: () => true,
    unpinRow: () => true,
  };
  const onError = vi.fn();
  const deps: HomeControllerDeps = {
    startChat: vi.fn(() => new Promise<HomeChatSession>(() => {})),
    homeStore: { read: () => EMPTY },
    history,
    pins,
    hostedRuns: {
      snapshot: (): RunHostSnapshot => IDLE,
      cancel: () => true,
      close: () => Promise.resolve(),
    },
    schedule: () => () => {},
    now: () => 1_000,
    onExit: vi.fn(),
    onError,
  };
  const controller = createHomeController(deps);
  expect(controller.openScreen('tab-host', { tab: 'history' })).toBe(true);
  return { controller, loads, pinRun, onError };
}

const historyOf = (c: HomeController) => {
  const screen = c.getSnapshot().screen;
  return screen?.kind === 'tab-host' ? screen.host.history : undefined;
};

const readyLoad = (): RunDetailLoad => ({ kind: 'missing' });

describe('Enter on a History row loads the run through the host', () => {
  it('asks for the run the cursor is on, waits (the tab says so), and shows what arrives', async () => {
    const { controller, loads } = mount();
    expect(historyOf(controller)?.read?.rows).toHaveLength(1);
    controller.handleKey('', ENTER);
    expect(loads.map((load) => load.runId)).toEqual([RUN]);
    expect(historyOf(controller)?.detail?.phase).toBe('loading');

    loads[0]?.resolve(readyLoad());
    await flush();
    expect(historyOf(controller)?.detail).toMatchObject({ runId: RUN, phase: 'missing' });
  });

  it('drops a result that arrives after the person went back, and after the screen closed', async () => {
    const { controller, loads } = mount();
    controller.handleKey('', ENTER);
    controller.handleKey('', ESC);
    expect(historyOf(controller)?.detail, 'Esc went back to the list').toBeUndefined();
    loads[0]?.resolve(readyLoad());
    await flush();
    expect(historyOf(controller)?.detail, 'a late result opens nothing').toBeUndefined();

    controller.handleKey('', ENTER);
    controller.handleKey('', ESC);
    controller.handleKey('', ESC); // the screen closes
    expect(controller.getSnapshot().screen).toBeUndefined();
    loads[1]?.resolve(readyLoad());
    await flush();
    expect(controller.getSnapshot().screen, 'and a closed screen stays closed').toBeUndefined();
  });

  it('answers a fault that is not about the run with a sentence on the list, and the Home goes on', async () => {
    const { controller, loads, onError } = mount();
    controller.handleKey('', ENTER);
    loads[0]?.reject(new Error('PRIVATE-DETAIL'));
    await flush();
    const tab = historyOf(controller);
    expect(tab?.detail).toBeUndefined();
    expect(tab?.message).toBe('The run could not be loaded just now. Enter tries again.');
    expect(tab?.message).not.toContain('PRIVATE');
    expect(onError, 'the Home is not ended by a failed detail').not.toHaveBeenCalled();
    expect(controller.getSnapshot().screen?.kind).toBe('tab-host');
  });
});

describe('p reaches the pin port the Home was given', () => {
  it('pins the run under its full id', () => {
    const { controller, pinRun } = mount();
    controller.handleKey('p', {});
    expect(pinRun).toHaveBeenCalledWith(RUN);
  });
});
