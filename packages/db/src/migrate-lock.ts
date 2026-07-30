import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Cross-process serialization for the `runMigrations` batch
 * ([ADR-0073](../../../docs/decisions/0073-history-db-migration-lock.md), finding `#99`).
 *
 * **Why a lock file and not a transaction.** drizzle's synchronous SQLite migrator runs the `SELECT` that
 * DECIDES which migrations are pending *outside* its own transaction, then opens a plain DEFERRED `BEGIN`. So
 * the read that decides and the write that applies are not atomic whatever `BEGIN` mode is used — two
 * processes on a fresh `history.db` both conclude the full set is pending, one commits, and the other dies on
 * `CREATE TABLE runs` with a raw `DrizzleError`. We also cannot hoist `migrate()` into our own transaction,
 * because its raw `BEGIN` would throw inside one. The ADR records why `flock`/`LockFileEx` — mechanically
 * superior, since the kernel releases on process death — is unreachable without a new dependency.
 *
 * **The protocol.** Create `<db-path>.migrate.lock` with `'wx'` (`O_CREAT|O_EXCL`, the atomic-create idiom
 * already used in `config/write.ts` and `media-write.ts`). On `EEXIST`, poll; if the holder's recorded start
 * time is older than {@link STALE_MS} it is presumed dead and taken over by an atomic `rename` (never
 * unlink-then-create, which would recreate the race one level up). If the lock cannot be taken within
 * {@link MAX_WAIT_MS} — or cannot be created at all, e.g. a read-only directory or a mount without real
 * `O_EXCL` — fall through to run-then-reconcile rather than hang or crash.
 */

/**
 * How old a lock may be before it is presumed abandoned. Two orders of magnitude above a real batch
 * (milliseconds on a local file), so a live holder is never mistaken for a dead one even on a loaded CI box —
 * and short enough that a crashed holder costs one pause rather than a permanently wedged install.
 *
 * It exists because `finally` is not a guarantee: `SIGKILL`, an OOM kill and a power loss all skip it, so a
 * crashed holder WILL leave the file behind. This is the only thing that recovers it.
 */
const STALE_MS = 30_000;
/** Total time a waiter will wait before giving up on the lock and reconciling instead. */
const MAX_WAIT_MS = 10_000;
/** Bounded busy-wait between polls; the whole batch is shorter than this on the happy path. */
const POLL_MS = 50;
/**
 * How many times a "create failed but the lock reads as absent" cycle is retried before concluding the
 * filesystem is refusing the lock outright (a read-only directory, a mount without real `O_EXCL`) and
 * reconciling instead. Without a bound that combination is an infinite spin, which would hang first-run
 * startup — the one place this code exists to protect.
 */
const MAX_VANISHED_RETRIES = 8;

/** What a holder records. `pid` is DIAGNOSTIC ONLY — pids recycle, so `startedAt` decides staleness. */
interface LockClaim {
  readonly pid: number;
  readonly startedAt: number;
  /** Distinguishes concurrent takeover attempts, so a taker can prove the lock it reads back is its own. */
  readonly nonce: string;
  /**
   * The lock file exists but its contents could not be trusted (truncated, hand-edited, written by something
   * else). Presumed abandoned **regardless of the clock** — an unreadable claim carries no usable start time,
   * so deciding staleness from `startedAt` would leave garbage wedging the lock for as long as the clock
   * happens to disagree. Set only by {@link readClaim}.
   */
  readonly unreadable?: boolean;
}

/** Synchronous, because `better-sqlite3` and the whole migration path are. Bounded by {@link POLL_MS}. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A lock whose contents we cannot trust — stale by flag, never by arithmetic. See {@link LockClaim}. */
const UNREADABLE_CLAIM: LockClaim = { pid: -1, startedAt: 0, nonce: '', unreadable: true };

function readClaim(lockPath: string): LockClaim | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    // Vanished between our create attempt and this read — the holder released. Not held by anyone we must
    // wait for. A deliberate, documented ignore, and the ONLY case that means "absent".
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'startedAt' in parsed &&
      typeof parsed.startedAt === 'number' &&
      'nonce' in parsed &&
      typeof parsed.nonce === 'string'
    ) {
      const pid = 'pid' in parsed && typeof parsed.pid === 'number' ? parsed.pid : -1;
      return { pid, startedAt: parsed.startedAt, nonce: parsed.nonce };
    }
    // A truncated / hand-edited / foreign lock file is unreadable, not authoritative. Treat it as stale so a
    // garbage file can never wedge every future invocation — the takeover path then replaces it.
    return UNREADABLE_CLAIM;
  } catch {
    // Present but not JSON — same conclusion: unreadable, therefore presumed abandoned. Distinct from the
    // ENOENT branch above, which means genuinely absent; conflating the two spins the wait loop forever.
    return UNREADABLE_CLAIM;
  }
}

/** Serialize a claim, `'wx'`-create it at `lockPath`, and report whether we now hold it. */
function tryCreate(lockPath: string, claim: LockClaim): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
    writeSync(fd, JSON.stringify(claim));
    return true;
  } catch {
    return false; // EEXIST (someone holds it) or a filesystem refusal (the caller falls back)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the claim is already written; a close failure cannot un-hold the lock */
      }
    }
  }
}

/**
 * Take over a lock presumed stale, by an **atomic swap**: write the claim to a uniquely-named temp file in the
 * same directory and `rename` it over the lock path. `rename` is atomic and last-writer-wins, so two
 * concurrent takers converge on exactly ONE owner — whereas unlink-then-create lets both believe they hold it.
 * The taker then re-reads and proceeds only if the claim it reads back carries its own nonce.
 */
function tryTakeover(lockPath: string, claim: LockClaim): boolean {
  const tmp = join(dirname(lockPath), `.migrate.lock.${claim.nonce}.tmp`);
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(claim));
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, lockPath);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup; it may never have been created */
    }
    return false;
  }
  return readClaim(lockPath)?.nonce === claim.nonce;
}

function release(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone — another process took it over as stale because we overran the threshold. Nothing to undo;
    // the migration itself either committed or rolled back on its own.
  }
}

/**
 * Run `migrate` once; on ANY failure, run it exactly once more. The second pass observes the winner's
 * committed `__drizzle_migrations` row and applies nothing, so a lost race resolves cleanly — while a genuine
 * migration failure fails the same way twice and the ORIGINAL error is rethrown (fail-loud, never the vaguer
 * second one). Only reachable when the lock could not be taken; the ADR keeps it as the fallback because on a
 * read-only directory, or on Windows where a scanner can hold a handle, crashing would be strictly worse.
 */
function runReconciling<T>(run: () => T): T {
  try {
    return run();
  } catch (first) {
    try {
      return run();
    } catch {
      throw first;
    }
  }
}

/**
 * Run `migrate` under the cross-process migration lock. `dbPath` is the database file; `undefined` or
 * `':memory:'` skips the lock entirely — a private in-memory database cannot be contended by construction, and
 * a lock file named `:memory:.migrate.lock` would be nonsense (this also keeps the test suite's hundreds of
 * in-memory migrations off the lock path). Injectable clock/nonce so the wait behaviour is testable without
 * real time.
 */
export function withMigrationLock<T>(
  dbPath: string | undefined,
  run: () => T,
  deps: {
    readonly now?: () => number;
    readonly nonce?: () => string;
    readonly sleep?: (ms: number) => void;
  } = {},
): T {
  if (dbPath === undefined || dbPath === ':memory:') {
    return run();
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepSync;
  const nonce = (deps.nonce ?? (() => `${process.pid}-${now()}`))();
  const lockPath = `${dbPath}.migrate.lock`;
  const claim: LockClaim = { pid: process.pid, startedAt: now(), nonce };

  const deadline = now() + MAX_WAIT_MS;
  let vanished = 0;
  for (;;) {
    if (tryCreate(lockPath, claim)) {
      try {
        return run();
      } finally {
        release(lockPath);
      }
    }
    const held = readClaim(lockPath);
    if (held === undefined) {
      // Released between our create attempt and the read — go straight back for it. Bounded: if `tryCreate`
      // keeps failing while the file keeps reading as absent, the filesystem is refusing the lock (a read-only
      // directory, a mount without real `O_EXCL`) and no amount of retrying will change that. Spinning there
      // would hang first-run startup, so a handful of attempts is enough to conclude it and reconcile instead.
      vanished += 1;
      if (vanished <= MAX_VANISHED_RETRIES) {
        continue;
      }
      return runReconciling(run);
    }
    const stale = held.unreadable === true || now() - held.startedAt >= STALE_MS;
    if (stale && tryTakeover(lockPath, claim)) {
      try {
        return run();
      } finally {
        release(lockPath);
      }
    }
    if (now() >= deadline) {
      // The holder is alive but slower than any real batch, or the filesystem refuses the lock. Reconciling
      // beats hanging first-run startup, and beats crashing the loser of the race.
      return runReconciling(run);
    }
    sleep(POLL_MS);
  }
}
