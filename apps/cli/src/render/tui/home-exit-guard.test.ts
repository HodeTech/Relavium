/**
 * Leaving the Home while a hosted workflow run executes
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §6).
 *
 * `requestExit()` is the one way the Home ends. Every path that would end it (`/exit` chosen from the palette, the second
 * `Ctrl+C` on the loaded landing, `Ctrl+D` on an empty prompt, the loading bail-out, a closed bare `relavium permissions` sheet) is
 * driven here in both states: with a leg live it asks and leaves nothing changed, with none it leaves exactly as it always did. The
 * run host and the clock are scripted, so nothing here sleeps, builds an engine or touches an operator home.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { PermissionsPort } from '../../permissions/chat-permissions.js';
import { createChatStore } from './chat-store.js';
import { createChordHistory, type ChordHistory } from './chord-guard.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { HOSTED_RUN_EXIT_GRACE_MS, HOSTED_RUN_POLL_MS } from './tui-constants.js';

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};

const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const RUNNING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-0001', cancelling: false },
  last: undefined,
};
const CANCELLING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-0001', cancelling: true },
  last: undefined,
};
const PREPARING: RunHostSnapshot = { launching: true, active: undefined, last: undefined };

const ENTER = { return: true } as const;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const ctrl = (c: HomeController, letter: string): void => c.handleKey(letter, { ctrl: true });
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};

/** The one timer the controller is given: a virtual clock whose pending callbacks fire in order as it is advanced. */
function virtualClock() {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { readonly at: number; readonly run: () => void }>();
  return {
    schedule: (run: () => void, delayMs: number): (() => void) => {
      next += 1;
      const id = next;
      pending.set(id, { at: now + delayMs, run });
      return () => {
        pending.delete(id);
      };
    },
    advance: (ms: number): void => {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, entry]) => entry.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = target;
    },
    pending: (): number => pending.size,
  };
}

/** A run host that records what it is asked, whose leg ends only when the test says so (or when `cancel` is told to end it). */
function scriptedHost(
  initial: RunHostSnapshot,
  log: string[],
  options: { cancelEndsLeg?: boolean } = {},
) {
  let current = initial;
  const host = {
    snapshot: (): RunHostSnapshot => current,
    cancel: vi.fn((): boolean => {
      log.push('cancel');
      if (current.active === undefined) return false;
      current =
        options.cancelEndsLeg === true
          ? IDLE
          : { ...current, active: { ...current.active, cancelling: true } };
      return true;
    }),
    close: vi.fn((): Promise<void> => {
      log.push('close');
      return Promise.resolve();
    }),
  };
  return {
    host,
    set: (next: RunHostSnapshot): void => {
      current = next;
    },
  };
}

const PERMISSIONS_PORT: PermissionsPort = {
  surface: 'project',
  load: () => ({ project: { ok: true, rows: [] }, session: undefined }),
  withdraw: () => ({ tone: 'done', text: 'Withdrawn.' }),
};

function mount(
  initial: RunHostSnapshot,
  options: {
    cancelEndsLeg?: boolean;
    startChat?: HomeControllerDeps['startChat'];
    launchRun?: () => Promise<string>;
    withHost?: boolean;
    /** Whether the exit-guard card's exact frame is on screen (default: it is; `false` is a host that has not measured it). */
    painted?: boolean;
    /** The monotonic clock the card's lockout runs on (default: it never moves). */
    now?: () => number;
    /** The Home's one chord history, shared with whatever answered a card a moment ago. */
    chordHistory?: ChordHistory;
  } = {},
) {
  const log: string[] = [];
  const clock = virtualClock();
  const run = scriptedHost(initial, log, { cancelEndsLeg: options.cancelEndsLeg ?? false });
  const onExit = vi.fn(() => {
    log.push('exit');
  });
  const onError = vi.fn((cause: unknown) => {
    throw cause;
  });
  const controller = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    // By default a chat never arrives: the sites that build one say so, and the others never ask for one.
    startChat: options.startChat ?? (() => new Promise<HomeChatSession>(() => {})),
    homeStore: { read: () => EMPTY },
    permissions: PERMISSIONS_PORT,
    ...(options.launchRun === undefined ? {} : { launchRun: options.launchRun }),
    ...(options.withHost === false ? {} : { hostedRuns: run.host }),
    schedule: clock.schedule,
    now: options.now ?? (() => 0),
    ...(options.chordHistory === undefined ? {} : { chordHistory: options.chordHistory }),
    onExit,
    onError,
  });
  if (options.painted !== false) controller.bindHomeFrame(() => true);
  return { controller, run, clock, log, onExit };
}

/** Every way to end the Home, each one a function of a fresh Home. `armed` ones are driven with a leg live and with none. */
const SITES: readonly {
  readonly site: string;
  readonly drive: (c: HomeController) => void | Promise<void>;
  readonly startChat?: HomeControllerDeps['startChat'];
}[] = [
  {
    site: 'the /exit palette command',
    drive: (c) => {
      c.handleKey('/', {});
      type(c, 'exit');
      c.handleKey('', ENTER);
    },
  },
  {
    site: 'the second Ctrl+C on the loaded landing',
    drive: (c) => {
      ctrl(c, 'c');
      ctrl(c, 'c');
    },
  },
  {
    site: 'Ctrl+D on an empty prompt',
    drive: (c) => {
      ctrl(c, 'd');
    },
  },
  {
    site: 'the loading bail-out (Ctrl+C while the first chat is being built)',
    startChat: () => new Promise<HomeChatSession>(() => {}),
    drive: (c) => {
      type(c, 'hello');
      c.handleKey('', ENTER);
      expect(c.getSnapshot().mode).toBe('loading');
      ctrl(c, 'c');
    },
  },
  {
    site: 'Ctrl+D while the first chat is being built',
    startChat: () => new Promise<HomeChatSession>(() => {}),
    drive: (c) => {
      type(c, 'hello');
      c.handleKey('', ENTER);
      expect(c.getSnapshot().mode).toBe('loading');
      ctrl(c, 'd');
    },
  },
  {
    site: 'the close of a bare `relavium permissions` sheet',
    drive: (c) => {
      c.openPermissionsAsCommand();
      expect(c.getSnapshot().permissionsSheet).toBeDefined();
      c.handleKey('', { escape: true });
    },
  },
];

describe('every path that ends the Home goes through one request (ADR-0139 §6)', () => {
  describe.each(SITES)('$site', ({ drive, startChat }) => {
    it.each([
      ['executing', RUNNING],
      ['cancelling', CANCELLING],
      ['preparing', PREPARING],
    ] as const)('with a leg %s: asks, and neither exits nor cancels', async (_label, snapshot) => {
      const { controller, run, log, onExit } = mount(snapshot, {
        ...(startChat === undefined ? {} : { startChat }),
      });
      await drive(controller);
      expect(onExit, 'the Home did not end').not.toHaveBeenCalled();
      expect(controller.getSnapshot().exitGuard).toBe('confirm');
      expect(run.host.cancel, 'asking cancels nothing').not.toHaveBeenCalled();
      expect(run.host.close).not.toHaveBeenCalled();
      expect(log).toEqual([]);
      expect(controller.getSnapshot().permissionsSheet, 'no sheet behind the card').toBeUndefined();
    });

    it('with no leg: leaves exactly once and opens no card', async () => {
      const { controller, run, onExit, clock } = mount(IDLE, {
        ...(startChat === undefined ? {} : { startChat }),
      });
      await drive(controller);
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().exitGuard).toBeUndefined();
      expect(run.host.cancel).not.toHaveBeenCalled();
      expect(clock.pending(), 'no timer outlives the Home').toBe(0);
    });

    it('with no run host wired: leaves exactly once, as it always did', async () => {
      const { controller, onExit } = mount(RUNNING, {
        withHost: false,
        ...(startChat === undefined ? {} : { startChat }),
      });
      await drive(controller);
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().exitGuard).toBeUndefined();
    });
  });
});

describe('the exit-guard card', () => {
  const open = (snapshot: RunHostSnapshot = RUNNING, options: { cancelEndsLeg?: boolean } = {}) => {
    const rig = mount(snapshot, options);
    ctrl(rig.controller, 'd');
    expect(rig.controller.getSnapshot().exitGuard).toBe('confirm');
    return rig;
  };

  it('Ctrl+Y cancels the run, then waits for it to settle; the Home leaves when it has', () => {
    const { controller, run, clock, log, onExit } = open();
    ctrl(controller, 'y');
    expect(controller.getSnapshot().exitGuard, 'the screen says it is stopping').toBe('stopping');
    expect(run.host.cancel).toHaveBeenCalledTimes(1);
    expect(onExit, 'the leg has not settled yet: the Home waits').not.toHaveBeenCalled();
    clock.advance(HOSTED_RUN_POLL_MS * 4);
    expect(onExit).not.toHaveBeenCalled();
    run.set(IDLE); // the engine finished stopping the leg
    clock.advance(HOSTED_RUN_POLL_MS);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(
      log,
      'the run is cancelled before the Home leaves, and a settled leg needs no teardown',
    ).toEqual(['cancel', 'exit']);
    expect(run.host.close, 'a leg that settled is not abandoned').not.toHaveBeenCalled();
    expect(clock.pending(), 'neither the grace nor the watch outlives the Home').toBe(0);
  });

  it('Ctrl+Y over a leg that ends at once leaves at once', () => {
    const { controller, log, onExit, clock } = open(RUNNING, { cancelEndsLeg: true });
    ctrl(controller, 'y');
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['cancel', 'exit']);
    expect(clock.pending()).toBe(0);
  });

  it('abandons a leg that has not settled in ten seconds: runs the host teardown, then leaves', () => {
    expect(HOSTED_RUN_EXIT_GRACE_MS, 'the engine’s grace window').toBe(10_000);
    const { controller, run, clock, log, onExit } = open();
    ctrl(controller, 'y');
    clock.advance(HOSTED_RUN_EXIT_GRACE_MS - 1);
    expect(onExit, 'still inside the grace').not.toHaveBeenCalled();
    expect(controller.getSnapshot().exitGuard).toBe('stopping');
    clock.advance(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(run.host.close).toHaveBeenCalledTimes(1);
    expect(log, 'cancel, then the teardown, then the exit').toEqual(['cancel', 'close', 'exit']);
    expect(clock.pending()).toBe(0);
    clock.advance(HOSTED_RUN_EXIT_GRACE_MS * 3);
    expect(onExit, 'nothing fires again').toHaveBeenCalledTimes(1);
  });

  it('leaves even when the teardown cannot be started or fails', async () => {
    const rig = open();
    rig.run.host.close.mockImplementationOnce(() => Promise.reject(new Error('teardown failed')));
    ctrl(rig.controller, 'y');
    rig.clock.advance(HOSTED_RUN_EXIT_GRACE_MS);
    await flush();
    expect(rig.onExit).toHaveBeenCalledTimes(1);
  });

  it('leaves, abandoning the leg, when the cancel itself throws', () => {
    const rig = open();
    rig.run.host.cancel.mockImplementationOnce(() => {
      throw new Error('cancel failed');
    });
    ctrl(rig.controller, 'y');
    expect(rig.onExit).toHaveBeenCalledTimes(1);
    expect(rig.run.host.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Esc', '', { escape: true }],
    ['Ctrl+C', 'c', { ctrl: true }],
    ['Ctrl+N', 'n', { ctrl: true }],
  ] as const)('%s closes the card, cancels nothing and stays', (_name, input, key) => {
    const { controller, run, clock, onExit } = open();
    controller.handleKey(input, key);
    expect(controller.getSnapshot().exitGuard).toBeUndefined();
    expect(run.host.cancel).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    expect(controller.getSnapshot().mode).toBe('home');
    // The Home is back in its ordinary state: the keymap starts over, so one Ctrl+C is a first press and does not ask again.
    ctrl(controller, 'c');
    expect(controller.getSnapshot().exitGuard).toBeUndefined();
    expect(controller.getSnapshot().interruptArmed).toBe(true);
    expect(clock.pending(), 'the watch of a live run keeps the strip current').toBe(1);
  });

  it('Ctrl+C is a cancel at the card, never a second press of the keymap', () => {
    const { controller, onExit } = mount(RUNNING);
    ctrl(controller, 'c');
    ctrl(controller, 'c');
    expect(controller.getSnapshot().exitGuard).toBe('confirm');
    ctrl(controller, 'c');
    ctrl(controller, 'c');
    expect(onExit, 'four presses and the Home is still there').not.toHaveBeenCalled();
    expect(
      controller.getSnapshot().exitGuard,
      'closed by the third, asked again by the fourth',
    ).toBe(undefined);
  });

  it.each([
    ['a bare y', 'y', {}],
    ['a bare n', 'n', {}],
    ['Enter', '', { return: true }],
    ['Ctrl+D', 'd', { ctrl: true }],
    ['Ctrl+Alt+Y', 'y', { ctrl: true, meta: true }],
    ['a letter', 'a', {}],
    ['Tab', '', { tab: true }],
  ] as const)('%s answers nothing and leaves the card open', (_name, input, key) => {
    const { controller, run, onExit } = open();
    controller.handleKey(input, key);
    expect(controller.getSnapshot().exitGuard).toBe('confirm');
    expect(run.host.cancel).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    expect(controller.getSnapshot().input.text, 'nothing reaches the prompt behind it').toBe('');
  });

  it('a paste is not an answer and does not reach the prompt', () => {
    const { controller, run, onExit } = open();
    controller.handlePaste('\u0019');
    controller.handlePaste('typed text');
    expect(controller.getSnapshot().exitGuard).toBe('confirm');
    expect(controller.getSnapshot().input.text).toBe('');
    expect(run.host.cancel).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('while it is stopping, no key takes the wait back or cuts it short, and a second Ctrl+Y cancels nothing more', () => {
    const { controller, run, clock, onExit } = open();
    ctrl(controller, 'y');
    for (const [input, key] of [
      ['', { escape: true }],
      ['c', { ctrl: true }],
      ['n', { ctrl: true }],
      ['y', { ctrl: true }],
      ['d', { ctrl: true }],
      ['', { return: true }],
    ] as const)
      controller.handleKey(input, key);
    expect(controller.getSnapshot().exitGuard).toBe('stopping');
    expect(run.host.cancel).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
    clock.advance(HOSTED_RUN_EXIT_GRACE_MS);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('names the run as it is now: the card follows the leg while it is open', () => {
    const { controller, run, clock } = open(RUNNING);
    expect(controller.getSnapshot().hostedRun?.active?.cancelling).toBe(false);
    run.set(CANCELLING);
    clock.advance(HOSTED_RUN_POLL_MS);
    expect(controller.getSnapshot().hostedRun?.active?.cancelling).toBe(true);
    expect(controller.getSnapshot().exitGuard).toBe('confirm');
  });

  describe('an answer when no leg is running does nothing harmful', () => {
    it('Ctrl+Y, Ctrl+N and Esc on the landing with no card open exit nothing, cancel nothing and type nothing', () => {
      const { controller, run, onExit } = mount(RUNNING);
      ctrl(controller, 'y');
      ctrl(controller, 'n');
      controller.handleKey('', { escape: true });
      expect(controller.getSnapshot().exitGuard).toBeUndefined();
      expect(controller.getSnapshot().input.text).toBe('');
      expect(run.host.cancel).not.toHaveBeenCalled();
      expect(onExit).not.toHaveBeenCalled();
    });

    it('Ctrl+Y at a card whose run ended meanwhile leaves, with nothing left to cancel', () => {
      const { controller, run, clock, log, onExit } = open();
      run.set(IDLE); // the run finished on its own while the card was up
      clock.advance(HOSTED_RUN_POLL_MS);
      expect(controller.getSnapshot().exitGuard, 'the card stays until it is answered').toBe(
        'confirm',
      );
      ctrl(controller, 'y');
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(log, 'the cancel of a leg that is gone is a no-op, and nothing is abandoned').toEqual([
        'cancel',
        'exit',
      ]);
      expect(run.host.close).not.toHaveBeenCalled();
    });

    it('Esc at a card whose run ended meanwhile stays, and a later exit asks nothing', () => {
      const { controller, run, clock, onExit } = open();
      run.set(IDLE);
      clock.advance(HOSTED_RUN_POLL_MS);
      controller.handleKey('', { escape: true });
      expect(controller.getSnapshot().exitGuard).toBeUndefined();
      expect(clock.pending(), 'an idle host needs no watch').toBe(0);
      ctrl(controller, 'd');
      expect(onExit, 'with no leg the Home leaves at once').toHaveBeenCalledTimes(1);
    });

    it('a card is not opened twice by a held key, and a second request while it is open changes nothing', () => {
      const { controller, run, onExit } = open();
      ctrl(controller, 'd');
      ctrl(controller, 'd');
      expect(controller.getSnapshot().exitGuard).toBe('confirm');
      expect(run.host.cancel).not.toHaveBeenCalled();
      expect(onExit).not.toHaveBeenCalled();
    });
  });

  describe('while the first chat is being built', () => {
    it('a confirmed exit abandons the build: the chat that arrives is reclaimed, not shown', async () => {
      let finish: (session: HomeChatSession) => void = () => {};
      const teardown = vi.fn(() => Promise.resolve());
      const built = { teardown } as unknown as HomeChatSession;
      const { controller, run, onExit } = mount(RUNNING, {
        startChat: () =>
          new Promise<HomeChatSession>((resolve) => {
            finish = resolve;
          }),
      });
      type(controller, 'hello');
      controller.handleKey('', ENTER);
      ctrl(controller, 'c');
      expect(controller.getSnapshot().exitGuard).toBe('confirm');
      ctrl(controller, 'y');
      expect(run.host.cancel).toHaveBeenCalledTimes(1);
      finish(built);
      await flush();
      expect(teardown, 'the just-built chat is reclaimed').toHaveBeenCalledTimes(1);
      expect(
        controller.getSnapshot().mode,
        'the chat never takes the screen from the stopping run',
      ).toBe('loading');
      expect(onExit).not.toHaveBeenCalled();
    });

    it('a chat that arrives while the card only asks takes the screen and closes the card', async () => {
      let finish: (session: HomeChatSession) => void = () => {};
      const built: HomeChatSession = {
        store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
        sessionId: 'sess-exit-guard',
        processLine: () => Promise.resolve(),
        shouldStop: () => false,
        stopReason: () => 'exit',
        teardown: () => Promise.resolve(),
      };
      const { controller } = mount(RUNNING, {
        startChat: () =>
          new Promise<HomeChatSession>((resolve) => {
            finish = resolve;
          }),
      });
      type(controller, 'hello');
      controller.handleKey('', ENTER);
      ctrl(controller, 'c');
      expect(controller.getSnapshot().exitGuard).toBe('confirm');
      finish(built);
      await flush();
      expect(controller.getSnapshot().mode).toBe('chat');
      expect(
        controller.getSnapshot().exitGuard,
        'no invisible card is left to swallow keys',
      ).toBeUndefined();
    });
  });

  it('a signal that tears the Home down stops the wait: nothing fires after it', async () => {
    const { controller, clock, onExit } = open();
    ctrl(controller, 'y');
    expect(clock.pending()).toBeGreaterThan(0);
    await controller.teardownActive();
    expect(clock.pending()).toBe(0);
    clock.advance(HOSTED_RUN_EXIT_GRACE_MS * 2);
    expect(onExit, 'the signal path owns the exit').not.toHaveBeenCalled();
  });
});

describe("the exit-guard card's Ctrl+Y cancels a run for good, so it is a deliberate key", () => {
  const openWith = (options: Parameters<typeof mount>[1]) => {
    const rig = mount(RUNNING, options);
    ctrl(rig.controller, 'd');
    expect(rig.controller.getSnapshot().exitGuard).toBe('confirm');
    return rig;
  };

  it('answers nothing while the card has not been measured on screen, and answers once it has', () => {
    const { controller, run, onExit } = openWith({ painted: false });
    ctrl(controller, 'y');
    expect(controller.getSnapshot().exitGuard, 'the card is still asking').toBe('confirm');
    expect(run.host.cancel, 'nothing was cancelled').not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    controller.bindHomeFrame(() => true); // the host measured and flushed the card
    ctrl(controller, 'y');
    expect(controller.getSnapshot().exitGuard).toBe('stopping');
    expect(run.host.cancel).toHaveBeenCalledTimes(1);
  });

  it('answers nothing with no host evidence bound at all', () => {
    const { controller, run } = openWith({ painted: false });
    controller.bindHomeFrame(undefined);
    ctrl(controller, 'y');
    expect(run.host.cancel).not.toHaveBeenCalled();
    expect(controller.getSnapshot().exitGuard).toBe('confirm');
  });

  it('refuses a held Ctrl+Y that arrives inside the lockout, and every refused repeat restarts the window', () => {
    let t = 0;
    const chordHistory = createChordHistory();
    // Another card (a gate card, the consent card) was resolved by a key at t = 0 and the key is still down.
    chordHistory.lastResolvedAt = 0;
    const { controller, run, onExit } = openWith({ now: () => t, chordHistory });
    for (const at of [100, 1900, 3800]) {
      t = at;
      ctrl(controller, 'y');
      expect(controller.getSnapshot().exitGuard, `refused at ${String(at)} ms`).toBe('confirm');
    }
    expect(run.host.cancel, 'a held key cancelled nothing').not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    t = 3800 + 2000; // released for the whole window
    ctrl(controller, 'y');
    expect(controller.getSnapshot().exitGuard).toBe('stopping');
    expect(run.host.cancel).toHaveBeenCalledTimes(1);
  });

  it('still lets Esc, Ctrl+C and Ctrl+N close the card inside the lockout', () => {
    for (const [input, key] of [
      ['', { escape: true }],
      ['c', { ctrl: true }],
      ['n', { ctrl: true }],
    ] as const) {
      const chordHistory = createChordHistory();
      chordHistory.lastResolvedAt = 0;
      const { controller } = openWith({ now: () => 100, chordHistory, painted: false });
      controller.handleKey(input, key);
      expect(controller.getSnapshot().exitGuard).toBeUndefined();
    }
  });
});

describe('the Home follows its run host', () => {
  it('publishes the run once the action that started it ends, keeps watching while it is live, and stops when it ends', async () => {
    let started: () => void = () => {};
    const rig = mount(IDLE, {
      launchRun: () =>
        new Promise<string>((resolve) => {
          started = () => resolve('Started.');
        }),
    });
    rig.controller.handlePaste('/run');
    rig.controller.handleKey('', ENTER);
    expect(
      rig.controller.getSnapshot().hostedRun,
      'nothing is published before there is a run',
    ).toBeUndefined();
    rig.run.set(RUNNING);
    started();
    await flush();
    expect(rig.controller.getSnapshot().hostedRun?.active?.runId).toBe('run-0001');
    expect(rig.clock.pending(), 'a live leg is watched').toBe(1);
    rig.run.set(CANCELLING);
    rig.clock.advance(HOSTED_RUN_POLL_MS);
    expect(rig.controller.getSnapshot().hostedRun?.active?.cancelling).toBe(true);
    rig.run.set(IDLE);
    rig.clock.advance(HOSTED_RUN_POLL_MS);
    expect(rig.controller.getSnapshot().hostedRun?.active).toBeUndefined();
    expect(rig.clock.pending(), 'no leg, no watch').toBe(0);
  });

  it('publishes nothing new for an unchanged host (no repaint on every poll)', () => {
    const rig = mount(RUNNING);
    ctrl(rig.controller, 'd');
    const listener = vi.fn();
    rig.controller.subscribe(listener);
    rig.clock.advance(HOSTED_RUN_POLL_MS * 5);
    expect(listener).not.toHaveBeenCalled();
  });
});
