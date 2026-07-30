import Database from 'better-sqlite3';

/**
 * Cross-process serialization for the `runMigrations` batch
 * ([ADR-0073](../../../docs/decisions/0073-history-db-migration-lock.md), finding `#99`).
 *
 * **Why a lock at all.** drizzle's synchronous SQLite migrator runs the `SELECT` that DECIDES which migrations
 * are pending *outside* its own transaction, then opens a plain DEFERRED `BEGIN`. So the read that decides and
 * the write that applies are not atomic whatever `BEGIN` mode is used — two processes on a fresh `history.db`
 * both conclude the full set is pending, one commits, and the other dies on `CREATE TABLE runs` with a raw
 * `DrizzleError`. We also cannot hoist `migrate()` into our own transaction, because its raw `BEGIN` would
 * throw inside one.
 *
 * **The mechanism: a real advisory lock, via a dedicated SQLite lock database.** `BEGIN EXCLUSIVE` on a
 * separate file takes an OS-level `fcntl` write lock for the life of the transaction, and — the property that
 * matters — **the kernel releases it when the process dies, however it dies.** ADR-0073's original lock-file
 * protocol could not achieve that: it needed a staleness threshold, and breaking a stale lock with plain file
 * operations is unsound (two takers can each believe they won, and a superseded holder can delete the new
 * owner's lock). Review found exactly that; the ADR carries a dated note.
 *
 * A separate file, not `history.db` itself: taking `BEGIN EXCLUSIVE` on the database drizzle is about to
 * migrate would deadlock it against our own connection.
 *
 * On contention the waiter blocks inside SQLite's busy handler for up to {@link LOCK_TIMEOUT_MS}; past that it
 * falls through to run-then-reconcile rather than hang or crash.
 */

/**
 * How long a waiter blocks for the lock before reconciling instead. Generous against a millisecond-scale
 * batch, and bounded so a pathological holder cannot hang first-run startup — the one thing this protects.
 */
const LOCK_TIMEOUT_MS = 10_000;

/**
 * Run `migrate` once; on ANY failure, run it exactly once more. The second pass observes the winner's
 * committed `__drizzle_migrations` row and applies nothing, so a lost race resolves cleanly — while a genuine
 * migration failure fails the same way twice and the ORIGINAL error is rethrown (fail-loud, never the vaguer
 * second one). Reachable only when the lock could not be taken: a read-only directory, a filesystem whose
 * `fcntl` locking does not work (some network mounts), or a holder that outlasted the timeout. Crashing the
 * loser of a race there would be strictly worse.
 */
function runReconciling<T>(run: () => T): T {
  try {
    return run();
  } catch (error_) {
    try {
      return run();
    } catch {
      throw error_;
    }
  }
}

/**
 * Run `migrate` under the cross-process migration lock. `dbPath` is the database file; `undefined` or
 * `':memory:'` skips the lock entirely — a private in-memory database cannot be contended by construction, and
 * it keeps the test suite's hundreds of in-memory migrations off this path. `deps.openLock` is a test seam for
 * driving the could-not-acquire branch without a real second process.
 */
export function withMigrationLock<T>(
  dbPath: string | undefined,
  run: () => T,
  deps: {
    readonly openLock?: (path: string) => Database.Database;
    /** Acquisition timeout override — tests drive the refused-acquisition branch without a real 10 s wait. */
    readonly timeoutMs?: number;
  } = {},
): T {
  if (dbPath === undefined || dbPath === ':memory:') {
    return run();
  }
  const openLock = deps.openLock ?? ((path: string) => new Database(path));
  let lock: Database.Database;
  try {
    lock = openLock(`${dbPath}.migrate.lock`);
  } catch {
    // The lock file cannot be opened at all (a read-only directory). Reconciling beats refusing to start.
    return runReconciling(run);
  }
  try {
    lock.pragma(`busy_timeout = ${deps.timeoutMs ?? LOCK_TIMEOUT_MS}`);
    try {
      // The acquisition. `BEGIN EXCLUSIVE` is the only statement here that can block or fail on contention.
      lock.exec('BEGIN EXCLUSIVE');
    } catch {
      // SQLITE_BUSY past the timeout, or a filesystem whose locking does not work. Either way: do not hang.
      return runReconciling(run);
    }
    try {
      return run();
    } finally {
      // Release. A throw here must not mask the migration's own outcome, and `close()` below releases the OS
      // lock regardless — so this is best-effort by design, not a swallowed failure.
      try {
        lock.exec('COMMIT');
      } catch {
        /* the close below releases the OS lock either way */
      }
    }
  } finally {
    lock.close();
  }
}
