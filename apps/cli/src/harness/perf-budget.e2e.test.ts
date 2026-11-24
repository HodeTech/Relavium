import {
  agentSessions,
  createClient,
  createRunHistoryReader,
  runMigrations,
  runs,
  sessionMessages,
  type DbClient,
} from '@relavium/db';
import { asc, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2.5.I S5 — query-shape perf budgets for the CLI's hot read paths (the 2.5.B Home "recent sessions/runs"
 * strips + the `relavium list` reads). Rather than a flaky wall-clock number, this asserts the *shape* of the
 * plan SQLite chooses: the read is served off its intended index with **no filesort** (`USE TEMP B-TREE`) and
 * **no full table SCAN** — the concrete guarantee the store docs claim ("served off `idx_…` (no filesort)").
 * A dropped/renamed index, or an `ORDER BY` the index no longer covers, flips the plan and fails here.
 *
 * (The other §2.5.I perf item — the 80×24 narrow-terminal degrade — already exists and is asserted directly
 * in `render/tui/home-projection.test.ts` (`homeFitsTerminal` / `tooSmallMessage` at the 80×24 boundary), so
 * it needs no new coverage here.)
 */

describe('query-shape perf budgets (2.5.I S5) — the hot reads stay index-served, no filesort', () => {
  let client: DbClient;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
  });

  afterEach(() => {
    client.sqlite.close();
  });

  /** A valid SQLite bind value — narrowed with a runtime guard (no unsafe cast at the DB boundary). */
  function toBindValue(value: unknown): string | number | bigint | Buffer | null {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      Buffer.isBuffer(value)
    ) {
      return value;
    }
    return null; // EXPLAIN ignores the value; a non-primitive param (drizzle never emits one) binds as NULL
  }

  /** Read the `detail` column off an EXPLAIN row via `in`-narrowing — no `as` cast. */
  function detailOf(row: unknown): string {
    return typeof row === 'object' &&
      row !== null &&
      'detail' in row &&
      typeof row.detail === 'string'
      ? row.detail
      : '';
  }

  /** The `EXPLAIN QUERY PLAN` `detail` lines for a drizzle query (its `?`-placeholder SQL + bound params). */
  function planFor(query: { toSQL: () => { sql: string; params: unknown[] } }): string[] {
    const { sql, params } = query.toSQL();
    // The `?` placeholders must still be bound (EXPLAIN ignores their values); validate each at the DB boundary.
    const bind = params.map(toBindValue);
    const rows = client.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bind);
    return rows.map(detailOf);
  }

  /**
   * A read is within budget when the ORDER BY is served off its intended index (no filesort) and the scan is
   * index-backed (no full-table SCAN). The `indexName` pin is the primary guard (a dropped/renamed index fails
   * here); the SCAN regex is belt-and-suspenders and is coupled to modern SQLite's `SCAN <table>` plan wording.
   * (If a future `.select()` narrows to only-indexed columns, SQLite emits `USING COVERING INDEX` — still
   * index-served, but the `USING INDEX` substring would need loosening then.)
   */
  function expectIndexServedNoFilesort(
    plan: string[],
    table: 'agent_sessions' | 'runs' | 'session_messages' | 'run_events' | 'step_executions', // closed union — no computed/metachar table names
    indexName: string,
  ): void {
    const joined = plan.join('\n');
    expect(joined).toMatch(/USING (COVERING )?INDEX/); // an index serves the scan, not a full-table SCAN
    expect(joined).toContain(indexName); // and specifically the intended index — the real teeth of the budget
    expect(joined).not.toMatch(/USE TEMP B-TREE/); // the ORDER BY is index-served — no filesort
    expect(joined).not.toMatch(new RegExp(`SCAN ${table}(?! USING)`)); // no bare full-table scan
  }

  it('listSessions (recent-sessions strip / chat-list) is served off idx_agent_sessions_updated', () => {
    // Mirrors session-store.ts `listSessions` (keep in sync — that query site back-references this budget):
    // non-deleted, most-recently-updated first, id tiebreak. No `.limit` — the plan is identical for the bounded
    // Home strip and the unbounded `chat-list`, so this one case covers both callers.
    const query = client.db
      .select()
      .from(agentSessions)
      .where(isNull(agentSessions.deletedAt))
      .orderBy(desc(agentSessions.updatedAt), desc(agentSessions.id));
    expectIndexServedNoFilesort(planFor(query), 'agent_sessions', 'idx_agent_sessions_updated');
  });

  it('listRuns (recent-runs strip / relavium list) is served off idx_runs_created', () => {
    // Mirrors run-history-store.ts `listRuns` (the no-status branch; keep in sync — back-referenced there):
    // non-deleted, newest-first, id tiebreak. Unbounded — same plan as the bounded Home strip.
    const query = client.db
      .select()
      .from(runs)
      .where(isNull(runs.deletedAt))
      .orderBy(desc(runs.createdAt), desc(runs.id));
    expectIndexServedNoFilesort(planFor(query), 'runs', 'idx_runs_created');
  });

  it('loadFull messages read is one indexed range scan (not a per-message read), served off idx_session_messages_seq', () => {
    // Mirrors session-store.ts `loadMessages` (keep in sync — back-referenced there): one ordered range read of
    // a session's transcript, keyed by session_id. Pinning the (session_id, sequence_number) index + forbidding a
    // temp b-tree is what stops SQLite silently falling to the (session_id, created_at) index with a filesort.
    const filter: SQL = eq(sessionMessages.sessionId, 'sess-1');
    const query = client.db
      .select()
      .from(sessionMessages)
      .where(filter)
      .orderBy(asc(sessionMessages.sequenceNumber));
    expectIndexServedNoFilesort(planFor(query), 'session_messages', 'idx_session_messages_seq');
  });

  // --- the reads the Home's management browsers add (ADR-0140 §4, MVP-8 step 1) ---------------------------
  // These plan the statement the REAL reader issues, not a mirror of it: a mirrored query can drift from the
  // store's and keep passing. The reader runs against the empty migrated database with `prepare` observed, and
  // each captured statement is planned as issued (its `?` placeholders bound to NULL — EXPLAIN ignores values).

  /** The SQL a real reader call prepares, in order. */
  function issuedSql(read: () => unknown): string[] {
    const spy = vi.spyOn(client.sqlite, 'prepare');
    try {
      read();
      return spy.mock.calls.map(([source]) => source);
    } finally {
      spy.mockRestore();
    }
  }

  /** The `EXPLAIN QUERY PLAN` detail lines of one statement exactly as the reader prepared it. */
  function planOfIssued(sqlText: string): string[] {
    const placeholders = sqlText.match(/\?/gu)?.length ?? 0;
    const rows = client.sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sqlText}`)
      .all(...Array.from({ length: placeholders }, () => null));
    return rows.map(detailOf);
  }

  /** The single statement a reader call issues, planned. */
  function planOfRead(read: () => unknown): string[] {
    const statements = issuedSql(read);
    expect(statements).toHaveLength(1);
    return planOfIssued(statements[0] ?? '');
  }

  it('listRunSummaries (the History page) is served off idx_runs_created with no filesort, first page and keyset page', () => {
    const reader = createRunHistoryReader(client.db);
    expectIndexServedNoFilesort(
      planOfRead(() => reader.listRunSummaries({ limit: 20 })),
      'runs',
      'idx_runs_created',
    );
    // The keyset cursor must not turn the page into a scan-and-sort.
    expectIndexServedNoFilesort(
      planOfRead(() =>
        reader.listRunSummaries({ limit: 20, before: { createdAt: 1_000, id: 'run-1' } }),
      ),
      'runs',
      'idx_runs_created',
    );
  });

  it('listRunSummaries scoped to a project is served off idx_runs_project_created with no filesort', () => {
    const reader = createRunHistoryReader(client.db);
    expectIndexServedNoFilesort(
      planOfRead(() => reader.listRunSummaries({ limit: 20, projectRoot: '/work/p1' })),
      'runs',
      'idx_runs_project_created',
    );
    expectIndexServedNoFilesort(
      planOfRead(() =>
        reader.listRunSummaries({
          limit: 20,
          projectRoot: '/work/p1',
          before: { createdAt: 1_000, id: 'run-1' },
        }),
      ),
      'runs',
      'idx_runs_project_created',
    );
    // A status filter inside a project rides the same index with a residual filter; if this ever needs a second
    // index, this is the plan that says so (ADR-0140 §4).
    expectIndexServedNoFilesort(
      planOfRead(() =>
        reader.listRunSummaries({ limit: 20, projectRoot: '/work/p1', status: 'failed' }),
      ),
      'runs',
      'idx_runs_project_created',
    );
  });

  it('listRunSummaries filtered by status alone sorts only the last ORDER BY term, never the whole page', () => {
    // The known bound, pinned so it cannot quietly get worse: `idx_runs_status` is (status, created_at DESC), so
    // the `id DESC` tiebreak costs a sort WITHIN a run of equal `created_at` (SQLite's "LAST TERM"), as the
    // existing `listRuns({ status })` path documents. A full-page sort here would mean the index stopped serving.
    const reader = createRunHistoryReader(client.db);
    const plan = planOfRead(() => reader.listRunSummaries({ limit: 20, status: 'failed' })).join(
      '\n',
    );
    expect(plan).toContain('idx_runs_status (status=?)');
    expect(plan).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/u);
    expect(plan).not.toMatch(/SCAN runs(?! USING)/u);
  });

  it('loadRunEventsAfter (the poll tail) is a keyset range read on idx_run_events_run_seq', () => {
    const reader = createRunHistoryReader(client.db);
    const plan = planOfRead(() => reader.loadRunEventsAfter('run-1', 41, 50));
    expectIndexServedNoFilesort(plan, 'run_events', 'idx_run_events_run_seq');
    expect(plan.join('\n')).toContain('seq>?'); // the cursor bounds the scan, it is not a filter after a full range
  });

  it('loadRunLeases is a primary-key lookup, not a scan', () => {
    const reader = createRunHistoryReader(client.db);
    const plan = planOfRead(() => reader.loadRunLeases(['run-1', 'run-2', 'run-3']));
    expect(plan.join('\n')).toContain('USING INDEX sqlite_autoindex_run_leases_1 (run_id=?)');
    expect(plan.join('\n')).not.toMatch(/SCAN run_leases/u);
  });

  it('listStepSummaries and loadStepDetail are served off the step_executions indexes', () => {
    const reader = createRunHistoryReader(client.db);
    expectIndexServedNoFilesort(
      planOfRead(() => reader.listStepSummaries('run-1')),
      'step_executions',
      'idx_step_exec_run',
    );
    expectIndexServedNoFilesort(
      planOfRead(() => reader.loadStepDetail('run-1', 'node-1', 1)),
      'step_executions',
      'idx_step_exec_run_node',
    );
  });
});
