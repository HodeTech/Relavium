/**
 * The read behind the Home's History tab ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): the paging rules (a view of twenty, a fetch of at most 200, three pages kept, a keyset cursor), the pinned section
 * inside the scope, and the cost folded once per finished run. Every claim runs over a real in-memory `history.db`, so a tie on one
 * millisecond is a tie in SQLite and a damaged log is a damaged log; the reader is wrapped only to COUNT what it is asked.
 */
import {
  createClient,
  createRunHistoryReader,
  createRunPinStore,
  runEvents,
  runMigrations,
  type DbClient,
  type RunHistoryReader,
  type RunPinStore,
} from '@relavium/db';
import type { RunStatus } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedRun } from '../test-support.js';
import { buildHistoryRows, type HistoryRow } from './history-model.js';
import {
  HISTORY_COST_CACHE_MAX,
  HISTORY_FETCH_ROWS,
  HISTORY_VIEW_ROWS,
  createHistorySource,
  type HistoryEntry,
  type HistorySource,
} from './history-source.js';
import { UNVERIFIED_USAGE } from './usage-coverage.js';

const HERE = '/work/here';
const THERE = '/work/there';
const T0 = 1_750_000_000_000;
const NOW = T0 + 3_600_000;

let client: DbClient;
let reader: RunHistoryReader;
let pins: RunPinStore;
let listCalls: ReturnType<typeof vi.fn<RunHistoryReader['listRunSummaries']>>;
let foldCalls: ReturnType<typeof vi.fn<RunHistoryReader['visitRunEventsForReplay']>>;

beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  reader = createRunHistoryReader(client.db);
  pins = createRunPinStore(client.db);
  listCalls = vi.fn(reader.listRunSummaries);
  foldCalls = vi.fn(reader.visitRunEventsForReplay);
});
afterEach(() => {
  client.sqlite.close();
});

const inProject = (runId: string, root: string): void => {
  client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?').run(root, runId);
};

/** `count` finished runs `run-00`…, in HERE, `step` ms apart (0 ⇒ all on one millisecond), newest id last. */
async function seedMany(count: number, step: number, state: 'completed' | 'failed' = 'completed') {
  for (let index = 0; index < count; index += 1) {
    const runId = `run-${String(index).padStart(3, '0')}`;
    await seedRun(client.db, { slug: 'wf', runId, state, atMs: T0 + index * step });
    inProject(runId, HERE);
  }
}

function sourceOver(over: { readonly pinsOf?: () => ReturnType<RunPinStore['listPins']> } = {}) {
  return createHistorySource({
    reader: { ...reader, listRunSummaries: listCalls, visitRunEventsForReplay: foldCalls },
    listRunPins: over.pinsOf ?? (() => pins.listPins({ kind: 'run' })),
    projectRoot: HERE,
    now: () => NOW,
  });
}

const idsOf = (entries: readonly HistoryEntry[]): string[] =>
  entries.flatMap((entry) => (entry.kind === 'run' ? [entry.row.id] : []));

const readPage = (source: HistorySource, page: number, status?: RunStatus) =>
  source.read({ scope: 'project', status, page });

describe('paging: a keyset cursor over a view of twenty', () => {
  it('keeps both rows of a created_at tie that straddles a page boundary, once each and in order', async () => {
    // Twenty-five runs on ONE millisecond: the boundary after the twentieth falls inside the tie.
    await seedMany(25, 0);
    const source = sourceOver();
    const first = readPage(source, 0);
    const second = readPage(source, 1);
    expect(first.rows).toHaveLength(HISTORY_VIEW_ROWS);
    expect(first.hasNext).toBe(true);
    expect(second.rows).toHaveLength(5);
    expect(second.hasNext).toBe(false);
    const all = [...idsOf(first.rows), ...idsOf(second.rows)];
    expect(new Set(all).size, 'no row twice').toBe(25);
    // `(created_at DESC, id DESC)`: with one created_at the ids run from the highest down.
    expect(all).toEqual(
      Array.from({ length: 25 }, (_, index) => `run-${String(24 - index).padStart(3, '0')}`),
    );
  });

  it('keeps the tie with a status chosen, where a fetch is 21 rows and the twenty-first only says there is more', async () => {
    await seedMany(25, 0);
    const source = sourceOver();
    const first = readPage(source, 0, 'completed');
    const second = readPage(source, 1, 'completed');
    expect(listCalls.mock.calls.map(([options]) => options.limit)).toEqual([
      HISTORY_VIEW_ROWS + 1,
      HISTORY_VIEW_ROWS + 1,
    ]);
    expect(new Set([...idsOf(first.rows), ...idsOf(second.rows)]).size).toBe(25);
    expect(first.hasNext).toBe(true);
    expect(second.rows).toHaveLength(5);
  });

  it('fetches at most 200 raw rows without a status, and drops a run that is not finished instead of counting it', async () => {
    await seedMany(3, 10);
    for (const id of ['live-1', 'live-2']) {
      await seedRun(client.db, { slug: 'wf', runId: id, state: 'running', atMs: T0 + 1_000 });
      inProject(id, HERE);
    }
    const page = readPage(sourceOver(), 0);
    expect(listCalls).toHaveBeenCalledTimes(1);
    expect(listCalls.mock.calls[0]?.[0].limit).toBe(HISTORY_FETCH_ROWS);
    expect(idsOf(page.rows)).toEqual(['run-002', 'run-001', 'run-000']);
    expect(page.hasNext).toBe(false);
  });

  it('re-reads an evicted page with its own cursor and returns the same rows, and keeps no more than three pages', async () => {
    await seedMany(65, 10);
    const source = sourceOver();
    const firstRead = readPage(source, 0);
    readPage(source, 1);
    readPage(source, 2);
    readPage(source, 3);
    expect(listCalls).toHaveBeenCalledTimes(4);
    // Pages 1, 2 and 3 are the three nearest the one in view: reading them again fetches nothing.
    readPage(source, 2);
    readPage(source, 1);
    readPage(source, 3);
    expect(listCalls, 'the three pages nearest the view are kept').toHaveBeenCalledTimes(4);
    // Page 0 was evicted by the walk to page 3: reading it fetches again, with no cursor, and gets the rows it had.
    const again = readPage(source, 0);
    expect(listCalls).toHaveBeenCalledTimes(5);
    expect(listCalls.mock.calls[4]?.[0]).not.toHaveProperty('before');
    expect(again.rows).toEqual(firstRead.rows);
    // Coming back to 0 evicts the page farthest from it: page 3 is read again, from the cursor the walk kept, with the same rows.
    readPage(source, 1);
    readPage(source, 2);
    expect(listCalls).toHaveBeenCalledTimes(5);
    const third = readPage(source, 3);
    expect(listCalls).toHaveBeenCalledTimes(6);
    expect(idsOf(third.rows)).toEqual(['run-004', 'run-003', 'run-002', 'run-001', 'run-000']);
  });

  it('drops the pages past a page whose boundary moved, so a page 0 re-read after its eviction never leaves a stale next page', async () => {
    await seedMany(65, 10);
    const source = sourceOver();
    for (const page of [0, 1, 2, 3]) readPage(source, page);
    expect(listCalls).toHaveBeenCalledTimes(4);
    // Three newer runs arrive while page 0 is out of memory (the walk to page 3 evicted it): page 0 now ends three rows earlier.
    for (const id of ['run-new-0', 'run-new-1', 'run-new-2']) {
      await seedRun(client.db, { slug: 'wf', runId: id, state: 'completed', atMs: T0 + 10_000 });
      inProject(id, HERE);
    }
    const first = readPage(source, 0);
    expect(listCalls, 'page 0 was evicted: it is fetched again').toHaveBeenCalledTimes(5);
    expect(idsOf(first.rows).slice(0, 3)).toEqual(['run-new-2', 'run-new-1', 'run-new-0']);
    // Pages 1 and 2 were read with the OLD boundary: they are fetched again with the new cursor, not served from memory.
    const second = readPage(source, 1);
    const third = readPage(source, 2);
    const fourth = readPage(source, 3);
    expect(listCalls.mock.calls.length, 'pages 1, 2 and 3 are fetched again').toBe(8);
    const all = [first, second, third, fourth].flatMap((read) => idsOf(read.rows));
    expect(new Set(all).size, 'no row twice').toBe(68);
    expect(all, 'no row skipped, in order').toEqual([
      'run-new-2',
      'run-new-1',
      'run-new-0',
      ...Array.from({ length: 65 }, (_, index) => `run-${String(64 - index).padStart(3, '0')}`),
    ]);
  });

  it('clamps a page past the walk to the last page it reached, and starts the walk again for a new scope or status', async () => {
    await seedMany(30, 10);
    const source = sourceOver();
    expect(readPage(source, 5).query.page, 'a page nobody reached is page 0').toBe(0);
    readPage(source, 1);
    const widened = source.read({ scope: 'all', status: undefined, page: 1 });
    expect(widened.query.page, 'a new scope starts the walk').toBe(0);
    const filtered = source.read({ scope: 'all', status: 'failed', page: 1 });
    expect(filtered.query).toEqual({ scope: 'all', status: 'failed', page: 0 });
    expect(filtered.rows).toEqual([]);
  });

  it('scopes the page to this project, and every project with `all`', async () => {
    await seedMany(2, 10);
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'elsewhere',
      state: 'completed',
      atMs: T0 + 500,
    });
    inProject('elsewhere', THERE);
    const source = sourceOver();
    expect(idsOf(source.read({ scope: 'project', status: undefined, page: 0 }).rows)).toEqual([
      'run-001',
      'run-000',
    ]);
    expect(idsOf(source.read({ scope: 'all', status: undefined, page: 0 }).rows)).toEqual([
      'elsewhere',
      'run-001',
      'run-000',
    ]);
  });
});

describe('the pinned section', () => {
  it('lists a pinned run inside the current scope, marks it in the page, and leaves out a pinned run of another project', async () => {
    await seedMany(3, 10);
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'elsewhere',
      state: 'completed',
      atMs: T0 + 500,
    });
    inProject('elsewhere', THERE);
    pins.pinItem({ kind: 'run', projectRoot: '', ref: 'run-000', at: 1 });
    pins.pinItem({ kind: 'run', projectRoot: '', ref: 'elsewhere', at: 2 });
    const source = sourceOver();

    const here = source.read({ scope: 'project', status: undefined, page: 0 });
    expect(idsOf(here.pinned), 'the pin of another project is not in this scope').toEqual([
      'run-000',
    ]);
    const marked = here.rows.find((entry) => entry.kind === 'run' && entry.row.id === 'run-000');
    expect(marked).toMatchObject({ kind: 'run', row: { pinned: true } });
    expect(
      marked?.kind === 'run' && marked.pinRowid,
      'the pin row is the handle that removes it',
    ).toBeGreaterThan(0);
    expect(here.rows.filter((entry) => entry.kind === 'run' && entry.row.pinned)).toHaveLength(1);

    const everywhere = source.read({ scope: 'all', status: undefined, page: 0 });
    expect(idsOf(everywhere.pinned), 'newest pin first, in every scope').toEqual([
      'elsewhere',
      'run-000',
    ]);
  });

  it('shows a pinned run whatever the status filter says, and a pin whose run is gone as a missing entry that can be removed', async () => {
    await seedMany(2, 10);
    pins.pinItem({ kind: 'run', projectRoot: '', ref: 'run-001', at: 1 });
    pins.pinItem({ kind: 'run', projectRoot: '', ref: 'no-such-run', at: 2 });
    const read = readPage(sourceOver(), 0, 'failed');
    expect(read.rows, 'the page is the filter’s').toEqual([]);
    expect(read.pinned).toHaveLength(2);
    expect(read.pinned[0]).toMatchObject({ kind: 'missing', label: 'no-such-run' });
    expect(read.pinned[0]?.kind === 'missing' && read.pinned[0].pinRowid).toBeGreaterThan(0);
    expect(read.pinned[1]).toMatchObject({ kind: 'run', row: { id: 'run-001', pinned: true } });
  });

  it('reads the pins every time, so a page kept in memory never holds a stale pin', async () => {
    await seedMany(3, 10);
    const source = sourceOver();
    expect(readPage(source, 0).pinned).toEqual([]);
    pins.pinItem({ kind: 'run', projectRoot: '', ref: 'run-001', at: 1 });
    const after = readPage(source, 0);
    expect(listCalls, 'the page itself came from memory').toHaveBeenCalledTimes(1);
    expect(idsOf(after.pinned)).toEqual(['run-001']);
    expect(
      after.rows.find((entry) => entry.kind === 'run' && entry.row.id === 'run-001'),
    ).toMatchObject({
      row: { pinned: true },
    });
  });
});

describe('the cost: lazy, folded once per finished run', () => {
  it('folds a finished run the first time its cost is asked for and never again, across reads, an evicted page and a second ask', async () => {
    await seedMany(65, 10);
    const source = sourceOver();
    const page = readPage(source, 0);
    const rows = page.rows.flatMap((entry) => (entry.kind === 'run' ? [entry.row] : []));
    expect(foldCalls, 'reading the page folds nothing').not.toHaveBeenCalled();

    const [first, second] = rows;
    if (first === undefined || second === undefined) throw new Error('the page has rows');
    const cost = source.cost(first);
    expect(cost.kind).toBe('text');
    source.cost(first);
    source.cost(second);
    source.cost(second);
    expect(foldCalls, 'two runs asked for twice each').toHaveBeenCalledTimes(2);

    // Walk far enough to evict page 0, read it again, and ask for the same rows again.
    readPage(source, 1);
    readPage(source, 2);
    readPage(source, 3);
    const back = readPage(source, 0);
    const again = back.rows.flatMap((entry) => (entry.kind === 'run' ? [entry.row] : []));
    expect(again[0]?.id).toBe(first.id);
    for (const row of again.slice(0, 2)) source.cost(row);
    expect(foldCalls, 'a run that was folded is not folded again').toHaveBeenCalledTimes(2);
    source.cost(again[2] ?? first);
    expect(foldCalls).toHaveBeenCalledTimes(3);
  });

  it('folds nothing for a run that is not finished: it can still change', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'live', state: 'running', atMs: T0 });
    inProject('live', HERE);
    pins.pinItem({ kind: 'run', projectRoot: '', ref: 'live', at: 1 });
    const source = sourceOver();
    const entry = source.read({ scope: 'project', status: undefined, page: 0 }).pinned[0];
    if (entry?.kind !== 'run') throw new Error('the pinned running run is listed');
    expect(entry.row.status).toBe('running');
    expect(source.cost(entry.row)).toEqual({ kind: 'not-final' });
    expect(source.cost(entry.row)).toEqual({ kind: 'not-final' });
    expect(foldCalls).not.toHaveBeenCalled();
  });

  it('marks a run whose log cannot be read as unreadable, keeps its row, and does not fold it a second time', async () => {
    await seedMany(2, 10);
    client.db
      .insert(runEvents)
      .values({
        id: '00000000-0000-4000-8000-0000000000a1',
        runId: 'run-001',
        seq: 900,
        eventType: 'node:started',
        payloadJson: JSON.stringify({ type: 'node:started', nodeId: 42 }),
        ts: 0,
      })
      .run();
    const source = sourceOver();
    const rows = readPage(source, 0).rows.flatMap((entry) =>
      entry.kind === 'run' ? [entry.row] : [],
    );
    expect(
      rows.map((row) => row.id),
      'the damaged run is still listed',
    ).toEqual(['run-001', 'run-000']);
    const [damaged, healthy] = rows;
    if (damaged === undefined || healthy === undefined) throw new Error('two rows');
    expect(source.cost(damaged)).toEqual({ kind: 'unreadable' });
    expect(source.cost(damaged)).toEqual({ kind: 'unreadable' });
    expect(source.cost(healthy).kind, 'its neighbour is read').toBe('text');
    expect(foldCalls, 'the damaged fold was attempted once').toHaveBeenCalledTimes(2);
  });
});

describe('the cost cache: at most HISTORY_COST_CACHE_MAX runs, and the run asked for least recently goes first', () => {
  /** `count` finished rows, `run-000`…, read straight from records (the cache is keyed by the row, so no database is needed to fill it). */
  function rowsOf(count: number): readonly HistoryRow[] {
    const at = new Date(T0).toISOString();
    return buildHistoryRows({
      runs: Array.from({ length: count }, (_, index) => ({
        id: `run-${String(index).padStart(3, '0')}`,
        workflowId: 'wf',
        status: 'completed' as const,
        executionMode: 'local' as const,
        triggerType: 'manual' as const,
        startedAt: at,
        completedAt: at,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostMicrocents: 0,
        createdAt: at,
        updatedAt: at,
      })),
      nowMs: NOW,
      pinnedRunIds: new Set(),
    });
  }

  /** A source whose fold is a counted stand-in: the claim is how often the cache folds, not what a fold reads. */
  function countingSource() {
    const folds = vi.fn((runId: string) => {
      void runId;
      return {
        totalCostMicrocents: 0,
        usageCoverage: UNVERIFIED_USAGE,
        unpricedCalls: 0,
        nodes: new Map(),
      };
    });
    const source = createHistorySource({
      reader,
      listRunPins: () => [],
      projectRoot: HERE,
      now: () => NOW,
      readCoverage: folds,
    });
    return { source, folds };
  }

  it('keeps at most 500 folds of 600 finished runs: the first hundred were dropped, and a re-read of one folds again', () => {
    const rows = rowsOf(600);
    const { source, folds } = countingSource();
    for (const row of rows) source.cost(row);
    expect(folds, 'each run folded once the first time').toHaveBeenCalledTimes(600);

    const [oldest, newest] = [rows[0], rows[599]];
    const firstKept = rows[600 - HISTORY_COST_CACHE_MAX];
    if (oldest === undefined || newest === undefined || firstKept === undefined)
      throw new Error('the rows exist');
    // The newest read is kept, and so is the oldest of the five hundred kept: neither folds again.
    source.cost(newest);
    source.cost(firstKept);
    expect(folds, 'the five hundred newest are kept').toHaveBeenCalledTimes(600);
    // The oldest was dropped past the bound: asking for it folds it again.
    source.cost(oldest);
    expect(folds, 'an evicted run folds again').toHaveBeenCalledTimes(601);
    expect(folds).toHaveBeenLastCalledWith(oldest.id);
  });

  it('drops the run asked for least recently, not the one folded first: a run asked for again survives the eviction that follows', () => {
    const rows = rowsOf(HISTORY_COST_CACHE_MAX + 1);
    const { source, folds } = countingSource();
    for (const row of rows.slice(0, HISTORY_COST_CACHE_MAX)) source.cost(row);
    const [first, second, extra] = [rows[0], rows[1], rows[HISTORY_COST_CACHE_MAX]];
    if (first === undefined || second === undefined || extra === undefined)
      throw new Error('the rows exist');
    // The cache is full. The oldest fold is asked for again, so it is the youngest; a new run then pushes one out.
    source.cost(first);
    source.cost(extra);
    expect(folds).toHaveBeenCalledTimes(HISTORY_COST_CACHE_MAX + 1);
    // What went was the second fold (now the least recently asked for), and the first stayed.
    source.cost(first);
    expect(folds, 'the run asked for again was kept').toHaveBeenCalledTimes(
      HISTORY_COST_CACHE_MAX + 1,
    );
    source.cost(second);
    expect(folds, 'the least recently asked for was dropped').toHaveBeenCalledTimes(
      HISTORY_COST_CACHE_MAX + 2,
    );
    expect(folds).toHaveBeenLastCalledWith(second.id);
  });
});
