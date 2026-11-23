/**
 * The Active tab only reads
 * ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §2: "the poll never
 * reconciles").
 *
 * The tab shows a run whose owner died as `stalled` and offers nothing to settle it: settling is `reconcile`, which WRITES (a `run:failed`
 * event, a status change, the terminal outbox's drain), it runs once when the Home opens, and a poll that ran it every few seconds would
 * make every Home on the machine race the others to fail a run another process may still be executing. Nothing in the read's types lets it
 * write (it holds a reader, not a database), so the claim is pinned by what it DOES: over a database with a stale lease, the whole poll runs
 * (the first read, ticks across several lease TTLs, a moved token, a refresh) and
 *
 * - the reconcile entry point and the engine's own `reconcile` are never called, and
 * - no row of any table changed, and the connection counts no change (`total_changes()`), and
 * - the stale run is still listed, as `stalled`: it was classified, not settled.
 *
 * A control proves the detector is not blind: `reconcileInterruptedRuns` over the very same database settles the stale run and moves the
 * fingerprint, so an unchanged fingerprint means the read wrote nothing rather than that this fixture cannot be written to.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowEngine } from '@relavium/core';
import { createClient, createRunHistoryReader, runMigrations, type DbClient } from '@relavium/db';
import { RUN_LEASE_TTL_MS } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedRun } from '../test-support.js';
import { createActivePoll, ACTIVE_POLL_MS } from './active-poll.js';
import { createActiveReader, readActive, type ActiveRead } from './active-source.js';
import { createChangeProbe, dataVersionOf } from './change-probe.js';
import { terminalOutboxPath } from './open.js';
import { reconcileInterruptedRuns } from './reconcile.js';

// The reconcile entry point, wrapped: the real function still runs when the control calls it, and every call is counted.
vi.mock('./reconcile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reconcile.js')>();
  return { ...actual, reconcileInterruptedRuns: vi.fn(actual.reconcileInterruptedRuns) };
});

const HERE = '/work/here';
/** Long enough ago that the real clock is past every lease and every run age below by many TTLs, which `reconcile` reads. */
const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const EXPIRED_AGO_MS = 10_000;
const STALE = 'run-stale-lease';
const NO_LEASE = 'run-no-lease';
const PARKED = 'run-parked-here';

let dir: string;
let client: DbClient;
beforeEach(async () => {
  vi.mocked(reconcileInterruptedRuns).mockClear();
  dir = mkdtempSync(join(tmpdir(), 'relavium-active-read-only-'));
  mkdirSync(join(dir, '.relavium'));
  client = createClient(':memory:');
  runMigrations(client.db);
  // A run whose lease lapsed (stalled once a TTL has passed), a run that never had one, and a run parked at a gate in this project.
  await seedRun(client.db, {
    slug: 'wf',
    runId: STALE,
    state: 'running',
    atMs: BASE - 5 * RUN_LEASE_TTL_MS,
  });
  client.sqlite
    .prepare(
      'INSERT INTO run_leases (run_id, owner_id, generation, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(STALE, 'owner-1', 1, BASE - EXPIRED_AGO_MS, BASE, BASE);
  await seedRun(client.db, {
    slug: 'wf',
    runId: NO_LEASE,
    state: 'running',
    atMs: BASE - 6 * RUN_LEASE_TTL_MS,
  });
  await seedRun(client.db, {
    slug: 'wf',
    runId: PARKED,
    state: 'paused',
    atMs: BASE - 4 * RUN_LEASE_TTL_MS,
    gate: { gateId: 'g1', gateType: 'approval' },
  });
  client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?').run(HERE, PARKED);
});
afterEach(() => {
  client.sqlite.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Every row of every table, and the number of changes the connection has made: anything the read wrote shows up in one of them. */
function fingerprint(): string {
  const names = client.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .flatMap((row) =>
      typeof row === 'object' && row !== null && 'name' in row && typeof row.name === 'string'
        ? [row.name]
        : [],
    );
  const tables = names.map((name) => [
    name,
    client.sqlite.prepare(`SELECT * FROM "${name}"`).all(),
  ]);
  const changes: unknown = client.sqlite.prepare('SELECT total_changes() AS n').get();
  return JSON.stringify({ changes, tables });
}

function manualTime() {
  let elapsed = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  };
  return {
    epochNow: (): number => BASE + elapsed,
    now: (): number => elapsed,
    settle,
    schedule: (callback: () => void, delayMs: number): (() => void) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: elapsed + delayMs, callback });
      return () => {
        timers.delete(id);
      };
    },
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

describe('the Active read and its poll never settle a run', () => {
  it('over a stale lease, a whole poll (reads, ticks across TTLs, a moved token, a refresh) writes nothing and calls no reconcile', async () => {
    const engineReconcile = vi.spyOn(WorkflowEngine.prototype, 'reconcile');
    const time = manualTime();
    const probe = createChangeProbe(dataVersionOf(client.db));
    const applied: ActiveRead[] = [];
    const poll = createActivePoll<ActiveRead>({
      schedule: time.schedule,
      now: time.now,
      token: probe.token,
      read: createActiveReader({
        reader: createRunHistoryReader(client.db),
        projectRoot: HERE,
        hostedRunId: () => undefined,
        listHeld: () => Promise.resolve([]),
        now: time.epochNow,
        leaseTtlMs: RUN_LEASE_TTL_MS,
      }),
      apply: (value) => {
        applied.push(value);
      },
      paused: () => false,
      isClosed: () => false,
    });

    const before = fingerprint();
    poll.start();
    await time.settle();
    await time.advance(3 * RUN_LEASE_TTL_MS);
    probe.bump();
    await time.advance(ACTIVE_POLL_MS);
    poll.refresh();
    await time.settle();
    await time.advance(2 * RUN_LEASE_TTL_MS);
    poll.cancel();

    expect(applied.length, 'the poll read more than once, over several TTLs').toBeGreaterThan(3);
    expect(fingerprint(), 'no row of any table changed, and the connection made no change').toBe(
      before,
    );
    expect(vi.mocked(reconcileInterruptedRuns)).not.toHaveBeenCalled();
    expect(engineReconcile).not.toHaveBeenCalled();

    const last = applied.at(-1);
    expect(last?.rows.find((row) => row.runId === STALE)).toMatchObject({
      class: 'other-running',
      status: 'running',
      stalled: true,
    });
    expect(last?.rows.find((row) => row.runId === NO_LEASE)).toMatchObject({
      status: 'running',
      stalled: true,
    });
    expect(last?.rows.find((row) => row.runId === PARKED)).toMatchObject({ status: 'paused' });
  });

  it('a single synchronous read of the same database writes nothing either', () => {
    const before = fingerprint();
    const { rows } = readActive({
      reader: createRunHistoryReader(client.db),
      projectRoot: HERE,
      hostedRunId: undefined,
      heldRunIds: new Set<string>(),
      nowMs: BASE + 10 * RUN_LEASE_TTL_MS,
      leaseTtlMs: RUN_LEASE_TTL_MS,
    });
    expect(rows.find((row) => row.runId === STALE)).toMatchObject({ stalled: true });
    expect(fingerprint()).toBe(before);
    expect(vi.mocked(reconcileInterruptedRuns)).not.toHaveBeenCalled();
  });

  it('control: reconcile over the same database DOES settle the stale run, and the fingerprint sees it', async () => {
    const before = fingerprint();
    await reconcileInterruptedRuns(client.db, terminalOutboxPath(dir));
    expect(vi.mocked(reconcileInterruptedRuns)).toHaveBeenCalledOnce();
    expect(client.sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(STALE)).toEqual({
      status: 'failed',
    });
    expect(fingerprint(), 'a write is visible to this detector').not.toBe(before);
  });
});
