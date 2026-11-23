/**
 * The read behind the Home's Active tab ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2): what it asks the history reader for, in what sizes, and what it does with a run whose log is damaged. The paging claims drive a
 * scripted reader (450 runs cost nothing to build, and the reader refuses an over-long lease list exactly as the real one does); the
 * classification claims run over a real in-memory `history.db`, so a damaged log is a damaged log.
 */
import {
  MAX_RUN_LEASE_IDS,
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
  type ActiveSourceReader,
} from './active-source.js';

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
    expect(rowOf(rows, 'run-media')).toMatchObject({
      class: 'other-paused-media',
      actionable: false,
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
