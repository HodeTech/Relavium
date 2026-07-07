import {
  agentSessions,
  createClient,
  runMigrations,
  runs,
  sessionMessages,
  type DbClient,
} from '@relavium/db';
import { asc, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  /** The `EXPLAIN QUERY PLAN` `detail` lines for a drizzle query (its `?`-placeholder SQL + bound params). */
  function planFor(query: { toSQL: () => { sql: string; params: unknown[] } }): string[] {
    const { sql, params } = query.toSQL();
    // The drizzle `params` are valid SQLite bind values (strings/numbers); EXPLAIN ignores their values but the
    // `?` placeholders must still be bound. Read the `detail` column defensively at the DB boundary.
    const bind = params as ReadonlyArray<string | number | bigint | Buffer | null>;
    const rows = client.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bind);
    return rows.map((row) => (row as { detail?: string }).detail ?? '');
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
    table: 'agent_sessions' | 'runs' | 'session_messages', // closed union — no computed/metachar table names
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
});
