/**
 * The Runs screen (the tab host narrowed to Active | History) as a screen of the Home's one slot
 * ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §1; MVP-11 unit 8, OD-24 D2),
 * through the real Home controller: that it owns every key and drops a paste, that `Ctrl+C` closes it and never cancels a run, that closing it
 * forgets what its tabs remembered, and that a run view or a gate card opened from it returns to it with `Esc` (and only with `Esc`).
 *
 * `tab-host.test.ts` owns the model (the keys, the geometry, the scope). The `[h]` that reaches it from the `/workflows` popup is
 * `home-manage-popups.test.ts`. The run host, the ports and the clock are scripted: no engine is built and no operator home is read.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildHistoryRows } from '../../history/history-model.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { HostedLegEnd, RunHostSnapshot } from '../../home/run-host.js';
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

const RUN = 'run-0001';
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const RUNNING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: RUN, cancelling: false },
  last: undefined,
};
const PAUSED_END: HostedLegEnd = {
  leg: 'start',
  runId: RUN,
  terminal: {
    disposition: 'paused',
    safety: undefined,
    headline: `Run ${RUN} is paused at a gate.`,
    remedy: undefined,
  },
  handedOff: true,
  retirement: 'retired',
  fault: undefined,
};
const PARKED: RunHostSnapshot = { launching: false, active: undefined, last: PAUSED_END };
const APPROVAL_RUN: RunGates = {
  runId: RUN,
  workflowId: 'wf',
  gates: [
    {
      runId: RUN,
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

const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const ctrl = (c: HomeController, letter: string): void => c.handleKey(letter, { ctrl: true });
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A History port over `count` finished runs (the cursor needs rows to stand on); nothing else is read. */
function historyPort(count: number): HistoryPort {
  const at = '2026-11-23T10:00:00.000Z';
  const runs = Array.from({ length: count }, (_, index) => ({
    id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
    workflowId: 'wf',
    status: 'completed' as const,
    executionMode: 'local' as const,
    triggerType: 'manual',
    startedAt: at,
    completedAt: at,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: at,
    updatedAt: at,
  }));
  return {
    read: () => ({
      query: { scope: 'project', status: undefined, page: 0 },
      pinned: [],
      rows: buildHistoryRows({
        runs,
        nowMs: Date.parse(at) + 3_600_000,
        pinnedRunIds: new Set(),
        workflowLabels: new Map([['wf', 'deploy']]),
      }).map((row) => ({ kind: 'run' as const, row })),
      hasPrev: false,
      hasNext: false,
    }),
    cost: () => ({ kind: 'text', text: '$0.01' }),
    loadDetail: () => Promise.resolve({ kind: 'missing' }),
  };
}

interface Options {
  readonly host?: RunHostSnapshot;
  readonly rows?: number;
  readonly gateCards?: boolean;
}

/** A Home over a scripted run host and History port. */
function mount(options: Options = {}) {
  const cancel = vi.fn((): boolean => true);
  const onExit = vi.fn();
  const deps: HomeControllerDeps = {
    startChat: vi.fn(() => new Promise<HomeChatSession>(() => {})),
    homeStore: { read: () => EMPTY },
    history: historyPort(options.rows ?? 5),
    hostedRuns: {
      snapshot: (): RunHostSnapshot => options.host ?? IDLE,
      cancel,
      close: () => Promise.resolve(),
    },
    ...(options.gateCards === true
      ? {
          gateCards: {
            list: () => [],
            read: (runId: string) => (runId === RUN ? APPROVAL_RUN : undefined),
            resume: () => Promise.reject(new Error('nothing is answered here')),
          },
        }
      : {}),
    schedule: () => () => {},
    now: () => 1_000,
    onExit,
    onError: (cause) => {
      throw cause;
    },
  };
  const controller = createHomeController(deps);
  return { controller, cancel, onExit };
}

type Home = ReturnType<typeof mount>;

const hostOf = (c: HomeController) => {
  const screen = c.getSnapshot().screen;
  return screen?.kind === 'tab-host' ? screen.host : undefined;
};
const cursorOf = (c: HomeController): number | undefined => hostOf(c)?.history?.cursor;
const open = (c: HomeController): void => {
  expect(c.openScreen('tab-host', { tab: 'history' })).toBe(true);
};

describe('how the Runs screen is reached', () => {
  it('openScreen opens it on the tab it is asked for, reading it as it is entered', () => {
    const home = mount();
    open(home.controller);
    expect(hostOf(home.controller)?.tab).toBe('history');
    expect(cursorOf(home.controller)).toBe(0);
    home.controller.handleKey('', ESC);
    expect(home.controller.openScreen('tab-host', { tab: 'active' })).toBe(true);
    expect(hostOf(home.controller)?.tab).toBe('active');
  });

  it('is refused over a chat: the slot admits no screen there', async () => {
    const home = mount();
    home.controller.handlePaste('hello');
    home.controller.handleKey('', ENTER);
    await flush();
    expect(home.controller.openScreen('tab-host', { tab: 'history' })).toBe(false);
  });
});

describe('the Runs screen owns the keyboard', () => {
  it('a typed key reaches no prompt, and a paste is dropped', () => {
    const { controller } = mount();
    open(controller);
    type(controller, 'hello');
    expect(controller.getSnapshot().input.text).toBe('');
    controller.handlePaste('pasted words');
    expect(controller.getSnapshot().input.text, 'the prompt behind it is untouched').toBe('');
  });

  it('←, → and Tab move between the two tabs, and Esc closes from either', () => {
    const { controller } = mount();
    open(controller);
    controller.handleKey('', { leftArrow: true });
    expect(hostOf(controller)?.tab).toBe('active');
    controller.handleKey('', { tab: true });
    expect(hostOf(controller)?.tab).toBe('history');
    controller.handleKey('', { tab: true, shift: true });
    expect(hostOf(controller)?.tab).toBe('active');
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(controller.getSnapshot().mode).toBe('home');
  });

  it('is told the terminal size: below the floor only Esc and Ctrl+C are the screen’s', () => {
    const { controller } = mount();
    open(controller);
    controller.setTerminalSize(60, 20);
    expect(controller.getSnapshot().screen?.kind).toBe('tab-host');
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen).toBeUndefined();
  });
});

describe('Ctrl+C in the Runs screen closes the screen and cancels nothing', () => {
  it('with a leg executing behind it: the first press closes, arms nothing and cancels no run; the second is the landing’s own', () => {
    const { controller, cancel, onExit } = mount({ host: RUNNING });
    open(controller);
    ctrl(controller, 'c');
    expect(cancel, 'the first press did not cancel the run').not.toHaveBeenCalled();
    expect(controller.getSnapshot().screen, 'it closed the screen').toBeUndefined();
    expect(controller.getSnapshot().interruptArmed, 'and armed nothing').toBe(false);
    ctrl(controller, 'c');
    expect(cancel, 'the second is a first press of the landing').not.toHaveBeenCalled();
    expect(controller.getSnapshot().interruptArmed).toBe(true);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('closes from the Active tab too', () => {
    const { controller, cancel } = mount({ host: RUNNING });
    controller.openScreen('tab-host', { tab: 'active' });
    ctrl(controller, 'c');
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('closing the Runs screen forgets what its tabs remembered', () => {
  it('reopening starts on History at its top, after a cursor that moved and a tab that changed', () => {
    const { controller } = mount({ rows: 5 });
    open(controller);
    controller.handleKey('', { downArrow: true });
    controller.handleKey('', { downArrow: true });
    expect(cursorOf(controller)).toBe(2);
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen).toBeUndefined();
    open(controller);
    expect(cursorOf(controller), 'the cursor did not outlive the screen').toBe(0);

    controller.handleKey('', { downArrow: true });
    controller.handleKey('', { leftArrow: true });
    expect(hostOf(controller)?.tab).toBe('active');
    ctrl(controller, 'c');
    open(controller);
    expect(hostOf(controller)?.tab).toBe('history');
    expect(cursorOf(controller)).toBe(0);
    expect(hostOf(controller)?.positions).toEqual({ active: 0, history: 0 });
  });

  it('keeps each tab’s position while the screen lives: the cursor is where it was when the tab is entered again', () => {
    const { controller } = mount({ rows: 5 });
    open(controller);
    controller.handleKey('', { downArrow: true });
    controller.handleKey('', { downArrow: true });
    controller.handleKey('', { leftArrow: true });
    controller.handleKey('', { rightArrow: true });
    expect(cursorOf(controller)).toBe(2);
  });
});

describe('a screen opened from the Runs screen returns to it with Esc, and only with Esc', () => {
  const viewed = (options: Options = {}): Home => {
    const home = mount({ rows: 5, ...options });
    open(home.controller);
    home.controller.handleKey('', { downArrow: true });
    home.controller.handleKey('', { downArrow: true });
    home.controller.handleKey('', { downArrow: true });
    expect(cursorOf(home.controller)).toBe(3);
    expect(home.controller.openScreen('run-view', { runId: RUN, from: 'tab-host' })).toBe(true);
    expect(home.controller.getSnapshot().screen?.kind).toBe('run-view');
    return home;
  };

  it('Esc from the run view puts the screen back on the tab and the row it came from', () => {
    const { controller } = viewed();
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(hostOf(controller)?.tab).toBe('history');
    expect(cursorOf(controller)).toBe(3);
  });

  it('Esc from a run view opened from the landing returns to the landing', () => {
    const { controller } = mount({ rows: 5 });
    expect(controller.openScreen('run-view', { runId: RUN })).toBe(true);
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen).toBeUndefined();
    open(controller);
    expect(cursorOf(controller), 'nothing was remembered for it').toBe(0);
  });

  it('a run view from the landing does not carry what an earlier Runs screen remembered', () => {
    const { controller } = mount({ rows: 5 });
    open(controller);
    controller.handleKey('', { downArrow: true });
    expect(controller.openScreen('run-view', { runId: RUN }), 'from the landing, by default').toBe(
      true,
    );
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen, 'Esc leaves to the landing').toBeUndefined();
    open(controller);
    expect(cursorOf(controller)).toBe(0);
  });

  it('Ctrl+C from the run view closes the whole screen, and the Runs screen starts at its top the next time', () => {
    const { controller, cancel } = viewed();
    ctrl(controller, 'c');
    expect(cancel, 'no leg executes: nothing to cancel').not.toHaveBeenCalled();
    expect(controller.getSnapshot().screen).toBeUndefined();
    open(controller);
    expect(cursorOf(controller)).toBe(0);
  });

  it('Ctrl+C from the run view of a leg that executes follows the run view’s ladder: the first press arms, and cancels nothing', () => {
    const { controller, cancel } = viewed({ host: RUNNING });
    ctrl(controller, 'c');
    expect(cancel).not.toHaveBeenCalled();
    expect(controller.getSnapshot().screen?.kind, 'the run view stays').toBe('run-view');
    expect(controller.getSnapshot().interruptArmed).toBe(true);
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen?.kind, 'and Esc still returns').toBe('tab-host');
    expect(cursorOf(controller)).toBe(3);
  });

  it('a gate card opened from that run view returns to the view with Esc, and to the Runs screen with a second Esc', () => {
    const { controller } = viewed({ host: PARKED, gateCards: true });
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().screen?.kind).toBe('gate-card');
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen?.kind).toBe('run-view');
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().screen?.kind).toBe('gate-card');
    controller.handleKey('', ESC);
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(cursorOf(controller)).toBe(3);
  });

  it('Ctrl+C on that gate card closes the card and the view and the Runs screen with them', () => {
    const { controller } = viewed({ host: PARKED, gateCards: true });
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().screen?.kind).toBe('gate-card');
    ctrl(controller, 'c');
    expect(controller.getSnapshot().screen).toBeUndefined();
    open(controller);
    expect(cursorOf(controller)).toBe(0);
  });
});
