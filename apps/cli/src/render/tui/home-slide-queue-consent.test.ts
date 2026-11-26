/**
 * The keys that arrive while the Home's pages slide (MVP-11 unit 7, round 1: SE71 and the queue guards), through the real controller with a
 * scripted clock and timer. A key that would ANSWER something (`Enter`, which opens the focused row, sends the draft or runs a command; the answer
 * chords `Ctrl+Y` and `Ctrl+N`) is judged when it is PRESSED: no frame has shown the page it would act on at rest then, so it is dropped, never
 * applied at the arrival. The other keys keep their order. A queue that waited is dropped whole when, by the time it would be applied, the terminal
 * is below the Home's 80×24 floor or a popup owns the keyboard. `home-pages-controller.test.ts` owns the slide itself; nothing here sleeps.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeControllerDeps,
} from './home-controller.js';
import { SLIDE_FRAME_MS, SLIDE_SETTLE_BOUND_MS } from './home-pages.js';

const DOWN = { downArrow: true } as const;
const ESC = { escape: true } as const;
const ENTER = { return: true } as const;
const CTRL = { ctrl: true } as const;
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const EXECUTING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-live', cancelling: false },
  last: undefined,
};
/** The three frames between and the arrival of one slide at 80×24. */
const ONE_SLIDE_MS = SLIDE_FRAME_MS * 3;

const sessionRow = (sessionId: string): HomeSessionRow => ({
  sessionId,
  title: undefined,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});
/** Two sessions: the work page's first row is a session `Enter` resumes. */
const SESSIONS: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [sessionRow('s1'), sessionRow('s2')],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 2, runs: 0 },
  isEmpty: false,
};

/** Let the promises a key started settle. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};

function rig(
  options: { readonly hosted?: RunHostSnapshot; readonly popupOpen?: () => boolean } = {},
) {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const resumeChat = vi.fn(() => new Promise<undefined>(() => {}));
  const startChat = vi.fn(() => new Promise<HomeChatSession>(() => {}));
  const cancel = vi.fn(() => true);
  const onExit = vi.fn();
  const deps: HomeControllerDeps = {
    startChat,
    homeStore: { read: () => SESSIONS },
    resumeChat,
    hostedRuns: {
      snapshot: () => options.hosted ?? IDLE,
      cancel,
      close: () => Promise.resolve(),
    },
    schedule: (run, delayMs) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: now + delayMs, run });
      return () => {
        timers.delete(id);
      };
    },
    slideTransitions: true,
    now: () => now,
    ...(options.popupOpen === undefined ? {} : { popupOpen: options.popupOpen }),
    onExit,
    onError: (cause) => {
      throw cause;
    },
  };
  const controller = createHomeController(deps);
  controller.setTerminalSize(80, 24);
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].run();
    }
    now = end;
  };
  return {
    controller,
    advance,
    resumeChat,
    startChat,
    cancel,
    onExit,
    state: () => controller.getSnapshot(),
    press: (key: object): void => controller.handleKey('', key),
    type: (text: string): void => {
      for (const char of text) controller.handleKey(char, {});
    },
  };
}

describe('a key that answers, pressed while the pages slide, is dropped when it is pressed', () => {
  it('an `Enter` on the row the slide arrives at opens nothing, even with the arrival on screen by the time it would be applied', async () => {
    const r = rig();
    r.controller.bindHomeFrame(() => true); // every frame the host is asked about is "on screen": only the press time can refuse it
    r.press(DOWN);
    expect(r.state().stripFocus?.id, 'the slide lands on the first session').toBe('s1');
    r.press(ENTER);
    r.advance(ONE_SLIDE_MS);
    await settle();
    expect(r.resumeChat).not.toHaveBeenCalled();
    expect(r.state().stripFocus?.id, 'the row is still focused, unopened').toBe('s1');
    r.press(ENTER); // the same key once the arrival is the page at rest: the person has seen the row
    await settle();
    expect(r.resumeChat).toHaveBeenCalledWith('s1');
  });

  it('an `Enter` pressed after the arrival, while its frame is not yet acknowledged, is dropped too (no draft is sent from the landing)', async () => {
    const r = rig();
    let visible = false;
    r.controller.bindHomeFrame(() => visible);
    r.press(DOWN);
    r.advance(ONE_SLIDE_MS);
    r.press(ESC); // back up: the slide to the landing
    r.type('hello');
    r.advance(ONE_SLIDE_MS); // arrived, its frame not acknowledged yet: the keys wait
    r.press(ENTER);
    visible = true;
    r.controller.homeFrameShown?.(r.state());
    await settle();
    expect(r.state().input.text, 'the typed keys were applied in order').toBe('hello');
    expect(
      r.startChat,
      'no chat was started for a draft the Enter never saw sent',
    ).not.toHaveBeenCalled();
    expect(r.state().mode).toBe('home');
  });

  it('`Ctrl+Y` and `Ctrl+N` are never replayed onto a card a key before them opened: the exit guard a queued `Ctrl+D` opens stays asking', () => {
    for (const chord of ['y', 'n'] as const) {
      const r = rig({ hosted: EXECUTING });
      r.controller.bindHomeFrame(() => true);
      r.press(DOWN);
      r.controller.handleKey('d', CTRL); // queued: at the arrival it opens the exit guard (a run is executing)
      r.controller.handleKey(chord, CTRL); // queued after it: an answer to a card no frame has shown
      r.advance(ONE_SLIDE_MS);
      expect(r.state().exitGuard, `Ctrl+${chord.toUpperCase()}`).toBe('confirm');
      expect(r.cancel, `Ctrl+${chord.toUpperCase()} stopped nothing`).not.toHaveBeenCalled();
      expect(r.onExit).not.toHaveBeenCalled();
    }
  });

  it('every other key keeps its place in the queue: letters, a paste, the arrows and `Esc`', () => {
    const r = rig();
    r.press(DOWN);
    r.press(ENTER); // dropped
    r.type('a');
    r.controller.handlePaste('B');
    r.type('c');
    r.advance(ONE_SLIDE_MS);
    expect(r.state().input.text).toBe('aBc');
    expect(
      r.state().stripFocus,
      'the first key typed on the row moved to the docked prompt',
    ).toBeUndefined();
  });
});

describe('a queue that waited is dropped whole when it could no longer be applied as it was pressed', () => {
  it('below the 80×24 floor at the arrival: nothing typed reaches the prompt, nothing is sent', () => {
    const r = rig();
    r.press(DOWN);
    r.advance(ONE_SLIDE_MS);
    r.press(ESC); // the slide up to the landing
    r.type('ab');
    r.controller.setTerminalSize(70, 20); // the resize ends the slide; the queue would be applied under "Terminal too small"
    r.advance(SLIDE_SETTLE_BOUND_MS);
    expect(r.state().input.text).toBe('');
    expect(r.startChat).not.toHaveBeenCalled();
  });

  it('a popup that opened while the keys waited gets none of them, and neither does the Home behind it', () => {
    let popupOpen = false;
    const r = rig({ popupOpen: () => popupOpen });
    r.controller.bindHomeFrame(() => false); // the host has not measured the arrival
    r.press(DOWN);
    r.advance(ONE_SLIDE_MS);
    r.press(ESC);
    r.type('ab');
    r.advance(ONE_SLIDE_MS); // arrived: the keys wait for its frame
    popupOpen = true; // a popup (the first-run offer) opened meanwhile
    r.advance(SLIDE_SETTLE_BOUND_MS);
    expect(r.state().input.text).toBe('');
  });

  it('a queue applied at the floor and with no popup is applied as before', () => {
    const r = rig({ popupOpen: () => false });
    r.press(DOWN);
    r.advance(ONE_SLIDE_MS);
    r.press(ESC);
    r.type('ab');
    r.controller.setTerminalSize(80, 24);
    r.advance(SLIDE_SETTLE_BOUND_MS);
    expect(r.state().input.text).toBe('ab');
  });
});
