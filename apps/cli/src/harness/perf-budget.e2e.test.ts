import {
  agentSessions,
  createClient,
  createRunHistoryReader,
  createSessionStore,
  runMigrations,
  runs,
  sessionMessages,
  type DbClient,
} from '@relavium/db';
import { asc, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildHomeSnapshot } from '../home/home-store.js';
import { readProjectRunGates } from '../home/run-gates.js';

/**
 * How much slower one Home refresh may be over a 20× longer history of a directory with the same paused runs. The paused runs and the
 * counts read no row per run of the history, so the two cost about the same (the count of every run walks the index alone); a read that
 * checks the status on each run of the project's range makes the long one several times slower.
 */
const HOME_REFRESH_HISTORY_RATIO = 2;

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
    // A terminal status filter inside a project (the History browser's) rides the same index with a residual filter; if
    // this ever needs a second index, this is the plan that says so (ADR-0140 §4). A status of a run in flight reads the
    // status index instead (pinned below).
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

  // --- the Home reads THIS directory, with true totals (MVP-11 unit 7) -------------------------------------------------------
  // The real reader's and the real session store's statements, planned as issued (as the browsers' reads above are).

  it('the Home’s lists of this directory are served off the directory indexes with no filesort', () => {
    const reader = createRunHistoryReader(client.db);
    // The Runs section: this project's runs that are not under Attention (no paused run, no failed run inside the window). The two
    // exclusions are residual filters on the project's own ordered range, so the newest rows come first without a sort.
    expectIndexServedNoFilesort(
      planOfRead(() =>
        reader.listRunSummaries({
          limit: 16,
          projectRoot: '/work/p1',
          exceptStatus: 'paused',
          failedOnlyBefore: 1_000,
        }),
      ),
      'runs',
      'idx_runs_project_created',
    );
    // The failed runs inside the window: the lower bound is a RANGE on the same index, not a filter after it.
    const failed = planOfRead(() =>
      reader.listRunSummaries({
        limit: 16,
        projectRoot: '/work/p1',
        status: 'failed',
        since: 1_000,
      }),
    );
    expectIndexServedNoFilesort(failed, 'runs', 'idx_runs_project_created');
    expect(failed.join('\n')).toContain('created_at>?');
    const sessions = createSessionStore(client.db);
    expectIndexServedNoFilesort(
      planOfRead(() => sessions.listSessions({ limit: 8, workingDir: '/work/p1' })),
      'agent_sessions',
      'idx_agent_sessions_working_dir_updated',
    );
  });

  /**
   * The columns an index CONSTRAINS in a plan (`SEARCH runs USING INDEX idx_runs_status (status=? AND created_at>?)` → `status`,
   * `created_at`): what bounds the range read. A filter column that is not among them is checked on every row of the range, which is work
   * that grows with the range, not with the answer.
   */
  function constrainedColumns(plan: readonly string[]): string[] {
    return plan.flatMap((line) => {
      const terms = /USING (?:COVERING )?INDEX \S+ \(([^)]*)\)/u.exec(line)?.[1];
      return terms === undefined
        ? []
        : terms.split(' AND ').map((term) => term.split(/[=<>]/u)[0] ?? '');
    });
  }

  /** A plan that is no full-table scan and no sort of the whole result (a sort of the last ORDER BY term within one key is allowed). */
  function expectNoScanNoFullSort(plan: readonly string[], label: string): void {
    const joined = plan.join('\n');
    expect(joined, label).toMatch(/USING (COVERING )?INDEX/u);
    expect(joined, label).not.toMatch(/SCAN runs(?! USING)/u);
    expect(joined, label).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/u);
  }

  it('a project read with the status of a run in flight reads that status’s range; a terminal status keeps the project’s range', () => {
    // The paused runs of a 50,000-run project cost one table row per run of the project on the project's range (MVP-11 unit 7 round 2:
    // 30 ms per count, on every Home refresh); on the status range they cost the paused runs. The History browser's filters (the
    // terminal statuses) keep the project's range, where the newest rows come first.
    const reader = createRunHistoryReader(client.db);
    for (const status of ['pending', 'running', 'paused'] as const) {
      for (const read of [
        () => reader.listRunSummaries({ limit: 9, projectRoot: '/work/p1', status }),
        // The parked read's next page (`readProjectRunGates` pages past its first chunk by the keyset cursor).
        () =>
          reader.listRunSummaries({
            limit: 9,
            projectRoot: '/work/p1',
            status,
            before: { createdAt: 1_000, id: 'run-1' },
          }),
        () => reader.countRunSummaries({ projectRoot: '/work/p1', status }),
      ]) {
        const plan = planOfRead(read);
        expectNoScanNoFullSort(plan, status);
        expect(plan.join('\n'), status).toContain('idx_runs_status (status=?');
        expect(constrainedColumns(plan), status).toContain('status');
      }
    }
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const plan = planOfRead(() =>
        reader.listRunSummaries({ limit: 21, projectRoot: '/work/p1', status }),
      );
      expectIndexServedNoFilesort(plan, 'runs', 'idx_runs_project_created');
      expect(constrainedColumns(plan), status).toEqual(['project_root']);
    }
  });

  it('the Home’s refresh: every runs statement it issues is planned, and a status it filters on bounds the index range it reads', () => {
    // The statements the REAL store and the REAL parked read issue for one refresh (the snapshot, then the controller's parked runs),
    // recorded with the filter each was issued for, so a new or changed read is planned as issued and not as a list here says it is.
    const reader = createRunHistoryReader(client.db);
    const issued: { readonly kind: 'list' | 'count'; readonly filter: string; plan: string[] }[] =
      [];
    const recorded = <A extends object, R>(
      kind: 'list' | 'count',
      read: (filter: A) => R,
    ): ((filter: A) => R) => {
      return (filter) => {
        let result: R | undefined;
        const statements = issuedSql(() => {
          result = read(filter);
        });
        for (const statement of statements)
          issued.push({ kind, filter: JSON.stringify(filter), plan: planOfIssued(statement) });
        if (result === undefined) throw new Error('the read returned nothing');
        return result;
      };
    };
    const runsSeam = {
      ...reader,
      listRunSummaries: recorded('list', reader.listRunSummaries),
      countRunSummaries: recorded('count', reader.countRunSummaries),
    };
    buildHomeSnapshot({
      sessions: createSessionStore(client.db),
      runs: runsSeam,
      projectRoot: '/work/p1',
      workingDir: '/work/p1',
      now: () => 10 * 86_400_000,
    });
    readProjectRunGates(runsSeam, '/work/p1', { maxRuns: 8 });

    for (const { kind, filter, plan } of issued) {
      const label = `${kind} ${filter}`;
      expectNoScanNoFullSort(plan, label);
      // A status filter is a CONSTRAINED column of the index the read uses: the read costs the runs of that status (in the window), never
      // a row read per run of the directory's history. Every paused read, and every count that names a status: a count served off the
      // project's range with the status checked on each run (the old Runs count, `status <> ?`) fails here. The two other lists stop
      // after their limit (the Runs section) or inside the window's range of the project (the failed runs), and keep that range.
      const pausedRead = filter.includes('"status":"paused"');
      const countByStatus = kind === 'count' && /"(?:status|exceptStatus)"/u.test(filter);
      if (pausedRead || countByStatus) expect(constrainedColumns(plan), label).toContain('status');
    }
    // Exactly three counts, none of them a residual filter: the paused runs, the failed runs of the window, and every run of the directory
    // (the project's range, no run row read); the Runs total is their difference, never a fourth count.
    const counts = issued.filter((statement) => statement.kind === 'count');
    expect(counts.map((statement) => constrainedColumns(statement.plan))).toEqual([
      ['status'],
      ['status', 'created_at'],
      ['project_root'],
    ]);
    // The paused runs are read twice (the snapshot's unreadable probe and the parked rows), both off the status range.
    const pausedLists = issued.filter(
      (statement) => statement.kind === 'list' && statement.filter.includes('"status":"paused"'),
    );
    expect(pausedLists).toHaveLength(2);
    // The sessions of this directory.
    const sessions = createSessionStore(client.db);
    expectIndexServedNoFilesort(
      planOfRead(() => sessions.countSessions({ workingDir: '/work/p1' })),
      'agent_sessions',
      'idx_agent_sessions_working_dir_updated',
    );
  });

  it('a Home refresh costs what this directory holds in Attention, not its history: a 20× longer history is not a slower refresh', () => {
    // Two directories with the same six paused runs, created FIRST (the oldest rows: a newest-first walk of the project's range meets
    // them last), and every other run completed long before the failed-run window. One has 1,000 runs, the other 20,000. A refresh
    // that reads the paused runs off the status range costs about the same in both; one that checks the status on the project's range
    // (or counts the Runs section that way) reads a row per run of the history and is many times slower in the long one. A ratio of
    // two timings on one machine, the best of several each, taken in turn: the machine's speed and load cancel.
    const T0 = Date.parse('2026-01-01T00:00:00.000Z');
    const DAY = 86_400_000;
    const definition = JSON.stringify({ nodes: 'n'.repeat(2_000) });
    client.sqlite
      .prepare(
        `INSERT INTO workflows (id, name, slug, definition, created_at, updated_at) VALUES ('wf', 'wf', 'wf', '{}', ?, ?)`,
      )
      .run(T0, T0);
    const insert = client.sqlite.prepare(
      `INSERT INTO runs (id, workflow_id, workflow_definition_snapshot, project_root, status, created_at, updated_at) VALUES (?, 'wf', ?, ?, ?, ?, ?)`,
    );
    const seedDirectory = (root: string, count: number): void => {
      for (let index = 0; index < count; index++) {
        const at = T0 + index * 1_000;
        insert.run(
          `${root}#${String(index)}`,
          definition,
          root,
          index < 6 ? 'paused' : 'completed',
          at,
          at,
        );
      }
    };
    client.sqlite.transaction(() => {
      seedDirectory('/work/short', 1_000);
      seedDirectory('/work/long', 20_000);
    })();
    const reader = createRunHistoryReader(client.db);
    const sessions = createSessionStore(client.db);
    const refresh = (root: string): number => {
      const started = performance.now();
      const snapshot = buildHomeSnapshot({
        sessions,
        runs: reader,
        projectRoot: root,
        workingDir: root,
        now: () => T0 + 60 * DAY,
      });
      readProjectRunGates(reader, root, { maxRuns: 8 });
      const elapsed = performance.now() - started;
      expect(snapshot.totals.attention, root).toBe(6);
      return elapsed;
    };
    const best = { short: Number.POSITIVE_INFINITY, long: Number.POSITIVE_INFINITY };
    for (let round = 0; round < 9; round++) {
      best.short = Math.min(best.short, refresh('/work/short'));
      best.long = Math.min(best.long, refresh('/work/long'));
    }
    expect(best.long / best.short, JSON.stringify(best)).toBeLessThan(HOME_REFRESH_HISTORY_RATIO);
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
