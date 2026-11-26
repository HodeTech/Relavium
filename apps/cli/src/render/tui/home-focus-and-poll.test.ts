/**
 * Two small promises of the Home controller that a review found broken, through the real controller with scripted ports.
 *
 * 1. **The `Enter` after a dropped focus is ignored once, and only where the person was looking at the strip.** A refresh that takes the
 *    focused strip row away while the landing is in front means the person's `Enter` was meant for that row, so the first one after it
 *    is ignored (ADR-0140 §6). It was also set when the row left behind a screen: a person who answered a gate on its card and pressed `Esc`
 *    had the first `Enter` at the landing swallowed, with no time or frame bound.
 * 2. **The Active tab's poll reads nothing while a native question or form holds the keyboard** (ADR-0140 §2: paused while a card is open),
 *    as the strip's own tick does.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ActiveRead } from '../../history/active-source.js';
import { classifyActiveRuns } from '../../history/active-model.js';
import { ACTIVE_POLL_MS } from '../../history/active-poll.js';
import type { ChangeToken } from '../../history/change-probe.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { HostedLaunch, RunHostSnapshot } from '../../home/run-host.js';
import type { ParkedRunRow } from './home-attention.js';
import { createHomeController, STRIP_REFRESH_MS, type HomeController } from './home-controller.js';

const RUN = 'run-0001';
const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: false,
};
const SESSION: HomeSnapshot = {
  ...EMPTY,
  recentSessions: [
    {
      sessionId: 's1',
      title: undefined,
      agentSlug: 'chat',
      modelId: undefined,
      status: 'ended',
      updatedAt: '2026-11-23T00:00:00.000Z',
      totalCostMicrocents: 0,
    },
  ],
  totals: { attention: 0, sessions: 1, runs: 0 },
};
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const executing = (runId: string): RunHostSnapshot => ({
  launching: false,
  active: { leg: 'resume', runId, cancelling: false },
  last: undefined,
});
const DOWN = { downArrow: true } as const;
const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const PARKED: ParkedRunRow = { runId: RUN, kind: 'approval', gates: 1 };
const APPROVAL: RunGates = {
  runId: RUN,
  workflowId: 'wf',
  gates: [
    {
      runId: RUN,
      gateId: 'g1',
      nodeId: 'review',
      gateType: 'approval',
      message: 'Ship it?',
      accepts: ['approved', 'rejected'],
    },
  ],
  budgetGates: [],
  degraded: false,
};
const STARTED: HostedLaunch = {
  kind: 'started',
  leg: 'resume',
  runId: RUN,
  ended: new Promise(() => undefined),
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
};

/** A scripted clock and timers, and the move of time that fires them in order. */
function clock() {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: (): number => now,
    schedule: (run: () => void, delayMs: number): (() => void) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: now + delayMs, run });
      return () => {
        timers.delete(id);
      };
    },
    advance: async (ms: number): Promise<void> => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].run();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

describe('the Enter after a refresh dropped the focused row', () => {
  function rig(options: {
    readonly parked?: readonly ParkedRunRow[];
    readonly snapshot?: HomeSnapshot;
    readonly host?: RunHostSnapshot;
  }) {
    const time = clock();
    let host = options.host ?? IDLE;
    let parked = options.parked ?? [];
    let shown = options.snapshot ?? EMPTY;
    const token = { dataVersion: 1, generation: 0 };
    const replies: ((launch: HostedLaunch) => void)[] = [];
    const resume = vi.fn(
      () =>
        new Promise<HostedLaunch>((resolve) => {
          replies.push(resolve);
        }),
    );
    const controller = createHomeController({
      startChat: () => new Promise(() => {}),
      homeStore: { read: () => shown },
      hostedRuns: { snapshot: () => host, cancel: () => true, close: () => Promise.resolve() },
      gateCards: {
        list: () => parked,
        read: () => APPROVAL,
        resume,
        guard: { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 },
      },
      strip: { token: (): ChangeToken => ({ ...token }), isClosed: () => false },
      schedule: time.schedule,
      now: time.now,
      onExit: () => {},
      onError: (cause) => {
        throw cause;
      },
    });
    // The host's evidence that the card's frame is on screen: the card answers only then.
    controller.bindGateCardFrame(() => true);
    return {
      controller,
      time,
      resume,
      /** The host starts the leg that carries the answer, and the log no longer lists the run as parked. */
      replyStarted: async (): Promise<void> => {
        host = executing(RUN);
        parked = [];
        for (const reply of replies.splice(0)) reply(STARTED);
        await settle();
      },
      /** Another terminal changed the strip: the next tick reads it. */
      anotherTerminalShows: (next: HomeSnapshot): void => {
        shown = next;
        token.generation += 1;
      },
    };
  }

  it('is not swallowed when the host answers a gate after its card was left: the person answered it, and knows the row has gone', async () => {
    const r = rig({ parked: [PARKED] });
    r.controller.handleKey('', DOWN);
    expect(r.controller.getSnapshot().stripFocus).toEqual({ kind: 'run', id: RUN });
    r.controller.handleKey('', ENTER);
    expect(r.controller.getSnapshot().screen?.kind).toBe('gate-card');
    r.controller.handleKey('y', { ctrl: true });
    await settle();
    expect(r.resume).toHaveBeenCalledOnce();
    // The host is still preparing the leg: the person leaves the card, and the landing is in front.
    r.controller.handleKey('', ESC);
    expect(r.controller.getSnapshot().screen, 'the card is closed').toBeUndefined();
    expect(r.controller.getSnapshot().stripFocus, 'the row they answered is still focused').toEqual(
      {
        kind: 'run',
        id: RUN,
      },
    );
    // The leg starts, the row leaves the strip and the focus with it: nobody was looking at a row somebody else removed.
    await r.replyStarted();
    expect(r.controller.getSnapshot().parkedRuns).toEqual([]);
    expect(r.controller.getSnapshot().stripFocus).toBeUndefined();
    // The first `Enter` is the prompt's own: it brings back the view of the run that executes.
    r.controller.handleKey('', ENTER);
    expect(r.controller.getSnapshot().screen).toMatchObject({ kind: 'run-view', runId: RUN });
  });

  it('is still ignored once when a refresh of what another terminal changed took the row away under the landing', async () => {
    const r = rig({ snapshot: SESSION, host: executing('hosted-run') });
    r.controller.handleKey('', DOWN);
    expect(r.controller.getSnapshot().stripFocus).toEqual({ kind: 'session', id: 's1' });
    r.anotherTerminalShows(EMPTY);
    await r.time.advance(STRIP_REFRESH_MS);
    expect(r.controller.getSnapshot().stripFocus, 'the focus went with its row').toBeUndefined();
    r.controller.handleKey('', ENTER);
    expect(
      r.controller.getSnapshot().screen,
      'the Enter was meant for the row: it does not open the view of the run that executes',
    ).toBeUndefined();
    r.controller.handleKey('', ENTER);
    expect(r.controller.getSnapshot().screen).toMatchObject({ kind: 'run-view' });
  });

  it('ends when a screen opens and closes after the drop: the first key back at the landing is the landing`s own', async () => {
    const r = rig({ snapshot: SESSION, host: executing('hosted-run') });
    r.controller.handleKey('', DOWN);
    r.anotherTerminalShows(EMPTY);
    await r.time.advance(STRIP_REFRESH_MS);
    expect(r.controller.getSnapshot().stripFocus).toBeUndefined();
    expect(r.controller.openScreen('help')).toBe(true);
    r.controller.closeScreen();
    r.controller.handleKey('', ENTER);
    expect(r.controller.getSnapshot().screen).toMatchObject({ kind: 'run-view' });
  });
});

describe('the Active tab`s poll while a native question holds the keyboard', () => {
  const HERE = '/work/here';
  const NOW = 1_000_000;
  const MEDIA_RUN: RunGates = {
    runId: 'media-run',
    workflowId: 'wf',
    gates: [],
    budgetGates: [],
    pendingMediaJobNodeIds: ['image-node'],
    degraded: false,
  };

  function activeRig() {
    const time = clock();
    const token = { dataVersion: 1, generation: 0 };
    const rows = classifyActiveRuns({
      runs: [
        {
          id: 'media-run',
          workflowId: 'wf',
          status: 'paused',
          executionMode: 'local',
          triggerType: 'manual',
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCostMicrocents: 0,
          createdAt: '2026-11-23T00:00:00.000Z',
          updatedAt: '2026-11-23T00:00:00.000Z',
          projectRoot: HERE,
        },
      ],
      leases: new Map(),
      currentProjectRoot: HERE,
      outboxHeldRunIds: new Set(),
      nowMs: NOW,
      leaseTtlMs: 60_000,
      pendingGateCounts: new Map([['media-run', 0]]),
      pendingMediaJobCounts: new Map([['media-run', 1]]),
    });
    const read = vi.fn(
      (): Promise<ActiveRead> => Promise.resolve({ rows, more: [], heldUnread: false }),
    );
    let release: (notice: string | undefined) => void = () => undefined;
    const continueMedia = vi.fn(
      () =>
        new Promise<string | undefined>((resolve) => {
          release = resolve;
        }),
    );
    const controller = createHomeController({
      startChat: () => new Promise(() => {}),
      homeStore: { read: () => EMPTY },
      active: { token: (): ChangeToken => ({ ...token }), read, isClosed: () => false },
      hostedRuns: { snapshot: () => IDLE, cancel: () => true, close: () => Promise.resolve() },
      gateCards: {
        list: () => [],
        read: () => MEDIA_RUN,
        resume: () => Promise.reject(new Error('unused')),
      },
      continueMedia,
      schedule: time.schedule,
      now: time.now,
      onExit: () => {},
      onError: (cause) => {
        throw cause;
      },
    });
    return {
      controller,
      time,
      read,
      continueMedia,
      release: (notice?: string): void => release(notice),
      moveToken: (): void => {
        token.generation += 1;
      },
    };
  }
  const press = (
    controller: HomeController,
    key: Parameters<HomeController['handleKey']>[1],
  ): void => {
    controller.handleKey('', key);
  };

  it('reads nothing while the question is open, and reads again once it is answered', async () => {
    const a = activeRig();
    expect(a.controller.openScreen('tab-host', { tab: 'active' })).toBe(true);
    await settle();
    expect(a.read, 'one read when the tab was entered').toHaveBeenCalledTimes(1);

    // `Enter` on the paused row that waits for media jobs asks whether to continue it: a native question, which holds the keyboard.
    press(a.controller, ENTER);
    await settle();
    expect(a.continueMedia).toHaveBeenCalledOnce();
    expect(a.controller.getSnapshot().nativeActionBusy).toBe(true);

    a.moveToken();
    await a.time.advance(ACTIVE_POLL_MS * 6);
    expect(
      a.read,
      'the token moved six ticks ago, and nothing was read while the question is open',
    ).toHaveBeenCalledTimes(1);

    a.release(undefined);
    await settle();
    expect(a.controller.getSnapshot().nativeActionBusy).toBe(false);
    await a.time.advance(ACTIVE_POLL_MS);
    expect(a.read, 'the question is answered: the tab reads what moved').toHaveBeenCalledTimes(2);
  });
});
