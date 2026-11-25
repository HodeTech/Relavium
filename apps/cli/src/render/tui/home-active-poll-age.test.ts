/**
 * The Active tab's poll re-reads at least once per lease TTL, whatever the change token does
 * ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §2, §6).
 *
 * A run turns `stalled` when its lease has been gone for more than one TTL, and nothing is written when that happens, so no event moves the
 * token. The strip's idle refresh turns the age bound off (`maxAgeMs: Infinity`, because nothing it shows depends on the clock alone); the
 * tab's poll must not copy that, or a run whose owner died stays "running" for as long as the tab is open. `history/active-poll-stalled.test.ts`
 * pins the bound on the poll itself; this file pins that the HOME's tab passes none that turns it off, through the real controller over the
 * real read (`createActiveReader`) of a real in-memory `history.db`, with a scripted clock and timer.
 */
import { createClient, createRunHistoryReader, runMigrations, type DbClient } from '@relavium/db';
import { RUN_LEASE_TTL_MS } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVE_POLL_MS } from '../../history/active-poll.js';
import { createActiveReader, type ActiveRead } from '../../history/active-source.js';
import { createChangeProbe, dataVersionOf } from '../../history/change-probe.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { seedRun } from '../../test-support.js';
import {
  createHomeController,
  type HomeActivePort,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';

const HERE = '/work/here';
const BASE = Date.parse('2026-11-23T12:00:00.000Z');
/** How long ago the lease expired when the tab is entered: past its expiry, but not yet by a whole TTL. */
const EXPIRED_AGO_MS = 10_000;
const RUN = 'run-lease-lapsing';

const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: false,
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
};

let client: DbClient;
beforeEach(async () => {
  client = createClient(':memory:');
  runMigrations(client.db);
  await seedRun(client.db, {
    slug: 'wf',
    runId: RUN,
    state: 'running',
    atMs: BASE - 5 * RUN_LEASE_TTL_MS,
  });
  client.sqlite
    .prepare(
      'INSERT INTO run_leases (run_id, owner_id, generation, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(RUN, 'owner-1', 1, BASE - EXPIRED_AGO_MS, BASE, BASE);
});
afterEach(() => {
  client.sqlite.close();
});

/** A Home over the real Active read, a scripted clock and scripted timers: nothing sleeps. */
function mount() {
  let elapsed = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const probe = createChangeProbe(dataVersionOf(client.db));
  const reader = createActiveReader({
    reader: createRunHistoryReader(client.db),
    projectRoot: HERE,
    hostedRunId: () => undefined,
    listHeld: () => Promise.resolve([]),
    now: () => BASE + elapsed,
    leaseTtlMs: RUN_LEASE_TTL_MS,
  });
  const reads = vi.fn((): Promise<ActiveRead> => reader());
  const active: HomeActivePort = { token: probe.token, read: reads, isClosed: () => false };
  const deps: HomeControllerDeps = {
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => EMPTY },
    active,
    hostedRuns: { snapshot: () => IDLE, cancel: () => true, close: () => Promise.resolve() },
    gateCards: {
      list: () => [],
      read: () => undefined,
      resume: () => Promise.reject(new Error('nothing is answered here')),
    },
    schedule: (callback, delayMs) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: elapsed + delayMs, callback });
      return () => {
        timers.delete(id);
      };
    },
    now: () => elapsed,
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  };
  const controller = createHomeController(deps);
  return {
    controller,
    reads,
    timers: (): number => timers.size,
    /** Move the clock and fire every timer that falls due, in order, letting each read settle. */
    advance: async (ms: number): Promise<void> => {
      const end = elapsed + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        elapsed = Math.max(elapsed, due[1].at);
        due[1].callback();
        await settle();
      }
      elapsed = end;
    },
  };
}

const activeOf = (controller: HomeController) => {
  const screen = controller.getSnapshot().screen;
  return screen?.kind === 'tab-host' ? screen.host.active : undefined;
};
const rowOf = (controller: HomeController) =>
  activeOf(controller)?.rows.find((row) => row.runId === RUN);

describe('the Home`s Active tab re-reads once a lease TTL has passed, with the token where it was', () => {
  it('shows a run whose lease lapsed a TTL ago as stalled, though no write moved the token', async () => {
    const home = mount();
    expect(home.controller.openScreen('tab-host', { tab: 'active' })).toBe(true);
    await settle();
    expect(home.reads, 'one read when the tab was entered').toHaveBeenCalledTimes(1);
    expect(rowOf(home.controller), 'a lease lapsed seconds ago is not yet stalled').toMatchObject({
      class: 'other-running',
      stalled: false,
    });

    await home.advance(RUN_LEASE_TTL_MS - 2 * ACTIVE_POLL_MS);
    expect(home.reads, 'inside the bound and nothing moved: no read').toHaveBeenCalledTimes(1);
    expect(rowOf(home.controller)?.stalled).toBe(false);

    await home.advance(3 * ACTIVE_POLL_MS);
    expect(home.reads, 'past one TTL: read again, whatever the token says').toHaveBeenCalledTimes(
      2,
    );
    expect(rowOf(home.controller), 'and the tab now says the run is stalled').toMatchObject({
      stalled: true,
    });
  });

  it('keeps re-reading, once per TTL, for as long as the tab is open', async () => {
    const home = mount();
    home.controller.openScreen('tab-host', { tab: 'active' });
    await settle();
    await home.advance(5 * RUN_LEASE_TTL_MS + ACTIVE_POLL_MS);
    expect(home.reads.mock.calls.length, 'the first read and one more per TTL').toBe(6);
  });
});
