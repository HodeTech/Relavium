/**
 * The Home repaints for the clock alone while a relative word is on screen (MVP-11 unit 7, round 2: observation F8). The words
 * (`expires in 5m`, `failed 2h ago`, `waiting 3h`) are worded from the clock when a frame is painted, and a landing nothing else repaints kept
 * the words of its last paint: `expires in 13s` stood for 45 seconds, and `expires in 5m` for hours, past the deadline. One timer repaints it
 * every {@link RELATIVE_WORDS_REPAINT_MS}, only while the idle landing or the work page has such a word, with no read of the database; it is
 * cancelled when anything else has the screen and when the Home ends. Through the real Home controller with the clock and the timer scripted.
 * `home-relative-words-frames.test.tsx` draws it.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { ParkedRunRow } from './home-attention.js';
import { showsRelativeWords } from './home-attention.js';
import {
  createHomeController,
  RELATIVE_WORDS_REPAINT_MS,
  STRIP_REFRESH_MS,
  type HomeControllerDeps,
} from './home-controller.js';

const DOWN = { downArrow: true } as const;
const ESC = { escape: true } as const;

const failed: HomeRunRow = {
  runId: 'f1',
  workflowSlug: 'wf',
  status: 'failed',
  createdAt: '2026-11-23T00:00:00.000Z',
  startedAt: undefined,
  completedAt: undefined,
  totalCostMicrocents: 0,
};
const session: HomeSessionRow = {
  sessionId: 's1',
  title: undefined,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
};
const BASE: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const withSessions: HomeSnapshot = {
  ...BASE,
  recentSessions: [session],
  totals: { attention: 0, sessions: 1, runs: 0 },
  isEmpty: false,
};
const withFailed: HomeSnapshot = {
  ...BASE,
  failedRuns: [failed],
  totals: { attention: 1, sessions: 0, runs: 0 },
  isEmpty: false,
};
const OPEN: ParkedRunRow = {
  runId: 'p1',
  kind: 'approval',
  gates: 1,
  parkedSince: '2026-11-23T00:00:00.000Z',
};
const DUE: ParkedRunRow = { ...OPEN, expiresAt: '2026-11-23T01:00:00.000Z' };

describe('showsRelativeWords: whether the clock alone changes what would be drawn', () => {
  const at = (
    page: 'start' | 'work',
    snapshot: HomeSnapshot,
    parked: readonly ParkedRunRow[] = [],
  ): boolean => showsRelativeWords({ page, snapshot, parked });

  it('the work page lists a row that carries an age or a time: a session, a failed run, a parked run (waiting or a deadline)', () => {
    expect(at('work', withSessions)).toBe(true);
    expect(at('work', withFailed)).toBe(true);
    expect(at('work', BASE, [OPEN])).toBe(true);
    expect(at('work', BASE, [DUE])).toBe(true);
    expect(at('work', { ...BASE, recentRuns: [failed] })).toBe(true);
    expect(at('work', { ...BASE, recentAgents: [{ agentSlug: 'a', lastUsedAt: '2026-11-23T00:00:00.000Z' }] })).toBe(true);
  }); // prettier-ignore

  it('the work page of a Home with nothing to list says nothing relative', () => {
    expect(at('work', BASE)).toBe(false);
  });

  it('page 1 says a time only when its head names a failed run (`failed 2h ago`) or a parked run with a deadline (`expires in 5m`)', () => {
    expect(at('start', withFailed)).toBe(true);
    expect(at('start', BASE, [DUE])).toBe(true);
    // a parked run with no deadline: the head says `needs approval` and no time; the row says how long it waits, one page down
    expect(at('start', BASE, [OPEN])).toBe(false);
    // counts only (`↓ 1 session`) and an unreadable run (`a run cannot be read`) have no time in them
    expect(at('start', withSessions)).toBe(false);
    expect(
      at('start', { ...BASE, unreadableRuns: [{ runId: 'u1', reason: 'corrupt-row' }] }),
    ).toBe(false);
    expect(at('start', BASE)).toBe(false);
  }); // prettier-ignore

  it('page 1 names the first item of the one order: a deadline outranks everything, a parked run with none (no time on page 1) a failed run', () => {
    expect(at('start', withFailed, [DUE])).toBe(true);
    expect(at('start', withFailed, [OPEN]), 'the parked run is named, and its head has no time').toBe(false);
    expect(at('start', { ...BASE, unreadableRuns: [{ runId: 'u1', reason: 'corrupt-row' }] }, [OPEN])).toBe(false);
    expect(at('start', { ...withFailed, unreadableRuns: [{ runId: 'u1', reason: 'corrupt-row' }] })).toBe(true);
  }); // prettier-ignore
});

interface RigOptions {
  readonly snapshot: HomeSnapshot;
  readonly parked?: readonly ParkedRunRow[];
  /** `onError` is called and returns (a fault ends the Home) instead of rethrowing the fault into the test. */
  readonly faultsEndTheHome?: boolean;
  /** The popup host's open state as the controller reads it (`popupOpen`): no state of the controller, so its close repaints nothing there. */
  readonly popup?: { open: boolean };
}

function rig(options: RigOptions) {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void; delayMs: number }>();
  const read = vi.fn(() => options.snapshot);
  const onExit = vi.fn();
  const onError = vi.fn((cause: unknown) => {
    if (options.faultsEndTheHome !== true) throw cause;
  });
  const deps: HomeControllerDeps = {
    startChat: () => new Promise(() => {}),
    homeStore: { read },
    gateCards: {
      list: () => options.parked ?? [],
      read: () => undefined,
      resume: () => Promise.reject(new Error('unused')),
    },
    schedule: (run, delayMs) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: now + delayMs, run, delayMs });
      return () => {
        timers.delete(id);
      };
    },
    now: () => now,
    onExit,
    onError,
    popupOpen: () => options.popup?.open === true,
  };
  const controller = createHomeController(deps);
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].run();
    }
    now = end;
  };
  let paints = 0;
  controller.subscribe(() => {
    paints += 1;
  });
  return {
    controller,
    read,
    onExit,
    onError,
    advance,
    paints: (): number => paints,
    /** The repaint timers armed now (the strip's own tick is the one with `STRIP_REFRESH_MS`). */
    wordsTimers: (): number =>
      [...timers.values()].filter((timer) => timer.delayMs === RELATIVE_WORDS_REPAINT_MS).length,
    stripTimers: (): number =>
      [...timers.values()].filter((timer) => timer.delayMs === STRIP_REFRESH_MS).length,
  };
}
type Rig = ReturnType<typeof rig>;

const down = (r: Rig): void => r.controller.handleKey('', DOWN);
const back = (r: Rig): void => r.controller.handleKey('', ESC);

describe('the timer exists only while a relative word is on the idle landing or the work page', () => {
  it('a Home with nothing to show, and one whose landing counts only (`↓ 1 session`), arm none', () => {
    expect(rig({ snapshot: BASE }).wordsTimers()).toBe(0);
    expect(rig({ snapshot: withSessions }).wordsTimers()).toBe(0);
  });

  it('arms one as the work page opens (its rows carry ages) and cancels it as the landing comes back', () => {
    const r = rig({ snapshot: withSessions });
    down(r);
    expect(r.controller.getSnapshot().homePage).toBe('work');
    expect(r.wordsTimers()).toBe(1);
    back(r);
    expect(r.controller.getSnapshot().homePage).toBe('start');
    expect(r.wordsTimers()).toBe(0);
  });

  it('arms one on the landing itself when its head names a failed run or a parked run with a deadline; a parked run with none is on page 2 only', () => {
    expect(rig({ snapshot: withFailed }).wordsTimers()).toBe(1);
    expect(rig({ snapshot: BASE, parked: [DUE] }).wordsTimers()).toBe(1);
    const open = rig({ snapshot: BASE, parked: [OPEN] });
    expect(open.wordsTimers()).toBe(0);
    down(open);
    expect(open.wordsTimers()).toBe(1);
  });

  it('never more than one, whatever the Home does', () => {
    const r = rig({ snapshot: withFailed });
    for (let step = 0; step < 6; step += 1) {
      r.controller.handleKey('x', {});
      r.controller.handleKey('', { backspace: true });
      down(r);
      back(r);
      expect(r.wordsTimers(), `step ${String(step)}`).toBeLessThanOrEqual(1);
    }
  });
});

describe('a tick repaints, reads nothing and arms the next', () => {
  it('every RELATIVE_WORDS_REPAINT_MS: one repaint, a new state with the same rows, and no read of the database', () => {
    const r = rig({ snapshot: withFailed });
    const before = r.controller.getSnapshot();
    const reads = r.read.mock.calls.length;
    const paints = r.paints();
    r.advance(RELATIVE_WORDS_REPAINT_MS - 1);
    expect(r.paints(), 'nothing before the interval').toBe(paints);
    r.advance(1);
    expect(r.paints(), 'one repaint at the interval').toBe(paints + 1);
    const after = r.controller.getSnapshot();
    expect(after, 'a new state: the frame is worded again from the clock').not.toBe(before);
    expect(after.snapshot, 'with the rows it had').toBe(before.snapshot);
    expect(after.parkedRuns).toBe(before.parkedRuns);
    expect(r.read, 'and no read').toHaveBeenCalledTimes(reads);
    expect(r.wordsTimers(), 'the next one is armed').toBe(1);
    r.advance(RELATIVE_WORDS_REPAINT_MS * 3);
    expect(r.paints()).toBe(paints + 4);
  });

  it('the interval is half a minute (the words change by the minute), and it is not the strip’s five seconds', () => {
    expect(RELATIVE_WORDS_REPAINT_MS).toBe(30_000);
    expect(RELATIVE_WORDS_REPAINT_MS).toBeGreaterThan(STRIP_REFRESH_MS);
  });

  it('a Home with no strip dependencies repaints too (the words do not depend on the database)', () => {
    const r = rig({ snapshot: withFailed });
    expect(r.stripTimers(), 'no strip port: no strip tick').toBe(0);
    expect(r.wordsTimers()).toBe(1);
  });
});

describe('the timer is cancelled when the idle landing or the work page is not what is in front', () => {
  it('an open palette (the `/` typed at the prompt), until it is closed again', () => {
    const r = rig({ snapshot: withFailed });
    r.controller.handleKey('/', {});
    expect(r.controller.getSnapshot().palette, 'the palette is open').toBeDefined();
    expect(r.wordsTimers()).toBe(0);
    const paints = r.paints();
    r.advance(RELATIVE_WORDS_REPAINT_MS * 3);
    expect(r.paints(), 'no repaint for the clock behind a palette').toBe(paints);
    back(r);
    expect(r.controller.getSnapshot().palette).toBeUndefined();
    expect(r.wordsTimers()).toBe(1);
  });

  it('a terminal below the floor, until it is big enough again', () => {
    const r = rig({ snapshot: withFailed });
    r.controller.setTerminalSize(70, 20);
    expect(r.wordsTimers()).toBe(0);
    r.controller.setTerminalSize(100, 30);
    expect(r.wordsTimers()).toBe(1);
  });
});

describe('a popup pauses the repaint and does not end it (MVP-11 unit 7, round 2: F4)', () => {
  it('a tick under a popup repaints nothing; once the popup has closed a tick still follows, with no key pressed', () => {
    const popup = { open: false };
    const r = rig({ snapshot: withFailed, popup });
    expect(r.wordsTimers()).toBe(1);
    popup.open = true; // a popup opened over the landing (the popup host's own state: the controller is not told)
    const paints = r.paints();
    r.advance(RELATIVE_WORDS_REPAINT_MS * 2);
    expect(r.paints(), 'no repaint for the clock behind a popup').toBe(paints);
    expect(r.wordsTimers(), 'the chain is kept while only a popup is in front').toBe(1);
    popup.open = false; // it closed; nothing in the controller changed
    r.advance(RELATIVE_WORDS_REPAINT_MS);
    expect(r.paints(), 'the words are worded again from the clock without a key').toBe(paints + 1);
    expect(r.wordsTimers()).toBe(1);
  });

  it('a state change while the popup is open keeps the chain too (the popup alone never cancels it)', () => {
    const popup = { open: false };
    const r = rig({ snapshot: withFailed, popup });
    popup.open = true;
    r.controller.setProviderState(false, 'a notice the host set under the popup');
    expect(r.wordsTimers()).toBe(1);
    popup.open = false;
    const paints = r.paints();
    r.advance(RELATIVE_WORDS_REPAINT_MS);
    expect(r.paints()).toBe(paints + 1);
  });
});

describe('a repaint that fails ends the Home, as the strip’s tick does', () => {
  it('a listener that throws on the tick is a fault of the Home: `onError` is told once, nothing is left scheduled, nothing throws out of the timer', () => {
    const r = rig({ snapshot: withFailed, faultsEndTheHome: true });
    r.controller.subscribe(() => {
      throw new Error('a listener fault');
    });
    expect(() => r.advance(RELATIVE_WORDS_REPAINT_MS)).not.toThrow();
    expect(r.onError).toHaveBeenCalledTimes(1);
    expect(r.wordsTimers()).toBe(0);
    r.advance(RELATIVE_WORDS_REPAINT_MS * 3);
    expect(r.onError).toHaveBeenCalledTimes(1);
  });
});

describe('no timer is left running after the Home ends', () => {
  it('Ctrl+D at the empty prompt', () => {
    const r = rig({ snapshot: withFailed });
    expect(r.wordsTimers()).toBe(1);
    r.controller.handleKey('d', { ctrl: true });
    expect(r.onExit).toHaveBeenCalledTimes(1);
    expect(r.wordsTimers()).toBe(0);
    const paints = r.paints();
    r.advance(RELATIVE_WORDS_REPAINT_MS * 4);
    expect(r.paints(), 'and nothing repaints afterwards').toBe(paints);
  });

  it('a signal (the teardown): and a later change of state does not arm it again', async () => {
    const r = rig({ snapshot: withFailed });
    expect(r.wordsTimers()).toBe(1);
    await r.controller.teardownActive();
    expect(r.wordsTimers()).toBe(0);
    r.controller.setTerminalSize(100, 30);
    r.controller.setProviderState(false);
    expect(r.wordsTimers(), 'a state change after the end arms nothing').toBe(0);
    const paints = r.paints();
    r.advance(RELATIVE_WORDS_REPAINT_MS * 4);
    expect(r.paints()).toBe(paints);
  });
});
