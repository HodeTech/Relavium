/**
 * The exit guard says when its lockout holds `Ctrl+Y` (MVP-11 unit 8; ADR-0145 §3, the `(wait)` rule unit 6 built for the popups): its lockout
 * runs from the card's appearance (a held key's first repeat never stops the run), and its legend reads `[Ctrl+Y] stop the run and leave (wait)`
 * until the lock opens, then flips once. The display is the controller's `exitGuardLock`, a value beside its state, never a field of it, and its
 * one timer is its own seam (`lockSchedule`): the Home's `schedule` (the run watch, the grace) gains no timer from it.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { RootApp } from './home-app.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { settleFrames, waitFor, withoutStyles } from './harness-util.js';
import { exitGuardLines } from './home-projection.js';
import { APPROVAL_LOCKOUT_MS } from './tool-review-model.js';

afterEach(cleanup);

const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const RUNNING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-0001', cancelling: false },
  last: undefined,
};
const CTRL = { ctrl: true } as const;

function rig() {
  let t = 1_000;
  const homeTimers: number[] = [];
  const lockTimers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const cancel = vi.fn((): boolean => true);
  const controller = createHomeController({
    startChat: () => new Promise<HomeChatSession>(() => {}),
    homeStore: { read: () => EMPTY },
    hostedRuns: { snapshot: () => RUNNING, cancel, close: () => Promise.resolve() },
    schedule: (_run, delayMs) => {
      homeTimers.push(delayMs);
      return () => {};
    },
    lockSchedule: (run, delayMs) => {
      const timer = { at: t + delayMs, run, cancelled: false };
      lockTimers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    now: () => t,
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
  });
  controller.bindHomeFrame(() => true);
  /** Move the guard's clock to `at` and fire the lock display's timers that are due. */
  const to = (at: number): void => {
    t = at;
    for (const timer of lockTimers.filter((x) => !x.cancelled && x.at <= at)) {
      timer.cancelled = true;
      timer.run();
    }
  };
  return {
    controller,
    cancel,
    to,
    now: () => t,
    homeTimers,
    liveLockTimers: () => lockTimers.filter((x) => !x.cancelled).length,
  };
}

describe('the exit guard’s (wait)', () => {
  it('holds from the card’s appearance, flips once at the end, and touches neither the state nor the Home’s timers', () => {
    const r = rig();
    r.controller.handleKey('d', CTRL);
    expect(r.controller.getSnapshot().exitGuard).toBe('confirm');
    expect(r.controller.exitGuardLock.read(), 'the card has just appeared').toBe(true);
    expect(r.liveLockTimers(), 'one timer, on its own seam').toBe(1);
    const homeTimers = r.homeTimers.length;
    const state = r.controller.getSnapshot();
    let flips = 0;
    r.controller.exitGuardLock.subscribe(() => {
      flips += 1;
    });
    r.to(1_000 + APPROVAL_LOCKOUT_MS - 1);
    expect(r.controller.exitGuardLock.read()).toBe(true);
    r.to(1_000 + APPROVAL_LOCKOUT_MS);
    expect(r.controller.exitGuardLock.read(), 'open at the instant').toBe(false);
    expect(flips, 'one repaint').toBe(1);
    expect(r.controller.getSnapshot(), 'the lock is no field of the state').toBe(state);
    expect(r.homeTimers.length, 'the Home’s own timers gained nothing').toBe(homeTimers);
    r.controller.handleKey('y', CTRL);
    expect(r.controller.getSnapshot().exitGuard, 'a deliberate press after it counts').toBe(
      'stopping',
    );
  });

  it('a held Ctrl+Y never stops the run, and the (wait) holds while it is held', () => {
    const r = rig();
    r.controller.handleKey('d', CTRL);
    for (let at = 1_300; at <= 4_300; at += 300) {
      r.to(at);
      r.controller.handleKey('y', CTRL);
      expect(r.controller.getSnapshot().exitGuard, `refused at ${String(at)}`).toBe('confirm');
      expect(r.controller.exitGuardLock.read(), `still waiting at ${String(at)}`).toBe(true);
    }
    expect(r.cancel).not.toHaveBeenCalled();
    r.to(4_300 + APPROVAL_LOCKOUT_MS);
    expect(r.controller.exitGuardLock.read(), 'one lockout after the last repeat').toBe(false);
  });

  it('a card that is closed holds no key', () => {
    const r = rig();
    r.controller.handleKey('d', CTRL);
    r.controller.handleKey('n', CTRL);
    expect(r.controller.getSnapshot().exitGuard).toBeUndefined();
    expect(r.controller.exitGuardLock.read()).toBe(false);
  });

  it('the legend marks every Ctrl+Y the card offers', () => {
    expect(exitGuardLines('confirm', RUNNING, 15, true).at(-1)).toBe(
      '[Ctrl+Y] stop the run and leave (wait) · Esc / [Ctrl+C] / [Ctrl+N] stay',
    );
    expect(exitGuardLines('confirm', RUNNING, 15, false).at(-1)).toBe(
      '[Ctrl+Y] stop the run and leave · Esc / [Ctrl+C] / [Ctrl+N] stay',
    );
    const cancelling = {
      ...RUNNING,
      active: { ...RUNNING.active, cancelling: true },
    } as RunHostSnapshot;
    expect(exitGuardLines('confirm', cancelling, 15, true).at(-1)).toMatch(
      /\(about 15s\) \(wait\)/u,
    );
    expect(exitGuardLines('confirm', undefined, 15, true).at(-1)).toMatch(
      /^\[Ctrl\+Y\] leave the Home \(wait\)/u,
    );
  });
});

describe('the (wait) keeps the way back (unit 8 fix wave, S-2, S-11; ADR-0145 §2)', () => {
  const CANCELLING: RunHostSnapshot = {
    ...RUNNING,
    active: { leg: 'start', runId: 'run-0001', cancelling: true },
  };

  it('a run that is stopping: the bound gives way to `(wait)`, `[Ctrl+N] stay` is never cut', () => {
    const locked = exitGuardLines('confirm', CANCELLING, 13, true, 72).at(-1) ?? '';
    expect(locked).toBe('[Ctrl+Y] leave once it stops (wait) · Esc / [Ctrl+C] / [Ctrl+N] stay');
    // Where it fits the bound stays (the other three legends fit 72 whole, locked or not).
    expect(exitGuardLines('confirm', CANCELLING, 13, false, 80).at(-1)).toBe(
      '[Ctrl+Y] leave once it stops (about 13s) · Esc / [Ctrl+C] / [Ctrl+N] stay',
    );
    // At 80 columns the card's rule is 72 wide (the Home's 74-column content less its two), one short of the unlocked line: the bound gives
    // way there too (the confirmed exit's `stopping` row still says it).
    expect(exitGuardLines('confirm', CANCELLING, 13, false, 72).at(-1)).toBe(
      '[Ctrl+Y] leave once it stops · Esc / [Ctrl+C] / [Ctrl+N] stay',
    );
    expect(exitGuardLines('confirm', RUNNING, 13, true, 72).at(-1)).toBe(
      '[Ctrl+Y] stop the run and leave (wait) · Esc / [Ctrl+C] / [Ctrl+N] stay',
    );
    expect(exitGuardLines('confirm', undefined, 13, true, 72).at(-1)).toBe(
      '[Ctrl+Y] leave the Home (wait) · Esc / [Ctrl+C] / [Ctrl+N] stay',
    );
  });

  it.each([80, 100])(
    'drawn at %i columns, locked and then open: the card’s rows end where its rule ends, and the way back is whole',
    async (cols) => {
      let t = 1_000;
      let fire: (() => void) | undefined;
      // A run id long enough that the title row would run past the rule unless it is fitted to it.
      const LONG_ID: RunHostSnapshot = {
        ...CANCELLING,
        active: { leg: 'start', runId: `run-${'7'.repeat(70)}`, cancelling: true },
      };
      const controller = createHomeController({
        startChat: () => new Promise<HomeChatSession>(() => {}),
        homeStore: { read: () => EMPTY },
        hostedRuns: {
          snapshot: () => LONG_ID,
          cancel: () => true,
          close: () => Promise.resolve(),
        },
        schedule: () => () => {},
        lockSchedule: (run) => {
          fire = run;
          return () => {
            fire = undefined;
          };
        },
        now: () => t,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      const harness = render(
        <RootApp
          controller={controller}
          nowMs={() => 0}
          color={false}
          getSize={() => ({ cols, rows: 24 })}
          subscribeResize={() => () => {}}
        />,
      );
      await settleFrames();
      harness.stdin.write('\u0004'); // Ctrl+D
      await waitFor(() => (harness.lastFrame() ?? '').includes('(wait)'));
      const cardRows = (): readonly string[] => {
        const rows = withoutStyles(harness.lastFrame() ?? '').split('\n');
        const rule = rows.findIndex((row) => row.includes('== Leaving the Home'));
        expect(rule, rows.join('\n')).toBeGreaterThanOrEqual(0);
        const end = rows[rule]?.length ?? 0;
        // The Home's sheets end two columns short of the terminal's edge (the run card's `columns − 2`): so does this one (M-12 X05).
        expect(end, 'the rule ends at the Home sheets’ right edge').toBe(cols - 2);
        const card = rows.slice(rule + 1).filter((row) => row.trim() !== '');
        expect(card.at(-1), 'the way back whole').toMatch(/\[Ctrl\+N\] stay$/u);
        for (const row of card)
          expect(row.length, `ends inside the rule: ${row}`).toBeLessThanOrEqual(end);
        return card;
      };
      expect(cardRows().at(-1)).toContain('(wait)');
      t += APPROVAL_LOCKOUT_MS;
      fire?.();
      await waitFor(() => !(harness.lastFrame() ?? '').includes('(wait)'));
      expect(cardRows().at(-1)).toMatch(/^\s*\[Ctrl\+Y\] leave once it stops/u);
    },
  );
});

describe('on the drawn Home', () => {
  it('the card says (wait) on its Ctrl+Y, and flips once the lock opens', async () => {
    let t = 1_000;
    let fire: (() => void) | undefined;
    const controller = createHomeController({
      startChat: () => new Promise<HomeChatSession>(() => {}),
      homeStore: { read: () => EMPTY },
      hostedRuns: { snapshot: () => RUNNING, cancel: () => true, close: () => Promise.resolve() },
      schedule: () => () => {},
      lockSchedule: (run) => {
        fire = run;
        return () => {
          fire = undefined;
        };
      },
      now: () => t,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    const harness = render(
      <RootApp
        controller={controller}
        nowMs={() => 0}
        color={false}
        getSize={() => ({ cols: 80, rows: 24 })}
        subscribeResize={() => () => {}}
      />,
    );
    await settleFrames();
    harness.stdin.write('\u0004'); // Ctrl+D
    await waitFor(() => (harness.lastFrame() ?? '').includes('stop the run and leave (wait)'));
    expect(withoutStyles(harness.lastFrame() ?? '')).toContain(
      '[Ctrl+Y] stop the run and leave (wait)',
    );
    t += APPROVAL_LOCKOUT_MS;
    fire?.();
    await waitFor(() => !(harness.lastFrame() ?? '').includes('(wait)'));
    expect(withoutStyles(harness.lastFrame() ?? '')).toContain(
      '[Ctrl+Y] stop the run and leave · Esc',
    );
  });
});
