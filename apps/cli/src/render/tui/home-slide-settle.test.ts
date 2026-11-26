/**
 * The Home's slide, its arrival and the keys that wait for it, for a HOST WHOSE ARRIVAL FRAME IS NOT ON SCREEN (MVP-11 unit 7, round 1: the
 * mutation sweep's MU72). The tests of `home-pages-controller.test.ts` that end a slide early (`Ctrl+C`, a resize) run with no host that
 * measures frames, where "the arrival is on screen" is always true and the settle path is never entered, so the two calls that decide how an
 * early end behaves were pinned by nothing a mounted Home reaches. Here a host is bound (`bindHomeFrame`) whose answer is "not shown yet":
 *
 *  - `Ctrl+C` does not wait: it ends the slide, applies at once what was queued before it (the host's word is not waited for), and is then
 *    handled. It does so whether the slide is still running or has already arrived and waits for its frame.
 *  - a resize ends the slide where it would arrive and the keys then wait for that frame like any arrival: shown (`homeFrameShown`) releases
 *    them at once, a frame that is not the arrival does not, a host that never says so releases them after `SLIDE_SETTLE_BOUND_MS`.
 *  - the wait's bound belongs to ONE arrival: once the arrival was shown it never fires, so it cannot release the keys of the NEXT arrival early.
 *
 * The clock, the timer and the reads are scripted: nothing here sleeps.
 */
import { describe, expect, it } from 'vitest';

import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { createHomeController, type HomeControllerDeps } from './home-controller.js';
import { SLIDE_FRAME_MS, SLIDE_SETTLE_BOUND_MS } from './home-pages.js';

const DOWN = { downArrow: true } as const;
const ESC = { escape: true } as const;
const CTRL_C = { ctrl: true } as const;
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };

/** The three frames between and the arrival of one slide at the rows the rig is sized to. */
const ONE_SLIDE_MS = SLIDE_FRAME_MS * 3;

const runRow = (runId: string): HomeRunRow => ({
  runId,
  workflowSlug: 'wf',
  status: 'completed',
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
/** A session and a run: the work page has rows, so `↓` from the landing slides to it and `Esc` slides back. */
const BUSY: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [sessionRow('s1')],
  recentRuns: [runRow('r1')],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 1, runs: 1 },
  isEmpty: false,
};

function rig() {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const deps: HomeControllerDeps = {
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => BUSY },
    resumeChat: () => new Promise(() => {}),
    hostedRuns: { snapshot: () => IDLE, cancel: () => true, close: () => Promise.resolve() },
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
    onExit: () => undefined,
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
  return {
    controller,
    advance,
    state: () => controller.getSnapshot(),
    press: (key: object): void => controller.handleKey('', key),
    type: (text: string): void => {
      for (const char of text) controller.handleKey(char, {});
    },
    /** What the host says when the frame holding the controller's CURRENT state has been measured and flushed. */
    shown: (): void => controller.homeFrameShown?.(controller.getSnapshot()),
  };
}

describe('`Ctrl+C` does not wait for a host whose arrival frame is not on screen', () => {
  it('during the slide: it ends it, the keys before it are applied at once, and then it arms', () => {
    const r = rig();
    r.controller.bindHomeFrame(() => false);
    r.press(DOWN);
    r.type('a');
    expect(r.state().input.text, 'the key waits while it slides').toBe('');
    r.controller.handleKey('c', CTRL_C);
    expect(r.state().slide).toBeUndefined();
    expect(r.state().input.text, 'applied before the Ctrl+C, not after the bound').toBe('a');
    expect(r.state().interruptArmed, 'the Ctrl+C itself was handled').toBe(true);
    r.advance(SLIDE_SETTLE_BOUND_MS * 2);
    expect(r.state().input.text, 'applied once').toBe('a');
  });

  it('after the arrival, while its frame is awaited: the same, at once', () => {
    const r = rig();
    r.controller.bindHomeFrame(() => false);
    r.press(DOWN);
    r.type('a');
    r.advance(ONE_SLIDE_MS);
    expect(r.state().slide).toBeUndefined();
    expect(r.state().input.text, 'arrived, not shown: the key waits for it').toBe('');
    r.controller.handleKey('c', CTRL_C);
    expect(r.state().input.text, 'the wait was not served out').toBe('a');
    expect(r.state().interruptArmed).toBe(true);
  });
});

describe('a resize while the pages slide, for a host whose arrival frame is not on screen', () => {
  it('ends the slide, and the keys wait for the arrival up to the settle bound, no longer', () => {
    const r = rig();
    r.controller.bindHomeFrame(() => false);
    r.press(DOWN);
    r.type('q');
    r.controller.setTerminalSize(100, 30);
    expect(r.state().slide).toBeUndefined();
    expect(r.state().input.text, 'the arrival is not on screen yet: the key waits').toBe('');
    r.advance(SLIDE_SETTLE_BOUND_MS - 1);
    expect(r.state().input.text, 'still inside the bound').toBe('');
    r.advance(1);
    expect(r.state().input.text, 'the bound has passed: applied').toBe('q');
  });

  it('releases them as soon as the host shows the arrival, and the bound then never fires again', () => {
    const r = rig();
    r.controller.bindHomeFrame(() => false);
    r.press(DOWN);
    r.type('q');
    r.controller.setTerminalSize(100, 30);
    expect(r.state().input.text).toBe('');
    r.shown();
    expect(r.state().input.text, 'shown: applied at once').toBe('q');
    r.advance(SLIDE_SETTLE_BOUND_MS * 2);
    expect(r.state().input.text, 'applied once').toBe('q');
  });
});

describe('the keys that waited for an arrival the host has not shown', () => {
  it('are released the moment the host shows the arrival, and not again when the bound would have fallen due', () => {
    const r = rig();
    r.controller.bindHomeFrame(() => false);
    r.press(DOWN);
    r.type('hi');
    r.advance(ONE_SLIDE_MS * 2);
    expect(r.state().slide).toBeUndefined();
    expect(r.state().input.text, 'arrived, not shown').toBe('');
    r.shown();
    expect(r.state().input.text).toBe('hi');
    r.advance(SLIDE_SETTLE_BOUND_MS * 2);
    expect(r.state().input.text, 'applied once').toBe('hi');
  });

  it('are not released by a frame that is not the arrival', () => {
    const r = rig();
    r.controller.bindHomeFrame(() => false);
    r.press(DOWN);
    r.type('x');
    r.advance(ONE_SLIDE_MS);
    r.controller.homeFrameShown?.({ ...r.state() }); // a copy: not the state that arrived
    expect(r.state().input.text).toBe('');
    r.shown();
    expect(r.state().input.text).toBe('x');
  });

  it('wait out their own bound when the host never says so', () => {
    const r = rig();
    r.controller.bindHomeFrame(() => false);
    r.press(DOWN);
    r.type('x');
    r.advance(ONE_SLIDE_MS);
    r.advance(SLIDE_SETTLE_BOUND_MS - 1);
    expect(r.state().input.text).toBe('');
    r.advance(1);
    expect(r.state().input.text).toBe('x');
  });

  it('have a bound that belongs to ONE arrival: once it was shown, the bound cannot release the keys of the next arrival early', () => {
    const r = rig();
    r.controller.bindHomeFrame(() => false);
    r.press(DOWN); // slide A, down to the work page
    r.type('a');
    r.advance(ONE_SLIDE_MS); // A arrives; its frame is not on screen: A's bound is armed
    expect(r.state().input.text).toBe('');
    const aBoundDueIn = SLIDE_SETTLE_BOUND_MS;
    const shownAfter = 30;
    r.advance(shownAfter);
    r.shown(); // A's frame is shown: 'a' is applied and A's bound is over
    expect(r.state().input.text).toBe('a');
    r.press(ESC); // slide B, back up to the landing
    expect(r.state().slide?.to, 'the Esc started the slide back').toBe('start');
    r.type('b');
    r.advance(ONE_SLIDE_MS); // B arrives, not shown: its own bound is armed
    expect(r.state().slide).toBeUndefined();
    expect(r.state().input.text).toBe('a');
    // Move to just past the moment A's bound would have fallen due. It was cancelled when A's frame was shown, so it must not release B's key.
    const elapsedSinceA = shownAfter + ONE_SLIDE_MS;
    r.advance(aBoundDueIn - elapsedSinceA + SLIDE_FRAME_MS);
    expect(r.state().input.text, 'A’s bound does not fire').toBe('a');
    r.advance(SLIDE_SETTLE_BOUND_MS);
    expect(r.state().input.text, 'B’s own bound releases it').toBe('ab');
  });
});
