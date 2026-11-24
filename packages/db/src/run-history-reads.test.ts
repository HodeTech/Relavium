import { RunEventSchema, type RunStatus } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  createRunHistoryReader,
  isCorruptRunEventError,
  isRunHistoryReadError,
  MAX_RUN_DETAIL_DOCUMENT_BYTES,
  MAX_RUN_LEASE_IDS,
  MAX_RUN_STEP_SUMMARIES,
  MAX_RUN_SUMMARY_PAGE,
  MAX_RUN_TAIL_EVENTS,
  MAX_RUN_TAIL_SCAN_ROWS,
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
/** The columns of a run LIST row (`runSummaryColumns`): the only `runs` columns a list read may select. */
const SUMMARY_COLUMNS = [
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
];
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

  /**
   * What a detail statement still names of `column` once the size-gated expressions are removed: the gate
   * (`CASE WHEN length(CAST(c AS BLOB)) <= bound THEN c END`) and the byte length (`length(CAST(c AS BLOB))`).
   * Anything left is a read of the document that is not behind the gate, so a test expects the column to be gone.
   * The table qualifier is dropped first (drizzle writes a column qualified in one place and bare in another).
   */
  function ungatedReadsOf(sql: string, table: string, column: string): string[] {
    const ref = `"${column}"`;
    const bare = sql.replaceAll(`"${table}".`, '');
    const gate = `CASE WHEN length(CAST(${ref} AS BLOB)) <= ${MAX_RUN_DETAIL_DOCUMENT_BYTES} THEN ${ref} END`;
    const length = `length(CAST(${ref} AS BLOB))`;
    return bare.replaceAll(gate, '').replaceAll(length, '').match(new RegExp(ref, 'gu')) ?? [];
  }

  /** A JSON text of exactly `bytes` UTF-8 bytes (`{"v":"aaa..."}`), so a bound test sits on the byte. */
  function documentOfBytes(bytes: number): string {
    const frame = '{"v":""}'.length;
    return `{"v":"${'a'.repeat(bytes - frame)}"}`;
  }

  /** Every distinct `runs` column a statement names (`"runs"."x"`), sorted — what it reads, not only what it returns. */
  function runsColumnsNamedBy(sql: string): string[] {
    const named = new Set<string>();
    for (const match of sql.matchAll(/"runs"\."([a-z_]+)"/gu)) {
      const column = match[1];
      if (column !== undefined) named.add(column);
    }
    return [...named].sort((a, b) => a.localeCompare(b));
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

    it('pages a tie across a page boundary under the status filter and under the workflow filter', () => {
      // Eight runs on ONE millisecond, alternating status and workflow, with one newer and one older run inside
      // the filters, so a boundary falls INSIDE the tie at page sizes 1, 2 and 3 for each filtered set. The
      // expectations are written out, not read back from the reader.
      for (let index = 0; index < 8; index++) {
        seedRun(`tie-${index}`, T0 + 1000, {
          status: index % 2 === 0 ? 'failed' : 'completed',
          workflowId: index % 3 === 0 ? 'wf-b' : 'wf-a',
        });
      }
      seedRun('new-failed-b', T0 + 2000, { status: 'failed', workflowId: 'wf-b' });
      seedRun('old-failed-a', T0 + 500, { status: 'failed', workflowId: 'wf-a' });
      seedRun('new-completed-a', T0 + 3000, { status: 'completed', workflowId: 'wf-a' });

      const expectations: readonly [string, SummaryFilter, string[]][] = [
        [
          'status failed',
          { status: 'failed' },
          ['new-failed-b', 'tie-6', 'tie-4', 'tie-2', 'tie-0', 'old-failed-a'],
        ],
        ['workflow wf-b', { workflowId: 'wf-b' }, ['new-failed-b', 'tie-6', 'tie-3', 'tie-0']],
        [
          'status failed in workflow wf-b',
          { status: 'failed', workflowId: 'wf-b' },
          ['new-failed-b', 'tie-6', 'tie-0'],
        ],
      ];
      for (const [name, filter, expected] of expectations) {
        const whole = reader.listRunSummaries({ ...filter, limit: 100 }).map((row) => row.id);
        expect(whole, name).toEqual(expected);
        for (const pageSize of [1, 2, 3]) {
          expect(walk(pageSize, filter), `${name}, page size ${pageSize}`).toEqual(expected);
        }
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

    it('serves exactly the page maximum and refuses a limit above it, never clamping it', () => {
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
      expect(MAX_RUN_SUMMARY_PAGE).toBe(200);
      expect(reader.listRunSummaries({ limit: MAX_RUN_SUMMARY_PAGE })).toHaveLength(
        MAX_RUN_SUMMARY_PAGE,
      );
      expect(reader.listRunSummaries({ limit: 7 })).toHaveLength(7);
      // One past the maximum is a refusal, exactly like `loadRunLeases` past its id cap: a clamped page would
      // read as "the list ended" when 5 more rows exist.
      for (const limit of [MAX_RUN_SUMMARY_PAGE + 1, 10_000, Number.MAX_SAFE_INTEGER]) {
        let refusal: unknown;
        try {
          reader.listRunSummaries({ limit });
        } catch (error) {
          refusal = error;
        }
        expect(isRunHistoryReadError(refusal), `limit ${String(limit)}`).toBe(true);
        expect(refusal).toMatchObject({ code: 'invalid_limit' });
        if (refusal instanceof Error) expect(refusal.message).not.toContain(String(limit));
      }
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
        expect(selectedColumns(sql).sort()).toEqual([...SUMMARY_COLUMNS].sort());
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
    it('returns the run with its output and error JSON exactly as stored, and their byte lengths', () => {
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
        outputJson: '{"partial":true}',
        outputByteLength: 16,
        errorJson: '{"code":"internal"}',
        errorByteLength: 19,
      });
      expect(detail).not.toHaveProperty('workflowDefinitionSnapshot');
      const statements = statementsOf(() => reader.loadRunDetail('r-1'));
      expect(statements).toHaveLength(1);
      expect(statements[0]).not.toContain('workflow_definition_snapshot');
    });

    it('has no inputJson: the run inputs are not read, selected or returned', () => {
      seedRun('r-in', T0, { inputJson: '{"secret":"sk-live"}', outputJson: '{"o":1}' });
      const detail = reader.loadRunDetail('r-in');
      expect(detail).not.toHaveProperty('inputJson');
      expect(JSON.stringify(detail)).not.toContain('sk-live');
      const [statement] = statementsOf(() => reader.loadRunDetail('r-in'));
      expect(statement).not.toContain('input_json');
    });

    it('says null for an output and an error the run does not have', () => {
      seedRun('r-2', T0);
      const detail = reader.loadRunDetail('r-2');
      expect(detail).toMatchObject({
        outputJson: null,
        outputByteLength: null,
        errorJson: null,
        errorByteLength: null,
      });
      expect(detail).not.toHaveProperty('projectRoot');
    });

    it('does not return a soft-deleted or an unknown run', () => {
      seedRun('r-3', T0, { deletedAt: T0 + 1 });
      expect(reader.loadRunDetail('r-3')).toBeUndefined();
      expect(reader.loadRunDetail('missing')).toBeUndefined();
    });

    describe('the size gate (1 MiB, applied in SQL)', () => {
      const atBound = documentOfBytes(MAX_RUN_DETAIL_DOCUMENT_BYTES);
      const overBound = documentOfBytes(MAX_RUN_DETAIL_DOCUMENT_BYTES + 1);

      it('states the bound as exactly 1 MiB', () => {
        expect(MAX_RUN_DETAIL_DOCUMENT_BYTES).toBe(1_048_576);
        expect(Buffer.byteLength(atBound, 'utf8')).toBe(1_048_576);
        expect(Buffer.byteLength(overBound, 'utf8')).toBe(1_048_577);
      });

      it('returns an output of exactly 1 MiB as text and one byte more as null with its length', () => {
        seedRun('at', T0, { outputJson: atBound });
        seedRun('over', T0 + 1, { outputJson: overBound });
        expect(reader.loadRunDetail('at')).toMatchObject({
          outputJson: atBound,
          outputByteLength: 1_048_576,
        });
        expect(reader.loadRunDetail('over')).toMatchObject({
          outputJson: null,
          outputByteLength: 1_048_577,
        });
      });

      it('gates error_json the same way, independently of the output', () => {
        seedRun('e-at', T0, { errorJson: atBound, outputJson: overBound });
        seedRun('e-over', T0 + 1, { errorJson: overBound, outputJson: '{"o":1}' });
        expect(reader.loadRunDetail('e-at')).toMatchObject({
          errorJson: atBound,
          errorByteLength: 1_048_576,
          outputJson: null,
          outputByteLength: 1_048_577,
        });
        expect(reader.loadRunDetail('e-over')).toMatchObject({
          errorJson: null,
          errorByteLength: 1_048_577,
          outputJson: '{"o":1}',
          outputByteLength: 7,
        });
      });

      it('counts bytes, not characters: a multi-byte document under 1 MiB of characters is refused', () => {
        // 400,000 characters of 3 bytes each: 1,200,000 bytes (over the bound), 400,000 characters (under it).
        const wide = `"${'€'.repeat(400_000)}"`;
        seedRun('wide', T0, { outputJson: wide });
        expect(reader.loadRunDetail('wide')).toMatchObject({
          outputJson: null,
          outputByteLength: 1_200_002,
        });
        // The same count of characters in one-byte text is well inside the bound and comes back whole.
        const narrow = `"${'e'.repeat(400_000)}"`;
        seedRun('narrow', T0 + 1, { outputJson: narrow });
        expect(reader.loadRunDetail('narrow')).toMatchObject({
          outputJson: narrow,
          outputByteLength: 400_002,
        });
      });

      it('never selects a document outside the gate: no raw output_json, error_json or input_json column', () => {
        seedRun('s', T0, { outputJson: '{"o":1}', errorJson: '{"e":1}' });
        const [statement] = statementsOf(() => reader.loadRunDetail('s'));
        expect(statement).toBeDefined();
        const sqlText = statement ?? '';
        // Both documents are present in the statement behind the gate, and nothing mentions them outside it.
        for (const column of ['output_json', 'error_json']) {
          expect(sqlText).toContain(
            `CASE WHEN length(CAST("${column}" AS BLOB)) <= 1048576 THEN "${column}" END`,
          );
        }
        expect(ungatedReadsOf(sqlText, 'runs', 'output_json')).toEqual([]);
        expect(ungatedReadsOf(sqlText, 'runs', 'error_json')).toEqual([]);
        expect(sqlText).not.toContain('input_json');
        expect(sqlText).not.toContain('workflow_definition_snapshot');
      });
    });
  });

  describe('listStepSummaries and loadStepDetail', () => {
    function seedStep(
      runId: string,
      nodeId: string,
      attempt: number,
      createdAt: number,
      extra: {
        /** Only for a second row of one (run, node, attempt), whose derived id would collide with the first. */
        readonly id?: string;
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
          id: extra.id ?? `${runId}-${nodeId}-${attempt}`,
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

    it('returns at most MAX_RUN_STEP_SUMMARIES rows, the first ones in execution order, and a full list is the signal (PR #102 review: P3)', () => {
      expect(MAX_RUN_STEP_SUMMARIES).toBe(5000);
      seedRun('r', T0);
      seedRun('small', T0);
      client.db.transaction(() => {
        for (let index = 0; index < MAX_RUN_STEP_SUMMARIES + 1; index++) {
          seedStep('r', `n${String(index)}`, 1, T0 + index);
        }
        for (let index = 0; index < 3; index++)
          seedStep('small', `n${String(index)}`, 1, T0 + index);
      });

      const capped = reader.listStepSummaries('r');
      expect(capped).toHaveLength(MAX_RUN_STEP_SUMMARIES);
      // The FIRST rows in execution order, not an arbitrary subset: the cut is at the tail.
      expect(capped[0]?.nodeId).toBe('n0');
      expect(capped.at(-1)?.nodeId).toBe(`n${String(MAX_RUN_STEP_SUMMARIES - 1)}`);
      // A run below the cap is returned whole, so a list of exactly the cap is the only list that may be cut.
      expect(reader.listStepSummaries('small')).toHaveLength(3);
      // The bound is in the statement, not applied after the rows reached JavaScript.
      const [statement] = statementsOf(() => reader.listStepSummaries('r'));
      expect(statement?.toLowerCase()).toContain('limit');
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
        errorByteLength: 16,
        outputJson: null,
        outputByteLength: null,
        cachedTokens: 0,
      });
      const second = reader.loadStepDetail('r', 'n1', 2);
      expect(second).toMatchObject({
        attemptNumber: 2,
        outputJson: '{"answer":"second"}',
        outputByteLength: 19,
        inputTokens: 7,
        outputTokens: 9,
        costMicrocents: 55,
        errorJson: null,
        errorByteLength: null,
      });
      // The recorded input is the rendered template, which can be secret-derived and which no surface shows.
      expect(second).not.toHaveProperty('inputJson');
      expect(reader.loadStepDetail('r', 'n1', 3)).toBeUndefined();
      expect(reader.loadStepDetail('r', 'ghost', 1)).toBeUndefined();
      expect(reader.loadStepDetail('other', 'n1', 1)).toBeUndefined();
    });

    it('returns the latest-inserted row when a re-dispatched node left two rows for one (run, node, attempt)', () => {
      seedRun('r', T0);
      // Both rows share one created_at, so only the insertion order (rowid) can tell the later one apart.
      seedStep('r', 'n1', 1, T0 + 10, { id: 'dup-first', outputJson: '{"v":"first"}' });
      seedStep('r', 'n1', 1, T0 + 10, { id: 'dup-second', outputJson: '{"v":"second"}' });

      expect(reader.loadStepDetail('r', 'n1', 1)).toMatchObject({
        nodeId: 'n1',
        attemptNumber: 1,
        outputJson: '{"v":"second"}',
      });
    });

    describe('the size gate (1 MiB, applied in SQL)', () => {
      const atBound = documentOfBytes(MAX_RUN_DETAIL_DOCUMENT_BYTES);
      const overBound = documentOfBytes(MAX_RUN_DETAIL_DOCUMENT_BYTES + 1);

      it('returns an output of exactly 1 MiB as text and one byte more as null with its length', () => {
        seedRun('r', T0);
        seedStep('r', 'at', 1, T0 + 1, { outputJson: atBound });
        seedStep('r', 'over', 1, T0 + 2, { outputJson: overBound });
        expect(reader.loadStepDetail('r', 'at', 1)).toMatchObject({
          outputJson: atBound,
          outputByteLength: 1_048_576,
        });
        expect(reader.loadStepDetail('r', 'over', 1)).toMatchObject({
          outputJson: null,
          outputByteLength: 1_048_577,
        });
      });

      it('gates error_json the same way, independently of the output', () => {
        seedRun('r', T0);
        seedStep('r', 'at', 1, T0 + 1, { status: 'failed', errorJson: atBound });
        seedStep('r', 'over', 1, T0 + 2, {
          status: 'failed',
          errorJson: overBound,
          outputJson: '{"o":1}',
        });
        expect(reader.loadStepDetail('r', 'at', 1)).toMatchObject({
          errorJson: atBound,
          errorByteLength: 1_048_576,
        });
        expect(reader.loadStepDetail('r', 'over', 1)).toMatchObject({
          errorJson: null,
          errorByteLength: 1_048_577,
          outputJson: '{"o":1}',
          outputByteLength: 7,
        });
      });

      it('counts bytes, not characters', () => {
        seedRun('r', T0);
        const wide = `"${'€'.repeat(400_000)}"`;
        seedStep('r', 'wide', 1, T0 + 1, { outputJson: wide });
        expect(reader.loadStepDetail('r', 'wide', 1)).toMatchObject({
          outputJson: null,
          outputByteLength: 1_200_002,
        });
      });

      it('never selects a document outside the gate: no raw output_json, error_json or input_json column', () => {
        seedRun('r', T0);
        seedStep('r', 'n', 1, T0 + 1, { outputJson: '{"o":1}', errorJson: '{"e":1}' });
        const [statement] = statementsOf(() => reader.loadStepDetail('r', 'n', 1));
        expect(statement).toBeDefined();
        const sqlText = statement ?? '';
        for (const column of ['output_json', 'error_json']) {
          expect(sqlText).toContain(
            `CASE WHEN length(CAST("${column}" AS BLOB)) <= 1048576 THEN "${column}" END`,
          );
        }
        expect(ungatedReadsOf(sqlText, 'step_executions', 'output_json')).toEqual([]);
        expect(ungatedReadsOf(sqlText, 'step_executions', 'error_json')).toEqual([]);
        expect(sqlText).not.toContain('input_json');
        expect(sqlText).not.toContain('agent_snapshot');
      });
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

    describe('the scan cap (PR #102 review: P3)', () => {
      const capped = (rows: number): RunHistoryReader =>
        createRunHistoryReader(client.db, { tailScanRows: rows });

      it('the default cap is a constant far above any log a current writer produces', () => {
        expect(MAX_RUN_TAIL_SCAN_ROWS).toBe(50_000);
      });

      it('stops after exactly the cap, with a cursor the caller continues from, and loses no row', () => {
        seedRun('r', T0);
        // 700 rows this binary cannot read, then two it can: the old read scanned all of them in ONE call.
        client.db.transaction(() => {
          for (let seq = 0; seq < 700; seq++) insertNewerRow('r', seq);
        });
        insertEvent('r', 700);
        insertEvent('r', 701);
        // 300 is not a multiple of the 256-row batch, so the cap is exact only if the last statement is shortened.
        const small = capped(300);

        const first = small.loadRunEventsAfter('r', -1, 10);
        expect(first.events).toEqual([]);
        expect(first.skipped).toHaveLength(300);
        expect(first.scannedThroughSeq).toBe(299);

        const second = small.loadRunEventsAfter('r', first.scannedThroughSeq, 10);
        expect(second.events).toEqual([]);
        expect(second.skipped).toHaveLength(300);
        expect(second.scannedThroughSeq).toBe(599);

        // The third call reaches the readable rows, and the cursor protocol delivered every one of them.
        const third = small.loadRunEventsAfter('r', second.scannedThroughSeq, 10);
        expect(third.events.map((event) => event.sequenceNumber)).toEqual([700, 701]);
        expect(third.skipped).toHaveLength(100);
        expect(third.scannedThroughSeq).toBe(701);

        // A call past the end scans nothing, which is how a caller that read to the end knows it did.
        expect(small.loadRunEventsAfter('r', 701, 10)).toEqual({
          events: [],
          scannedThroughSeq: 701,
          skipped: [],
        });
      });

      it('a log of exactly the cap is read whole in one call, and readable rows never reach the cap', () => {
        seedRun('r', T0);
        for (let seq = 0; seq < 5; seq++) insertEvent('r', seq);
        const page = capped(5).loadRunEventsAfter('r', -1, 100);
        expect(page.events.map((event) => event.sequenceNumber)).toEqual([0, 1, 2, 3, 4]);
        expect(page.scannedThroughSeq).toBe(4);
        // Readable rows stop the call at `limit`, whatever the cap is.
        expect(capped(5).loadRunEventsAfter('r', -1, 2).events).toHaveLength(2);
      });
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

    it('ranks only the summary columns: no snapshot or JSON document passes through the window sort', () => {
      seedRun('big', T0, {
        projectRoot: '/p1',
        status: 'failed',
        inputJson: '{"secret":"x"}',
        outputJson: '{"o":1}',
        errorJson: '{"e":1}',
      });
      const statements = statementsOf(() => reader.loadLatestRunPerWorkflowInProject('/p1'));
      expect(statements).toHaveLength(1);
      const sqlText = statements[0] ?? '';
      expect(sqlText).toContain('row_number()'); // the window statement, not some other one
      for (const column of BLOB_COLUMNS) expect(sqlText).not.toContain(column);
      // Every `runs` column the statement names, in the window CTE or anywhere else: the thirteen summary
      // columns of the list reads, plus `deleted_at` for the soft-delete filter.
      expect(runsColumnsNamedBy(sqlText)).toEqual(
        [...SUMMARY_COLUMNS, 'deleted_at'].sort((a, b) => a.localeCompare(b)),
      );

      const [row] = reader.loadLatestRunPerWorkflowInProject('/p1');
      expect(row).toMatchObject({
        slug: 'alpha',
        lastRun: { id: 'big', status: 'failed', createdAt: new Date(T0).toISOString() },
      });
      for (const key of ['workflowDefinitionSnapshot', 'inputJson', 'outputJson', 'errorJson']) {
        expect(row?.lastRun).not.toHaveProperty(key);
      }
    });
  });
  /**
   * The plans of the two reads whose statements the CLI harness does not plan (the rest are pinned in
   * apps/cli/src/harness/perf-budget.e2e.test.ts). Each plans the statement the reader REALLY prepared — its
   * `?` placeholders bound to NULL, which EXPLAIN ignores — not a mirror of it that could drift and keep passing.
   */
  describe('query plans', () => {
    function planOfRead(read: () => unknown): string[] {
      const statements = statementsOf(read);
      expect(statements).toHaveLength(1);
      const sqlText = statements[0] ?? '';
      const placeholders = sqlText.match(/\?/gu)?.length ?? 0;
      return client.sqlite
        .prepare(`EXPLAIN QUERY PLAN ${sqlText}`)
        .all(...Array.from({ length: placeholders }, () => null))
        .map((row) =>
          typeof row === 'object' &&
          row !== null &&
          'detail' in row &&
          typeof row.detail === 'string'
            ? row.detail
            : '',
        );
    }

    it('loadRunDetail is a primary-key lookup: no scan, no temp b-tree', () => {
      const plan = planOfRead(() => reader.loadRunDetail('run-1')).join('\n');
      expect(plan).toMatch(/SEARCH runs USING INDEX sqlite_autoindex_runs_1 \(id=\?\)/u);
      expect(plan).not.toMatch(/SCAN runs/u);
      expect(plan).not.toContain('TEMP B-TREE');
    });

    it('loadStepDetail is an index lookup on idx_step_exec_run_node even with the size gate in its select list', () => {
      const plan = planOfRead(() => reader.loadStepDetail('run-1', 'n', 1)).join('\n');
      expect(plan).toMatch(/SEARCH step_executions USING INDEX idx_step_exec_run_node/u);
      expect(plan).not.toMatch(/SCAN step_executions/u);
      expect(plan).not.toContain('TEMP B-TREE');
    });

    it('loadLatestRunPerWorkflowInProject reads the project off idx_runs_project_created, and its window sort is the one expected', () => {
      const plan = planOfRead(() => reader.loadLatestRunPerWorkflowInProject('/work/p1')).join(
        '\n',
      );
      // The project filter is an index range, never a scan of every run...
      expect(plan).toMatch(
        /SEARCH runs USING (COVERING )?INDEX idx_runs_project_created \(project_root=\?\)/u,
      );
      expect(plan).not.toMatch(/SCAN runs(?! USING)/u);
      // ...and the per-workflow ranking is a window sort over THAT project's runs (the cost the schema reference
      // states), which is why what passes through it must be summary columns only (the test above).
      expect(plan).toContain('USE TEMP B-TREE FOR ORDER BY');
    });

    it('listRunSummaries filtered by workflow alone reads the workflow off idx_runs_workflow and sorts only the last ORDER BY term, first page and keyset page', () => {
      // `idx_runs_workflow` is (workflow_id, created_at DESC), so the `id DESC` tiebreak costs a sort WITHIN a run of
      // equal `created_at` (SQLite's "LAST TERM") and never over the whole page: the same bound the schema reference
      // states for a status-only filter. The keyset cursor narrows the range on the index; it is not a residual filter.
      const firstPage = planOfRead(() =>
        reader.listRunSummaries({ limit: 20, workflowId: 'wf-a' }),
      ).join('\n');
      const keysetPage = planOfRead(() =>
        reader.listRunSummaries({
          limit: 20,
          workflowId: 'wf-a',
          before: { createdAt: 1_000, id: 'run-1' },
        }),
      ).join('\n');
      expect(firstPage).toContain('SEARCH runs USING INDEX idx_runs_workflow (workflow_id=?)');
      expect(keysetPage).toContain(
        'SEARCH runs USING INDEX idx_runs_workflow (workflow_id=? AND created_at<?)',
      );
      for (const plan of [firstPage, keysetPage]) {
        expect(plan).toContain('USE TEMP B-TREE FOR LAST TERM OF ORDER BY');
        // The whole-page sort is the plan that says the index stopped serving the order.
        expect(plan).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/u);
        expect(plan).not.toMatch(/SCAN runs/u);
      }
    });
  });
});
