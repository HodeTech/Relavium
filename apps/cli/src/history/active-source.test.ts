/**
 * The read behind the Home's Active tab ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2): what it asks the history reader for, in what sizes, and what it does with a run whose log is damaged. The paging claims drive a
 * scripted reader (450 runs cost nothing to build, and the reader refuses an over-long lease list exactly as the real one does); the
 * classification claims run over a real in-memory `history.db`, so a damaged log is a damaged log.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_RUN_LEASE_IDS,
  RunHistoryReadError,
  UnreadableRunEventLogError,
  createClient,
  createRunHistoryReader,
  runEvents,
  runMigrations,
  type DbClient,
  type RunHistoryReader,
  type RunLeaseSummary,
  type RunSummaryRecord,
} from '@relavium/db';
import type { RunStatus } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedRun } from '../test-support.js';
import { STALLED_REASON } from './active-model.js';
import {
  ACTIVE_LEASE_CHUNK,
  ACTIVE_STATUS_LIMIT,
  chunksOf,
  createActiveReader,
  readActive,
  readActiveGateCounts,
  readActiveParkCounts,
  type ActiveSourceReader,
} from './active-source.js';
import { readSnapshotOf } from './change-probe.js';

const HERE = '/work/here';
const THERE = '/work/there';
const T0 = 1_750_000_000_000;
const TTL = 60_000;
const NOW = T0 + 10 * TTL;

let client: DbClient;
let reader: RunHistoryReader;

beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  reader = createRunHistoryReader(client.db);
});
afterEach(() => {
  client.sqlite.close();
});

const inProject = (runId: string, root: string): void => {
  client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?').run(root, runId);
};

const input = (over: Partial<Parameters<typeof readActive>[0]> = {}) => ({
  reader,
  projectRoot: HERE,
  hostedRunId: undefined,
  heldRunIds: new Set<string>(),
  nowMs: NOW,
  leaseTtlMs: TTL,
  ...over,
});

const rowOf = (rows: ReturnType<typeof readActive>['rows'], runId: string) => {
  const row = rows.find((candidate) => candidate.runId === runId);
  if (row === undefined) throw new Error(`no row for ${runId}`);
  return row;
};

/** A run summary: index 0 is the newest and each later index one millisecond older, per status, so a keyset cursor is unambiguous. */
function summary(
  prefix: string,
  index: number,
  status: RunStatus,
  root: string | undefined = HERE,
): RunSummaryRecord {
  const at = new Date(T0 - index).toISOString();
  return {
    id: `${prefix}-${String(index).padStart(5, '0')}`,
    workflowId: 'wf',
    status,
    executionMode: 'local',
    triggerType: 'manual',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: at,
    updatedAt: at,
    ...(root === undefined ? {} : { projectRoot: root }),
  };
}

/**
 * A reader over scripted runs that honours `status`, `projectRoot`, `limit` and the keyset cursor, refuses a lease list over the real
 * reader's bound, and records every page and every lease chunk it served.
 */
function scripted(runs: readonly RunSummaryRecord[]) {
  const pages: { status: RunStatus | undefined; limit: number; served: number }[] = [];
  const leaseChunks: number[] = [];
  const stateReads: string[] = [];
  const read: ActiveSourceReader = {
    ...reader,
    listRunSummaries: vi.fn((opts: Parameters<RunHistoryReader['listRunSummaries']>[0]) => {
      // The real store refuses a keyset position that is not a safe integer; the scripted one must, or a NaN cursor would pass unseen.
      if (opts.before !== undefined && !Number.isSafeInteger(opts.before.createdAt)) {
        throw new RunHistoryReadError(
          'invalid_cursor',
          'before must be a (createdAt, id) position',
        );
      }
      const matching = runs.filter(
        (run) =>
          (opts.status === undefined || run.status === opts.status) &&
          (opts.projectRoot === undefined || run.projectRoot === opts.projectRoot),
      );
      const after =
        opts.before === undefined ? -1 : matching.findIndex((run) => run.id === opts.before?.id);
      const page = matching.slice(after + 1, after + 1 + opts.limit);
      pages.push({ status: opts.status, limit: opts.limit, served: page.length });
      return page;
    }),
    loadRunLeases: vi.fn((ids: readonly string[]) => {
      if (ids.length > MAX_RUN_LEASE_IDS) throw new Error('too_many_run_ids');
      leaseChunks.push(ids.length);
      return new Map<string, RunLeaseSummary>();
    }),
    loadWorkflowSlugs: (ids: readonly string[]) => new Map(ids.map((id) => [id, `slug-of-${id}`])),
    // An empty log reconstructs no gate: these tests are about paging and chunking, not about what a log holds.
    loadRunStateEvents: vi.fn((runId: string) => {
      stateReads.push(runId);
      return [];
    }),
  };
  return { read, pages, leaseChunks, stateReads };
}

describe('chunks of 200', () => {
  it('asks for the leases of 450 runs as 200, 200 and 50, and never over the reader’s bound', () => {
    const runs = [
      ...Array.from({ length: 150 }, (_, i) => summary('run', i, 'running')),
      ...Array.from({ length: 150 }, (_, i) => summary('pen', i, 'pending')),
      ...Array.from({ length: 150 }, (_, i) => summary('par', i, 'paused')),
    ];
    const { read, leaseChunks } = scripted(runs);
    const result = readActive(input({ reader: read }));
    expect(result.rows).toHaveLength(450);
    expect(leaseChunks).toEqual([200, 200, 50]);
    expect(ACTIVE_LEASE_CHUNK).toBe(MAX_RUN_LEASE_IDS);
    expect(ACTIVE_LEASE_CHUNK).toBe(200);
  });

  it('chunksOf keeps order, loses nothing and repeats nothing', () => {
    const items = Array.from({ length: 450 }, (_, i) => i);
    const chunks = chunksOf(items, 200);
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 50]);
    expect(chunks.flat()).toEqual(items);
    expect(chunksOf([], 200)).toEqual([]);
  });

  it('chunksOf refuses a size that cannot advance, so a lease read never loops or drops its runs', () => {
    // A size of zero used to loop for ever (the position never moved); each of these must refuse at once, before any loop starts.
    for (const size of [0, -1, -200, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => chunksOf(['a', 'b'], size), `size ${String(size)}`).toThrow(RangeError);
    }
    // Even for no items: the refusal is of the argument, not of what it would have chunked.
    expect(() => chunksOf([], 0)).toThrow(RangeError);
    expect(chunksOf(['a', 'b', 'c'], 1)).toEqual([['a'], ['b'], ['c']]);
  });

  it('asks no lease question for a Home with nothing active', () => {
    const { read, leaseChunks } = scripted([]);
    expect(readActive(input({ reader: read })).rows).toEqual([]);
    expect(leaseChunks).toEqual([]);
  });
});

describe('bounded at 200 runs a status', () => {
  it('keeps the first page of a status and counts the rest with one more page, never reading beyond two', () => {
    const runs = [
      ...Array.from({ length: 250 }, (_, i) => summary('run', i, 'running')),
      ...Array.from({ length: 450 }, (_, i) => summary('pen', i, 'pending')),
      ...Array.from({ length: 5 }, (_, i) => summary('par', i, 'paused', THERE)),
    ];
    const { read, pages } = scripted(runs);
    const result = readActive(input({ reader: read }));
    expect(result.rows.filter((row) => row.status === 'running')).toHaveLength(ACTIVE_STATUS_LIMIT);
    expect(result.rows.filter((row) => row.status === 'pending')).toHaveLength(ACTIVE_STATUS_LIMIT);
    expect(result.rows.filter((row) => row.status === 'paused')).toHaveLength(5);
    expect(result.more).toEqual([
      { status: 'running', count: 50, atLeast: false },
      { status: 'pending', count: 200, atLeast: true },
    ]);
    expect(pages.every((page) => page.limit <= ACTIVE_STATUS_LIMIT)).toBe(true);
    expect(
      pages.filter((page) => page.status === 'pending'),
      'a count page after the kept one, and no third',
    ).toHaveLength(2);
  });

  it('a full page whose last row has an unusable time is shown as it is, with nothing counted past it, and the tab does not fail', () => {
    const runs = Array.from({ length: ACTIVE_STATUS_LIMIT + 50 }, (_, i) =>
      summary('run', i, 'running'),
    );
    // The 200th (the last the first page keeps) has a time nobody can parse: no cursor can start after it.
    const damaged = runs[ACTIVE_STATUS_LIMIT - 1];
    if (damaged === undefined) throw new Error('no run');
    runs[ACTIVE_STATUS_LIMIT - 1] = { ...damaged, createdAt: 'not a date' };
    const { read, pages } = scripted(runs);
    const result = readActive(input({ reader: read }));
    expect(result.rows.filter((row) => row.status === 'running')).toHaveLength(ACTIVE_STATUS_LIMIT);
    expect(result.more, 'no count: there is no position to count from').toEqual([]);
    expect(
      pages.filter((page) => page.status === 'running'),
      'and no second page was asked for',
    ).toHaveLength(1);
  });

  it('says nothing is beyond a status that holds exactly a page, and reads no second page for a short one', () => {
    const runs = [
      ...Array.from({ length: ACTIVE_STATUS_LIMIT }, (_, i) => summary('run', i, 'running')),
      ...Array.from({ length: 3 }, (_, i) => summary('pen', i, 'pending')),
    ];
    const { read, pages } = scripted(runs);
    const result = readActive(input({ reader: read }));
    expect(result.more).toEqual([]);
    expect(pages.filter((page) => page.status === 'pending')).toHaveLength(1);
    expect(
      pages.filter((page) => page.status === 'running'),
      'a full page asks once more',
    ).toHaveLength(2);
  });
});

describe('a paused run’s gates', () => {
  it('reads no gate for a Home with no paused run of its own project', () => {
    const { read, stateReads } = scripted([
      summary('par', 0, 'paused', THERE),
      summary('run', 0, 'running'),
    ]);
    const result = readActive(input({ reader: read }));
    expect(stateReads).toEqual([]);
    expect(rowOf(result.rows, 'par-00000')).toMatchObject({
      class: 'other-paused-elsewhere',
      actionable: false,
    });
  });

  it('a run parked at a human gate is actionable, a budget-only park counts as a gate, and a media park says it waits for a media job', async () => {
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-gate',
      state: 'paused',
      atMs: T0,
      gate: { gateId: 'g1', gateType: 'approval' },
    });
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-budget',
      state: 'paused',
      atMs: T0 + 1,
      budgetGateId: 'b1',
    });
    await seedRun(client.db, { slug: 'wf', runId: 'run-media', state: 'paused', atMs: T0 + 2 });
    for (const id of ['run-gate', 'run-budget', 'run-media']) inProject(id, HERE);
    const { rows } = readActive(input());
    expect(rowOf(rows, 'run-gate')).toMatchObject({
      class: 'other-paused-here',
      actionable: true,
      enter: 'open-gate-card',
    });
    expect(rowOf(rows, 'run-budget')).toMatchObject({
      class: 'other-paused-here',
      actionable: true,
    });
    // A media park whose log shows a job in flight can be continued (ADR-0139 §3, the 2026-11-23 amendment note): `Enter` asks first.
    expect(rowOf(rows, 'run-media')).toMatchObject({
      class: 'other-paused-media',
      actionable: true,
      enter: 'continue-media',
      reason: 'waiting for a media job',
    });
  });

  it('a run whose log is damaged reads `gate state not read`, never "media job", and is offered no card', async () => {
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-good',
      state: 'paused',
      atMs: T0,
      gate: { gateId: 'g1', gateType: 'approval' },
    });
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-bad',
      state: 'paused',
      atMs: T0 + 1,
      gate: { gateId: 'g2', gateType: 'approval' },
    });
    inProject('run-good', HERE);
    inProject('run-bad', HERE);
    client.db
      .insert(runEvents)
      .values({
        id: '00000000-0000-4000-8000-0000000000f1',
        runId: 'run-bad',
        seq: 900,
        eventType: 'node:started',
        payloadJson: JSON.stringify({ type: 'node:started', nodeId: 42 }),
        ts: 0,
      })
      .run();
    const { rows } = readActive(input());
    const bad = rowOf(rows, 'run-bad');
    expect(bad).toMatchObject({
      class: 'paused-gate-unknown',
      actionable: false,
      reason: 'gate state not read',
    });
    expect(JSON.stringify(bad)).not.toContain('media job');
    expect(rowOf(rows, 'run-good'), 'the others are read').toMatchObject({ actionable: true });
  });

  it('a degraded run is omitted from the count: only a run whose log was read has a number', async () => {
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-good',
      state: 'paused',
      atMs: T0,
      gates: [
        { gateId: 'g1', gateType: 'approval' },
        { gateId: 'g2', gateType: 'review' },
      ],
    });
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-bad',
      state: 'paused',
      atMs: T0 + 1,
      gate: { gateId: 'g3', gateType: 'approval' },
    });
    inProject('run-good', HERE);
    inProject('run-bad', HERE);
    client.db
      .insert(runEvents)
      .values({
        id: '00000000-0000-4000-8000-0000000000f2',
        runId: 'run-bad',
        seq: 900,
        eventType: 'node:started',
        payloadJson: JSON.stringify({ type: 'node:started', nodeId: 42 }),
        ts: 0,
      })
      .run();
    const paused = reader.listRunSummaries({ limit: 10, status: 'paused' });
    const counts = readActiveGateCounts(reader, HERE, paused);
    expect(counts?.get('run-good')).toBe(2);
    expect(counts?.has('run-bad'), 'a damaged log has no count, and so no zero').toBe(false);
  });

  it('counts the media jobs in flight beside the gates, and a damaged log has neither (never a zero that reads as a media park)', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-media', state: 'paused', atMs: T0 });
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-gate',
      state: 'paused',
      atMs: T0 + 1,
      gate: { gateId: 'g1', gateType: 'approval' },
    });
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-bad',
      state: 'paused',
      atMs: T0 + 2,
      gate: { gateId: 'g2', gateType: 'approval' },
    });
    for (const id of ['run-media', 'run-gate', 'run-bad']) inProject(id, HERE);
    client.db
      .insert(runEvents)
      .values({
        id: '00000000-0000-4000-8000-0000000000f3',
        runId: 'run-bad',
        seq: 900,
        eventType: 'node:started',
        payloadJson: JSON.stringify({ type: 'node:started', nodeId: 42 }),
        ts: 0,
      })
      .run();
    const paused = reader.listRunSummaries({ limit: 10, status: 'paused' });
    const counts = readActiveParkCounts(reader, HERE, paused);
    expect(counts?.media.get('run-media')).toBe(1);
    expect(counts?.gates.get('run-media')).toBe(0);
    expect(counts?.media.get('run-gate')).toBe(0);
    expect(counts?.gates.get('run-gate')).toBe(1);
    expect(counts?.media.has('run-bad')).toBe(false);
    expect(counts?.gates.has('run-bad')).toBe(false);
  });
});

describe('a paused run’s gate count is kept per run, so a tick does not read every log again', () => {
  const pausedRuns = (count: number): RunSummaryRecord[] =>
    Array.from({ length: count }, (_, index) => summary('par', index, 'paused'));
  const readerOver = (runs: readonly RunSummaryRecord[]) => {
    const scriptedRead = scripted(runs);
    return {
      ...scriptedRead,
      read: createActiveReader({
        reader: scriptedRead.read,
        projectRoot: HERE,
        hostedRunId: () => undefined,
        listHeld: () => Promise.resolve([]),
        now: () => NOW,
        leaseTtlMs: TTL,
      }),
    };
  };

  it('reads each paused run’s log once, and an unchanged run is not read again at the next tick', async () => {
    const { read, stateReads } = readerOver(pausedRuns(3));
    await read();
    expect(stateReads).toHaveLength(3);
    await read();
    await read();
    expect(stateReads, 'three more ticks, no row moved: no log was read').toHaveLength(3);
  });

  it('reads again only the run whose row moved', async () => {
    const runs = pausedRuns(3);
    const { read, stateReads } = readerOver(runs);
    await read();
    const moved = runs[1];
    if (moved === undefined) throw new Error('no run');
    runs[1] = { ...moved, updatedAt: new Date(T0 + 5).toISOString() };
    await read();
    expect(stateReads.slice(3), 'only the moved run').toEqual([moved.id]);
    await read();
    expect(stateReads, 'and it is kept again under its new key').toHaveLength(4);
  });

  it('a run whose gate was answered leaves the paused rows, and its kept count is not shown for it', async () => {
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-gate',
      state: 'paused',
      atMs: T0,
      gate: { gateId: 'g1', gateType: 'approval' },
    });
    inProject('run-gate', HERE);
    const read = createActiveReader({
      reader,
      projectRoot: HERE,
      hostedRunId: () => undefined,
      listHeld: () => Promise.resolve([]),
      now: () => NOW,
      leaseTtlMs: TTL,
    });
    expect(rowOf((await read()).rows, 'run-gate')).toMatchObject({ actionable: true });
    // The gate is answered: the run is running again, so it leaves the paused page and the kept count with it.
    client.sqlite
      .prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ?")
      .run(T0 + 9, 'run-gate');
    expect(rowOf((await read()).rows, 'run-gate').class).not.toBe('other-paused-here');
  });

  it('reads an entry again once it is older than a lease TTL, because two events in one millisecond leave the row as it was', async () => {
    const scriptedRead = scripted(pausedRuns(2));
    let now = NOW;
    const read = createActiveReader({
      reader: scriptedRead.read,
      projectRoot: HERE,
      hostedRunId: () => undefined,
      listHeld: () => Promise.resolve([]),
      now: () => now,
      leaseTtlMs: TTL,
    });
    await read();
    now += TTL - 1;
    await read();
    expect(scriptedRead.stateReads, 'still inside the TTL').toHaveLength(2);
    now += 1;
    await read();
    expect(scriptedRead.stateReads, 'a TTL later every entry is read again').toHaveLength(4);
  });

  it('drops the entry of a run that is no longer listed, so it is read when it comes back', async () => {
    const runs = pausedRuns(2);
    const { read, stateReads } = readerOver(runs);
    await read();
    const gone = runs.pop();
    await read();
    expect(stateReads).toHaveLength(2);
    if (gone === undefined) throw new Error('no run');
    runs.push(gone);
    await read();
    expect(stateReads.slice(2), 'the returning run is read, the kept one is not').toEqual([
      gone.id,
    ]);
  });

  it('an error that is not a damaged log is never kept: nothing is cached, and the next tick reads again and recovers', async () => {
    const scriptedRead = scripted(pausedRuns(2));
    let failing = true;
    const reads: string[] = [];
    const flaky: ActiveSourceReader = {
      ...scriptedRead.read,
      loadRunStateEvents: (runId: string) => {
        reads.push(runId);
        // A busy or closing database is a thrown error, not a per-run damage verdict: it leaves the read, and the poll retries.
        if (failing) throw new Error('database is locked');
        return [];
      },
    };
    const read = createActiveReader({
      reader: flaky,
      projectRoot: HERE,
      hostedRunId: () => undefined,
      listHeld: () => Promise.resolve([]),
      now: () => NOW,
      leaseTtlMs: TTL,
    });
    await expect(read()).rejects.toThrow('database is locked');
    failing = false;
    const result = await read();
    expect(
      reads.length,
      'the failed run was read again on the very next call, not kept as unread',
    ).toBe(3);
    for (const row of result.rows) expect(row.reason).not.toBe('gate state not read');
  });

  it('a damaged log is a fact about the stored rows: it is kept for the row’s key and re-read when the row moves or a TTL passes', async () => {
    const runs = pausedRuns(1);
    const scriptedRead = scripted(runs);
    let damaged = true;
    const reads: string[] = [];
    const flawed: ActiveSourceReader = {
      ...scriptedRead.read,
      loadRunStateEvents: (runId: string) => {
        reads.push(runId);
        if (damaged) throw new UnreadableRunEventLogError(runId, [3]);
        return [];
      },
    };
    let now = NOW;
    const read = createActiveReader({
      reader: flawed,
      projectRoot: HERE,
      hostedRunId: () => undefined,
      listHeld: () => Promise.resolve([]),
      now: () => now,
      leaseTtlMs: TTL,
    });
    expect((await read()).rows[0]?.reason).toBe('gate state not read');
    damaged = false;
    now += TTL - 1;
    expect((await read()).rows[0]?.reason, 'inside the TTL the verdict stands').toBe(
      'gate state not read',
    );
    expect(reads).toHaveLength(1);
    now += 1;
    expect(
      (await read()).rows[0]?.reason,
      'a TTL later the log is read again and found whole',
    ).not.toBe('gate state not read');
    expect(reads).toHaveLength(2);
  });

  it('keeps nothing when the caller passes no cache: every read is whole', () => {
    const scriptedRead = scripted(pausedRuns(2));
    const paused = pausedRuns(2);
    readActiveGateCounts(scriptedRead.read, HERE, paused);
    readActiveGateCounts(scriptedRead.read, HERE, paused);
    expect(scriptedRead.stateReads).toHaveLength(4);
  });
});

describe('what a run is', () => {
  it('names the leg this Home hosts, a run whose end is held, and a run nobody owns any more', async () => {
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-hosted',
      state: 'running',
      atMs: NOW - 5_000,
    });
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-held',
      state: 'running',
      atMs: NOW - 5_000,
    });
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-dead',
      state: 'running',
      atMs: NOW - 5 * TTL,
    });
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-live',
      state: 'running',
      atMs: NOW - 5 * TTL,
    });
    client.sqlite
      .prepare(
        'INSERT INTO run_leases (run_id, owner_id, generation, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('run-live', 'owner-1', 1, NOW + TTL, NOW, NOW);
    const { rows } = readActive(
      input({ hostedRunId: 'run-hosted', heldRunIds: new Set(['run-held']) }),
    );
    expect(rowOf(rows, 'run-hosted')).toMatchObject({ class: 'hosted', actionable: true });
    expect(rowOf(rows, 'run-held')).toMatchObject({ class: 'held', actionable: false });
    expect(rowOf(rows, 'run-dead')).toMatchObject({
      class: 'other-running',
      stalled: true,
      stalledReason: STALLED_REASON,
    });
    expect(rowOf(rows, 'run-live'), 'a live lease is not stalled').toMatchObject({
      stalled: false,
    });
  });

  it('labels a run by its workflow’s slug', async () => {
    await seedRun(client.db, { slug: 'deploy-site', runId: 'run-a', state: 'running', atMs: NOW });
    expect(rowOf(readActive(input()).rows, 'run-a').label).toBe('deploy-site');
  });

  it('leaves out every finished run', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-done', state: 'completed', atMs: T0 });
    await seedRun(client.db, { slug: 'wf', runId: 'run-failed', state: 'failed', atMs: T0 + 1 });
    expect(readActive(input()).rows).toEqual([]);
  });
});

describe('the asynchronous read', () => {
  it('puts the outbox’s run ids into the read, and a run it holds is held', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-a', state: 'running', atMs: NOW });
    const read = createActiveReader({
      reader,
      projectRoot: HERE,
      hostedRunId: () => undefined,
      listHeld: () => Promise.resolve([{ runId: 'run-a' }, {}]),
      now: () => NOW,
      leaseTtlMs: TTL,
    });
    const result = await read();
    expect(rowOf(result.rows, 'run-a').class).toBe('held');
    expect(result.heldUnread).toBe(false);
  });

  it('an outbox that cannot be read leaves the held set empty and says so; it never fails the read', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-a', state: 'running', atMs: NOW });
    const read = createActiveReader({
      reader,
      projectRoot: HERE,
      hostedRunId: () => undefined,
      listHeld: () => Promise.reject(new Error('EACCES: /private/path')),
      now: () => NOW,
      leaseTtlMs: TTL,
    });
    const result = await read();
    expect(result.heldUnread).toBe(true);
    expect(rowOf(result.rows, 'run-a').class).toBe('other-running');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('asks the host which run it hosts and the clock what time it is at every read, not once', async () => {
    const hosted = vi.fn((): string | undefined => undefined);
    const now = vi.fn(() => NOW);
    const read = createActiveReader({
      reader,
      projectRoot: HERE,
      hostedRunId: hosted,
      listHeld: () => Promise.resolve([]),
      now,
      leaseTtlMs: TTL,
    });
    await read();
    await read();
    expect(hosted).toHaveBeenCalledTimes(2);
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('parses the outbox again only when its stamp moved, and a held set that changed is picked up', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-a', state: 'running', atMs: NOW });
    await seedRun(client.db, { slug: 'wf', runId: 'run-b', state: 'running', atMs: NOW - 1 });
    let held: { runId: string }[] = [{ runId: 'run-a' }];
    let stamp: string | undefined = '10:1';
    const listHeld = vi.fn(() => Promise.resolve(held));
    const read = createActiveReader({
      reader,
      projectRoot: HERE,
      hostedRunId: () => undefined,
      listHeld,
      outboxStamp: () => stamp,
      now: () => NOW,
      leaseTtlMs: TTL,
    });
    expect(rowOf((await read()).rows, 'run-a').class).toBe('held');
    await read();
    await read();
    expect(listHeld, 'an unchanged file is parsed once').toHaveBeenCalledTimes(1);
    held = [{ runId: 'run-a' }, { runId: 'run-b' }];
    stamp = '40:2';
    const moved = await read();
    expect(listHeld).toHaveBeenCalledTimes(2);
    expect(rowOf(moved.rows, 'run-b').class, 'the new held id is picked up').toBe('held');
    stamp = undefined;
    await read();
    await read();
    expect(listHeld, 'no stamp, no keeping').toHaveBeenCalledTimes(4);
  });

  it('keeps nothing of an outbox it could not read, and lists it again at the next read', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-a', state: 'running', atMs: NOW });
    let fail = true;
    const listHeld = vi.fn(() =>
      fail ? Promise.reject(new Error('EACCES')) : Promise.resolve([{ runId: 'run-a' }]),
    );
    const read = createActiveReader({
      reader,
      projectRoot: HERE,
      hostedRunId: () => undefined,
      listHeld,
      outboxStamp: () => '10:1',
      now: () => NOW,
      leaseTtlMs: TTL,
    });
    expect((await read()).heldUnread).toBe(true);
    fail = false;
    const again = await read();
    expect(again.heldUnread).toBe(false);
    expect(rowOf(again.rows, 'run-a').class).toBe('held');
  });

  it('a stamp that throws is no stamp: the outbox is listed', async () => {
    const listHeld = vi.fn(() => Promise.resolve([]));
    const read = createActiveReader({
      reader,
      projectRoot: HERE,
      hostedRunId: () => undefined,
      listHeld,
      outboxStamp: () => {
        throw new Error('EPERM');
      },
      now: () => NOW,
      leaseTtlMs: TTL,
    });
    await read();
    await read();
    expect(listHeld).toHaveBeenCalledTimes(2);
  });

  it('does not read the database when it closed while the outbox was being read', async () => {
    let closed = false;
    const listRunSummaries = vi.fn(reader.listRunSummaries);
    const read = createActiveReader({
      reader: { ...reader, listRunSummaries },
      projectRoot: HERE,
      hostedRunId: () => undefined,
      listHeld: () => {
        closed = true;
        return Promise.resolve([]);
      },
      isClosed: () => closed,
      now: () => NOW,
      leaseTtlMs: TTL,
    });
    await expect(read()).rejects.toThrow('closed');
    expect(listRunSummaries).not.toHaveBeenCalled();
  });

  it('is a read, not a write: it runs over a reader that can only read', async () => {
    const only: ActiveSourceReader = {
      listRunSummaries: reader.listRunSummaries,
      loadRunLeases: reader.loadRunLeases,
      loadWorkflowSlugs: reader.loadWorkflowSlugs,
      loadRunDetail: reader.loadRunDetail,
      loadRunStateEvents: reader.loadRunStateEvents,
    };
    const read = createActiveReader({
      reader: only,
      projectRoot: HERE,
      hostedRunId: () => undefined,
      listHeld: () => Promise.resolve([]),
      now: () => NOW,
      leaseTtlMs: TTL,
    });
    await expect(read()).resolves.toMatchObject({ rows: [], more: [] });
  });
});

describe('one read, one snapshot (ADR-0140 §2)', () => {
  /** The Home's connection and another process's, on one file: `:memory:` has one connection and cannot show a commit between two reads. */
  let dir: string;
  let home: DbClient;
  let other: DbClient;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relavium-active-snapshot-'));
    const file = join(dir, 'history.db');
    home = createClient(file);
    runMigrations(home.db);
    other = createClient(file);
  });
  afterEach(() => {
    home.sqlite.close();
    other.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A Home reader over the shared file that, right after it served the page of `status`, lets another process move `runId` to `to`. */
  function racing(runId: string, afterStatus: RunStatus, to: RunStatus) {
    const real = createRunHistoryReader(home.db);
    let moved = false;
    const reader: ActiveSourceReader = {
      ...real,
      listRunSummaries: (opts) => {
        const page = real.listRunSummaries(opts);
        if (!moved && opts.status === afterStatus) {
          moved = true;
          other.sqlite
            .prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?')
            .run(to, T0 + 5, runId);
        }
        return page;
      },
    };
    return reader;
  }
  const mediaRead = (reader: ActiveSourceReader, snapshot?: ReturnType<typeof readSnapshotOf>) =>
    createActiveReader({
      reader,
      projectRoot: HERE,
      hostedRunId: () => undefined,
      listHeld: () => Promise.resolve([]),
      now: () => NOW,
      leaseTtlMs: TTL,
      snapshot,
    });

  it('lists a run once even when another process moves it between the status pages (it was listed twice without the snapshot)', async () => {
    await seedRun(home.db, { slug: 'wf', runId: 'run-moving', state: 'running', atMs: T0 });
    home.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?').run(HERE, 'run-moving');
    // Control: with separate statements the run is read as `running`, then as `paused`: two rows for one run.
    const loose = await mediaRead(racing('run-moving', 'running', 'paused'))();
    expect(
      loose.rows.filter((row) => row.runId === 'run-moving'),
      'the control: the race is real on these reads',
    ).toHaveLength(2);
    other.sqlite.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run('run-moving');
    const snap = await mediaRead(
      racing('run-moving', 'running', 'paused'),
      readSnapshotOf(home.db),
    )();
    const rows = snap.rows.filter((row) => row.runId === 'run-moving');
    expect(rows, 'one snapshot: the run is one row').toHaveLength(1);
    expect(rows[0]?.status, 'and it is the state the snapshot began with').toBe('running');
  });

  it('keeps a run another process moves the other way (paused to running) listed, not missing for a tick', async () => {
    await seedRun(home.db, { slug: 'wf', runId: 'run-resumed', state: 'running', atMs: T0 });
    const park = (): void => {
      other.sqlite
        .prepare("UPDATE runs SET status = 'paused', project_root = ? WHERE id = ?")
        .run(HERE, 'run-resumed');
    };
    park();
    // The run is paused when the first page (running) is read and running when the third (paused) is: it falls between the two pages.
    const loose = await mediaRead(racing('run-resumed', 'running', 'running'))();
    expect(
      loose.rows.filter((row) => row.runId === 'run-resumed'),
      'the control: without a snapshot the run is on neither page',
    ).toHaveLength(0);
    park();
    const snap = await mediaRead(
      racing('run-resumed', 'running', 'running'),
      readSnapshotOf(home.db),
    )();
    const rows = snap.rows.filter((row) => row.runId === 'run-resumed');
    expect(rows, 'one snapshot: the run is listed, once').toHaveLength(1);
    expect(rows[0]?.status).toBe('paused');
  });

  it('ends the transaction when the read throws, so no lock outlives the call', async () => {
    const failing: ActiveSourceReader = {
      ...createRunHistoryReader(home.db),
      loadRunLeases: () => {
        throw new Error('boom');
      },
    };
    await seedRun(home.db, { slug: 'wf', runId: 'run-x', state: 'running', atMs: T0 });
    await expect(mediaRead(failing, readSnapshotOf(home.db))()).rejects.toThrow('boom');
    expect(home.sqlite.inTransaction, 'rolled back, not left open').toBe(false);
    // And another process can still write.
    other.sqlite.prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run('run-x');
  });
});

describe('the project roots the reader hands its rows (ADR-0145 §8)', () => {
  it('names the root of a run of another project from ~ when it was given the directory and the home; without them the root is as stored', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-else', state: 'paused', atMs: T0 });
    inProject('run-else', '/home/ada/other');
    const rootOf = async (paths: { cwd: string; home: string } | undefined) => {
      const read = createActiveReader({
        reader,
        projectRoot: HERE,
        hostedRunId: () => undefined,
        listHeld: () => Promise.resolve([]),
        now: () => NOW,
        leaseTtlMs: TTL,
        ...(paths === undefined ? {} : { paths }),
      });
      return (await read()).rows.find((row) => row.runId === 'run-else')?.projectRoot;
    };
    expect(await rootOf({ cwd: HERE, home: '/home/ada' })).toBe('~/other');
    expect(await rootOf(undefined)).toBe('/home/ada/other');
  });
});
