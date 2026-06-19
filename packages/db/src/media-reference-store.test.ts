import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  createMediaReferencePort,
  createMediaReferenceStore,
  type MediaReferenceStore,
} from './media-reference-store.js';
import { mediaObjects, mediaReferences } from './schema.js';

const HANDLE = `media://sha256-${'a'.repeat(64)}`;

describe('MediaReferenceStore (1.AF/D12c + D11 — media_objects/media_references junction)', () => {
  let client: DbClient;
  let store: MediaReferenceStore;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    let tick = 1_000;
    store = createMediaReferenceStore(client.db, () => (tick += 1));
  });
  afterEach(() => client.sqlite.close());

  function record(): void {
    store.recordObject({ handle: HANDLE, mimeType: 'image/png', modality: 'image', byteLength: 5 });
  }

  it('describe returns the durable metadata + only the session/workspace authz scopes', () => {
    record();
    store.addReference(HANDLE, 'run', 'run-1'); // lifetime — never grants read
    store.addReference(HANDLE, 'node', 'node-1'); // lifetime — never grants read
    store.addReference(HANDLE, 'session', 's1'); // authz
    store.addReference(HANDLE, 'workspace', 'w1'); // authz (reserved kind, still stored)
    const info = store.describe(HANDLE);
    expect(info?.mimeType).toBe('image/png');
    expect(info?.byteLength).toBe(5);
    expect(info?.allowedScopes).toEqual([
      { kind: 'session', id: 's1' },
      { kind: 'workspace', id: 'w1' },
    ]);
  });

  it('describe returns undefined for an unknown handle', () => {
    record();
    expect(store.describe(`media://sha256-${'b'.repeat(64)}`)).toBeUndefined();
  });

  it('describe returns undefined for a GC-reclaimed (deleted_at) handle', () => {
    record();
    store.addReference(HANDLE, 'session', 's1');
    client.db
      .update(mediaObjects)
      .set({ deletedAt: 9_999 })
      .where(eq(mediaObjects.handle, HANDLE))
      .run();
    expect(store.describe(HANDLE)).toBeUndefined();
  });

  it('addReference is idempotent on (handle, scopeKind, scopeId) — the refcount is the distinct count', () => {
    record();
    store.addReference(HANDLE, 'session', 's1');
    store.addReference(HANDLE, 'session', 's1'); // same scope again — no second row
    expect(store.describe(HANDLE)?.allowedScopes).toEqual([{ kind: 'session', id: 's1' }]);
  });

  it('recordObject is idempotent on the content-addressed handle (re-record refreshes, never duplicates)', () => {
    record();
    record(); // same bytes/handle — upsert, not a duplicate
    store.addReference(HANDLE, 'session', 's1');
    expect(store.describe(HANDLE)?.allowedScopes).toEqual([{ kind: 'session', id: 's1' }]);
  });

  it('removeRunReferences drops only the run rows for that run, leaving session authz intact (D11 sweep)', () => {
    record();
    store.addReference(HANDLE, 'run', 'run-1');
    store.addReference(HANDLE, 'run', 'run-2');
    store.addReference(HANDLE, 'session', 's1');
    expect(store.removeRunReferences('run-1')).toBe(1); // only run-1's row
    // The session authz row survives — a terminal sweep of one run never revokes a session's read.
    expect(store.describe(HANDLE)?.allowedScopes).toEqual([{ kind: 'session', id: 's1' }]);
    expect(store.removeRunReferences('nope')).toBe(0); // no matching run rows
  });

  it('reclaimExpired soft-deletes only zero-ref objects past the grace window (D11 GC)', () => {
    // The injected clock advances +1 per read (from 1000). Record at t≈1001, last_referenced_at≈1001.
    record();
    store.addReference(HANDLE, 'session', 's1');
    // Still referenced ⇒ never reclaimed, regardless of grace.
    expect(store.reclaimExpired(0)).toEqual([]);
    expect(store.describe(HANDLE)).toBeDefined();
    // Drop to zero refs (a terminal sweep would do this for a run ref; here remove the session ref).
    client.db.delete(mediaReferences).where(eq(mediaReferences.handle, HANDLE)).run();
    // A large grace window ⇒ not yet expired (last_referenced_at is recent vs the advancing clock).
    expect(store.reclaimExpired(1_000_000)).toEqual([]);
    // grace 0 ⇒ now > last_referenced_at, zero refs ⇒ reclaimed (handle returned, deleted_at set).
    expect(store.reclaimExpired(0)).toEqual([HANDLE]);
    expect(store.describe(HANDLE)).toBeUndefined(); // soft-deleted
    expect(store.reclaimExpired(0)).toEqual([]); // idempotent — already deleted
    // RESURRECTION: producing the same content-addressed bytes again must revive the handle (clear
    // deleted_at), so describe() returns it and read_media can authorize the re-introduced content again.
    record();
    expect(store.describe(HANDLE)).toBeDefined();
    store.addReference(HANDLE, 'session', 's1');
    expect(store.describe(HANDLE)?.allowedScopes).toEqual([{ kind: 'session', id: 's1' }]);
  });

  it('createMediaReferencePort records the object + a run ref, and reclaimRun removes the run ref (D12c/D11)', async () => {
    // The SQLite port is synchronous (better-sqlite3), but MediaReferencePort returns void | Promise<void>
    // for a future async store (Phase-2 Postgres) — so the calls are awaited (also satisfies no-floating-promises).
    const port = createMediaReferencePort(store);
    await port.recordRunMedia(
      { handle: HANDLE, mimeType: 'image/png', modality: 'image', byteLength: 5 },
      'run-1',
    );
    expect(store.describe(HANDLE)?.byteLength).toBe(5); // the media_objects row was recorded
    await port.reclaimRun('run-1');
    expect(store.removeRunReferences('run-1')).toBe(0); // the run ref was already reclaimed by the port
  });
});
