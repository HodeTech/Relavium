/**
 * Bounded, **fail-loud** `SQLITE_BUSY` / `SQLITE_LOCKED` retry for the write path (2.5.I).
 *
 * `history.db` is opened with `busy_timeout = 5000` ([client.ts](./client.ts)), so SQLite's own busy handler
 * already waits out most lock contention *inside* a single statement or `BEGIN`. This helper covers the
 * residual: a write that still surfaces `SQLITE_BUSY`/`SQLITE_LOCKED` after that wait (heavy multi-process
 * contention, or the `SQLITE_BUSY_SNAPSHOT` a stale deferred writer hits — which `BEGIN IMMEDIATE` avoids and
 * this retries if it ever escapes). It is the concrete realization of the concurrent-process write requirement
 * recorded in the **ADR-0064 amendment note** (DB write-path concurrency): every multi-statement write
 * transaction opens `BEGIN IMMEDIATE` **and** routes through this policy.
 *
 * The backoff is **deterministic — no jitter, never `Math.random`** — following the no-jitter / deterministic
 * convention of [ADR-0040 §backoff](../../../docs/decisions/0040-node-retry-budget-above-the-chain.md): a
 * linear `baseDelayMs × attempt` pause between attempts (1×, 2×, … up to `maxAttempts − 1`). On an exhausted
 * budget — or any non-lock fault — it **rethrows the original error**; it never silently drops a write
 * (ADR-0050's durability-first `persistEvent` posture: a swallowed write is silent data loss).
 *
 * The wrapped `fn` MUST be re-runnable: a lock fault rolls the transaction back with no partial write, and the
 * retry re-runs the whole `fn` from scratch. The wrapped writers (`persistEvent`'s fold, the model-catalog
 * `replaceProviderModels` bulk-upsert + `upsert`, the provider `upsert`) are idempotent given the same input +
 * DB state.
 *
 * CAVEAT: `{ behavior: 'immediate' }` only applies to the OUTERMOST `BEGIN`. If a wrapped store method is ever
 * called INSIDE another `db.transaction`, better-sqlite3 demotes it to a `SAVEPOINT` and the IMMEDIATE behavior
 * is silently ignored. All current call sites invoke these as top-level store methods; a future batch-in-one-
 * transaction caller must take the outer `BEGIN IMMEDIATE` itself.
 */

/** Driver error codes we wait out: a lock we can retry. Anything else is a real fault → rethrow. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);

/** Default total attempts (the first try + up to 4 retries). */
const DEFAULT_MAX_ATTEMPTS = 5;
/** Default linear-backoff base; the nth retry sleeps `base × n` ms. */
const DEFAULT_BASE_DELAY_MS = 25;

export interface BusyRetryOptions {
  /** Total attempts INCLUDING the first (default {@link DEFAULT_MAX_ATTEMPTS}). Must be ≥ 1. */
  readonly maxAttempts?: number;
  /** Linear-backoff base in ms (default {@link DEFAULT_BASE_DELAY_MS}); the nth retry sleeps `base × n`. */
  readonly baseDelayMs?: number;
  /** Injectable synchronous sleep — tests pass a no-op/recorder so they never actually block. */
  readonly sleep?: (ms: number) => void;
}

/** A `better-sqlite3` `SqliteError` carries a string `.code` (e.g. `SQLITE_BUSY`); match structurally. */
function isRetryableLockError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof err.code === 'string' &&
    RETRYABLE_CODES.has(err.code)
  );
}

/**
 * Synchronous sleep via `Atomics.wait` on a throwaway `SharedArrayBuffer` — `better-sqlite3` is synchronous,
 * so the backoff must be too. This parks the thread for `ms` (nothing ever notifies the location, so it always
 * times out) without a busy-loop, and is deterministic. `Atomics.wait` is permitted on Node's main thread.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn`, retrying only on `SQLITE_BUSY`/`SQLITE_LOCKED` up to `maxAttempts`, with a deterministic linear
 * backoff between attempts. Returns `fn`'s value on success; rethrows the original error on a non-lock fault
 * or an exhausted budget (fail-loud). Synchronous — it wraps a synchronous `db.transaction(...)` call.
 */
export function withBusyRetry<T>(fn: () => T, options: BusyRetryOptions = {}): T {
  // Floor at 1 so a stray `0`/negative can never disable the first attempt (or spin) — always at least one try.
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? sleepSync;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      // Fail loud: the last attempt, or any non-lock fault, rethrows the ORIGINAL error unchanged.
      if (attempt >= maxAttempts || !isRetryableLockError(err)) {
        throw err;
      }
      // Deterministic linear backoff (no jitter): let the contending writer commit before we re-take the lock.
      sleep(baseDelayMs * attempt);
    }
  }
}
