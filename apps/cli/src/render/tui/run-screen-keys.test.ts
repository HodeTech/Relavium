/**
 * The run view's ladder and the screen slot it sits in
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §5,
 * [ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §1), through the real
 * Home controller:
 *
 * - the first `Ctrl+C` only arms and the second cancels; `Esc` leaves the view and the leg keeps running; cancelling arms nothing; a card
 *   persists until it is dismissed or another run replaces it;
 * - the slot is one place: `openScreen` and `closeScreen`, the overlays are not open behind it, and nothing is pasted through it.
 *
 * The run host and the clock are scripted, so nothing here sleeps, builds an engine or touches an operator home. `home-exit-guard.test.ts`
 * owns the exit guard, `run-screen.test.ts` the model and `interrupt-keymap.test.ts` the tables; this file owns the controller's use of them.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { HostedLegEnd, RunHostSnapshot } from '../../home/run-host.js';
import { INTERRUPT_ARM_WINDOW_MS } from './interrupt-keymap.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
} from './home-controller.js';
import { createRunStore, type RunStore } from './run-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { HOSTED_RUN_POLL_MS } from './tui-constants.js';

const EMPTY: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};

const RUN = 'run-0001';
const OTHER = 'run-0002';
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const running = (runId: string = RUN, cancelling = false): RunHostSnapshot => ({
  launching: false,
  active: { leg: 'start', runId, cancelling },
  last: undefined,
});
const END = (
  runId: string,
  disposition: 'completed' | 'cancelled' = 'completed',
): HostedLegEnd => ({
  leg: 'start',
  runId,
  terminal: {
    disposition,
    safety: undefined,
    headline: `Run ${runId} ${disposition}.`,
    remedy: undefined,
  },
  handedOff: false,
  retirement: 'retired',
  fault: undefined,
});
const settled = (runId: string = RUN): RunHostSnapshot => ({
  launching: false,
  active: undefined,
  last: END(runId),
});

const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const ctrl = (c: HomeController, letter: string): void => c.handleKey(letter, { ctrl: true });
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The one timer the controller is given: a virtual clock whose pending callbacks fire in order as it is advanced. */
function virtualTimers() {
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
    /** How many timers are armed right now. */
    pending: (): number => pending.size,
  };
}

interface Options {
  readonly initial?: RunHostSnapshot;
  readonly launchRun?: () => Promise<string>;
  readonly runStore?: (runId: string) => RunStore | undefined;
  readonly startChat?: () => Promise<HomeChatSession>;
  readonly withHost?: boolean;
}

/** A Home over a scripted run host whose snapshot and notice ring the test sets, and whose cancel is a spy that flips the leg to cancelling. */
function mount(options: Options = {}) {
  const timers = virtualTimers();
  let clock = 0;
  let current = options.initial ?? running();
  let notices: readonly string[] = [];
  const cancel = vi.fn((): boolean => {
    if (current.active === undefined) return false;
    current = { ...current, active: { ...current.active, cancelling: true } };
    return true;
  });
  const close = vi.fn(() => Promise.resolve());
  const onExit = vi.fn();
  const startChat = options.startChat ?? vi.fn(() => new Promise<HomeChatSession>(() => {}));
  // The Home's one notification channel: what `/run` says once its popup has closed (ADR-0148 §6).
  const announced: string[] = [];
  const controller = createHomeController({
    startChat,
    homeStore: { read: () => EMPTY },
    announce: (text) => announced.push(text),
    ...(options.launchRun === undefined ? {} : { launchRun: options.launchRun }),
    ...(options.runStore === undefined ? {} : { runStore: options.runStore }),
    ...(options.withHost === false
      ? {}
      : {
          hostedRuns: {
            snapshot: (): RunHostSnapshot => current,
            cancel,
            close,
            notices: { snapshot: (): readonly string[] => notices },
          },
        }),
    schedule: timers.schedule,
    now: () => clock,
    onExit,
    onError: (cause) => {
      throw cause;
    },
  });
  return {
    controller,
    cancel,
    onExit,
    startChat,
    timers,
    announced,
    set: (next: RunHostSnapshot): void => {
      current = next;
    },
    setNotices: (next: readonly string[]): void => {
      notices = next;
    },
    /** Move the monotonic clock the interrupt keymap runs on. */
    tick: (ms: number): void => {
      clock += ms;
    },
  };
}

/** A Home with the run view of `RUN` open. */
function viewing(options: Options = {}) {
  const home = mount(options);
  expect(home.controller.openScreen('run-view', { runId: RUN })).toBe(true);
  expect(home.controller.getSnapshot().screen?.kind).toBe('run-view');
  return home;
}

describe('the first Ctrl+C in the run view only arms', () => {
  it('cancels nothing, keeps the view open and says the keymap is armed', () => {
    const { controller, cancel } = viewing();
    ctrl(controller, 'c');
    expect(cancel).not.toHaveBeenCalled();
    expect(controller.getSnapshot().screen?.runId).toBe(RUN);
    expect(controller.getSnapshot().interruptArmed).toBe(true);
  });

  it('is a first press again after a key in between: Ctrl+C, a key, Ctrl+C never cancels', () => {
    const { controller, cancel, tick } = viewing();
    ctrl(controller, 'c');
    tick(100);
    controller.handleKey('x', {});
    expect(controller.getSnapshot().interruptArmed, 'a key ends the armed state').toBe(false);
    tick(100);
    ctrl(controller, 'c');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('is a first press again once the window has run out', () => {
    const { controller, cancel, tick } = viewing();
    ctrl(controller, 'c');
    tick(INTERRUPT_ARM_WINDOW_MS + 1);
    ctrl(controller, 'c');
    expect(cancel).not.toHaveBeenCalled();
    expect(controller.getSnapshot().interruptArmed).toBe(true);
  });
});

describe('the second Ctrl+C cancels', () => {
  it('asks the host for the cooperative cancel exactly once, and the view stays open on the cancelling leg', () => {
    const { controller, cancel, tick } = viewing();
    ctrl(controller, 'c');
    tick(500);
    ctrl(controller, 'c');
    expect(cancel).toHaveBeenCalledTimes(1);
    const snapshot = controller.getSnapshot();
    expect(snapshot.screen?.runId, 'the view stays: it shows the run stopping').toBe(RUN);
    expect(snapshot.hostedRun?.active?.cancelling, 'the leg is published as cancelling').toBe(true);
    expect(snapshot.interruptArmed).toBe(false);
  });

  it('a third and fourth press never cancel again: a leg that is cancelling arms nothing', () => {
    const { controller, cancel, tick } = viewing();
    ctrl(controller, 'c');
    tick(10);
    ctrl(controller, 'c');
    expect(cancel).toHaveBeenCalledTimes(1);
    for (let press = 0; press < 4; press += 1) {
      tick(10);
      ctrl(controller, 'c');
      expect(controller.getSnapshot().interruptArmed, `press ${String(press)}`).toBe(false);
    }
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().screen?.runId).toBe(RUN);
  });

  it('reads the host NOW: a leg that ended after the first press is not cancelled by the second', () => {
    const { controller, cancel, set, tick } = viewing();
    ctrl(controller, 'c');
    tick(10);
    set(settled()); // the leg ended between the presses, and no poll has read it yet
    ctrl(controller, 'c');
    expect(cancel, 'nothing is left to cancel').not.toHaveBeenCalled();
    expect(controller.getSnapshot().screen, 'the second press closes the view').toBeUndefined();
  });
});

describe('Esc leaves the view and the leg keeps running', () => {
  it('closes the view, cancels nothing and leaves the leg executing', () => {
    const { controller, cancel } = viewing();
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
    // The strip's `▶` row is the way back: the leg is still there, and still not stopping.
    expect(controller.getSnapshot().hostedRun?.active).toEqual({
      leg: 'start',
      runId: RUN,
      cancelling: false,
    });
  });

  it('does not cancel even after the first Ctrl+C armed it, and the window does not follow the person out', () => {
    const { controller, cancel } = viewing();
    ctrl(controller, 'c');
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(controller.getSnapshot().interruptArmed).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    // The landing's own keymap starts over: a Ctrl+C here is its first press, never a second that would ask to leave the Home.
    ctrl(controller, 'c');
    expect(controller.getSnapshot().exitGuard).toBeUndefined();
    expect(controller.getSnapshot().interruptArmed).toBe(true);
  });

  it('leaves from every state of the leg without touching it', () => {
    for (const snapshot of [running(), running(RUN, true), settled(), IDLE, running(OTHER)]) {
      const { controller, cancel } = viewing({ initial: snapshot });
      controller.handleKey('', ESC);
      expect(controller.getSnapshot().screen, JSON.stringify(snapshot)).toBeUndefined();
      expect(cancel, JSON.stringify(snapshot)).not.toHaveBeenCalled();
    }
  });

  it('is the way out below the minimum too: it is a key of the view like any other', () => {
    const { controller } = viewing();
    controller.setTerminalSize(60, 20);
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen).toBeUndefined();
  });
});

describe('a leg that is cancelling arms nothing', () => {
  it('is a hint only: it arms no window, cancels nothing more and keeps the view', () => {
    const { controller, cancel } = viewing({ initial: running(RUN, true) });
    ctrl(controller, 'c');
    expect(controller.getSnapshot().interruptArmed).toBe(false);
    ctrl(controller, 'c');
    expect(controller.getSnapshot().interruptArmed).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(controller.getSnapshot().screen?.runId).toBe(RUN);
  });

  it('a window armed while the leg executed is dropped once it is cancelling', () => {
    const { controller, cancel, set, tick } = viewing();
    ctrl(controller, 'c');
    tick(10);
    set(running(RUN, true)); // another surface (the exit guard, a signal) began the stop
    ctrl(controller, 'c');
    expect(cancel, 'the stop is already under way').not.toHaveBeenCalled();
    expect(controller.getSnapshot().interruptArmed).toBe(false);
  });
});

describe('a card persists until it is dismissed or another run starts', () => {
  const OTHER_KEYS: readonly {
    readonly name: string;
    readonly send: (c: HomeController) => void;
  }[] = [
    { name: 'a letter', send: (c) => c.handleKey('q', {}) },
    { name: 'Enter', send: (c) => c.handleKey('', ENTER) },
    { name: 'an arrow', send: (c) => c.handleKey('', { downArrow: true }) },
    { name: 'Ctrl+D', send: (c) => ctrl(c, 'd') },
    { name: 'Ctrl+Y', send: (c) => ctrl(c, 'y') },
    { name: 'Ctrl+N', send: (c) => ctrl(c, 'n') },
    { name: 'a slash', send: (c) => c.handleKey('/', {}) },
  ];

  it.each(OTHER_KEYS)('stays open on $name, and cancels and answers nothing', ({ send }) => {
    const { controller, cancel, onExit } = viewing({ initial: settled() });
    send(controller);
    expect(controller.getSnapshot().screen?.runId).toBe(RUN);
    expect(controller.getSnapshot().palette, 'no overlay opens behind it').toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('is dismissed by Esc', () => {
    const { controller } = viewing({ initial: settled() });
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen).toBeUndefined();
  });

  it('is dismissed by Ctrl+C, which arms nothing and cancels nothing', () => {
    const { controller, cancel } = viewing({ initial: settled() });
    ctrl(controller, 'c');
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(controller.getSnapshot().interruptArmed).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('is replaced when another run starts: the old view then has nothing to cancel, and Ctrl+C closes it', () => {
    const { controller, cancel, set } = viewing({ initial: settled() });
    set(running(OTHER));
    ctrl(controller, 'c');
    expect(controller.getSnapshot().screen, 'the first press closes it').toBeUndefined();
    ctrl(controller, 'c');
    expect(cancel, "the other run was never the view's to cancel").not.toHaveBeenCalled();
  });

  it('a view of a run that is not the one executing never cancels it, however often Ctrl+C is pressed', () => {
    const { controller, cancel, tick } = viewing({ initial: running(OTHER) });
    for (let press = 0; press < 3; press += 1) {
      tick(10);
      ctrl(controller, 'c');
    }
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('a leg that has not named its run is not the view`s', () => {
  // A view is opened for a run that has an id, and the host's cancel acts on whichever leg is live: a `Ctrl+C` in a view must never
  // reach a leg it cannot name, or it would cancel another run's start.
  it.each([
    [
      'a leg preparing, with no run yet',
      {
        launching: false,
        active: { leg: 'start', runId: undefined, cancelling: false },
        last: undefined,
      },
    ],
    [
      'a resume leg preparing, with no run yet',
      {
        launching: true,
        active: { leg: 'resume', runId: undefined, cancelling: false },
        last: undefined,
      },
    ],
    ['a launch before any leg exists', { launching: true, active: undefined, last: undefined }],
  ] as const satisfies readonly (readonly [string, RunHostSnapshot])[])(
    'with %s: Ctrl+C closes the view, however often it is pressed, and cancels nothing',
    (_name, initial) => {
      const { controller, cancel, tick } = viewing({ initial });
      expect(controller.getSnapshot().screen?.runId).toBe(RUN);
      ctrl(controller, 'c');
      expect(controller.getSnapshot().screen, 'nothing to arm: the press leaves').toBeUndefined();
      expect(controller.getSnapshot().interruptArmed).toBe(false);
      tick(10);
      ctrl(controller, 'c');
      expect(cancel).not.toHaveBeenCalled();
    },
  );

  it('a view that was armed while its own leg executed stops being armed when another leg is all that is preparing', () => {
    const { controller, cancel, set, tick } = viewing();
    ctrl(controller, 'c'); // the view's own leg: the first press arms
    tick(10);
    set({
      launching: true,
      active: { leg: 'resume', runId: undefined, cancelling: false },
      last: undefined,
    });
    ctrl(controller, 'c'); // the second press finds no leg of THIS run: it closes the view
    expect(cancel, 'the leg that is preparing was never this view`s').not.toHaveBeenCalled();
  });
});

describe('the slot', () => {
  it('opens one screen, holds the run id, the store and the notice ring, and closes it', () => {
    const store = createRunStore(false); // the slot only holds it: the view is what reads it
    const { controller, setNotices } = mount({ runStore: () => undefined });
    setNotices(['one', 'two']);
    expect(controller.openScreen('run-view', { runId: RUN, store })).toBe(true);
    const screen = controller.getSnapshot().screen;
    expect(screen).toMatchObject({ kind: 'run-view', runId: RUN, notices: ['one', 'two'] });
    expect(screen?.store).toBe(store);
    controller.closeScreen();
    expect(controller.getSnapshot().screen).toBeUndefined();
    controller.closeScreen(); // idempotent
    expect(controller.getSnapshot().screen).toBeUndefined();
  });

  it('closing clears the slot, and a screen opened afterwards is the only one', () => {
    const { controller } = mount();
    controller.openScreen('run-view', { runId: RUN });
    controller.closeScreen();
    expect(controller.getSnapshot().screen, 'the close left nothing open').toBeUndefined();
    expect(controller.openScreen('run-view', { runId: OTHER })).toBe(true);
    expect(controller.getSnapshot().screen?.runId).toBe(OTHER);
  });

  it('opening replaces what the slot held, and drops the window the old screen armed', () => {
    const { controller, cancel, tick } = mount();
    controller.openScreen('run-view', { runId: RUN });
    ctrl(controller, 'c');
    tick(10);
    expect(controller.openScreen('run-view', { runId: RUN })).toBe(true);
    expect(controller.getSnapshot().interruptArmed).toBe(false);
    ctrl(controller, 'c'); // a first press of the new screen
    expect(cancel).not.toHaveBeenCalled();
  });

  it('refuses while an overlay is open, while a chat is being built and once the Home is ending', () => {
    const palette = mount();
    palette.controller.handleKey('/', {});
    expect(palette.controller.getSnapshot().palette).toBeDefined();
    expect(palette.controller.openScreen('run-view', { runId: RUN })).toBe(false);
    expect(palette.controller.getSnapshot().screen).toBeUndefined();

    const loading = mount();
    type(loading.controller, 'hello');
    loading.controller.handleKey('', ENTER);
    expect(loading.controller.getSnapshot().mode).toBe('loading');
    expect(loading.controller.openScreen('run-view', { runId: RUN })).toBe(false);

    const guard = mount();
    ctrl(guard.controller, 'd');
    expect(guard.controller.getSnapshot().exitGuard).toBe('confirm');
    expect(guard.controller.openScreen('run-view', { runId: RUN })).toBe(false);
  });

  it('owns every key while open: the prompt is not edited, a chat is not started and no overlay opens', () => {
    const { controller, startChat } = viewing();
    type(controller, 'hello');
    controller.handleKey('', ENTER);
    controller.handleKey('/', {});
    expect(controller.getSnapshot().input.text).toBe('');
    expect(controller.getSnapshot().palette).toBeUndefined();
    expect(controller.getSnapshot().mode).toBe('home');
    expect(startChat).not.toHaveBeenCalled();
  });

  it('drops a paste: it reaches neither the view nor the prompt behind it', () => {
    const { controller } = viewing();
    controller.handlePaste('pasted text');
    expect(controller.getSnapshot().input.text).toBe('');
    expect(controller.getSnapshot().screen?.runId).toBe(RUN);
    controller.handleKey('', ESC);
    controller.handlePaste('pasted text');
    expect(controller.getSnapshot().input.text, 'the gate lifts with the screen').toBe(
      'pasted text',
    );
  });

  it('is closed by the signal teardown path without a key: nothing is left armed', async () => {
    const { controller, timers } = viewing();
    ctrl(controller, 'c');
    expect(timers.pending(), 'a live leg is watched: the poll is armed').toBeGreaterThan(0);
    await controller.teardownActive();
    expect(timers.pending(), 'nothing of the watch outlives the teardown').toBe(0);
    // A Home that was told to end takes no more keys at all.
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen?.runId).toBe(RUN);
  });
});

describe('the notice ring in the view', () => {
  it('is re-read while a leg is live and republished only when it changed', () => {
    const { controller, setNotices, timers } = viewing();
    const seen: unknown[] = [];
    controller.subscribe(() => {
      seen.push(controller.getSnapshot().screen?.notices);
    });
    setNotices(['first']);
    timers.advance(HOSTED_RUN_POLL_MS);
    expect(controller.getSnapshot().screen?.notices).toEqual(['first']);
    const published = seen.length;
    timers.advance(HOSTED_RUN_POLL_MS);
    timers.advance(HOSTED_RUN_POLL_MS);
    expect(seen.length, 'an idle read repaints nothing').toBe(published);
    setNotices(['first', 'second']);
    timers.advance(HOSTED_RUN_POLL_MS);
    expect(controller.getSnapshot().screen?.notices).toEqual(['first', 'second']);
  });
});

describe('how the view is reached', () => {
  it("opens at once on the run that /run started, with the leg's live output", async () => {
    const store = createRunStore(false);
    const { controller, set } = mount({
      initial: IDLE,
      launchRun: () => {
        set(running());
        return Promise.resolve('Started w as run run-0001. It runs in the background.');
      },
      runStore: (runId) => (runId === RUN ? store : undefined),
    });
    controller.handlePaste('/run');
    controller.handleKey('', ENTER);
    await flush();
    const snapshot = controller.getSnapshot();
    expect(snapshot.screen).toMatchObject({ kind: 'run-view', runId: RUN });
    expect(snapshot.screen?.store).toBe(store);
    expect(snapshot.nativeActionBusy).toBe(false);
    expect(snapshot.hostedRun?.active?.runId, 'the strip and the view read one snapshot').toBe(RUN);
  });

  it('opens nothing when the launch started nothing (refused, cancelled, no workflow)', async () => {
    const { controller, announced } = mount({
      initial: IDLE,
      launchRun: () => Promise.resolve('Not started.'),
    });
    controller.handlePaste('/run');
    controller.handleKey('', ENTER);
    await flush();
    expect(controller.getSnapshot().screen).toBeUndefined();
    // What the launch said is one notification (ADR-0148 §6), never the Home's notice.
    expect(announced).toEqual(['Not started.']);
    expect(controller.getSnapshot().notice).toBeUndefined();
  });

  describe('a /run that started no run opens no view, however it ended, while another run executes or starts', () => {
    // The launch flow ends in a notice: the view is for the run it STARTED, told by the leg it left behind, as `r` on a Defined row tells it.
    // A view of ANOTHER run that is executing would hide the notice and is not what `/run` asked for.
    const scenarios: readonly {
      readonly name: string;
      readonly initial: RunHostSnapshot;
      /** What the host holds by the time the flow answers. */
      readonly after: RunHostSnapshot | undefined;
      readonly notice: string;
    }[] = [
      {
        name: 'cancelled while a leg executes',
        initial: running(),
        after: undefined,
        notice: 'Run cancelled.',
      },
      {
        name: 'refused because a leg already executes',
        initial: running(),
        after: undefined,
        notice: `A run is already executing: ${RUN}.`,
      },
      {
        name: 'refused while a resume leg is still acquiring its run, which has its id by the time the flow answers',
        initial: {
          launching: true,
          active: { leg: 'resume', runId: undefined, cancelling: false },
          last: undefined,
        },
        after: running(OTHER),
        notice: 'A run is already starting.',
      },
      {
        name: 'cancelled after the leg that executed settled',
        initial: running(),
        after: IDLE,
        notice: 'Run cancelled.',
      },
    ];

    it.each(scenarios)(
      '$name: what it said is one notification and no view opens',
      async ({ initial, after, notice }) => {
        const { controller, set, announced } = mount({
          initial,
          launchRun: () => {
            if (after !== undefined) set(after);
            return Promise.resolve(notice);
          },
          runStore: () => createRunStore(false),
        });
        controller.handlePaste('/run');
        controller.handleKey('', ENTER);
        await flush();
        const snapshot = controller.getSnapshot();
        expect(snapshot.screen, 'no view of another run').toBeUndefined();
        expect(announced).toEqual([notice]);
        expect(snapshot.notice).toBeUndefined();
        expect(snapshot.nativeActionBusy).toBe(false);
        expect(snapshot.mode).toBe('home');
      },
    );

    it('a /run that starts a run opens that run’s view, not the view of the leg that executed before', async () => {
      const store = createRunStore(false);
      const { controller, set } = mount({
        initial: running(),
        launchRun: () => {
          set(running(OTHER)); // the leg that executed settled while the form was open, and this launch started another
          return Promise.resolve(`Started w as run ${OTHER}. It runs in the background.`);
        },
        runStore: (runId) => (runId === OTHER ? store : undefined),
      });
      controller.handlePaste('/run');
      controller.handleKey('', ENTER);
      await flush();
      const screen = controller.getSnapshot().screen;
      expect(screen).toMatchObject({ kind: 'run-view', runId: OTHER, from: 'landing' });
      expect(screen?.store).toBe(store);
    });
  });

  it('comes back on Enter at the empty prompt while a leg executes, and not otherwise', () => {
    const live = mount();
    live.controller.handleKey('', ENTER);
    expect(live.controller.getSnapshot().screen).toMatchObject({ kind: 'run-view', runId: RUN });

    const none = mount({ initial: IDLE });
    none.controller.handleKey('', ENTER);
    expect(none.controller.getSnapshot().screen).toBeUndefined();

    const ended = mount({ initial: settled() });
    ended.controller.handleKey('', ENTER);
    expect(
      ended.controller.getSnapshot().screen,
      'a dismissed card is not summoned again by Enter',
    ).toBeUndefined();

    const typing = mount();
    type(typing.controller, 'hi');
    typing.controller.handleKey('', ENTER);
    expect(
      typing.controller.getSnapshot().screen,
      'a message starts a chat, it does not open the view',
    ).toBeUndefined();
  });

  it('a Home with no run host never has a view to come back to', () => {
    const { controller } = mount({ withHost: false });
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().screen).toBeUndefined();
  });
});

describe('a chat in front keeps its own Esc and Ctrl+C', () => {
  it('does not reach the slot: it is entered from the landing only', async () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const session: HomeChatSession = {
      store,
      sessionId: 'sess-slot',
      processLine: () => Promise.resolve(),
      shouldStop: () => false,
      stopReason: () => 'exit',
      teardown: () => Promise.resolve(),
    };
    const { controller, cancel } = mount({ startChat: () => Promise.resolve(session) });
    type(controller, 'hello');
    controller.handleKey('', ENTER);
    await flush();
    await flush();
    expect(controller.getSnapshot().mode).toBe('chat');
    expect(controller.openScreen('run-view', { runId: RUN })).toBe(false);
    ctrl(controller, 'c');
    expect(cancel, "a chat's Ctrl+C never reaches the run").not.toHaveBeenCalled();
  });
});
