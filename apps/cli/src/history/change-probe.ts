import type { Db } from '@relavium/db';

/**
 * The change token of the Home's read-only polls ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2): the cheapest question a poll can ask before it reads anything, "did anything I could show move since I last read?". The token is
 * a PAIR, because neither half answers alone:
 *
 * - **`dataVersion`** is SQLite's `PRAGMA data_version`. It changes whenever ANOTHER connection (another process) commits to the file.
 *   It does NOT change for a write made through the connection that asks, which is checked in SQLite and is the whole reason for the
 *   second half.
 * - **`generation`** is an in-process counter, bumped ({@link ChangeProbe.bump}) for every event this process appends or sees (the run
 *   view's feed calls it per event). The Home's own leg writes through the Home's own connection, so only the generation sees it.
 *
 * A token equal to the last one read means nothing a poll could show has moved, and the poll reads nothing. The token is a value: two
 * reads of it with no write between are {@link tokensEqual}.
 */
export interface ChangeToken {
  /** `PRAGMA data_version` now: it moves when another connection commits. */
  readonly dataVersion: number;
  /** The in-process generation now: it moves when {@link ChangeProbe.bump} is called. */
  readonly generation: number;
  /**
   * The run this Home's executing leg hosts now, when the caller adds it: the leg's start and end are not events a log holds, and the
   * Active tab labels the hosted run, so a leg that starts or ends is a change of its own.
   */
  readonly hostedRunId?: string | undefined;
}

export interface ChangeProbe {
  /** The token as it is now (one `PRAGMA data_version` read, which is cheap and takes no lock a writer waits on). May throw if the database is closed. */
  readonly token: () => ChangeToken;
  /** This process appended or saw an event: the next {@link ChangeProbe.token} differs from every earlier one. */
  readonly bump: () => void;
}

/** Whether two tokens say the same thing; a missing token is never equal to one, so a first read always happens. */
export function tokensEqual(a: ChangeToken | undefined, b: ChangeToken | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.dataVersion === b.dataVersion &&
    a.generation === b.generation &&
    a.hostedRunId === b.hostedRunId
  );
}

/** A probe over `dataVersion`, which is read each time a token is asked for (never cached: a cached value would never see another writer). */
export function createChangeProbe(dataVersion: () => number): ChangeProbe {
  let generation = 0;
  return {
    token: () => ({ dataVersion: dataVersion(), generation }),
    bump: () => {
      generation += 1;
    },
  };
}

/**
 * `PRAGMA data_version` of the connection behind `db`, as the number a probe compares. It is read through the handle the Home already
 * owns (no second connection is opened for a poll), and it throws for a closed handle, which the poll treats as "stop reading".
 */
export function dataVersionOf(db: Pick<Db, '$client'>): () => number {
  return () => {
    const value: unknown = db.$client.pragma('data_version', { simple: true });
    if (typeof value !== 'number')
      throw new TypeError('PRAGMA data_version did not return a number');
    return value;
  };
}

/**
 * Run `read` as ONE read transaction on the connection behind `db`: a snapshot, so every statement `read` makes sees the database as it
 * stood when the first one ran, however many other processes commit in between (the history database is in WAL mode, where a reader neither
 * blocks nor is blocked by a writer). Without it, the Active tab's three status pages are three separate reads: a run another process moves
 * from `running` to `paused` between them is listed twice, and one moved the other way is listed not at all until the next tick. The
 * transaction is a deferred `BEGIN` with no write in it and it ends (a commit, or a rollback when `read` throws, which then propagates) before
 * this returns, so nothing here can hold a lock past the call. It runs synchronously on the Home's own connection, so the Home's own writes
 * (the engine's, on the same connection) cannot interleave with it.
 */
export function readSnapshotOf(db: Pick<Db, '$client'>): ReadSnapshot {
  return <T>(read: () => T): T => db.$client.transaction(read)();
}

/** Run a synchronous read as one snapshot of the database ({@link readSnapshotOf}). */
export type ReadSnapshot = <T>(read: () => T) => T;
