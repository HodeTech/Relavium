/**
 * The Home's read of the open gates of THIS project's parked runs
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §7).
 *
 * Three claims: only this project's runs are ever returned (also when the reader over-returns), the read pages in chunks of at most
 * 200 and stops at its bound, and one damaged log degrades that run only. The first and the third run over a real in-memory
 * `history.db`; the paging claims drive a scripted reader so that 450 and 1,200 parked runs cost nothing to build.
 */
import {
  createClient,
  createRunHistoryReader,
  runEvents,
  runMigrations,
  RunHistoryReadError,
  type DbClient,
  type RunHistoryReader,
  type RunSummaryRecord,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedRun } from '../test-support.js';
import {
  isMediaOnlyPark,
  readProjectRunGates,
  readRunGates,
  RUN_GATES_CHUNK,
  RUN_GATES_MAX_RUNS,
  type RunGatesReader,
} from './run-gates.js';

const HERE = '/work/here';
const THERE = '/work/there';
const T0 = 1_750_000_000_000;

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

/** Put the run in a project: the seed helper records none. */
function inProject(runId: string, root: string): void {
  client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?').run(root, runId);
}

async function park(
  runId: string,
  root: string,
  gates: readonly { gateId: string; gateType: 'approval' | 'input' | 'review'; message?: string }[],
  atMs: number,
): Promise<void> {
  await seedRun(client.db, { slug: 'wf', runId, state: 'paused', atMs, gates });
  inProject(runId, root);
}

describe('the media-only park', () => {
  it('reads the nodes whose media jobs are in flight, and the run is a media-only park only with no gate of either kind', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-media', state: 'paused', atMs: T0 });
    inProject('run-media', HERE);
    await park('run-gate', HERE, [{ gateId: 'g1', gateType: 'approval' }], T0 + 1);
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-budget',
      state: 'paused',
      atMs: T0 + 2,
      budgetGateId: 'b1',
    });
    inProject('run-budget', HERE);
    const byId = new Map(readProjectRunGates(reader, HERE).runs.map((run) => [run.runId, run]));
    const media = byId.get('run-media');
    expect(media?.pendingMediaJobNodeIds).toEqual(['g']);
    expect(media?.gates).toEqual([]);
    expect(media !== undefined && isMediaOnlyPark(media)).toBe(true);
    expect(byId.get('run-gate')?.pendingMediaJobNodeIds).toEqual([]);
    expect(byId.get('run-budget')?.pendingMediaJobNodeIds).toEqual([]);
    for (const id of ['run-gate', 'run-budget']) {
      const run = byId.get(id);
      expect(run !== undefined && isMediaOnlyPark(run), id).toBe(false);
    }
    // The one-run read the question makes when it opens says the same.
    const one = readRunGates(reader, HERE, 'run-media');
    expect(one !== undefined && isMediaOnlyPark(one)).toBe(true);
  });

  it('is not a media-only park when a gate is open beside the job, when the log is unreadable, or when no job is in flight', () => {
    const base = { gates: [], budgetGates: [], degraded: false } as const;
    expect(isMediaOnlyPark({ ...base, pendingMediaJobNodeIds: ['n'] })).toBe(true);
    expect(isMediaOnlyPark({ ...base, pendingMediaJobNodeIds: [] })).toBe(false);
    expect(isMediaOnlyPark({ ...base })).toBe(false);
    expect(isMediaOnlyPark({ ...base, degraded: true, pendingMediaJobNodeIds: ['n'] })).toBe(false);
    const gate = {
      runId: 'r',
      gateId: 'g',
      nodeId: 'n',
      gateType: 'approval',
      message: 'm',
      accepts: ['approved'],
    } as const;
    expect(isMediaOnlyPark({ ...base, gates: [gate], pendingMediaJobNodeIds: ['n'] })).toBe(false);
    expect(
      isMediaOnlyPark({
        ...base,
        budgetGates: [{ gateId: 'b', nodeId: 'n', allowance: { kind: 'legacy' } }],
        pendingMediaJobNodeIds: ['n'],
      }),
    ).toBe(false);
  });
});

describe('only this project`s runs', () => {
  it('returns the gates of the runs parked here, each with its id, type and the decisions it accepts', async () => {
    await park('run-a', HERE, [{ gateId: 'g-a', gateType: 'approval', message: 'ship it?' }], T0);
    await park(
      'run-b',
      HERE,
      [
        { gateId: 'g-b1', gateType: 'input', message: 'which tag?' },
        { gateId: 'g-b2', gateType: 'review' },
      ],
      T0 + 1,
    );
    const read = readProjectRunGates(reader, HERE);
    expect(read.truncated).toBe(false);
    expect(read.degradedRunIds).toEqual([]);
    // Newest run first.
    expect(read.runs.map((run) => run.runId)).toEqual(['run-b', 'run-a']);
    const [b, a] = read.runs;
    expect(a?.gates).toEqual([
      {
        runId: 'run-a',
        gateId: 'g-a',
        nodeId: 'g',
        gateType: 'approval',
        message: 'ship it?',
        accepts: ['approved', 'rejected'],
      },
    ]);
    expect(b?.gates.map((gate) => [gate.gateId, gate.gateType, gate.accepts])).toEqual([
      ['g-b1', 'input', ['input_provided', 'rejected']],
      ['g-b2', 'review', ['approved', 'rejected']],
    ]);
  });

  it('never returns a run of another project, and not a run that recorded none', async () => {
    await park('run-here', HERE, [{ gateId: 'g1', gateType: 'approval' }], T0);
    await park('run-there', THERE, [{ gateId: 'g2', gateType: 'approval' }], T0 + 1);
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-none',
      state: 'paused',
      atMs: T0 + 2,
      gate: { gateId: 'g3', gateType: 'approval' },
    });
    const read = readProjectRunGates(reader, HERE);
    expect(read.runs.map((run) => run.runId)).toEqual(['run-here']);
    expect(JSON.stringify(read)).not.toContain('run-there');
    expect(JSON.stringify(read)).not.toContain('run-none');
  });

  it('holds when the reader over-returns: a run of another project handed back anyway is dropped', async () => {
    await park('run-here', HERE, [{ gateId: 'g1', gateType: 'approval' }], T0);
    await park('run-there', THERE, [{ gateId: 'g2', gateType: 'approval' }], T0 + 1);
    // A reader that ignores the project filter, as a faulty or future one might.
    const careless: RunGatesReader = {
      ...reader,
      listRunSummaries: ({ limit, status, before }) =>
        reader.listRunSummaries({
          limit,
          ...(status === undefined ? {} : { status }),
          ...(before === undefined ? {} : { before }),
        }),
    };
    expect(
      careless.listRunSummaries({ limit: 10, status: 'paused', projectRoot: HERE }),
    ).toHaveLength(2);
    const read = readProjectRunGates(careless, HERE);
    expect(read.runs.map((run) => run.runId)).toEqual(['run-here']);
    expect(JSON.stringify(read)).not.toContain('run-there');
  });

  it('reads only paused runs', async () => {
    await park('run-paused', HERE, [{ gateId: 'g1', gateType: 'approval' }], T0);
    await seedRun(client.db, { slug: 'wf', runId: 'run-done', state: 'completed', atMs: T0 + 1 });
    inProject('run-done', HERE);
    expect(readProjectRunGates(reader, HERE).runs.map((run) => run.runId)).toEqual(['run-paused']);
  });

  it('a media park is a run with no gate, and a budget park names its budget gate, not a human one', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-media', state: 'paused', atMs: T0 });
    inProject('run-media', HERE);
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-budget',
      state: 'paused',
      atMs: T0 + 1,
      budgetGateId: 'budget-1',
    });
    inProject('run-budget', HERE);
    const read = readProjectRunGates(reader, HERE);
    const media = read.runs.find((run) => run.runId === 'run-media');
    const budget = read.runs.find((run) => run.runId === 'run-budget');
    expect(media).toMatchObject({ gates: [], budgetGates: [], degraded: false });
    expect(budget?.gates).toEqual([]);
    expect(budget?.budgetGates.map((gate) => gate.gateId)).toEqual(['budget-1']);
  });

  it('carries the timeout policy the gate was raised with, and nothing for a gate that has none', async () => {
    await park('run-t', HERE, [{ gateId: 'g-plain', gateType: 'approval' }], T0);
    // The seed helper raises no deadline: rewrite one gate's event the way the engine writes it.
    const row = client.sqlite
      .prepare(
        "SELECT id, payload_json FROM run_events WHERE run_id = 'run-t' AND event_type = 'human_gate:paused'",
      )
      .get() as { id: string; payload_json: string };
    const event: unknown = {
      ...(JSON.parse(row.payload_json) as Record<string, unknown>),
      timeoutMs: 1000,
      timeoutAction: 'reject',
      expiresAt: '2026-11-23T12:00:00.000Z',
    };
    client.sqlite
      .prepare('UPDATE run_events SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(event), row.id);
    const [run] = readProjectRunGates(reader, HERE).runs;
    expect(run?.gates[0]).toMatchObject({
      gateId: 'g-plain',
      expiresAt: '2026-11-23T12:00:00.000Z',
      timeoutAction: 'reject',
    });
  });
});

describe('a run read on its own', () => {
  it('returns the gates of a run parked here, and nothing for another project`s, a missing or a finished one', async () => {
    await park('run-here', HERE, [{ gateId: 'g1', gateType: 'approval' }], T0);
    await park('run-there', THERE, [{ gateId: 'g2', gateType: 'approval' }], T0 + 1);
    await seedRun(client.db, { slug: 'wf', runId: 'run-done', state: 'completed', atMs: T0 + 2 });
    inProject('run-done', HERE);
    expect(readRunGates(reader, HERE, 'run-here')?.gates.map((gate) => gate.gateId)).toEqual([
      'g1',
    ]);
    expect(readRunGates(reader, HERE, 'run-there')).toBeUndefined();
    expect(readRunGates(reader, HERE, 'run-missing')).toBeUndefined();
    expect(readRunGates(reader, HERE, 'run-done')).toBeUndefined();
  });
});

describe('one damaged log degrades that run only', () => {
  it('names the run whose log cannot be read, and reads the others', async () => {
    await park('run-good', HERE, [{ gateId: 'g1', gateType: 'approval' }], T0);
    await park('run-bad', HERE, [{ gateId: 'g2', gateType: 'approval' }], T0 + 1);
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
    const read = readProjectRunGates(reader, HERE);
    expect(read.degradedRunIds).toEqual(['run-bad']);
    expect(read.runs.find((run) => run.runId === 'run-bad')).toMatchObject({
      gates: [],
      degraded: true,
    });
    expect(read.runs.find((run) => run.runId === 'run-good')?.gates).toHaveLength(1);
  });

  it('lets a fault that is not a per-run condition through', () => {
    const broken: RunGatesReader = {
      ...reader,
      listRunSummaries: () => [summary(0, HERE)],
      loadRunStateEvents: () => {
        throw new Error('the handle is closed');
      },
    };
    expect(() => readProjectRunGates(broken, HERE)).toThrow('the handle is closed');
  });
});

/** A run summary at a synthetic position: the newest has index 0 and every later index is one millisecond older. */
function summary(index: number, root: string): RunSummaryRecord {
  return {
    id: `run-${String(index).padStart(5, '0')}`,
    workflowId: 'wf',
    status: 'paused',
    executionMode: 'local',
    triggerType: 'manual',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: new Date(T0 - index).toISOString(),
    updatedAt: new Date(T0 - index).toISOString(),
    projectRoot: root,
  };
}

/** A reader over `count` synthetic parked runs that honours `limit` and the keyset cursor, and records every page it served. */
function scriptedReader(count: number) {
  const all = Array.from({ length: count }, (_, index) => summary(index, HERE));
  const pages: { limit: number; before: string | undefined; served: number }[] = [];
  const read: RunGatesReader = {
    ...reader,
    listRunSummaries: vi.fn((opts: Parameters<RunGatesReader['listRunSummaries']>[0]) => {
      const after =
        opts.before === undefined ? -1 : all.findIndex((run) => run.id === opts.before?.id);
      const page = all.slice(after + 1, after + 1 + opts.limit);
      pages.push({ limit: opts.limit, before: opts.before?.id, served: page.length });
      return page;
    }),
    // An empty log reconstructs no gate: this read is about paging, not about what a log holds.
    loadRunStateEvents: () => [],
  };
  return { read, pages };
}

describe('chunks of at most 200', () => {
  it('pages 450 parked runs as 200, 200 and 50, each page asked for no more than 200 and after the last row of the one before', () => {
    const { read, pages } = scriptedReader(450);
    const result = readProjectRunGates(read, HERE);
    expect(result.runs).toHaveLength(450);
    expect(result.truncated).toBe(false);
    expect(pages.map((page) => page.served)).toEqual([200, 200, 50]);
    expect(pages.every((page) => page.limit <= RUN_GATES_CHUNK)).toBe(true);
    expect(RUN_GATES_CHUNK).toBe(200);
    expect(pages.map((page) => page.before)).toEqual([undefined, 'run-00199', 'run-00399']);
    expect(new Set(result.runs.map((run) => run.runId)).size, 'no run twice').toBe(450);
  });

  it('asks for exactly one page when the project parks fewer runs than a page, and never asks for a second', () => {
    const { read, pages } = scriptedReader(37);
    expect(readProjectRunGates(read, HERE).runs).toHaveLength(37);
    expect(pages).toHaveLength(1);
  });

  it('stops at its bound and says so, so a project that never answers costs one bounded read', () => {
    const { read, pages } = scriptedReader(RUN_GATES_MAX_RUNS + 200);
    const result = readProjectRunGates(read, HERE);
    expect(result.runs).toHaveLength(RUN_GATES_MAX_RUNS);
    expect(result.truncated).toBe(true);
    expect(pages.length).toBeLessThanOrEqual(Math.ceil(RUN_GATES_MAX_RUNS / RUN_GATES_CHUNK) + 1);
  });

  it('a caller that keeps eight asks for nine summaries, never a chunk: one more than it keeps is enough to say there are more', () => {
    const { read, pages } = scriptedReader(37);
    const result = readProjectRunGates(read, HERE, { maxRuns: 8 });
    expect(result.runs.map((run) => run.runId)).toHaveLength(8);
    expect(result.truncated).toBe(true);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.limit, 'maxRuns + 1, not RUN_GATES_CHUNK').toBe(9);
    expect(read.listRunSummaries).toHaveBeenCalledTimes(1);
  });

  it('a caller that keeps eight and finds exactly eight reads one short page and is not truncated', () => {
    const { read, pages } = scriptedReader(8);
    const result = readProjectRunGates(read, HERE, { maxRuns: 8 });
    expect(result.runs).toHaveLength(8);
    expect(result.truncated).toBe(false);
    expect(pages.map((page) => [page.limit, page.served])).toEqual([[9, 8]]);
  });

  it('never asks for more than a chunk, however many runs the caller keeps', () => {
    const { read, pages } = scriptedReader(450);
    readProjectRunGates(read, HERE, { maxRuns: 450 });
    expect(pages.every((page) => page.limit <= RUN_GATES_CHUNK)).toBe(true);
  });

  it('ends the read, cut, on a full page whose last row has no usable position, instead of handing the store a cursor it refuses (PR #102 review)', () => {
    const { read, pages } = scriptedReader(450);
    // The store's own rule: a `before` whose time is not a safe integer is `invalid_cursor`, which would take the Attention list down.
    const strict: RunGatesReader = {
      ...read,
      listRunSummaries: (opts) => {
        if (opts.before !== undefined && !Number.isSafeInteger(opts.before.createdAt))
          throw new RunHistoryReadError(
            'invalid_cursor',
            'before must be a (createdAt, id) position',
          );
        const page = read.listRunSummaries(opts);
        // The last row of the first full page carries a time that does not parse.
        const last = page.at(-1);
        return opts.before === undefined && last !== undefined
          ? [...page.slice(0, -1), { ...last, createdAt: 'not a time' }]
          : page;
      },
    };
    const result = readProjectRunGates(strict, HERE);
    expect(result.runs, 'every run of the page it could read').toHaveLength(RUN_GATES_CHUNK);
    expect(result.truncated, 'it was cut, and says so').toBe(true);
    expect(pages, 'one page, and no second read from a position the store refuses').toHaveLength(1);
  });

  it('continues from a usable position as before: the cursor is the last row`s time and id', () => {
    const { read, pages } = scriptedReader(250);
    const seen: (number | undefined)[] = [];
    const spying: RunGatesReader = {
      ...read,
      listRunSummaries: (opts) => {
        seen.push(opts.before?.createdAt);
        return read.listRunSummaries(opts);
      },
    };
    expect(readProjectRunGates(spying, HERE).runs).toHaveLength(250);
    expect(pages.map((page) => page.before)).toEqual([undefined, 'run-00199']);
    expect(seen).toEqual([undefined, T0 - 199]);
  });

  it('is not truncated by a project that parks exactly the bound', () => {
    const { read } = scriptedReader(RUN_GATES_MAX_RUNS);
    const result = readProjectRunGates(read, HERE);
    expect(result.runs).toHaveLength(RUN_GATES_MAX_RUNS);
    expect(result.truncated).toBe(false);
  });
});
