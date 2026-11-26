/**
 * The Home's two pages through the real controller (MVP-11 unit 7): `↓`, `↑`, `Esc` and the keys that type move the focus between the landing's
 * prompt, the work page's rows and its docked prompt; the ONE draft is the same on both pages; `Enter` does on each place what it says; the
 * palette runs down from the landing and up from the work page; and in the alternate screen the change of page SLIDES, its frames timed by an
 * injected scheduler, every key that arrives meanwhile waiting in order for the arrival. `home-pages.test.ts` owns the pure reducer. The clock,
 * the timer and the reads are scripted: nothing sleeps.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ChangeToken } from '../../history/change-probe.js';
import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  EMPTY_PROMPT_ENTER_NOTICE,
  STRIP_REFRESH_MS,
  type HomeChatSession,
  type HomeControllerDeps,
} from './home-controller.js';
import { EXAMPLE_PROMPT } from './home-layout.js';
import { SLIDE_FRAME_MS, SLIDE_SETTLE_BOUND_MS } from './home-pages.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

const DOWN = { downArrow: true } as const;
const UP = { upArrow: true } as const;
const ESC = { escape: true } as const;
const ENTER = { return: true } as const;
const CTRL_C = { ctrl: true } as const;
const TAB = { tab: true } as const;
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const EXECUTING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-live', cancelling: false },
  last: undefined,
};

const runRow = (runId: string, status: HomeRunRow['status'] = 'completed'): HomeRunRow => ({
  runId,
  workflowSlug: 'wf',
  status,
  createdAt: '2026-11-23T00:00:00.000Z',
  startedAt: undefined,
  completedAt: undefined,
  totalCostMicrocents: 0,
});
const sessionRow = (sessionId: string): HomeSessionRow => ({
  sessionId,
  workingDir: '/work',
  title: undefined,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});
/** A failed run `f1`, the sessions `s1` and `s2`, a recent run `r1`: four rows, in the order the work page lists them. */
const BUSY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [runRow('f1', 'failed')] },
  recentSessions: [sessionRow('s1'), sessionRow('s2')],
  recentRuns: [runRow('r1')],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: false,
};
const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};

/** Let the promises a key started settle (a resume's native action, a poll's read). */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};

interface RigOptions {
  readonly snapshot?: HomeSnapshot;
  readonly slides?: boolean;
  readonly keyless?: boolean;
  readonly hosted?: RunHostSnapshot;
  readonly startChat?: () => Promise<HomeChatSession>;
}

function rig(options: RigOptions = {}) {
  let current = options.snapshot ?? BUSY;
  const token = { dataVersion: 1, generation: 0 };
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void; delay: number }>();
  const announced: string[] = [];
  const resumeChat = vi.fn(() => new Promise<undefined>(() => {}));
  const openSetup = vi.fn(() => new Promise<void>(() => {}));
  const startChat = vi.fn(options.startChat ?? (() => new Promise<HomeChatSession>(() => {})));
  const onExit = vi.fn();
  const deps: HomeControllerDeps = {
    startChat,
    homeStore: { read: () => current },
    resumeChat,
    announce: (text) => announced.push(text),
    hostedRuns: {
      snapshot: () => options.hosted ?? IDLE,
      cancel: () => true,
      close: () => Promise.resolve(),
    },
    providerSetup: { initialKeyless: options.keyless === true, open: openSetup },
    strip: { token: (): ChangeToken => ({ ...token }), isClosed: () => false },
    schedule: (run, delayMs) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: now + delayMs, run, delay: delayMs });
      return () => {
        timers.delete(id);
      };
    },
    slideTransitions: options.slides === true,
    now: () => now,
    onExit,
    onError: (cause) => {
      throw cause;
    },
  };
  const controller = createHomeController(deps);
  controller.setTerminalSize(80, 24);
  /** Move time forward, firing every timer that falls due on the way, in order. */
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
  const state = () => controller.getSnapshot();
  return {
    controller,
    state,
    advance,
    announced,
    resumeChat,
    openSetup,
    startChat,
    onExit,
    /** The timers pending now that are a frame of the slide (the strip's own poll is another timer). */
    slideTimers: (): number =>
      [...timers.values()].filter((timer) => timer.delay === SLIDE_FRAME_MS).length,
    pending: (): number => timers.size,
    show: (next: HomeSnapshot): void => {
      current = next;
      token.generation += 1;
    },
    press: (key: object, times = 1): void => {
      for (let n = 0; n < times; n += 1) controller.handleKey('', key);
    },
    type: (text: string): void => {
      for (const char of text) controller.handleKey(char, {});
    },
    focus: (): string | undefined => controller.getSnapshot().stripFocus?.id,
    /** The place the focus is in, as the design names it. */
    place: (): 'start-prompt' | 'rows' | 'docked-prompt' => {
      const s = controller.getSnapshot();
      if (s.homePage === 'start') return 'start-prompt';
      return s.stripFocus === undefined ? 'docked-prompt' : 'rows';
    },
  };
}

describe('`↓` goes down from the landing to the work page', () => {
  it('lands on the FIRST row of the list (the failed run), and the work page is in front', () => {
    const r = rig();
    expect(r.place()).toBe('start-prompt');
    r.press(DOWN);
    expect(r.place()).toBe('rows');
    expect(r.focus()).toBe('f1');
  });

  it('with a draft too: the first row, and the draft is kept', () => {
    const r = rig();
    r.type('fix the flaky test');
    r.press(DOWN);
    expect(r.focus()).toBe('f1');
    expect(r.state().input.text).toBe('fix the flaky test');
  });

  it('a multi-line draft moves its cursor down first, and goes down only from its last line', () => {
    const r = rig();
    r.type('first');
    r.controller.handleKey('j', { ctrl: true }); // a newline
    r.type('second');
    r.press(UP);
    expect(r.place(), 'the cursor went up a line, the page did not move').toBe('start-prompt');
    r.press(DOWN);
    expect(r.place(), 'the cursor came back down').toBe('start-prompt');
    expect(r.state().input.cursor, 'on the last line').toBeGreaterThan('first'.length);
    r.press(DOWN);
    expect(r.place()).toBe('rows');
  });

  it('does nothing at all with nothing to continue: there is no work page', () => {
    const r = rig({ snapshot: EMPTY });
    r.press(DOWN);
    expect(r.state().homePage).toBe('start');
    expect(r.state().slide).toBeUndefined();
  });
});

describe('on the work page', () => {
  it('`↑/↓` walk the rows; `↓` past the last row is the docked prompt, `↑` from it the last row, `↑` from the first row the landing', () => {
    const r = rig();
    r.press(DOWN);
    const walked: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      walked.push(r.focus() ?? '-');
      r.press(DOWN);
    }
    expect(walked).toEqual(['f1', 's1', 's2', 'r1']);
    expect(r.place()).toBe('docked-prompt');
    r.press(DOWN);
    expect(r.place(), '`↓` on the docked prompt goes nowhere').toBe('docked-prompt');
    r.press(UP);
    expect(r.focus()).toBe('r1');
    r.press(UP, 3);
    expect(r.focus()).toBe('f1');
    r.press(UP);
    expect(r.place()).toBe('start-prompt');
  });

  it('`↑` on a multi-line draft in the docked prompt moves its cursor up first, and goes onto the list only from its first line', () => {
    const r = rig();
    r.press(DOWN);
    r.press(DOWN, 4);
    expect(r.place()).toBe('docked-prompt');
    r.type('one');
    r.controller.handleKey('j', { ctrl: true });
    r.type('two');
    r.press(UP);
    expect(r.place(), 'the cursor moved up a line').toBe('docked-prompt');
    r.press(UP);
    expect(r.focus()).toBe('r1');
  });

  it('`Esc` goes back up to the landing from a row and from the docked prompt, the draft kept', () => {
    const r = rig();
    r.type('kept');
    r.press(DOWN);
    r.press(ESC);
    expect(r.place()).toBe('start-prompt');
    expect(r.state().input.text).toBe('kept');
    r.press(DOWN);
    r.press(DOWN, 4);
    expect(r.place()).toBe('docked-prompt');
    r.press(ESC);
    expect(r.place()).toBe('start-prompt');
    expect(r.state().input.text).toBe('kept');
  });

  it('a key that types on a row moves to the docked prompt and is typed there, after the draft', () => {
    const r = rig();
    r.type('ab');
    r.press(DOWN);
    expect(r.place()).toBe('rows');
    r.controller.handleKey('c', {});
    expect(r.place()).toBe('docked-prompt');
    expect(r.state().input.text).toBe('abc');
  });

  it('a paste on a row moves to the docked prompt and is pasted there', () => {
    const r = rig();
    r.press(DOWN);
    r.controller.handlePaste('pasted line');
    expect(r.place()).toBe('docked-prompt');
    expect(r.state().input.text).toBe('pasted line');
  });

  it('ONE draft: what is typed on the docked prompt is on the landing’s prompt when `Esc` goes back, and the other way round', () => {
    const r = rig();
    r.type('hello');
    r.press(DOWN);
    r.press(DOWN, 4);
    r.type(' world');
    expect(r.state().input.text).toBe('hello world');
    r.press(ESC);
    expect(r.state().input.text).toBe('hello world');
    r.type('!');
    r.press(DOWN);
    expect(r.state().input.text).toBe('hello world!');
  });

  it('`Enter` on a row opens it (a session is resumed); on the docked prompt with a draft it starts the chat', async () => {
    const r = rig();
    r.press(DOWN, 2);
    expect(r.focus()).toBe('s1');
    r.press(ENTER);
    await settle();
    expect(r.resumeChat).toHaveBeenCalledWith('s1');
    const chat = rig();
    chat.press(DOWN);
    chat.type('go');
    expect(chat.place()).toBe('docked-prompt');
    chat.press(ENTER);
    expect(chat.startChat).toHaveBeenCalledOnce();
    expect(chat.state().mode).toBe('loading');
  });

  it('`Enter` on the empty docked prompt does what it does on the landing’s: one notification, the setup with no key, the run view with a live run', () => {
    const r = rig();
    r.press(DOWN);
    r.press(DOWN, 4);
    r.press(ENTER);
    expect(r.announced).toEqual([EMPTY_PROMPT_ENTER_NOTICE]);
    const keyless = rig({ keyless: true });
    keyless.press(DOWN);
    keyless.press(DOWN, 4);
    keyless.press(ENTER);
    expect(keyless.openSetup).toHaveBeenCalledOnce();
    const live = rig({ hosted: EXECUTING });
    live.press(DOWN);
    live.press(DOWN, 4);
    live.press(ENTER);
    expect(live.state().screen?.kind).toBe('run-view');
  });

  it('`Tab` fills the example on the landing (with something to continue too) and does nothing on the work page', () => {
    const r = rig();
    r.press(TAB);
    expect(r.state().input.text).toBe(EXAMPLE_PROMPT);
    const work = rig();
    work.press(DOWN);
    work.press(DOWN, 4);
    work.press(TAB);
    expect(work.state().input.text).toBe('');
  });
});

describe('the palette runs away from the prompt it opens at', () => {
  it('down from the landing, up from the work page’s docked prompt; `/` on a row moves to the docked prompt first', () => {
    const landing = rig();
    landing.controller.handleKey('/', {});
    expect(landing.state().palette?.list.layout).toBe('down');
    const docked = rig();
    docked.press(DOWN);
    docked.press(DOWN, 4);
    docked.controller.handleKey('/', {});
    expect(docked.state().palette?.list.layout).toBe('up');
    const row = rig();
    row.press(DOWN);
    row.controller.handleKey('/', {});
    expect(row.place()).toBe('docked-prompt');
    expect(row.state().palette?.list.layout).toBe('up');
  });

  it('`Esc` closes the palette first and leaves the work page where it was', () => {
    const r = rig();
    r.press(DOWN);
    r.controller.handleKey('/', {});
    r.press(ESC);
    expect(r.state().palette).toBeUndefined();
    expect(r.place()).toBe('docked-prompt');
    r.press(ESC);
    expect(r.place()).toBe('start-prompt');
  });
});

describe('the page and what moves it', () => {
  it('a read that leaves nothing to continue takes the Home back to its landing', async () => {
    const r = rig();
    r.press(DOWN);
    expect(r.state().homePage).toBe('work');
    r.show(EMPTY);
    r.advance(STRIP_REFRESH_MS);
    await settle();
    expect(r.state().homePage).toBe('start');
    expect(r.focus()).toBeUndefined();
  });

  it('a chat that ends returns to the landing, whichever page started it', async () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    let stopped = false;
    const session: HomeChatSession = {
      store,
      sessionId: 'sess',
      // the first turn ends the session (an `/exit`)
      processLine: () => {
        stopped = true;
        return Promise.resolve();
      },
      shouldStop: () => stopped,
      stopReason: () => 'exit',
      teardown: () => Promise.resolve(),
    };
    const r = rig({ startChat: () => Promise.resolve(session) });
    r.press(DOWN);
    r.press(DOWN, 4);
    r.type('hi');
    r.press(ENTER);
    for (let turn = 0; turn < 50 && r.state().mode !== 'home'; turn += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.state().mode).toBe('home');
    expect(r.state().homePage).toBe('start');
    expect(r.focus()).toBeUndefined();
  });
});

describe('the slide (alternate screen): frames on the scheduler, keys in order after the arrival', () => {
  it('walks three frames between and then arrives, one every SLIDE_FRAME_MS; the page and the focus are the target’s from the start', () => {
    const r = rig({ slides: true });
    r.press(DOWN);
    expect(r.state().homePage).toBe('work');
    expect(r.focus()).toBe('f1');
    const frames: (number | undefined)[] = [r.state().slide?.frame];
    for (let n = 0; n < 3; n += 1) {
      r.advance(SLIDE_FRAME_MS);
      frames.push(r.state().slide?.frame);
    }
    expect(frames).toEqual([0, 1, 2, undefined]);
    expect(r.slideTimers(), 'nothing of the slide is left scheduled').toBe(0);
  });

  it('slides back up on `Esc` and on `↑` from the first row', () => {
    const r = rig({ slides: true });
    r.press(DOWN);
    r.advance(SLIDE_FRAME_MS * 3);
    r.press(ESC);
    expect(r.state().slide).toEqual({ to: 'start', frame: 0 });
    r.advance(SLIDE_FRAME_MS * 3);
    expect(r.state().slide).toBeUndefined();
    r.press(DOWN);
    r.advance(SLIDE_FRAME_MS * 3);
    r.press(UP);
    expect(r.state().slide?.to).toBe('start');
  });

  it('inline (no slide) the pages swap at once', () => {
    const r = rig({ slides: false });
    r.press(DOWN);
    expect(r.state().homePage).toBe('work');
    expect(r.state().slide).toBeUndefined();
    expect(r.slideTimers()).toBe(0);
  });

  it('queues every key and paste that arrives while it slides and applies them in order at the arrival (no host measures frames)', () => {
    const r = rig({ slides: true });
    r.press(DOWN);
    r.controller.handleKey('a', {});
    r.controller.handlePaste('XY');
    r.controller.handleKey('b', {});
    expect(r.state().input.text, 'nothing applied while it slides').toBe('');
    expect(r.focus()).toBe('f1');
    r.advance(SLIDE_FRAME_MS * 3);
    expect(r.state().input.text).toBe('aXYb');
    expect(r.place(), 'the first key typed on the row moved to the docked prompt').toBe(
      'docked-prompt',
    );
  });

  it('with a host that measures frames, waits for the arrival to be on screen, and then applies them', () => {
    const r = rig({ slides: true });
    let visible = false;
    r.controller.bindHomeFrame(() => visible);
    r.press(DOWN);
    r.type('ab');
    r.advance(SLIDE_FRAME_MS * 3);
    expect(r.state().slide).toBeUndefined();
    expect(r.state().input.text, 'the arrival is not on screen yet').toBe('');
    r.type('c');
    expect(r.state().input.text, 'a key after the arrival waits behind them').toBe('');
    r.controller.homeFrameShown?.({ ...r.state() }); // a frame of ANOTHER state: not the arrival
    expect(r.state().input.text).toBe('');
    visible = true;
    r.controller.homeFrameShown?.(r.state());
    expect(r.state().input.text).toBe('abc');
  });

  it('a host that never says so does not hold the keyboard: the queue is applied after SLIDE_SETTLE_BOUND_MS, each key with the host’s own check', () => {
    const r = rig({ slides: true });
    r.controller.bindHomeFrame(() => false);
    r.press(DOWN);
    r.press(ENTER); // `Enter` on the row the slide arrives at, which no frame has shown
    r.type('x');
    r.advance(SLIDE_FRAME_MS * 3);
    r.advance(SLIDE_SETTLE_BOUND_MS - 1);
    expect(r.state().input.text).toBe('');
    r.advance(1);
    expect(r.resumeChat, 'the unseen row was not opened').not.toHaveBeenCalled();
    expect(r.state().screen).toBeUndefined();
    expect(r.state().input.text, 'the key after it was typed').toBe('x');
  });

  it('a queued `Enter` on a row whose arrival is on screen opens it', async () => {
    const r = rig({ slides: true });
    r.controller.bindHomeFrame(() => true);
    r.press(DOWN);
    r.press(DOWN); // s1
    r.press(ENTER);
    r.advance(SLIDE_FRAME_MS * 3);
    expect(r.focus()).toBe('s1');
    await settle();
    expect(r.resumeChat).toHaveBeenCalledWith('s1');
  });

  it('a queued key that starts another slide leaves the rest to wait for that one', () => {
    const r = rig({ slides: true });
    r.press(DOWN);
    r.press(UP); // from the first row: back up to the landing, once the slide down has arrived
    r.type('z');
    r.advance(SLIDE_FRAME_MS * 3);
    expect(r.state().slide?.to).toBe('start');
    expect(r.state().input.text, 'the key waits for the second slide').toBe('');
    r.advance(SLIDE_FRAME_MS * 3);
    expect(r.state().homePage).toBe('start');
    expect(r.state().input.text).toBe('z');
  });

  it('`Ctrl+C` does not wait: the slide arrives at once, what came before it is applied, and then it arms', () => {
    const r = rig({ slides: true });
    r.press(DOWN);
    r.controller.handleKey('a', {});
    r.controller.handleKey('c', CTRL_C);
    expect(r.state().slide).toBeUndefined();
    expect(r.slideTimers()).toBe(0);
    expect(r.state().input.text, 'the key before it, applied').toBe('a');
    // ... and FIRST: the `Ctrl+C` after it armed the keymap (a key typed after it would have disarmed it, ADR-0115 §1)
    expect(r.state().interruptArmed).toBe(true);
  });

  it('a second `Ctrl+C` during a slide with a run executing opens the exit guard over the page that has arrived', () => {
    const r = rig({ slides: true, hosted: EXECUTING });
    r.press(DOWN);
    r.advance(SLIDE_FRAME_MS * 3);
    r.press(ESC); // a slide up, in progress
    expect(r.state().slide?.to).toBe('start');
    r.controller.handleKey('c', CTRL_C);
    expect(r.state().slide).toBeUndefined();
    r.controller.handleKey('c', CTRL_C);
    expect(r.state().exitGuard).toBe('confirm');
    expect(r.state().homePage).toBe('start');
    expect(r.onExit).not.toHaveBeenCalled();
  });

  it('a resize while it slides ends it where it would arrive', () => {
    const r = rig({ slides: true });
    r.press(DOWN);
    r.type('q');
    r.controller.setTerminalSize(100, 30);
    expect(r.state().slide).toBeUndefined();
    expect(r.slideTimers()).toBe(0);
    expect(r.state().input.text).toBe('q');
  });

  it('leaves nothing scheduled when the Home is torn down mid-slide', async () => {
    const r = rig({ slides: true });
    r.press(DOWN);
    r.type('w');
    await r.controller.teardownActive();
    expect(r.slideTimers()).toBe(0);
    r.advance(SLIDE_SETTLE_BOUND_MS * 2);
    expect(r.state().input.text, 'the queue died with the Home').toBe('');
  });
});
