import {
  createMediaReferenceStore,
  createRunHistoryReader,
  FilesystemMediaStore,
  type Db,
  type MediaReferenceStore,
} from '@relavium/db';
import type { RunStatus } from '@relavium/shared';

/** The terminal `runs.status` set — a run here will never be resumed, so its lingering `run`-refs are reclaimable.
 *  Typed as `Set<RunStatus>` (not `Set<string>`) so a misspelled status is a compile error and `.has(status)`
 *  narrows against the closed run-status union. */
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(['completed', 'failed', 'cancelled']);

/**
 * The ADR-0042 §4 DEFAULT grace window (7 days) before a zero-reference handle's bytes are reclaimed — the
 * fallback when `[defaults].media_gc_grace_days` (config-spec.md) is unset. The CLI resolves that key (DAYS → ms)
 * in `config/resolve.ts` and threads it into `sweepHostMediaBestEffort`'s `graceMs`; absent ⇒ this default.
 */
export const DEFAULT_MEDIA_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The minimum age a row-less CAS blob must reach before the orphan sweep deletes it (1 hour). A blob younger than
 * this may be a CONCURRENT run's freshly-`put` blob whose `recordObject` has not landed yet — deleting it would
 * destroy live media. A genuine crash-orphan simply ages past this window and is reclaimed on a later sweep. This
 * (independent of wall-clock timing) closes the check-then-sweep TOCTOU the `hasOtherActiveRuns` gate alone leaves.
 */
export const DEFAULT_ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

export interface MediaGcDeps {
  /** The run's CAS — the byte-reclamation + orphan-sweep delete from / enumerate it (a `FilesystemMediaStore`). */
  readonly casStore: Pick<FilesystemMediaStore, 'delete' | 'listHandles'>;
  /** The reference junction the reclaim-retry + grace-GC + orphan-detection read/mutate. */
  readonly references: Pick<
    MediaReferenceStore,
    'reclaimExpired' | 'removeRunReferences' | 'listObjectHandles' | 'runReferenceRunIds'
  >;
  /** True iff the run is SETTLED — terminal OR gone (soft-deleted / absent from live history) — so its lingering
   *  `run`-refs are safe to reclaim. NEVER true for an in-flight / paused run (whose media must survive a resume). */
  readonly isReclaimableRun: (runId: string) => boolean;
  /** True iff ANOTHER run is still active (running / paused) — gates the orphan sweep off so a concurrent writer's
   *  freshly-`put` (not-yet-`recordObject`'d) blob is never mistaken for a row-less orphan and deleted. */
  readonly hasOtherActiveRuns: () => boolean;
  /** The grace window before a zero-ref handle's bytes are reclaimed (ADR-0042 §4c). */
  readonly graceMs: number;
  /** Wall clock (ms) — for the orphan age-guard. Injected so tests are deterministic. */
  readonly now: () => number;
  /** The minimum age a row-less blob must reach before the orphan sweep deletes it (concurrent-writer guard). */
  readonly orphanMinAgeMs: number;
  /** The in-flight run — never reclaimed here (the engine owns its own terminal sweep at the terminal event). */
  readonly currentRunId?: string;
}

export interface MediaGcReport {
  /** Settled (terminal / gone) runs whose lingering `run`-refs the retry swept (a crash had dropped the sweep). */
  readonly reclaimedRuns: number;
  /** Handles whose bytes were reclaimed past the grace window (ADR-0042 §4c). */
  readonly graceReclaimed: number;
  /** Row-less CAS blobs (no `media_objects` row, past the settle age) deleted by the orphan sweep. */
  readonly orphansDeleted: number;
  /** Whether the orphan sweep ran (skipped when another run is active, to protect a concurrent writer). */
  readonly orphanSweepRan: boolean;
}

/**
 * The host media garbage collection (2.S/D-GC, ADR-0042 §4) — a best-effort, run-end ("keyed on the terminal run
 * event") pass the CLI owns (the engine signals the terminal; the host runs the mechanism). Three ordered steps:
 *
 *   1. **Clean-terminal reclaim retry** — re-attempt the terminal sweep (`removeRunReferences`) for every run
 *      holding a lingering `run`-ref whose run is SETTLED (terminal or gone, {@link MediaGcDeps.isReclaimableRun}
 *      — a crash had dropped the inline sweep). NEVER the current run (the engine reclaims it) and NEVER an
 *      in-flight / paused run (its media must live).
 *   2. **Grace-window GC** — `reclaimExpired(graceMs)` soft-deletes the rows of zero-ref handles past the grace
 *      window and returns them; delete each one's CAS bytes. AFTER step 1 so a handle just dropped to zero refs
 *      gets its fresh grace window (its `last_referenced_at` was refreshed) rather than being reclaimed this pass.
 *   3. **CAS-orphan sweep** — delete every CAS blob with NO `media_objects` row that is also older than
 *      `orphanMinAgeMs` (a crash between `put` and `recordObject` left row-less bytes). Gated off while another
 *      run is active, AND age-guarded, so a concurrent writer's fresh in-flight blob is never swept.
 *
 * Best-effort: the CALLER swallows a throw (a GC failure is never a run-correctness break, ADR-0042 §3).
 */
export async function runHostMediaGc(deps: MediaGcDeps): Promise<MediaGcReport> {
  // 1. Clean-terminal reclaim retry — only settled (terminal/gone), non-current runs.
  let reclaimedRuns = 0;
  for (const runId of deps.references.runReferenceRunIds()) {
    if (runId === deps.currentRunId || !deps.isReclaimableRun(runId)) {
      continue;
    }
    if (deps.references.removeRunReferences(runId) > 0) {
      reclaimedRuns += 1;
    }
  }

  // 2. Grace-window GC — reclaim the bytes of grace-expired zero-ref handles. `reclaimExpired` soft-deletes the
  //    rows synchronously and returns the handles; the CAS unlinks run concurrently (independent deletes).
  //    Known best-effort gap (ADR-0042 §3): between the soft-delete and a delete, a concurrent process could
  //    `recordObject` the same content-addressed handle (ON CONFLICT clears `deleted_at`), and the unlink would
  //    then drop bytes that are live again — leaving a row with no file. It requires byte-identical content
  //    re-produced inside a sub-ms window AFTER a full `graceMs` (7-day) zero-ref period, so it is negligible
  //    today; if `graceMs` is ever shortened materially, gate each delete on a re-verify SELECT (skip a handle
  //    whose `deleted_at` is NULL again).
  const expired = deps.references.reclaimExpired(deps.graceMs);
  await Promise.all(expired.map((handle) => deps.casStore.delete(handle)));

  // 3. CAS-orphan sweep — skip entirely while another run could be mid-write; age-guard each candidate so a
  //    fresh row-less blob (a concurrent run's, not yet recordObject'd) is never deleted.
  let orphansDeleted = 0;
  const orphanSweepRan = !deps.hasOtherActiveRuns();
  if (orphanSweepRan) {
    const known = new Set(deps.references.listObjectHandles());
    const settledBefore = deps.now() - deps.orphanMinAgeMs;
    // A row-less blob is an orphan ONLY if it also aged past `orphanMinAgeMs` — a fresher one may be a concurrent
    // run's just-`put` blob whose `recordObject` has not landed yet. Collect, then unlink concurrently.
    const orphans = (await deps.casStore.listHandles())
      .filter(({ handle, mtimeMs }) => !known.has(handle) && mtimeMs <= settledBefore)
      .map(({ handle }) => handle);
    await Promise.all(orphans.map((handle) => deps.casStore.delete(handle)));
    orphansDeleted = orphans.length;
  }

  return { reclaimedRuns, graceReclaimed: expired.length, orphansDeleted, orphanSweepRan };
}

/**
 * Wire {@link runHostMediaGc} from the run/gate command context and run it BEST-EFFORT (2.S/D-GC): assemble the
 * CAS + reference + run-history dependencies over the open `history.db` and swallow any throw — a GC failure is
 * never a run-correctness break (ADR-0042 §3). Called once at the TERMINAL of `run` / `gate` (the GC is "keyed on
 * the terminal run event" — the callers skip it on a non-terminal `paused` outcome). Returns the
 * {@link MediaGcReport} (a future `--verbose` line / tests consume it; the callers ignore it today), or
 * `undefined` when the GC threw.
 */
export async function sweepHostMediaBestEffort(args: {
  readonly db: Db;
  readonly casRoot: string;
  readonly currentRunId: string;
  readonly graceMs?: number;
  readonly orphanMinAgeMs?: number;
  readonly now?: () => number;
}): Promise<MediaGcReport | undefined> {
  try {
    // The cross-workflow read API (loadRun status + listActiveRuns) is built from the db handle alone.
    const reader = createRunHistoryReader(args.db);
    const now = args.now ?? Date.now;
    return await runHostMediaGc({
      casStore: new FilesystemMediaStore(args.casRoot),
      // One clock governs both the grace cutoff (`reclaimExpired` reads the store's `now`) and the orphan
      // age-guard below, so an injected `now` makes the whole pass deterministic.
      references: createMediaReferenceStore(args.db, now),
      isReclaimableRun: (id) => {
        // A run absent from LIVE history (soft-deleted / pruned ⇒ `loadRun` undefined) is GONE — its run-refs are
        // safe to reclaim, just like a terminal run's. An in-flight / paused run (a live non-terminal row) is kept.
        const status = reader.loadRun(id)?.status;
        return status === undefined || TERMINAL_RUN_STATUSES.has(status);
      },
      hasOtherActiveRuns: () => reader.listActiveRuns().some((run) => run.id !== args.currentRunId),
      graceMs: args.graceMs ?? DEFAULT_MEDIA_GC_GRACE_MS,
      now,
      orphanMinAgeMs: args.orphanMinAgeMs ?? DEFAULT_ORPHAN_MIN_AGE_MS,
      currentRunId: args.currentRunId,
    });
  } catch {
    return undefined; // best-effort — a GC failure is never a run-correctness break (ADR-0042 §3)
  }
}

/**
 * The run-end host media GC call the `run` and `gate` commands share (2.S/D-GC, ADR-0042 §4): fire
 * {@link sweepHostMediaBestEffort} ONLY when the run reached a TERMINAL event (`isTerminal`) AND a CAS is wired
 * (`casRoot`/`db` present — the in-memory unit/harness path has neither). A non-terminal (`paused`) outcome is
 * skipped so the resumable run's media survives. The whole call is best-effort — any throw (incl. an injected
 * `sweep` stub's) is swallowed so the GC can NEVER fail the run. Extracted here so neither command carries the
 * branch/try in its own body (one home for the guard).
 */
export async function sweepMediaAtTerminal(args: {
  readonly sweep: typeof sweepHostMediaBestEffort;
  readonly isTerminal: boolean;
  readonly db: Db | undefined;
  readonly casRoot: string | undefined;
  readonly currentRunId: string;
  readonly graceMs: number | undefined;
}): Promise<void> {
  // `db === undefined` is run.ts's optional-store path (gate always passes a live `opened.db`); `casRoot` /
  // `db` are wired together, so the in-memory unit/harness path (neither present) is also skipped here.
  if (!args.isTerminal || args.db === undefined || args.casRoot === undefined) {
    return;
  }
  try {
    await args.sweep({
      db: args.db,
      casRoot: args.casRoot,
      currentRunId: args.currentRunId,
      ...(args.graceMs === undefined ? {} : { graceMs: args.graceMs }),
    });
  } catch {
    // Defense-in-depth: the default sweeper already swallows, but the run-end GC must NEVER fail the run —
    // a throwing sweeper (a test, or a future impl) is swallowed here too (ADR-0042 §3).
  }
}
