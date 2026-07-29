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
 * **Two twins, one policy.** {@link withBusyRetry} is synchronous, because `better-sqlite3` is;
 * {@link withBusyRetryAsync} is for the call sites whose caller is genuinely async, where the backoff can yield
 * the event loop instead of parking the thread (#226). They share the retryable-code set, the budget, the
 * schedule and the fail-loud exhaustion — only the sleep differs. Read the async twin's own doc for what that
 * does and, more importantly, what it does NOT buy: each attempt still blocks inside the synchronous driver for
 * up to `busy_timeout`, so the backoff is the small term, not the dominant one.
 *
 * CAVEAT: `{ behavior: 'immediate' }` only applies to the OUTERMOST `BEGIN`. If a wrapped store method is ever
 * called INSIDE another `db.transaction`, better-sqlite3 demotes it to a `SAVEPOINT` and the IMMEDIATE behavior
 * is silently ignored. All current call sites invoke these as top-level store methods; a future batch-in-one-
 * transaction caller must take the outer `BEGIN IMMEDIATE` itself.
 */

/**
 * Driver error codes we wait out: a lock we can retry. Anything else is a real fault → rethrow.
 *
 * `better-sqlite3` reports the **extended** result code, so the stale-`BEGIN DEFERRED` upgrade failure this
 * module's header names arrives as `SQLITE_BUSY_SNAPSHOT` — a distinct string, not a `SQLITE_BUSY` prefix
 * match. `BEGIN IMMEDIATE` avoids it on every writer we own; this entry is the belt for one that ever escapes
 * (a store method demoted to a `SAVEPOINT` inside an outer transaction, or a future caller that opens its own
 * DEFERRED transaction). Matched exactly, never by prefix, so an unrelated future `SQLITE_BUSY_*` extended
 * code is not silently swept into the retry set (#100).
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_BUSY_SNAPSHOT',
]);

/** Default total attempts (the first try + up to 4 retries). */
const DEFAULT_MAX_ATTEMPTS = 5;
/** Default linear-backoff base; the nth retry sleeps `base × n` ms. */
const DEFAULT_BASE_DELAY_MS = 25;

/** The attempt budget + backoff schedule — identical for both twins, so the policy has one home. */
interface BusyRetryBudget {
  /** Total attempts INCLUDING the first (default {@link DEFAULT_MAX_ATTEMPTS}). Must be ≥ 1. */
  readonly maxAttempts?: number;
  /** Linear-backoff base in ms (default {@link DEFAULT_BASE_DELAY_MS}); the nth retry sleeps `base × n`. */
  readonly baseDelayMs?: number;
}

export interface BusyRetryOptions extends BusyRetryBudget {
  /** Injectable synchronous sleep — tests pass a no-op/recorder so they never actually block. */
  readonly sleep?: (ms: number) => void;
}

export interface AsyncBusyRetryOptions extends BusyRetryBudget {
  /** Injectable async sleep — tests pass a resolved-promise recorder so they never actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
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
 * Async sleep — the {@link sleepSync} twin for {@link withBusyRetryAsync}. A plain `setTimeout`, deliberately
 * NOT `.unref()`d: an unref'd timer would let Node exit mid-backoff and abandon a write the caller is still
 * awaiting, which is the silent data loss this module exists to prevent. The wait is bounded by the linear
 * schedule (≤ 100 ms at the defaults), so holding the loop open for it costs nothing at shutdown.
 */
function sleepAsync(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The shared fail-loud decision for both twins: the last attempt, or any non-lock fault, rethrows the
 * ORIGINAL error unchanged. Factored out so the retry POLICY has exactly one definition — a change to what
 * counts as retryable, or to the budget's boundary condition, cannot apply to one twin and not the other.
 */
function throwUnlessRetryable(err: unknown, attempt: number, maxAttempts: number): void {
  if (attempt >= maxAttempts || !isRetryableLockError(err)) {
    throw err;
  }
}

/**
 * Run `fn`, retrying only on a {@link RETRYABLE_CODES} lock fault up to `maxAttempts`, with a deterministic
 * linear backoff between attempts. Returns `fn`'s value on success; rethrows the original error on a non-lock
 * fault or an exhausted budget (fail-loud). Synchronous — it wraps a synchronous `db.transaction(...)` call.
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
      throwUnlessRetryable(err, attempt, maxAttempts);
      // Deterministic linear backoff (no jitter): let the contending writer commit before we re-take the lock.
      sleep(baseDelayMs * attempt);
    }
  }
}

/**
 * The **async twin** of {@link withBusyRetry}, for the call sites whose caller is genuinely async — today
 * `persistEvent` (run history) and the chat persister's write path. Identical budget, identical deterministic
 * linear backoff, identical fail-loud exhaustion; the only difference is that the backoff **yields the event
 * loop** instead of parking the thread on `Atomics.wait` (#226).
 *
 * Scope, stated plainly so this is not mistaken for more than it is: `better-sqlite3` is a **synchronous**
 * driver and each attempt's `BEGIN IMMEDIATE` can itself block the thread for up to `busy_timeout` (5 s). The
 * backoff is therefore the SMALL term — the sub-300 ms of a ~25 s worst case documented in
 * [database-schema.md](../../../docs/reference/shared-core/database-schema.md#concurrency--transaction-behavior).
 * This twin removes that small term where it is free to remove; it does not, and cannot, make the write path
 * non-blocking. Converting the remaining nine synchronous store methods would not change that either — which
 * is why they stay on {@link withBusyRetry} rather than growing an async API for no gain.
 *
 * One consequence the sync twin does not have: the `await` between attempts is an **observable yield**, so a
 * sibling writer may commit during the backoff. That is precisely the outcome the backoff exists to allow —
 * but it makes the re-runnability requirement on `fn` load-bearing rather than incidental. `fn` MUST be one
 * self-contained, idempotent transaction, never a partially-applied sequence: at the moment of the yield our
 * own transaction has already rolled back, so nothing of ours is in flight.
 */
export async function withBusyRetryAsync<T>(
  fn: () => T | Promise<T>,
  options: AsyncBusyRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? sleepAsync;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      throwUnlessRetryable(err, attempt, maxAttempts);
      await sleep(baseDelayMs * attempt);
    }
  }
}
