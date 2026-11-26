/**
 * The run this Home is executing is not one of the strip's parked runs
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §7).
 *
 * A resumed leg is read at its start boundary, while the log still says its run is `paused`: the run is not waiting on anyone while a leg
 * answers it, so its own Attention row must not read as parked, and must not take the `↓` focus, until the leg ends and the log is read
 * again. The controller filters the rows in two places (`parkedPatch`, which the landing coming back from a screen and the run host's state
 * changes both use, and the strip's idle tick), and both are pinned here through the real controller: the port still LISTS the run as
 * parked, because the log does say so, and the strip must not show it.
 *
 * The clock, the timer, the token, the run host and the reads are scripted: no database is opened and no engine is built.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ChangeToken } from '../../history/change-probe.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { ParkedRunRow } from './home-attention.js';
import {
  createHomeController,
  STRIP_REFRESH_MS,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import { stripRows } from './strip-focus.js';

const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const executing = (runId: string): RunHostSnapshot => ({
  launching: false,
  active: { leg: 'resume', runId, cancelling: false },
  last: undefined,
});

const P1: ParkedRunRow = { runId: 'parked-1', kind: 'approval', gates: 1 };
const P2: ParkedRunRow = { runId: 'parked-2', kind: 'approval', gates: 2 };
const P3: ParkedRunRow = { runId: 'parked-3', kind: 'budget', gates: 1 };

const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: false,
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};

/** A Home over a scripted run host, parked list, token and timer. `host` and `parked` are what the next read finds. */
function rig(initialParked: readonly ParkedRunRow[]) {
  let host: RunHostSnapshot = IDLE;
  let parked = initialParked;
  const token = { dataVersion: 1, generation: 0 };
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const list = vi.fn((): readonly ParkedRunRow[] => parked);
  const deps: HomeControllerDeps = {
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => EMPTY },
    hostedRuns: { snapshot: () => host, cancel: () => true, close: () => Promise.resolve() },
    gateCards: {
      list,
      read: () => undefined,
      resume: () => Promise.reject(new Error('nothing is answered here')),
    },
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
  };
  const controller = createHomeController(deps);
  return {
    controller,
    list,
    /** What the run host says from now on. */
    host: (next: RunHostSnapshot): void => {
      host = next;
    },
    /** What the log says is parked from now on. */
    log: (next: readonly ParkedRunRow[]): void => {
      parked = next;
    },
    moveToken: (): void => {
      token.generation += 1;
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
      }
      now = end;
      await settle();
    },
  };
}

const parkedIds = (controller: HomeController): string[] =>
  controller.getSnapshot().parkedRuns.map((row) => row.runId);
/** The runs the strip draws as parked, from the state the controller published (what `↓` walks over). */
const parkedStripIds = (controller: HomeController): string[] => {
  const state = controller.getSnapshot();
  return stripRows(state.parkedRuns, state.snapshot)
    .filter((row) => row.role === 'parked')
    .map((row) => row.id);
};

describe('the run a leg is executing is not a parked run of the strip', () => {
  it('when the landing comes back from a screen, the executing run is left out of the Attention rows and the other parked run stays', () => {
    const r = rig([P1, P2]);
    expect(parkedIds(r.controller), 'both are parked before any leg').toEqual([P1.runId, P2.runId]);

    expect(r.controller.openScreen('help')).toBe(true);
    // A leg answers P1 while the screen is in front: the log still lists it as parked, and the host says it is executing.
    r.host(executing(P1.runId));
    const readsBefore = r.list.mock.calls.length;
    r.controller.closeScreen();

    expect(r.list.mock.calls.length, 'the log was read again on the way back').toBeGreaterThan(
      readsBefore,
    );
    expect(r.list.mock.results.at(-1)?.value, 'and the log still says P1 is parked').toContain(P1);
    expect(
      parkedIds(r.controller),
      'the strip does not list the run this Home is executing',
    ).toEqual([P2.runId]);
    expect(parkedStripIds(r.controller), 'and the `↓` walk does not reach it').toEqual([P2.runId]);
  });

  it('on the idle tick, a read that still lists the executing run as parked does not put it on the strip', async () => {
    const r = rig([P1, P2]);
    r.host(executing(P1.runId));
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS);

    expect(r.list, 'the tick read the log').toHaveBeenCalledTimes(2);
    expect(r.list.mock.results.at(-1)?.value, 'and the log still says P1 is parked').toContain(P1);
    expect(parkedIds(r.controller)).toEqual([P2.runId]);
    expect(parkedStripIds(r.controller)).toEqual([P2.runId]);
  });

  it('on the idle tick, only the executing run is left out: a run another terminal parked meanwhile is shown', async () => {
    const r = rig([P1]);
    r.host(executing(P1.runId));
    r.log([P1, P2, P3]);
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS);
    expect(parkedIds(r.controller)).toEqual([P2.runId, P3.runId]);
  });

  it('a leg executing a run that is not parked takes nothing off the strip', async () => {
    const r = rig([P1, P2]);
    r.host(executing('some-other-run'));
    r.log([P1, P2, P3]);
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS);
    expect(parkedIds(r.controller)).toEqual([P1.runId, P2.runId, P3.runId]);
  });

  it('with no leg executing, the run is parked again when the landing comes back', () => {
    const r = rig([P1, P2]);
    r.controller.openScreen('help');
    r.host(executing(P1.runId));
    r.controller.closeScreen();
    expect(parkedIds(r.controller)).toEqual([P2.runId]);

    // The leg ended and the run is parked at its next gate: the log says so, and nothing hides it any more.
    r.controller.openScreen('help');
    r.host(IDLE);
    r.controller.closeScreen();
    expect(parkedIds(r.controller)).toEqual([P1.runId, P2.runId]);
  });
});
