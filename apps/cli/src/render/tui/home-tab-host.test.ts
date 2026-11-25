/**
 * The tab host as a screen of the Home's one slot
 * ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §1), through the real
 * Home controller: how `/permissions` and a bare `relavium permissions` reach it, that it owns every key and drops a paste, that `Ctrl+C`
 * closes it and never cancels a run, that closing it forgets what its tabs remembered, and that a run view or a gate card opened from it
 * returns to it with `Esc` (and only with `Esc`).
 *
 * `tab-host.test.ts` owns the model (the keys, the geometry, the allowlist) and `permissions-tab-reentry.test.ts` the fresh read on entering
 * a tab. The run host, the port and the clock are scripted: no engine is built and no operator home is read.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildDefinedModel } from '../../history/defined-model.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { HostedLegEnd, RunHostSnapshot } from '../../home/run-host.js';
import type {
  PermissionEntry,
  PermissionsPort,
  PermissionsSnapshot,
  WithdrawAnswer,
} from '../../permissions/chat-permissions.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import { SHEET_CONFIRM_DWELL_MS, SHEET_SETTLE_MS } from './permissions-sheet.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
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

const snapshotOf = (count: number): PermissionsSnapshot => ({
  project: {
    ok: true,
    rows: Array.from({ length: count }, (_, index) => ({
      id: `g${String(index)}`,
      label: `tool${String(index)}, 1 argument`,
      remembered: '2026-11-19 12:00Z',
    })),
  },
  session: undefined,
});

interface Options {
  readonly host?: RunHostSnapshot;
  readonly rows?: number;
  readonly port?: PermissionsPort | undefined;
  readonly withPort?: boolean;
  readonly gateCards?: boolean;
  /** A Defined tab behind `/workflows`: an empty project. */
  readonly withDefined?: boolean;
  readonly startChat?: () => Promise<HomeChatSession>;
}

/** A Home over a scripted run host, permissions port and clock. */
function mount(options: Options = {}) {
  let clock = 1_000;
  const cancel = vi.fn((): boolean => true);
  const withdraw = vi.fn((entry: PermissionEntry): WithdrawAnswer => {
    void entry;
    return { tone: 'done', text: 'Withdrawn.' };
  });
  const loads = vi.fn(() => snapshotOf(options.rows ?? 3));
  const port: PermissionsPort = options.port ?? { surface: 'project', load: loads, withdraw };
  const onExit = vi.fn();
  const startChat = options.startChat ?? vi.fn(() => new Promise<HomeChatSession>(() => {}));
  const deps: HomeControllerDeps = {
    startChat,
    homeStore: { read: () => EMPTY },
    ...(options.withPort === false ? {} : { permissions: port }),
    hostedRuns: {
      snapshot: (): RunHostSnapshot => options.host ?? IDLE,
      cancel,
      close: () => Promise.resolve(),
    },
    ...(options.withDefined === true
      ? {
          defined: {
            read: () => ({
              model: buildDefinedModel({ entries: [], pins: [] }),
              slugOf: (): string | undefined => undefined,
              pathOf: (): string | undefined => undefined,
            }),
          },
        }
      : {}),
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
    now: () => clock,
    onExit,
    onError: (cause) => {
      throw cause;
    },
  };
  const controller = createHomeController(deps);
  return {
    controller,
    cancel,
    withdraw,
    loads,
    onExit,
    startChat,
    tick: (ms: number): void => {
      clock += ms;
    },
  };
}

type Home = ReturnType<typeof mount>;

const hostOf = (c: HomeController) => {
  const screen = c.getSnapshot().screen;
  return screen?.kind === 'tab-host' ? screen.host : undefined;
};
const cursorOf = (c: HomeController): number | undefined => hostOf(c)?.sheet?.cursor;
const open = (c: HomeController): void => {
  expect(c.openScreen('tab-host', { tab: 'permissions' })).toBe(true);
};
const typedPermissions = async (c: HomeController): Promise<void> => {
  type(c, '/permissions');
  c.handleKey('', ENTER);
  await flush();
};

describe('how the tab host is reached', () => {
  it('a typed bare /permissions, the palette and openScreen all open it on the Permissions tab, reading the port', async () => {
    const typed = mount();
    await typedPermissions(typed.controller);
    expect(hostOf(typed.controller)?.tab).toBe('permissions');
    expect(typed.loads).toHaveBeenCalledTimes(1);

    const palette = mount();
    palette.controller.handleKey('/', {});
    type(palette.controller, 'permissions');
    palette.controller.handleKey('', ENTER);
    await flush();
    expect(hostOf(palette.controller)?.tab).toBe('permissions');

    const direct = mount();
    open(direct.controller);
    expect(hostOf(direct.controller)?.sheet?.surface).toBe('project');
  });

  it('opens on any tab it is asked for, and a placeholder reads nothing', () => {
    const { controller, loads } = mount();
    expect(controller.openScreen('tab-host', { tab: 'history' })).toBe(true);
    expect(hostOf(controller)?.tab).toBe('history');
    expect(loads).not.toHaveBeenCalled();
  });

  it('is the one slot: it replaces nothing it may not, and no overlay is open behind it', () => {
    const { controller } = mount();
    controller.handleKey('/', {});
    expect(controller.getSnapshot().palette).toBeDefined();
    expect(
      controller.openScreen('tab-host', { tab: 'permissions' }),
      'refused while an overlay is open',
    ).toBe(false);
    controller.handleKey('', ESC);
    open(controller);
    expect(controller.getSnapshot().palette).toBeUndefined();
    expect(
      controller.getSnapshot().chatSheet,
      'the chat’s overlay is not this screen',
    ).toBeUndefined();
  });

  it('is refused with a chat in front: a screen opens only from the landing', async () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const session: HomeChatSession = {
      store,
      sessionId: 'sess-tab-host',
      processLine: () => Promise.resolve(),
      shouldStop: () => false,
      stopReason: () => 'exit',
      teardown: () => Promise.resolve(),
    };
    const { controller } = mount({ startChat: () => Promise.resolve(session) });
    type(controller, 'hello');
    controller.handleKey('', ENTER);
    await flush();
    expect(controller.getSnapshot().mode).toBe('chat');
    expect(controller.openScreen('tab-host', { tab: 'permissions' })).toBe(false);
    expect(controller.getSnapshot().screen).toBeUndefined();
  });

  it('with no port it says so and opens nothing, whichever way it was asked', async () => {
    const { controller, startChat } = mount({ withPort: false });
    await typedPermissions(controller);
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(controller.getSnapshot().notice).toBe('Remembered commands are not available here.');
    expect(startChat).not.toHaveBeenCalled();
    controller.openPermissionsAsCommand();
    expect(
      controller.getSnapshot().screen,
      'a bare command with no port stays on the Home',
    ).toBeUndefined();
  });

  it('a port that cannot be read opens nothing and says why, where the person who asked is looking', async () => {
    const port: PermissionsPort = {
      surface: 'project',
      load: () => {
        throw new Error('boom');
      },
      withdraw: () => ({ tone: 'done', text: 'x' }),
    };
    const { controller } = mount({ port });
    await typedPermissions(controller);
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(controller.getSnapshot().notice).toBe('Could not read the permissions.');
  });
});

describe('a bare `relavium permissions` is the tab host as the run’s whole job', () => {
  it('opens at once on Permissions and ends the Home with success when it is closed: Esc, once', () => {
    const { controller, onExit } = mount();
    controller.openPermissionsAsCommand();
    expect(hostOf(controller)?.tab).toBe('permissions');
    expect(onExit).not.toHaveBeenCalled();
    controller.handleKey('', ESC);
    expect(onExit).toHaveBeenCalledTimes(1);
    controller.handleKey('', ESC);
    expect(onExit, 'once').toHaveBeenCalledTimes(1);
  });

  it('Ctrl+C ends it too; and a closed ordinary tab host ends nothing', async () => {
    const command = mount();
    command.controller.openPermissionsAsCommand();
    ctrl(command.controller, 'c');
    expect(command.onExit).toHaveBeenCalledTimes(1);

    const ordinary = mount();
    await typedPermissions(ordinary.controller);
    ordinary.controller.handleKey('', ESC);
    expect(ordinary.controller.getSnapshot().screen).toBeUndefined();
    expect(ordinary.onExit).not.toHaveBeenCalled();
  });

  it('with a leg executing it asks first, and the screen it was closed from does not stay open behind the card', () => {
    const { controller, onExit, cancel } = mount({ host: RUNNING });
    controller.openPermissionsAsCommand();
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().exitGuard).toBe('confirm');
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(onExit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('the command is over once its screen is gone, however it went', () => {
  /** `relavium permissions`, then a run view of the parked run reached from it, and (with `card`) the gate card opened on that view. */
  const commandThenView = (card: boolean): Home => {
    const home = mount({ host: PARKED, gateCards: true, withDefined: true });
    home.controller.openPermissionsAsCommand();
    expect(hostOf(home.controller)?.tab).toBe('permissions');
    expect(home.controller.openScreen('run-view', { runId: RUN, from: 'tab-host' })).toBe(true);
    if (card) {
      home.controller.handleKey('', ENTER);
      expect(home.controller.getSnapshot().screen?.kind).toBe('gate-card');
    }
    return home;
  };

  it.each([
    ['a gate card’s Ctrl+C', true],
    ['the run view’s own close', false],
  ] as const)(
    '%s closes the whole screen, and a bare `relavium permissions` ends with it, with success',
    (_label, card) => {
      const { controller, onExit } = commandThenView(card);
      expect(onExit, 'the screen is still open').not.toHaveBeenCalled();
      ctrl(controller, 'c');
      expect(onExit, 'the command’s screen is gone, so the command is over').toHaveBeenCalledTimes(
        1,
      );
    },
  );

  it.each([
    ['a gate card’s Ctrl+C', true],
    ['the run view’s own close', false],
  ] as const)(
    'an ordinary tab host ends nothing: %s closes the screen and keeps the Home open, and an Esc on a tab host opened later closes that screen only',
    async (_label, card) => {
      const { controller, onExit } = mount({ host: PARKED, gateCards: true, withDefined: true });
      await typedPermissions(controller);
      expect(hostOf(controller)?.tab).toBe('permissions');
      expect(controller.openScreen('run-view', { runId: RUN, from: 'tab-host' })).toBe(true);
      if (card) {
        controller.handleKey('', ENTER);
        expect(controller.getSnapshot().screen?.kind).toBe('gate-card');
      }
      ctrl(controller, 'c');
      expect(controller.getSnapshot().screen, 'the screen is gone').toBeUndefined();
      expect(onExit, 'and the Home is still open').not.toHaveBeenCalled();
      type(controller, '/workflows');
      controller.handleKey('', ENTER);
      await flush();
      expect(hostOf(controller)?.tab).toBe('defined');
      controller.handleKey('', ESC);
      expect(controller.getSnapshot().screen, 'Esc closed the tab host').toBeUndefined();
      expect(onExit, 'an ordinary tab host ends nothing').not.toHaveBeenCalled();
    },
  );

  it('still ends the Home when the command’s own tab host is closed after a card or a view that came back to it with Esc', () => {
    const { controller, onExit } = commandThenView(true);
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen?.kind).toBe('run-view');
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen?.kind).toBe('tab-host');
    controller.handleKey('', ESC);
    expect(onExit, 'the command’s own screen is the command’s whole job').toHaveBeenCalledTimes(1);
  });

  it('a permissions file that cannot be read on the way back from a view says so on the Home: the command does not end silently', () => {
    let broken = false;
    const snapshot = snapshotOf(3);
    const port: PermissionsPort = {
      surface: 'project',
      load: () => {
        if (broken) throw new Error('boom');
        return snapshot;
      },
      withdraw: () => ({ tone: 'done', text: 'x' }),
    };
    const { controller, onExit } = mount({ port, host: PARKED, withDefined: true });
    controller.openPermissionsAsCommand();
    expect(hostOf(controller)?.tab).toBe('permissions');
    expect(controller.openScreen('run-view', { runId: RUN, from: 'tab-host' })).toBe(true);
    broken = true;
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen, 'the tab host cannot come back').toBeUndefined();
    expect(
      onExit,
      'the Home stays open with the reason, so the reason can be read',
    ).not.toHaveBeenCalled();
    expect(controller.getSnapshot().notice).toBe('Could not read the permissions.');
  });
});

describe('the tab host owns the keyboard', () => {
  it('a typed key reaches no prompt, and a paste is dropped (and a waiting question with it)', () => {
    const { controller, tick, withdraw } = mount();
    open(controller);
    type(controller, 'hello');
    expect(controller.getSnapshot().input.text).toBe('');
    tick(SHEET_SETTLE_MS + 100);
    controller.handleKey('', { downArrow: true });
    tick(SHEET_SETTLE_MS + 100);
    controller.handleKey('d', {});
    expect(hostOf(controller)?.sheet?.armed).toBe(true);
    controller.handlePaste('pasted words');
    expect(hostOf(controller)?.sheet?.armed, 'the question is dropped').toBe(false);
    expect(controller.getSnapshot().input.text, 'the prompt behind it is untouched').toBe('');
    tick(SHEET_CONFIRM_DWELL_MS);
    controller.handleKey('', ENTER);
    expect(withdraw, 'a paste then Enter withdraws nothing').not.toHaveBeenCalled();
  });

  it('a withdrawal runs through the port the Home holds, and the answer is shown', () => {
    const { controller, tick, withdraw } = mount();
    open(controller);
    tick(SHEET_SETTLE_MS + 100);
    controller.handleKey('d', {});
    tick(SHEET_CONFIRM_DWELL_MS);
    controller.handleKey('', ENTER);
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(hostOf(controller)?.sheet?.message).toEqual({ tone: 'done', text: 'Withdrawn.' });
  });

  it('is told the terminal size: below the floor a withdrawal is not asked for', () => {
    const { controller, tick } = mount();
    open(controller);
    controller.setTerminalSize(60, 20);
    tick(SHEET_SETTLE_MS + 100);
    controller.handleKey('d', {});
    expect(hostOf(controller)?.sheet?.armed).toBe(false);
  });

  it('←, → and Tab move between tabs, and Esc closes from any of them', () => {
    const { controller } = mount();
    open(controller);
    controller.handleKey('', { leftArrow: true });
    expect(hostOf(controller)?.tab).toBe('history');
    controller.handleKey('', { tab: true, shift: true });
    expect(hostOf(controller)?.tab).toBe('active');
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(controller.getSnapshot().mode).toBe('home');
  });
});

describe('Ctrl+C in the tab host closes the screen and cancels nothing', () => {
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

  it('closes from a placeholder tab and from a waiting question, withdrawing nothing', () => {
    const { controller, tick, withdraw, cancel } = mount({ host: RUNNING });
    controller.openScreen('tab-host', { tab: 'active' });
    ctrl(controller, 'c');
    expect(controller.getSnapshot().screen).toBeUndefined();
    open(controller);
    tick(SHEET_SETTLE_MS + 100);
    controller.handleKey('d', {});
    tick(SHEET_CONFIRM_DWELL_MS);
    ctrl(controller, 'c');
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(withdraw).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('closing the tab host forgets what its tabs remembered', () => {
  it('reopening starts on the Permissions tab at its top, after a cursor that moved and a tab that changed', async () => {
    const { controller } = mount({ rows: 5 });
    open(controller);
    controller.handleKey('', { downArrow: true });
    controller.handleKey('', { downArrow: true });
    expect(cursorOf(controller)).toBe(2);
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen).toBeUndefined();
    await typedPermissions(controller);
    expect(hostOf(controller)?.tab).toBe('permissions');
    expect(cursorOf(controller), 'the cursor did not outlive the screen').toBe(0);

    controller.handleKey('', { downArrow: true });
    controller.handleKey('', { leftArrow: true });
    expect(hostOf(controller)?.tab).toBe('history');
    ctrl(controller, 'c');
    open(controller);
    expect(hostOf(controller)?.tab).toBe('permissions');
    expect(cursorOf(controller)).toBe(0);
    expect(hostOf(controller)?.positions).toEqual({
      defined: 0,
      active: 0,
      history: 0,
      permissions: 0,
      agents: 0,
      sessions: 0,
    });
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

describe('a screen opened from the tab host returns to it with Esc, and only with Esc', () => {
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

  it('Esc from the run view puts the tab host back on the tab and the row it came from', () => {
    const { controller } = viewed();
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(hostOf(controller)?.tab).toBe('permissions');
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

  it('a run view from the landing does not carry what an earlier tab host remembered', () => {
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

  it('Ctrl+C from the run view closes the whole screen, and the tab host starts at its top the next time', () => {
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

  it('a gate card opened from that run view returns to the view with Esc, and to the tab host with a second Esc', () => {
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

  it('Ctrl+C on that gate card closes the card and the view and the tab host with them', () => {
    const { controller } = viewed({ host: PARKED, gateCards: true });
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().screen?.kind).toBe('gate-card');
    ctrl(controller, 'c');
    expect(controller.getSnapshot().screen).toBeUndefined();
    open(controller);
    expect(cursorOf(controller)).toBe(0);
  });
});
