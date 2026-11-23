/**
 * What the Active tab shows depends on the clock as well as on the log
 * ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §2): a run turns `stalled`
 * when its lease has been gone for more than one lease TTL, and NOTHING is written when that happens, so no event moves the change token.
 * A poll that read only when the token moved would show the run as live for as long as the tab stayed open. The bound that prevents it is
 * the poll's `maxAgeMs`, which defaults to one lease TTL; the strip's own poll turns it off (`Infinity`) because nothing it shows depends on
 * the clock alone, and copying that setting to the tab would break the `stalled` rule without failing any other test.
 *
 * This runs the real poll over the real read (`createActiveReader`) over a real in-memory `history.db`, with the real change token
 * (`PRAGMA data_version`), and moves only a manual clock. The run was started long ago and its lease expired a little while ago, which is
 * not yet stalled (the boundary is a full TTL past the expiry); the token never moves after the first read.
 */
import { createClient, createRunHistoryReader, runMigrations, type DbClient } from '@relavium/db';
import { RUN_LEASE_TTL_MS } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedRun } from '../test-support.js';
import { ACTIVE_MAX_AGE_MS, ACTIVE_POLL_MS, createActivePoll } from './active-poll.js';
import { createChangeProbe, dataVersionOf } from './change-probe.js';
import { createActiveReader, type ActiveRead } from './active-source.js';

const HERE = '/work/here';
const BASE = Date.parse('2026-11-23T12:00:00.000Z');
/** How long ago the lease expired when the tab is entered: past its expiry, but not yet by a whole TTL. */
const EXPIRED_AGO_MS = 10_000;

let client: DbClient;
beforeEach(async () => {
  client = createClient(':memory:');
  runMigrations(client.db);
  await seedRun(client.db, {
    slug: 'wf',
    runId: 'run-lease-lapsing',
    state: 'running',
    atMs: BASE - 5 * RUN_LEASE_TTL_MS,
  });
  client.sqlite
    .prepare(
      'INSERT INTO run_leases (run_id, owner_id, generation, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('run-lease-lapsing', 'owner-1', 1, BASE - EXPIRED_AGO_MS, BASE, BASE);
});
afterEach(() => {
  client.sqlite.close();
});

/** Let every promise callback already queued run. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

/** A manual clock and timer: time moves only when a test advances it. */
function manualTime() {
  let elapsed = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    /** Epoch milliseconds, as the read compares a lease with it. */
    epochNow: (): number => BASE + elapsed,
    now: (): number => elapsed,
    schedule: (callback: () => void, delayMs: number): (() => void) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: elapsed + delayMs, callback });
      return () => {
        timers.delete(id);
      };
    },
    /** Move time forward, firing every timer that falls due on the way, in order, and letting each read settle. */
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

/** The tab's poll over the real read; `maxAgeMs` is passed only when a test names one, so the default is what runs otherwise. */
function tab(options: { readonly maxAgeMs?: number } = {}) {
  const time = manualTime();
  const probe = createChangeProbe(dataVersionOf(client.db));
  const reads: ActiveRead[] = [];
  const read = createActiveReader({
    reader: createRunHistoryReader(client.db),
    projectRoot: HERE,
    hostedRunId: () => undefined,
    listHeld: () => Promise.resolve([]),
    now: time.epochNow,
    leaseTtlMs: RUN_LEASE_TTL_MS,
  });
  const counted = vi.fn(read);
  const poll = createActivePoll<ActiveRead>({
    schedule: time.schedule,
    now: time.now,
    token: probe.token,
    read: counted,
    apply: (value) => {
      reads.push(value);
    },
    paused: () => false,
    isClosed: () => false,
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
  });
  const stalledNow = (): boolean | undefined =>
    reads.at(-1)?.rows.find((row) => row.runId === 'run-lease-lapsing')?.stalled;
  return { time, poll, reads: counted, stalledNow };
}

describe('a run whose lease lapsed becomes stalled although nothing was written', () => {
  it('the default bound is one lease TTL, the unit of the `stalled` rule', () => {
    expect(ACTIVE_MAX_AGE_MS).toBe(RUN_LEASE_TTL_MS);
  });

  it('with the default bound the tab reads again once a TTL has passed with the token where it was, and shows the run as stalled', async () => {
    const t = tab();
    t.poll.start();
    await settle();
    expect(t.reads, 'one read when the tab was entered').toHaveBeenCalledTimes(1);
    expect(t.stalledNow(), 'a lease that lapsed seconds ago is not yet stalled').toBe(false);

    await t.time.advance(RUN_LEASE_TTL_MS - 2 * ACTIVE_POLL_MS);
    expect(t.reads, 'still inside the bound, and nothing moved: no read').toHaveBeenCalledTimes(1);
    expect(t.stalledNow()).toBe(false);

    await t.time.advance(3 * ACTIVE_POLL_MS);
    expect(t.reads, 'past the bound: read again whatever the token says').toHaveBeenCalledTimes(2);
    expect(t.stalledNow(), 'and the run whose lease lapsed a TTL ago is stalled').toBe(true);
    t.poll.cancel();
  });

  it('with the bound turned off (the strip`s setting) the same tab never re-reads, so the run is shown live for as long as the tab is open', async () => {
    const t = tab({ maxAgeMs: Number.POSITIVE_INFINITY });
    t.poll.start();
    await settle();
    expect(t.stalledNow()).toBe(false);

    await t.time.advance(10 * RUN_LEASE_TTL_MS);
    expect(
      t.reads,
      'ten TTLs and the token never moved: nothing is read again',
    ).toHaveBeenCalledTimes(1);
    expect(t.stalledNow(), 'the lapsed lease is never noticed').toBe(false);
    t.poll.cancel();
  });
});
