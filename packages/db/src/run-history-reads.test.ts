import { RunEventSchema, type RunStatus } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  createRunHistoryReader,
  isCorruptRunEventError,
  isRunHistoryReadError,
  MAX_RUN_LEASE_IDS,
  MAX_RUN_SUMMARY_PAGE,
  MAX_RUN_TAIL_EVENTS,
  type RunHistoryReader,
  type RunSummaryRecord,
} from './run-history-store.js';
import { runEvents, runLeases, runs, stepExecutions, workflows } from './schema.js';
import { isoToEpochMs } from './time.js';

/**
 * The reads ADR-0140 §4 adds to the run-history reader for the Home's management browsers: a keyset page of run
 * summaries, the run and node detail reads, the poll tail, the lease lookup and the project-scoped overlay. Every
 * run here is seeded straight into the tables (never through `persistEvent`), so a fixture states exactly the row
 * a read sees, and the reads are exercised through the same `createRunHistoryReader` the CLI calls.
 */

const T0 = Date.parse('2026-06-23T10:00:00.000Z');
type SummaryFilter = Omit<Parameters<RunHistoryReader['listRunSummaries']>[0], 'limit' | 'before'>;
const BLOB_COLUMNS = [
  'workflow_definition_snapshot',
  'input_json',
  'output_json',
  'error_json',
  'trigger_metadata',
  'agent_snapshot',
];

describe('the run-history reads of the Home browsers (ADR-0140 §4)', () => {
  let client: DbClient;
  let reader: RunHistoryReader;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    reader = createRunHistoryReader(client.db);
    seedWorkflow('wf-a', 'alpha');
    seedWorkflow('wf-b', 'beta');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    client.sqlite.close();
  });

  function seedWorkflow(id: string, slug: string): void {
    client.db
      .insert(workflows)
      .values({ id, name: slug, slug, definition: '{}', createdAt: T0, updatedAt: T0 })
      .run();
  }

  function seedRun(
    id: string,
    createdAt: number,
    extra: {
      readonly workflowId?: string;
      readonly projectRoot?: string | null;
      readonly status?: RunStatus;
      readonly deletedAt?: number;
      readonly inputJson?: string;
      readonly outputJson?: string;
      readonly errorJson?: string;
    } = {},
  ): void {
    client.db
      .insert(runs)
      .values({
        id,
        workflowId: extra.workflowId ?? 'wf-a',
        workflowDefinitionSnapshot: '{"snapshot":"frozen"}',
        projectRoot: extra.projectRoot === undefined ? null : extra.projectRoot,
        status: extra.status ?? 'completed',
        ...(extra.deletedAt === undefined ? {} : { deletedAt: extra.deletedAt }),
        ...(extra.inputJson === undefined ? {} : { inputJson: extra.inputJson }),
        ...(extra.outputJson === undefined ? {} : { outputJson: extra.outputJson }),
        ...(extra.errorJson === undefined ? {} : { errorJson: extra.errorJson }),
        createdAt,
        updatedAt: createdAt,
      })
      .run();
  }

  /** The SQL every statement prepared while `fn` runs — what a read actually asks SQLite. */
  function statementsOf(fn: () => unknown): string[] {
    const spy = vi.spyOn(client.sqlite, 'prepare');
    try {
      fn();
      return spy.mock.calls.map(([source]) => source);
    } finally {
      spy.mockRestore();
    }
  }

  /** The column names of a statement's SELECT list (quotes and table qualifiers removed). */
  function selectedColumns(sql: string): string[] {
    const list = /^select\s+(.*?)\s+from\s/isu.exec(sql)?.[1];
    if (list === undefined) throw new Error(`not a SELECT: ${sql}`);
    return list
      .split(',')
      .map((column) => (column.trim().split('.').at(-1) ?? '').replaceAll('"', ''));
  }

  /** Walk the whole list page by page, exactly as a browser does, and return every id in the order read. */
  function walk(pageSize: number, filter: SummaryFilter = {}): string[] {
    const ids: string[] = [];
    let before: { createdAt: number; id: string } | undefined;
    for (let guard = 0; guard < 200; guard++) {
      const page = reader.listRunSummaries({
        ...filter,
        limit: pageSize,
        ...(before === undefined ? {} : { before }),
      });
      const last = page.at(-1);
      if (last === undefined) return ids;
      ids.push(...page.map((row) => row.id));
      before = { createdAt: isoToEpochMs(last.createdAt), id: last.id };
    }
    throw new Error('the page walk did not terminate');
  }

  describe('listRunSummaries', () => {
    it('lists newest first by (created_at, id), excluding soft-deleted runs', () => {
      seedRun('r-old', T0);
      seedRun('r-new', T0 + 5000);
      seedRun('r-tie-a', T0 + 1000);
      seedRun('r-tie-b', T0 + 1000);
      seedRun('r-gone', T0 + 9000, { deletedAt: T0 + 9500 });

      const page = reader.listRunSummaries({ limit: 10 });
      expect(page.map((row) => row.id)).toEqual(['r-new', 'r-tie-b', 'r-tie-a', 'r-old']);
      expect(page[0]).toMatchObject({
        id: 'r-new',
        workflowId: 'wf-a',
        status: 'completed',
        createdAt: new Date(T0 + 5000).toISOString(),
      });
    });

    it('pages by keyset across runs that share a created_at, repeating and skipping none', () => {
      // Five runs on one millisecond, two on a newer one and one older, so a page boundary falls INSIDE a tie.
      for (const id of ['a', 'b', 'c', 'd', 'e']) seedRun(`tie-${id}`, T0 + 1000);
      for (const id of ['f', 'g']) seedRun(`new-${id}`, T0 + 2000);
      seedRun('old-h', T0 + 500);
      const everything = reader.listRunSummaries({ limit: 100 }).map((row) => row.id);
      expect(everything).toEqual([
        'new-g',
        'new-f',
        'tie-e',
        'tie-d',
        'tie-c',
        'tie-b',
        'tie-a',
        'old-h',
      ]);

      for (const pageSize of [1, 2, 3, 5, 7]) {
        expect(walk(pageSize), `page size ${pageSize}`).toEqual(everything);
      }
    });

    it('treats the cursor as strictly after (createdAt, id), not at or before it', () => {
      seedRun('x-1', T0);
      seedRun('x-2', T0);
      seedRun('x-3', T0);
      expect(
        reader
          .listRunSummaries({ limit: 10, before: { createdAt: T0, id: 'x-2' } })
          .map((row) => row.id),
      ).toEqual(['x-1']);
      expect(reader.listRunSummaries({ limit: 10, before: { createdAt: T0, id: 'x-1' } })).toEqual(
        [],
      );
      expect(
        reader
          .listRunSummaries({ limit: 10, before: { createdAt: T0 + 1, id: 'x-0' } })
          .map((row) => row.id),
      ).toEqual(['x-3', 'x-2', 'x-1']);
    });

    it('filters by status, project root and workflow, alone and together, and pages each filter', () => {
      seedRun('p1-ok', T0 + 1, { projectRoot: '/work/p1', status: 'completed' });
      seedRun('p1-bad', T0 + 2, { projectRoot: '/work/p1', status: 'failed' });
      seedRun('p2-bad', T0 + 3, { projectRoot: '/work/p2', status: 'failed', workflowId: 'wf-b' });
      seedRun('p1-b', T0 + 4, { projectRoot: '/work/p1', workflowId: 'wf-b' });
      seedRun('nowhere', T0 + 5);

      const ids = (opts: SummaryFilter) =>
        reader.listRunSummaries({ limit: 10, ...opts }).map((row) => row.id);
      expect(ids({ projectRoot: '/work/p1' })).toEqual(['p1-b', 'p1-bad', 'p1-ok']);
      expect(ids({ status: 'failed' })).toEqual(['p2-bad', 'p1-bad']);
      expect(ids({ workflowId: 'wf-b' })).toEqual(['p1-b', 'p2-bad']);
      expect(ids({ projectRoot: '/work/p1', status: 'failed' })).toEqual(['p1-bad']);
      expect(ids({ projectRoot: '/work/p1', workflowId: 'wf-b', status: 'completed' })).toEqual([
        'p1-b',
      ]);
      expect(ids({ projectRoot: '/work/none' })).toEqual([]);
      expect(walk(1, { projectRoot: '/work/p1' })).toEqual(['p1-b', 'p1-bad', 'p1-ok']);
    });

    it('carries the project root when the run recorded one and omits it otherwise', () => {
      seedRun('with', T0 + 1, { projectRoot: '/work/p1' });
      seedRun('without', T0);
      const [first, second] = reader.listRunSummaries({ limit: 2 });
      expect(first).toMatchObject({ id: 'with', projectRoot: '/work/p1' });
      expect(second).toBeDefined();
      expect(second).not.toHaveProperty('projectRoot');
    });

    it('rejects a limit that is not a finite positive integer, with a typed error', () => {
      seedRun('r', T0);
      for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        let refusal: unknown;
        try {
          reader.listRunSummaries({ limit });
        } catch (error) {
          refusal = error;
        }
        expect(isRunHistoryReadError(refusal), `limit ${String(limit)}`).toBe(true);
        expect(refusal).toMatchObject({ code: 'invalid_limit' });
      }
    });

    it('clamps a limit above the page maximum', () => {
      client.db.transaction((tx) => {
        for (let index = 0; index < MAX_RUN_SUMMARY_PAGE + 5; index++) {
          tx.insert(runs)
            .values({
              id: `bulk-${String(index).padStart(4, '0')}`,
              workflowId: 'wf-a',
              workflowDefinitionSnapshot: '{}',
              createdAt: T0 + index,
              updatedAt: T0 + index,
            })
            .run();
        }
      });
      expect(reader.listRunSummaries({ limit: 10_000 })).toHaveLength(MAX_RUN_SUMMARY_PAGE);
      expect(reader.listRunSummaries({ limit: MAX_RUN_SUMMARY_PAGE })).toHaveLength(
        MAX_RUN_SUMMARY_PAGE,
      );
      expect(reader.listRunSummaries({ limit: 7 })).toHaveLength(7);
    });

    it('rejects a malformed cursor with a typed error', () => {
      for (const before of [
        { createdAt: 1.5, id: 'x' },
        { createdAt: Number.NaN, id: 'x' },
        { createdAt: 1, id: '' },
      ]) {
        let refusal: unknown;
        try {
          reader.listRunSummaries({ limit: 5, before });
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toMatchObject({ code: 'invalid_cursor' });
      }
    });

    it('selects only summary columns, never the snapshot or a JSON document', () => {
      seedRun('r', T0, {
        inputJson: '{"secret":"x"}',
        outputJson: '{"o":1}',
        errorJson: '{"e":1}',
      });
      const statements = statementsOf(() => {
        reader.listRunSummaries({ limit: 5 });
        reader.listRunSummaries({
          limit: 5,
          before: { createdAt: T0 + 1, id: 'z' },
          status: 'completed',
          projectRoot: '/work',
          workflowId: 'wf-a',
        });
      });
      expect(statements).toHaveLength(2);
      for (const sql of statements) {
        expect(selectedColumns(sql).sort()).toEqual(
          [
            'id',
            'workflow_id',
            'project_root',
            'status',
            'execution_mode',
            'trigger_type',
            'started_at',
            'completed_at',
            'total_input_tokens',
            'total_output_tokens',
            'total_cost_microcents',
            'created_at',
            'updated_at',
          ].sort(),
        );
        for (const column of BLOB_COLUMNS) expect(sql).not.toContain(column);
      }
      // And the record a caller holds has none of them either.
      const [row]: RunSummaryRecord[] = reader.listRunSummaries({ limit: 1 });
      for (const key of ['workflowDefinitionSnapshot', 'inputJson', 'outputJson', 'errorJson']) {
        expect(row).not.toHaveProperty(key);
      }
    });
  });

  describe('loadRunDetail', () => {
    it('returns the run with its input, output and error JSON exactly as stored', () => {
      seedRun('r-1', T0, {
        projectRoot: '/work/p1',
        status: 'failed',
        inputJson: '{"topic":"x"}',
        outputJson: '{"partial":true}',
        errorJson: '{"code":"internal"}',
      });
      const detail = reader.loadRunDetail('r-1');
      expect(detail).toMatchObject({
        id: 'r-1',
        status: 'failed',
        projectRoot: '/work/p1',
        inputJson: '{"topic":"x"}',
        outputJson: '{"partial":true}',
        errorJson: '{"code":"internal"}',
      });
      expect(detail).not.toHaveProperty('workflowDefinitionSnapshot');
      const statements = statementsOf(() => reader.loadRunDetail('r-1'));
      expect(statements).toHaveLength(1);
      expect(statements[0]).not.toContain('workflow_definition_snapshot');
    });

    it('omits an output and an error the run does not have, and defaults the input to {}', () => {
      seedRun('r-2', T0);
      const detail = reader.loadRunDetail('r-2');
      expect(detail?.inputJson).toBe('{}');
      expect(detail).not.toHaveProperty('outputJson');
      expect(detail).not.toHaveProperty('errorJson');
      expect(detail).not.toHaveProperty('projectRoot');
    });

    it('does not return a soft-deleted or an unknown run', () => {
      seedRun('r-3', T0, { deletedAt: T0 + 1 });
      expect(reader.loadRunDetail('r-3')).toBeUndefined();
      expect(reader.loadRunDetail('missing')).toBeUndefined();
    });
  });

  describe('listStepSummaries and loadStepDetail', () => {
    function seedStep(
      runId: string,
      nodeId: string,
      attempt: number,
      createdAt: number,
      extra: {
        readonly status?: 'running' | 'completed' | 'failed';
        readonly outputJson?: string;
        readonly errorJson?: string;
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly costMicrocents?: number;
      } = {},
    ): void {
      client.db
        .insert(stepExecutions)
        .values({
          id: `${runId}-${nodeId}-${attempt}`,
          runId,
          nodeId,
          nodeType: 'agent',
          attemptNumber: attempt,
          status: extra.status ?? 'completed',
          inputJson: '{"rendered":"template-secret"}',
          ...(extra.outputJson === undefined ? {} : { outputJson: extra.outputJson }),
          ...(extra.errorJson === undefined ? {} : { errorJson: extra.errorJson }),
          startedAt: createdAt,
          completedAt: createdAt + 5,
          durationMs: 5,
          inputTokens: extra.inputTokens ?? 0,
          outputTokens: extra.outputTokens ?? 0,
          costMicrocents: extra.costMicrocents ?? 0,
          createdAt,
          updatedAt: createdAt,
        })
        .run();
    }

    it('lists one row per attempt in execution order with the token counts, and no document column', () => {
      seedRun('r', T0);
      seedStep('r', 'n1', 1, T0 + 10, { inputTokens: 10, outputTokens: 20, costMicrocents: 300 });
      // Two attempts of one node, plus a node that started in the same millisecond as the second attempt.
      seedStep('r', 'n2', 1, T0 + 20, { status: 'failed', errorJson: '{"code":"x"}' });
      seedStep('r', 'n2', 2, T0 + 30, { outputJson: '{"answer":"long output"}' });
      seedStep('r', 'n3', 1, T0 + 30, { status: 'running' });

      const steps = reader.listStepSummaries('r');
      expect(steps.map((step) => `${step.nodeId}#${step.attemptNumber}`)).toEqual([
        'n1#1',
        'n2#1',
        'n2#2',
        'n3#1',
      ]);
      expect(steps[0]).toMatchObject({
        nodeId: 'n1',
        nodeType: 'agent',
        status: 'completed',
        durationMs: 5,
        costMicrocents: 300,
        inputTokens: 10,
        outputTokens: 20,
        startedAt: new Date(T0 + 10).toISOString(),
      });
      for (const step of steps) {
        for (const key of ['inputJson', 'outputJson', 'errorJson', 'agentSnapshot']) {
          expect(step).not.toHaveProperty(key);
        }
      }
      expect(reader.listStepSummaries('unknown')).toEqual([]);

      const [statement] = statementsOf(() => reader.listStepSummaries('r'));
      expect(statement).toBeDefined();
      expect(selectedColumns(statement ?? '').sort()).toEqual(
        [
          'node_id',
          'node_type',
          'status',
          'attempt_number',
          'started_at',
          'completed_at',
          'duration_ms',
          'cost_microcents',
          'input_tokens',
          'output_tokens',
        ].sort(),
      );
      for (const column of BLOB_COLUMNS) expect(statement).not.toContain(column);
    });

    it('loads one attempt with its output, error and token columns', () => {
      seedRun('r', T0);
      seedStep('r', 'n1', 1, T0 + 10, { status: 'failed', errorJson: '{"code":"first"}' });
      seedStep('r', 'n1', 2, T0 + 20, {
        outputJson: '{"answer":"second"}',
        inputTokens: 7,
        outputTokens: 9,
        costMicrocents: 55,
      });

      expect(reader.loadStepDetail('r', 'n1', 1)).toMatchObject({
        nodeId: 'n1',
        attemptNumber: 1,
        status: 'failed',
        errorJson: '{"code":"first"}',
        cachedTokens: 0,
      });
      const second = reader.loadStepDetail('r', 'n1', 2);
      expect(second).toMatchObject({
        attemptNumber: 2,
        outputJson: '{"answer":"second"}',
        inputTokens: 7,
        outputTokens: 9,
        costMicrocents: 55,
      });
      expect(second).not.toHaveProperty('errorJson');
      // The recorded input is the rendered template, which can be secret-derived and which no surface shows.
      expect(second).not.toHaveProperty('inputJson');
      expect(reader.loadStepDetail('r', 'n1', 3)).toBeUndefined();
      expect(reader.loadStepDetail('r', 'ghost', 1)).toBeUndefined();
      expect(reader.loadStepDetail('other', 'n1', 1)).toBeUndefined();
    });
  });

  describe('loadRunEventsAfter — the poll tail', () => {
    const insertEvent = (runId: string, seq: number, event?: Record<string, unknown>): void => {
      const body =
        event ??
        RunEventSchema.parse({
          type: 'budget:warning',
          runId,
          timestamp: new Date(T0).toISOString(),
          sequenceNumber: seq,
          spentMicrocents: seq,
          limitMicrocents: 1000,
          thresholdPct: 50,
        });
      client.db
        .insert(runEvents)
        .values({
          id: `${runId}-${seq}`,
          runId,
          seq,
          eventType: typeof body.type === 'string' ? body.type : 'unknown',
          payloadJson: JSON.stringify(body),
          ts: T0,
        })
        .run();
    };

    /** A row a NEWER binary wrote: an event type this binary has never heard of. */
    const insertNewerRow = (runId: string, seq: number): void =>
      insertEvent(runId, seq, { type: 'future:event', runId, sequenceNumber: seq });

    it('returns the events after the cursor, in seq order, up to the limit', () => {
      seedRun('r', T0);
      for (let seq = 0; seq < 6; seq++) insertEvent('r', seq);

      const all = reader.loadRunEventsAfter('r', -1, 100);
      expect(all.events.map((event) => event.sequenceNumber)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(all.scannedThroughSeq).toBe(5);
      expect(all.skipped).toEqual([]);

      const head = reader.loadRunEventsAfter('r', -1, 2);
      expect(head.events.map((event) => event.sequenceNumber)).toEqual([0, 1]);
      expect(head.scannedThroughSeq).toBe(1);

      const rest = reader.loadRunEventsAfter('r', head.scannedThroughSeq, 100);
      expect(rest.events.map((event) => event.sequenceNumber)).toEqual([2, 3, 4, 5]);
      expect(rest.scannedThroughSeq).toBe(5);
    });

    it('keeps the cursor where it was when there is nothing new, and never reads another run', () => {
      seedRun('r', T0);
      seedRun('other', T0);
      insertEvent('r', 0);
      insertEvent('other', 1);
      expect(reader.loadRunEventsAfter('r', 0, 10)).toEqual({
        events: [],
        scannedThroughSeq: 0,
        skipped: [],
      });
      expect(reader.loadRunEventsAfter('missing', 4, 10).scannedThroughSeq).toBe(4);
    });

    it('advances scannedThroughSeq over a trailing row of a newer type, so a cursor cannot park behind it', () => {
      seedRun('r', T0);
      insertEvent('r', 0);
      insertEvent('r', 1);
      insertNewerRow('r', 2); // the log's TAIL is a row this binary cannot read

      const first = reader.loadRunEventsAfter('r', -1, 10);
      expect(first.events.map((event) => event.sequenceNumber)).toEqual([0, 1]);
      expect(first.skipped).toEqual([{ sequenceNumber: 2, type: 'future:event' }]);
      expect(first.scannedThroughSeq).toBe(2); // NOT 1, the last event's seq

      // The caller's next poll starts at the scanned mark and finds nothing, instead of re-reading row 2 forever.
      const next = reader.loadRunEventsAfter('r', first.scannedThroughSeq, 10);
      expect(next).toEqual({ events: [], scannedThroughSeq: 2, skipped: [] });

      // And a later readable event is still found after it.
      insertEvent('r', 3);
      expect(
        reader
          .loadRunEventsAfter('r', next.scannedThroughSeq, 10)
          .events.map((event) => event.sequenceNumber),
      ).toEqual([3]);
    });

    it('stops at the limit-th event and leaves later rows, skipped or not, for the next call', () => {
      seedRun('r', T0);
      insertEvent('r', 0);
      insertEvent('r', 1);
      insertNewerRow('r', 2);
      const page = reader.loadRunEventsAfter('r', -1, 2);
      expect(page.events).toHaveLength(2);
      expect(page.scannedThroughSeq).toBe(1);
      expect(page.skipped).toEqual([]);
      expect(reader.loadRunEventsAfter('r', 1, 2)).toMatchObject({
        events: [],
        scannedThroughSeq: 2,
        skipped: [{ sequenceNumber: 2, type: 'future:event' }],
      });
    });

    it('does not return an empty page while readable rows remain behind a long run of skipped ones', () => {
      seedRun('r', T0);
      // More skipped rows than one statement's batch, so the read has to loop to find the first event.
      client.db.transaction(() => {
        for (let seq = 0; seq < 300; seq++) insertNewerRow('r', seq);
      });
      insertEvent('r', 300);
      insertEvent('r', 301);

      const page = reader.loadRunEventsAfter('r', -1, 1);
      expect(page.events.map((event) => event.sequenceNumber)).toEqual([300]);
      expect(page.scannedThroughSeq).toBe(300);
      expect(page.skipped).toHaveLength(300);
    });

    it('throws CorruptRunEventError on a damaged row, as the other reads do', () => {
      seedRun('r', T0);
      insertEvent('r', 0);
      client.db
        .insert(runEvents)
        .values({
          id: 'r-damaged',
          runId: 'r',
          seq: 1,
          eventType: 'budget:warning',
          payloadJson: '{"type":"budget:warning","sequenceNumber":1}',
          ts: T0,
        })
        .run();
      let refusal: unknown;
      try {
        reader.loadRunEventsAfter('r', -1, 10);
      } catch (error) {
        refusal = error;
      }
      expect(isCorruptRunEventError(refusal)).toBe(true);
    });

    it('validates its arguments and clamps the limit', () => {
      for (const limit of [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => reader.loadRunEventsAfter('r', -1, limit)).toThrow(/limit/u);
      }
      for (const afterSeq of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => reader.loadRunEventsAfter('r', afterSeq, 5)).toThrow(/afterSeq/u);
      }
      seedRun('r', T0);
      client.db.transaction(() => {
        for (let seq = 0; seq < MAX_RUN_TAIL_EVENTS + 5; seq++) insertEvent('r', seq);
      });
      const page = reader.loadRunEventsAfter('r', -1, 1_000_000);
      expect(page.events).toHaveLength(MAX_RUN_TAIL_EVENTS);
      expect(page.scannedThroughSeq).toBe(MAX_RUN_TAIL_EVENTS - 1);
    });
  });

  describe('loadRunLeases', () => {
    const lease = (runId: string, owner: string, generation: number, expiresAt: number): void => {
      client.db
        .insert(runLeases)
        .values({ runId, ownerId: owner, generation, expiresAt, createdAt: T0, updatedAt: T0 })
        .run();
    };

    it('returns the leases that exist and omits runs without one', () => {
      seedRun('held', T0);
      seedRun('expired', T0);
      seedRun('free', T0);
      lease('held', 'owner-1', 3, T0 + 60_000);
      lease('expired', 'owner-2', 1, T0 - 1);

      const leases = reader.loadRunLeases(['held', 'expired', 'free', 'unknown']);
      expect([...leases.keys()].sort()).toEqual(['expired', 'held']);
      expect(leases.get('held')).toEqual({
        ownerId: 'owner-1',
        generation: 3,
        expiresAt: T0 + 60_000,
      });
      expect(leases.get('expired')).toEqual({
        ownerId: 'owner-2',
        generation: 1,
        expiresAt: T0 - 1,
      });
    });

    it('answers an empty input without a query, accepts exactly the maximum and refuses more', () => {
      expect(statementsOf(() => reader.loadRunLeases([]))).toEqual([]);
      expect(reader.loadRunLeases([]).size).toBe(0);
      const ids = Array.from({ length: MAX_RUN_LEASE_IDS }, (_, index) => `run-${index}`);
      expect(reader.loadRunLeases(ids).size).toBe(0);
      let refusal: unknown;
      try {
        reader.loadRunLeases([...ids, 'one-too-many']);
      } catch (error) {
        refusal = error;
      }
      expect(isRunHistoryReadError(refusal)).toBe(true);
      expect(refusal).toMatchObject({ code: 'too_many_run_ids' });
    });
  });

  describe('loadLatestRunPerWorkflowInProject', () => {
    it('keeps the newest run per workflow within one project and ignores every other project', () => {
      seedRun('a-p1-old', T0 + 1, { projectRoot: '/p1' });
      seedRun('a-p1-new', T0 + 2, { projectRoot: '/p1' });
      seedRun('a-p2-newest', T0 + 9, { projectRoot: '/p2' }); // newer, but another project
      seedRun('b-p1', T0 + 3, { projectRoot: '/p1', workflowId: 'wf-b' });
      seedRun('b-p1-gone', T0 + 8, { projectRoot: '/p1', workflowId: 'wf-b', deletedAt: T0 + 9 });
      seedRun('b-p2', T0 + 4, { projectRoot: '/p2', workflowId: 'wf-b' });
      seedRun('a-unscoped', T0 + 10); // no recorded project at all

      const inProject = new Map(
        reader.loadLatestRunPerWorkflowInProject('/p1').map((row) => [row.slug, row.lastRun.id]),
      );
      expect(inProject).toEqual(
        new Map([
          ['alpha', 'a-p1-new'],
          ['beta', 'b-p1'],
        ]),
      );
      expect(
        reader
          .loadLatestRunPerWorkflowInProject('/p2')
          .map((row) => row.lastRun.id)
          .sort(),
      ).toEqual(['a-p2-newest', 'b-p2']);
      expect(reader.loadLatestRunPerWorkflowInProject('/nowhere')).toEqual([]);
      // The unscoped overlay is untouched: it still sees every project.
      expect(
        new Map(reader.loadLatestRunPerWorkflow().map((row) => [row.slug, row.lastRun.id])),
      ).toEqual(
        new Map([
          ['alpha', 'a-unscoped'],
          ['beta', 'b-p2'],
        ]),
      );
    });
  });
});
