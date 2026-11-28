/**
 * `Enter` on the row of a run whose log cannot be read, through the real Home controller (MVP-11 unit 7): it hands the card's opener the run the
 * snapshot holds under the row's ID, never the run at its position, never another run's, and nothing when the row is gone. The card itself is
 * `popups/unreadable-run-card.test.ts`; its hosts are `popups/unreadable-run-hosts.test.tsx`. The clock, the timer, the token and the reads are
 * scripted: no database is opened and time moves only when a test says so.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ChangeToken } from '../../history/change-probe.js';
import type { HomeSnapshot, HomeUnreadableRun } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import {
  createHomeController,
  STRIP_REFRESH_MS,
  type HomeChatSession,
  type HomeController,
} from './home-controller.js';

const DOWN = { downArrow: true } as const;
const ENTER = { return: true } as const;
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };

const unreadable = (runId: string, over: Partial<HomeUnreadableRun> = {}): HomeUnreadableRun => ({
  runId,
  workflowSlug: `flow-${runId}`,
  status: 'failed',
  createdAt: '2026-11-23T00:00:00.000Z',
  reason: 'corrupt-row',
  ...over,
});

const snapshotOf = (
  unreadableRuns: readonly HomeUnreadableRun[],
  failed: readonly string[] = [],
): HomeSnapshot => ({
  failedRuns: failed.map((runId) => ({
    runId,
    workflowSlug: 'wf',
    status: 'failed',
    createdAt: '2026-11-23T00:00:00.000Z',
    startedAt: undefined,
    completedAt: undefined,
    totalCostMicrocents: 0,
  })),
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns,
  totals: { attention: unreadableRuns.length + failed.length, sessions: 0, runs: 0 },
  isEmpty: false,
});

interface RigOptions {
  readonly snapshot: HomeSnapshot;
  /** Whether the card's opener is wired (default yes). */
  readonly wired?: boolean;
}

function rig(options: RigOptions) {
  let current = options.snapshot;
  const token = { dataVersion: 1, generation: 0 };
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const opened = vi.fn((request: { readonly run: HomeUnreadableRun }) => request);
  const controller = createHomeController({
    startChat: () => new Promise<HomeChatSession>(() => {}),
    homeStore: { read: () => current },
    hostedRuns: { snapshot: () => IDLE, cancel: () => true, close: () => Promise.resolve() },
    ...(options.wired === false ? {} : { openUnreadableRun: opened }),
    strip: { token: (): ChangeToken => ({ ...token }), isClosed: () => false },
    schedule: (run, delayMs) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: now + delayMs, run });
      return () => {
        timers.delete(id);
      };
    },
    now: () => now,
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
  return {
    controller,
    opened,
    /** Another process wrote: the strip reads the next snapshot at its next tick. */
    refreshTo: async (next: HomeSnapshot): Promise<void> => {
      current = next;
      token.generation += 1;
      const end = now + STRIP_REFRESH_MS;
      for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > end) continue;
        timers.delete(id);
        now = Math.max(now, timer.at);
        timer.run();
      }
      now = end;
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    },
  };
}

const press = (controller: HomeController, key: object, times = 1): void => {
  for (let n = 0; n < times; n += 1) controller.handleKey('', key);
};
const focusOf = (controller: HomeController) => controller.getSnapshot().stripFocus;

describe('Enter on an unreadable run’s row opens its card', () => {
  it('hands over the run the snapshot holds under the row’s id: the first row’s run on the first row, the second’s on the second', () => {
    const first = unreadable('u1', { reason: 'newer-version' });
    const second: HomeUnreadableRun = { runId: 'u2', reason: 'could-not-read' };
    const r = rig({ snapshot: snapshotOf([first, second]) });

    press(r.controller, DOWN);
    expect(focusOf(r.controller)?.id).toBe('u1');
    press(r.controller, ENTER);
    expect(r.opened).toHaveBeenCalledTimes(1);
    expect(r.opened.mock.calls[0]?.[0].run).toBe(first);

    press(r.controller, DOWN);
    expect(focusOf(r.controller)?.id).toBe('u2');
    press(r.controller, ENTER);
    expect(r.opened).toHaveBeenCalledTimes(2);
    expect(r.opened.mock.calls[1]?.[0].run).toBe(second);
  });

  it('changes nothing of the Home: the page and the focus stay, no notice is written, no screen opens', () => {
    const r = rig({ snapshot: snapshotOf([unreadable('u1'), unreadable('u2')]) });
    press(r.controller, DOWN, 2);
    const focus = focusOf(r.controller);
    press(r.controller, ENTER);
    const after = r.controller.getSnapshot();
    expect(focusOf(r.controller)).toBe(focus);
    expect(after.homePage).toBe('work');
    expect(after.notice).toBeUndefined();
    expect(after.screen).toBeUndefined();
  });

  it('the run is found by its id after a refresh moved its row: a run listed above it never takes its place', async () => {
    const r = rig({ snapshot: snapshotOf([unreadable('u1'), unreadable('u2')]) });
    press(r.controller, DOWN, 2);
    expect(focusOf(r.controller)?.id).toBe('u2');
    const added = unreadable('u0');
    await r.refreshTo(
      snapshotOf([added, unreadable('u1'), unreadable('u2', { reason: 'newer-version' })]),
    );
    expect(focusOf(r.controller)?.id, 'the focus is the run, not the position').toBe('u2');
    press(r.controller, ENTER);
    expect(r.opened).toHaveBeenCalledTimes(1);
    expect(r.opened.mock.calls[0]?.[0].run).toMatchObject({
      runId: 'u2',
      reason: 'newer-version',
    });
  });

  it('opens nothing for a run that left the list: the focus is dropped, and the Enter that was meant for it opens no other run’s card', async () => {
    const r = rig({ snapshot: snapshotOf([unreadable('u1'), unreadable('u2')]) });
    press(r.controller, DOWN, 2);
    expect(focusOf(r.controller)?.id).toBe('u2');
    await r.refreshTo(snapshotOf([unreadable('u1')]));
    expect(focusOf(r.controller), 'the row is gone, and the focus with it').toBeUndefined();
    press(r.controller, ENTER);
    expect(r.opened).not.toHaveBeenCalled();
  });

  it('is the only row of its kind that does this: a failed run’s Enter never calls the opener', () => {
    const r = rig({ snapshot: snapshotOf([], ['f1']) });
    press(r.controller, DOWN);
    expect(focusOf(r.controller)?.id).toBe('f1');
    press(r.controller, ENTER);
    expect(r.opened).not.toHaveBeenCalled();
  });

  it('on a Home with no card to open says so, once, and opens nothing', () => {
    const r = rig({ snapshot: snapshotOf([unreadable('u1')]), wired: false });
    press(r.controller, DOWN);
    press(r.controller, ENTER);
    expect(r.controller.getSnapshot().notice).toBe(
      'That run cannot be shown here. Nothing was opened.',
    );
    expect(focusOf(r.controller)?.id, 'the focus stays on the row').toBe('u1');
  });
});
