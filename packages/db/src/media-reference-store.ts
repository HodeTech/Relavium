import { randomUUID } from 'node:crypto';

import type {
  DurableMediaMeta,
  MediaModality,
  MediaReferencePort,
  MediaScopeKind,
  Scope,
} from '@relavium/shared';
import { and, eq } from 'drizzle-orm';

import type { Db } from './client.js';
import { mediaObjects, mediaReferences } from './schema.js';

/**
 * The `media_references` / `media_objects` host store (1.AF/D12c + D11, ADR-0042 §3-4 / ADR-0044 §1) — the
 * Node/SQLite reference for the media retention + authz junction. One junction serves BOTH the refcount /
 * terminal-sweep (the `run`/`node` rows) AND the `read_media` authz (the `session`/`workspace` rows —
 * {@link describe} returns only those). It lives in `@relavium/db` (better-sqlite3); the platform-free
 * engine never imports it — a host wires it behind the engine's reference-lifecycle port + the `read_media`
 * `MediaReadAccess` delegate, exactly as `FilesystemMediaStore` backs `ExecutionHost.mediaStore`.
 *
 * `recordObject` is idempotent on the content-addressed `handle` (same bytes ⇒ same row; a conflict just
 * refreshes `last_referenced_at`, the GC cursor); `addReference` is idempotent on the per-distinct-reference
 * unique index (the refcount is the row count). The `media_references.handle` FK targets `media_objects.handle`,
 * so a reference's object must be recorded first (a stray reference fails closed at the FK, never silently).
 */

/** The durable media metadata recorded when a handle is content-addressed (mirrors the `media_objects` row). */
export interface MediaObjectInput {
  readonly handle: string;
  readonly mimeType: string;
  readonly modality: MediaModality;
  readonly byteLength: number;
  readonly durationMs?: number;
}

/** A handle's durable metadata + its `read_media` authz scopes (the `describe` result the delegate forwards). */
export interface MediaHandleRecord {
  readonly mimeType: string;
  readonly byteLength: number;
  readonly allowedScopes: Scope[];
}

export interface MediaReferenceStore {
  /** Upsert the `media_objects` row, refreshing `last_referenced_at` (idempotent on the handle). */
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
}

export function createMediaReferenceStore(
  db: Db,
  now: () => number = Date.now,
): MediaReferenceStore {
  return {
    recordObject(input: MediaObjectInput): void {
      const ts = now();
      db.insert(mediaObjects)
        .values({
          id: randomUUID(),
          handle: input.handle,
          mimeType: input.mimeType,
          modality: input.modality,
          byteLength: input.byteLength,
          ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
          lastReferencedAt: ts,
          createdAt: ts,
        })
        // Content-addressed ⇒ the bytes (and byteLength) are identical on a re-record; just refresh the GC
        // cursor so a re-referenced object is not reclaimed mid-window.
        .onConflictDoUpdate({ target: mediaObjects.handle, set: { lastReferencedAt: ts } })
        .run();
    },

    addReference(handle: string, scopeKind: MediaScopeKind, scopeId: string): void {
      db.insert(mediaReferences)
        .values({ id: randomUUID(), handle, scopeKind, scopeId, createdAt: now() })
        // A scope references a handle at most once (the refcount is the distinct-row count).
        .onConflictDoNothing({
          target: [mediaReferences.handle, mediaReferences.scopeKind, mediaReferences.scopeId],
        })
        .run();
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
      const result = db
        .delete(mediaReferences)
        .where(and(eq(mediaReferences.scopeKind, 'run'), eq(mediaReferences.scopeId, runId)))
        .run();
      return result.changes;
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
    recordRunMedia(meta: DurableMediaMeta, runId: string): void {
      store.recordObject(meta);
      store.addReference(meta.handle, 'run', runId);
    },
    reclaimRun(runId: string): void {
      store.removeRunReferences(runId);
    },
  };
}
