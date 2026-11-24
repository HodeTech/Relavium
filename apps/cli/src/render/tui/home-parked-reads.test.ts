/**
 * When the Home re-reads its parked runs
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §7).
 *
 * The Attention rows come from the project's log (a database page per read), so the controller reads them when something that changes
 * them happened: a leg started or ended, a card opened or closed, the landing came back. A flip in how the SAME leg is described (a cancel
 * was requested, the engine named the run, the launch latch changed) is not one of those, and reads nothing. The run host and the clock
 * are scripted; no engine is built and no operator home is read.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { HostedLegEnd, RunHostSnapshot } from '../../home/run-host.js';
import type { ParkedRunRow } from './home-attention.js';
import { createHomeController } from './home-controller.js';
import { HOSTED_RUN_POLL_MS } from './tui-constants.js';

const RUN = 'run-0001';
const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const PREPARING: RunHostSnapshot = { launching: true, active: undefined, last: undefined };
const NAMED: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: RUN, cancelling: false },
  last: undefined,
};
const CANCELLING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: RUN, cancelling: true },
  last: undefined,
};
const END: HostedLegEnd = {
  leg: 'start',
  runId: RUN,
  terminal: {
    disposition: 'paused',
    safety: undefined,
    headline: `Run ${RUN} is paused.`,
    remedy: undefined,
  },
  handedOff: true,
  retirement: 'retired',
  fault: undefined,
};
const ENDED: RunHostSnapshot = { launching: false, active: undefined, last: END };
const ROW: ParkedRunRow = { runId: RUN, kind: 'approval', gates: 1 };

function rig(initial: RunHostSnapshot) {
  let host = initial;
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  const list = vi.fn((): readonly ParkedRunRow[] => [ROW]);
  const controller = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => EMPTY },
    hostedRuns: {
      snapshot: () => host,
      cancel: () => {
        if (host.active !== undefined)
          host = { ...host, active: { ...host.active, cancelling: true } };
        return true;
      },
      close: () => Promise.resolve(),
    },
    gateCards: { list, read: () => undefined, resume: () => Promise.reject(new Error('unused')) },
    schedule: (run, delayMs) => {
      next += 1;
      const id = next;
      pending.set(id, { at: now + delayMs, run });
      return () => pending.delete(id);
    },
    onExit: vi.fn(),
    onError: vi.fn((cause: unknown) => {
      throw cause;
    }),
  });
  return {
    controller,
    list,
    set: (snapshot: RunHostSnapshot): void => {
      host = snapshot;
    },
    poll: (): void => {
      now += HOSTED_RUN_POLL_MS;
      for (const [id, entry] of [...pending]) {
        if (entry.at > now) continue;
        pending.delete(id);
        entry.run();
      }
    },
  };
}

describe('the parked rows are read when a leg starts or ends, not on every flip of how it is described', () => {
  it('reads once when the Home is built, and not for a poll that finds nothing new', () => {
    const r = rig(NAMED);
    expect(r.list).toHaveBeenCalledTimes(1);
    expect(r.controller.openScreen('run-view', { runId: RUN })).toBe(true);
    for (let poll = 0; poll < 5; poll += 1) r.poll();
    expect(r.list, 'the same leg, the same state: nothing to read').toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the engine named the run', PREPARING, NAMED],
    ['the stop was requested', NAMED, CANCELLING],
  ] as const)('reads nothing when %s: the leg is the same live leg', (_why, before, after) => {
    const r = rig(before);
    r.controller.openScreen('run-view', { runId: RUN });
    expect(r.controller.getSnapshot().hostedRun).toBe(before);
    r.set(after);
    r.poll();
    expect(r.controller.getSnapshot().hostedRun, 'the strip followed it').toBe(after);
    expect(r.list, 'but the log did not change').toHaveBeenCalledTimes(1);
  });

  it('reads when the leg ends', () => {
    const r = rig(NAMED);
    r.controller.openScreen('run-view', { runId: RUN });
    r.set(ENDED);
    r.poll();
    expect(r.list).toHaveBeenCalledTimes(2);
    expect(r.controller.getSnapshot().parkedRuns).toEqual([ROW]);
  });

  it('reads when one leg ended and the next began between two polls: live both times, but not the same leg', () => {
    const r = rig(NAMED);
    r.controller.openScreen('run-view', { runId: RUN });
    r.set({
      launching: false,
      active: { leg: 'resume', runId: RUN, cancelling: false },
      last: END,
    });
    r.poll();
    expect(r.list).toHaveBeenCalledTimes(2);
  });
});

describe('the run a leg is executing is not parked', () => {
  const RESUMING_PREPARING: RunHostSnapshot = {
    launching: true,
    active: { leg: 'resume', runId: undefined, cancelling: false },
    last: END,
  };
  const RESUMING: RunHostSnapshot = {
    launching: false,
    active: { leg: 'resume', runId: RUN, cancelling: false },
    last: END,
  };
  const SETTLED_AGAIN: RunHostSnapshot = { launching: false, active: undefined, last: { ...END } };

  it('drops the run from the Attention rows while a resumed leg executes it, though the log still says paused, and brings it back when the leg ends', () => {
    const r = rig(PREPARING);
    r.controller.openScreen('run-view', { runId: RUN }); // reads the host, so the poll that follows is watching it
    expect(r.controller.getSnapshot().parkedRuns, 'the log lists the run').toEqual([ROW]);
    r.set(RESUMING); // the leg began and the engine named the run between two polls: one boundary, one read
    r.poll();
    expect(r.list, 'the boundary read the log').toHaveBeenCalledTimes(2);
    expect(
      r.controller.getSnapshot().parkedRuns,
      'the log still lists the run, but a leg is answering it: it is not waiting',
    ).toEqual([]);
    r.set(SETTLED_AGAIN);
    r.poll();
    expect(r.controller.getSnapshot().parkedRuns, 'the leg ended parked again').toEqual([ROW]);
  });

  it('drops the row when the engine names the run AFTER the start boundary, with no second read of the log', () => {
    const r = rig(RESUMING_PREPARING);
    r.controller.openScreen('run-view', { runId: RUN });
    expect(
      r.controller.getSnapshot().parkedRuns,
      'the run is not named yet: the row is still the log`s',
    ).toEqual([ROW]);
    const reads = r.list.mock.calls.length;
    r.set(RESUMING);
    r.poll();
    expect(r.controller.getSnapshot().parkedRuns).toEqual([]);
    expect(r.list.mock.calls.length, 'naming the run is not a change of the log: no read').toBe(
      reads,
    );
  });
});
