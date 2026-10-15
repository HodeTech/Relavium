import { randomUUID } from 'node:crypto';

import {
  MediaAdmissionError,
  canonicalMediaMimeType,
  reconcileMediaDescriptors,
  type DurableMediaMeta,
  type MediaReferencePort,
  type MediaScopeKind,
  type Scope,
} from '@relavium/shared';
import { and, eq, inArray, isNull, lte, notInArray } from 'drizzle-orm';

import type { Db, TxDb } from './client.js';
import { withBusyRetry } from './retry.js';
import { mediaObjects, mediaReferences } from './schema.js';

/** Max handles per `handle IN (…)` UPDATE — under SQLite's 999-bound-parameter floor (older builds). */
const SQLITE_INARRAY_CHUNK = 900;

/**
 * The `media_references` / `media_objects` host store (1.AF/D12c + D11, ADR-0042 §3-4 / ADR-0044 §1) — the
 * Node/SQLite reference for the media retention + authz junction. One junction serves BOTH the refcount /
 * terminal-sweep (the `run`/`node` rows) AND the `read_media` authz (the `session`/`workspace` rows —
 * {@link describe} returns only those). It lives in `@relavium/db` (better-sqlite3); the platform-free
 * engine never imports it — a host wires it behind the engine's reference-lifecycle port + the `read_media`
 * `MediaReadAccess` delegate, exactly as `FilesystemMediaStore` backs `ExecutionHost.mediaStore`.
 *
 * `admitProducedMedia` owns and validates a complete batch before one BEGIN IMMEDIATE. A handle's MIME,
 * modality and actual count are immutable, including after soft deletion; a previously absent duration
 * may be enriched. Conflicts roll back the entire batch. Admission never grants read access.
 * `addReference` is idempotent on the per-distinct-reference
 * unique index (the refcount is the row count). The `media_references.handle` FK targets `media_objects.handle`,
 * so a reference's object must be recorded first (a stray reference fails closed at the FK, never silently).
 */

/** The durable media metadata recorded when a handle is content-addressed (mirrors the `media_objects` row). */
export type MediaObjectInput = DurableMediaMeta;

/** A handle's durable metadata + its `read_media` authz scopes (the `describe` result the delegate forwards). */
export interface MediaHandleRecord {
  readonly mimeType: string;
  readonly byteLength: number;
  readonly allowedScopes: Scope[];
}

export interface MediaReferenceStore {
  /** Atomically admit all immutable descriptor tuples; no reference or read grant is added. */
  admitProducedMedia(batch: readonly DurableMediaMeta[]): void;
  /** Admit a singleton batch, refreshing compatible rows' retention cursors. */
  recordObject(input: MediaObjectInput): void;
  /** Add a `(handle, scopeKind, scopeId)` reference, idempotent on the unique index (refcount = row count). */
  addReference(handle: string, scopeKind: MediaScopeKind, scopeId: string): void;
  /**
   * `read_media`: a live handle's durable metadata + its `session`/`workspace` authz scopes (the run/node
   * lifetime rows are excluded — they never grant read). `undefined` for an unknown or GC-reclaimed
   * (`deleted_at` set) handle, so the tool fails closed.
   */
  describe(handle: string): MediaHandleRecord | undefined;
  /** D11 terminal sweep: remove a run's `run`-kind references (scoped to the run); returns the count removed. */
  removeRunReferences(runId: string): number;
  /** Every `media_objects.handle` (incl. soft-deleted rows) — the host GC's orphan-detection set (2.S/D-GC):
   *  a CAS blob whose handle is NOT here has no row at all (a crash between `put` and `recordObject`). */
  listObjectHandles(): string[];
  /** The distinct run ids that hold a `run`-kind reference — the host GC's clean-terminal reclaim-retry input
   *  (2.S/D-GC): re-attempt {@link removeRunReferences} for those whose run is terminal (a crashed inline sweep). */
  runReferenceRunIds(): string[];
  /**
   * D11 grace-window GC (ADR-0042 §4 step c): soft-delete (set `deleted_at`) every LIVE object that now
   * has **zero** references AND whose `last_referenced_at` is older than `graceMs` before now. Returns the
   * reclaimed handles so the host can delete their CAS bytes. A host periodic job calls this with the
   * configured grace (default 7 days); the terminal sweep ({@link removeRunReferences}) is what drops a
   * handle to zero refs in the first place. Idempotent — an already-deleted object is skipped.
   */
  reclaimExpired(graceMs: number): string[];
}

export function createMediaReferenceStore(
  db: Db,
  now: () => number = Date.now,
): MediaReferenceStore {
  // Write-transaction bodies, hoisted out of the `withBusyRetry(db.transaction(…))` nest so the map/loop
  // callbacks stay within the function-nesting budget (2.5.I close-out). Each is invoked INSIDE one BEGIN IMMEDIATE.

  /** Capture-then-delete a run's references + refresh the dropped handles' grace clock — atomic under BEGIN IMMEDIATE. */
  function removeRunReferencesTxn(runId: string, ts: number): number {
    // Capture the handles this run referenced BEFORE the delete, so the grace window of every handle this sweep
    // drops toward zero starts NOW (ADR-0042 §4 — measured from `last_referenced_at`), not from the handle's
    // production time. Without this, a long-lived handle losing its last reference is reclaimed on the next sweep
    // with zero effective grace.
    const affected = db
      .selectDistinct({ handle: mediaReferences.handle })
      .from(mediaReferences)
      .where(and(eq(mediaReferences.scopeKind, 'run'), eq(mediaReferences.scopeId, runId)))
      .all();
    const result = db
      .delete(mediaReferences)
      .where(and(eq(mediaReferences.scopeKind, 'run'), eq(mediaReferences.scopeId, runId)))
      .run();
    const handles = affected.map((row) => row.handle);
    // CHUNK the `handle IN (…)` refresh under SQLite's bound-parameter floor (a wide fan-out run can reference many
    // handles); one shared `ts` keeps the batches consistent.
    for (let i = 0; i < handles.length; i += SQLITE_INARRAY_CHUNK) {
      db.update(mediaObjects)
        .set({ lastReferencedAt: ts })
        .where(inArray(mediaObjects.handle, handles.slice(i, i + SQLITE_INARRAY_CHUNK)))
        .run();
    }
    return result.changes;
  }

  /** Soft-delete every 0-reference handle past its grace window — one atomic select-then-update snapshot. */
  function reclaimExpiredTxn(cutoff: number, ts: number): string[] {
    const referenced = db.select({ handle: mediaReferences.handle }).from(mediaReferences);
    const expired = db
      .select({ handle: mediaObjects.handle })
      .from(mediaObjects)
      .where(
        and(
          isNull(mediaObjects.deletedAt), // not already reclaimed
          lte(mediaObjects.lastReferencedAt, cutoff), // past the grace window
          notInArray(mediaObjects.handle, referenced), // zero references (refcount = row count)
        ),
      )
      .all();
    const handles = expired.map((row) => row.handle);
    // Soft-delete EXACTLY the expired handles found above (not a re-run of the 0-ref filter, which would ignore the
    // grace window). Serialized under BEGIN IMMEDIATE (2.5.I), so the select-then-update snapshot is consistent even
    // across two `relavium` processes. CHUNK the `handle IN (…)` list so a large sweep never exceeds SQLite's
    // bound-parameter limit (SQLITE_MAX_VARIABLE_NUMBER, 999 on older builds); one shared `ts` keeps the batches consistent.
    for (let i = 0; i < handles.length; i += SQLITE_INARRAY_CHUNK) {
      db.update(mediaObjects)
        .set({ deletedAt: ts })
        .where(inArray(mediaObjects.handle, handles.slice(i, i + SQLITE_INARRAY_CHUNK)))
        .run();
    }
    return handles;
  }

  function admitBatchTxn(tx: TxDb, batch: readonly DurableMediaMeta[], ts: number): void {
    for (const input of batch) {
      const existing = tx
        .select()
        .from(mediaObjects)
        .where(eq(mediaObjects.handle, input.handle))
        .get();
      if (existing === undefined) {
        tx.insert(mediaObjects)
          .values({
            id: randomUUID(),
            ...input,
            lastReferencedAt: ts,
            createdAt: ts,
          })
          .run();
        continue;
      }
      // Deleted rows retain their identity. Never resurrect or refresh a conflicting tuple.
      if (
        canonicalMediaMimeType(existing.mimeType) !== input.mimeType ||
        existing.modality !== input.modality ||
        existing.byteLength !== input.byteLength ||
        (existing.durationMs !== null &&
          input.durationMs !== undefined &&
          existing.durationMs !== input.durationMs)
      ) {
        throw new MediaAdmissionError('descriptor_conflict');
      }
      tx.update(mediaObjects)
        .set({
          mimeType: input.mimeType, // reviewed lexical aliases share one immutable canonical identity
          lastReferencedAt: ts,
          deletedAt: null,
          ...(existing.durationMs === null && input.durationMs !== undefined
            ? { durationMs: input.durationMs }
            : {}),
        })
        .where(eq(mediaObjects.handle, input.handle))
        .run();
    }
  }

  function admitProducedMedia(batch: readonly DurableMediaMeta[]): void {
    // Own every occurrence before de-duplication and before retry can yield to another writer.
    const owned = reconcileMediaDescriptors(batch);
    if (owned.length === 0) return;
    const ts = now(); // one timestamp for insertion, enrichment and resurrection, stable across retries
    withBusyRetry(() =>
      db.transaction((tx) => admitBatchTxn(tx, owned, ts), { behavior: 'immediate' }),
    );
  }

  return {
    admitProducedMedia,
    recordObject(input: MediaObjectInput): void {
      admitProducedMedia([input]);
    },

    addReference(handle: string, scopeKind: MediaScopeKind, scopeId: string): void {
      const ts = now();
      // INSERT (the reference) + UPDATE (the GC cursor) under ONE BEGIN IMMEDIATE so a concurrent GC sweep
      // (reclaimExpired) can't observe state between the two statements and reclaim a still-referenced handle —
      // the 2.5.I write-path convention (ADR-0064 amendment note).
      withBusyRetry(() =>
        db.transaction(
          () => {
            db.insert(mediaReferences)
              .values({ id: randomUUID(), handle, scopeKind, scopeId, createdAt: ts })
              // A scope references a handle at most once (the refcount is the distinct-row count).
              .onConflictDoNothing({
                target: [
                  mediaReferences.handle,
                  mediaReferences.scopeKind,
                  mediaReferences.scopeId,
                ],
              })
              .run();
            // Fresh reference activity ⇒ refresh the GC cursor. The grace window is measured from
            // `last_referenced_at` (ADR-0042 §4), so it must track the last reference-SET mutation, not just
            // production time — else a handle re-referenced long after it was produced inherits a stale, already-
            // expired cursor and is reclaimed on the next sweep instead of getting a fresh grace window.
            db.update(mediaObjects)
              .set({ lastReferencedAt: ts })
              .where(eq(mediaObjects.handle, handle))
              .run();
          },
          { behavior: 'immediate' },
        ),
      );
    },

    describe(handle: string): MediaHandleRecord | undefined {
      const object = db
        .select({
          mimeType: mediaObjects.mimeType,
          byteLength: mediaObjects.byteLength,
          deletedAt: mediaObjects.deletedAt,
        })
        .from(mediaObjects)
        .where(eq(mediaObjects.handle, handle))
        .get();
      if (object === undefined || object.deletedAt !== null) {
        return undefined; // unknown handle, or bytes already GC-reclaimed
      }
      const rows = db
        .select({ scopeKind: mediaReferences.scopeKind, scopeId: mediaReferences.scopeId })
        .from(mediaReferences)
        .where(eq(mediaReferences.handle, handle))
        .all();
      // Authz consults ONLY session/workspace rows (the run/node rows are lifetime-only). The explicit
      // kind narrowing keeps `allowedScopes` typed as `Scope[]` without an unsafe cast.
      const allowedScopes: Scope[] = [];
      for (const row of rows) {
        if (row.scopeKind === 'session' || row.scopeKind === 'workspace') {
          allowedScopes.push({ kind: row.scopeKind, id: row.scopeId });
        }
      }
      return { mimeType: object.mimeType, byteLength: object.byteLength, allowedScopes };
    },

    removeRunReferences(runId: string): number {
      const ts = now();
      // SELECT + DELETE + UPDATE-loop under ONE BEGIN IMMEDIATE (2.5.I write-path convention): the cursor
      // refresh must be atomic with the delete so a concurrent GC sweep never reclaims a handle mid-drop.
      return withBusyRetry(() =>
        db.transaction(() => removeRunReferencesTxn(runId, ts), { behavior: 'immediate' }),
      );
    },

    listObjectHandles(): string[] {
      return db
        .select({ handle: mediaObjects.handle })
        .from(mediaObjects)
        .all()
        .map((row) => row.handle);
    },

    runReferenceRunIds(): string[] {
      return db
        .selectDistinct({ scopeId: mediaReferences.scopeId })
        .from(mediaReferences)
        .where(eq(mediaReferences.scopeKind, 'run'))
        .all()
        .map((row) => row.scopeId);
    },

    reclaimExpired(graceMs: number): string[] {
      const ts = now(); // one clock read for the cutoff AND the soft-delete stamp (stable across retries)
      const cutoff = ts - graceMs;
      // SELECT (referenced) + SELECT (expired) + UPDATE-loop under ONE BEGIN IMMEDIATE (2.5.I): the reads and
      // the soft-delete are one atomic snapshot, so a reference added concurrently is never reclaimed. (The old
      // "single-connection ⇒ select-then-update is consistent" note held only WITHIN one process; two `relavium`
      // processes share this file — ADR-0064 §5.)
      return withBusyRetry(() =>
        db.transaction(() => reclaimExpiredTxn(cutoff, ts), { behavior: 'immediate' }),
      );
    },
  };
}

/**
 * Adapt a {@link MediaReferenceStore} to the engine's {@link MediaReferencePort} (1.AF/D12c + D11): the
 * host wires this behind `ExecutionHost.mediaReferences` so the pure engine records a produced handle's
 * `run` reference at the de-inline choke point and reclaims the run's references at its terminal event.
 * `DurableMediaMeta` is structurally a {@link MediaObjectInput}, so the record forwards it directly.
 */
export function createMediaReferencePort(store: MediaReferenceStore): MediaReferencePort {
  return {
    admitProducedMedia(batch: readonly DurableMediaMeta[]): void {
      store.admitProducedMedia(batch);
    },
    recordRunMedia(meta: DurableMediaMeta, runId: string): void {
      store.recordObject(meta);
      store.addReference(meta.handle, 'run', runId);
    },
    reclaimRun(runId: string): void {
      store.removeRunReferences(runId);
    },
  };
}
