import { eq } from 'drizzle-orm';
import { MediaAdmissionError, type DurableMediaMeta } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  afterEach(() => {
    vi.restoreAllMocks();
    client.sqlite.close();
  });

  function record(): void {
    store.recordObject({ handle: HANDLE, mimeType: 'image/png', modality: 'image', byteLength: 5 });
  }

  it('admission and all three GC writers each open an IMMEDIATE transaction', () => {
    const txnSpy = vi.spyOn(client.db, 'transaction');
    record(); // immutable tuple admission seeds the FK target atomically
    store.addReference(HANDLE, 'run', 'run-1'); // INSERT + cursor UPDATE
    store.removeRunReferences('run-1'); // SELECT + DELETE + cursor UPDATE
    store.reclaimExpired(0); // SELECT + SELECT + soft-delete
    // All three serialize under BEGIN IMMEDIATE so a concurrent sweep/refresh can't straddle their statements
    // (ADR-0064 §5); a DEFERRED begin would drop the config arg on any of them.
    expect(txnSpy).toHaveBeenCalledTimes(4);
    for (const call of txnSpy.mock.calls) {
      expect(call[1], 'FS_CAUSAL_MEDIA_METADATA_IMMEDIATE').toEqual({ behavior: 'immediate' });
    }
  });

  it('admits canonical aliases without adding a read grant or lifetime reference', async () => {
    const port = createMediaReferencePort(store);
    await port.admitProducedMedia([
      { handle: HANDLE, mimeType: 'IMAGE/JPG', modality: 'image', byteLength: 5 },
    ]);
    expect(store.describe(HANDLE)).toEqual({
      mimeType: 'image/jpeg',
      byteLength: 5,
      allowedScopes: [],
    });
    expect(client.db.select().from(mediaReferences).all()).toEqual([]);
  });

  it('reconciles a supported legacy lexical alias to the same canonical tuple', () => {
    store.recordObject({
      handle: HANDLE,
      mimeType: 'image/jpeg',
      modality: 'image',
      byteLength: 5,
    });
    client.db
      .update(mediaObjects)
      .set({ mimeType: 'image/jpg', deletedAt: 1234 })
      .where(eq(mediaObjects.handle, HANDLE))
      .run();
    store.recordObject({
      handle: HANDLE,
      mimeType: 'IMAGE/JPEG',
      modality: 'image',
      byteLength: 5,
    });
    expect(store.describe(HANDLE)).toEqual({
      mimeType: 'image/jpeg',
      byteLength: 5,
      allowedScopes: [],
    });
  });

  it.each([
    { handle: 'private invalid handle' },
    { mimeType: 'private/unknown' },
    { modality: 'audio' },
    { byteLength: -1 },
    { byteLength: 1.5 },
    { byteLength: Number.MAX_SAFE_INTEGER + 1 },
    { durationMs: 0 },
    { durationMs: 1 }, // duration is not admitted on an image
  ] satisfies readonly Partial<DurableMediaMeta>[])(
    'refuses invalid descriptors before entering a transaction: %j',
    (override) => {
      const txnSpy = vi.spyOn(client.db, 'transaction');
      expect(() =>
        store.recordObject({
          handle: HANDLE,
          mimeType: 'image/png',
          modality: 'image',
          byteLength: 5,
          ...override,
        }),
      ).toThrow(MediaAdmissionError);
      expect(txnSpy).not.toHaveBeenCalled();
      expect(store.listObjectHandles()).toEqual([]);
    },
  );

  it('enriches unknown duration once and never erases or contradicts known evidence', () => {
    const audio = {
      handle: HANDLE,
      mimeType: 'audio/mpeg',
      modality: 'audio',
      byteLength: 5,
    } satisfies DurableMediaMeta;
    store.recordObject(audio);
    store.recordObject({ ...audio, durationMs: 7 });
    store.recordObject(audio);
    expect(client.db.select().from(mediaObjects).get()?.durationMs).toBe(7);
    const before = client.db.select().from(mediaObjects).all();
    expect(
      () => store.recordObject({ ...audio, durationMs: 8 }),
      'FS_CAUSAL_MEDIA_METADATA_TUPLE',
    ).toThrowError(new MediaAdmissionError('descriptor_conflict'));
    expect(client.db.select().from(mediaObjects).all()).toEqual(before);
  });

  it.each([
    { mimeType: 'image/jpeg', modality: 'image', byteLength: 5 },
    { mimeType: 'audio/mpeg', modality: 'audio', byteLength: 5 },
    { mimeType: 'image/png', modality: 'image', byteLength: 6 },
  ] satisfies readonly Omit<DurableMediaMeta, 'handle'>[])(
    'retains soft-deleted identity and cursor on conflicting resurrection: %j',
    (descriptor) => {
      record();
      expect(store.reclaimExpired(0)).toEqual([HANDLE]);
      const before = client.db.select().from(mediaObjects).all();
      expect(() => store.recordObject({ handle: HANDLE, ...descriptor })).toThrowError(
        new MediaAdmissionError('descriptor_conflict'),
      );
      expect(client.db.select().from(mediaObjects).all()).toEqual(before);
      expect(store.describe(HANDLE)).toBeUndefined();
    },
  );

  it('a final tuple conflict rolls back insertion, duration enrichment, resurrection and grace refresh', () => {
    const audio = {
      handle: HANDLE,
      mimeType: 'audio/mpeg',
      modality: 'audio',
      byteLength: 5,
    } satisfies DurableMediaMeta;
    const conflict = {
      handle: `media://sha256-${'b'.repeat(64)}`,
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 9,
    } satisfies DurableMediaMeta;
    store.admitProducedMedia([audio, conflict]);
    expect(store.reclaimExpired(0)).toHaveLength(2);
    const before = client.db.select().from(mediaObjects).all();
    expect(
      () =>
        store.admitProducedMedia([
          { ...audio, handle: `media://sha256-${'c'.repeat(64)}` },
          { ...audio, durationMs: 7 },
          { ...conflict, byteLength: 10 },
        ]),
      'FS_CAUSAL_MEDIA_METADATA_ATOMIC_BATCH',
    ).toThrowError(new MediaAdmissionError('descriptor_conflict'));
    expect(
      client.db.select().from(mediaObjects).all(),
      'FS_CAUSAL_MEDIA_METADATA_ATOMIC_BATCH',
    ).toEqual(before);
    expect(client.db.select().from(mediaReferences).all()).toEqual([]);
  });

  it('owns batch metadata and timestamp before a busy retry can mutate caller input', () => {
    const input = {
      handle: HANDLE,
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 5,
    } satisfies DurableMediaMeta;
    const clock = vi.fn(() => 4321);
    const admitting = createMediaReferenceStore(client.db, clock);
    const original = client.db.transaction.bind(client.db);
    const transaction = vi.spyOn(client.db, 'transaction');
    transaction
      .mockImplementationOnce(() => {
        input.mimeType = 'image/jpeg';
        input.byteLength = 99;
        throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
      })
      .mockImplementation(original);
    admitting.admitProducedMedia([input]);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(client.db.select().from(mediaObjects).get()).toMatchObject({
      mimeType: 'image/png',
      byteLength: 5,
      createdAt: 4321,
      lastReferencedAt: 4321,
    });
  });

  it('never invokes a descriptor getter and refuses it before any database work', () => {
    const getter = vi.fn(() => 'image/png');
    const input = {
      handle: HANDLE,
      get mimeType() {
        return getter();
      },
      modality: 'image',
      byteLength: 5,
    } satisfies DurableMediaMeta;
    const transaction = vi.spyOn(client.db, 'transaction');
    expect(() => store.recordObject(input)).toThrowError(new MediaAdmissionError('unsafe_value'));
    expect(getter).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

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

  it('the terminal sweep refreshes last_referenced_at so grace measures from drop-to-zero, not production (D11)', () => {
    // A controllable (non-advancing) clock so the test pins the GC cursor basis precisely.
    let clock = 1_000;
    const s = createMediaReferenceStore(client.db, () => clock);
    s.recordObject({ handle: HANDLE, mimeType: 'image/png', modality: 'image', byteLength: 5 }); // last_ref=1000
    s.addReference(HANDLE, 'run', 'run-1'); // the only reference
    clock = 1_000_000; // the run lives a long time after the handle was produced
    expect(s.removeRunReferences('run-1')).toBe(1); // terminal sweep drops the last ref → refreshes the cursor
    // Grace window of 7: without the refresh the cursor would still be 1000 and the handle would be reclaimed
    // immediately (1000 ≤ 1_000_000 − 7); WITH it the window starts at the de-reference, so it survives.
    expect(s.reclaimExpired(7)).toEqual([]);
    clock = 1_000_010; // now past the grace window
    expect(s.reclaimExpired(7)).toEqual([HANDLE]);
  });

  it('addReference refreshes last_referenced_at (a re-referenced stale handle resets its grace window) (T-8)', () => {
    let clock = 1_000;
    const s = createMediaReferenceStore(client.db, () => clock);
    s.recordObject({ handle: HANDLE, mimeType: 'image/png', modality: 'image', byteLength: 5 }); // last_ref=1000
    clock = 1_000_000;
    s.addReference(HANDLE, 'session', 's1'); // fresh reference activity → cursor refreshed to 1_000_000
    client.db.delete(mediaReferences).where(eq(mediaReferences.handle, HANDLE)).run(); // now zero refs
    // The cursor came from the addReference (1_000_000), not production (1000), so a 7-unit grace holds.
    expect(s.reclaimExpired(7)).toEqual([]);
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

  it('listObjectHandles returns every media_objects handle incl. soft-deleted (the GC orphan-detection set)', () => {
    const h2 = `media://sha256-${'c'.repeat(64)}`;
    store.recordObject({ handle: HANDLE, mimeType: 'image/png', modality: 'image', byteLength: 5 });
    store.recordObject({ handle: h2, mimeType: 'audio/mpeg', modality: 'audio', byteLength: 9 });
    expect(new Set(store.listObjectHandles())).toEqual(new Set([HANDLE, h2]));
    // A GC-soft-deleted (deleted_at set) row still HAS a row — its blob is not a row-less orphan, so it stays in
    // the set (both handles are unreferenced + past a 0 grace ⇒ reclaimExpired soft-deletes them).
    expect(store.reclaimExpired(0)).toHaveLength(2);
    expect(new Set(store.listObjectHandles())).toEqual(new Set([HANDLE, h2]));
  });

  it('runReferenceRunIds returns the distinct run-kind scope ids only (the reclaim-retry input)', () => {
    store.recordObject({ handle: HANDLE, mimeType: 'image/png', modality: 'image', byteLength: 5 });
    store.addReference(HANDLE, 'run', 'run-a');
    store.addReference(HANDLE, 'run', 'run-a'); // idempotent — counted once
    store.addReference(HANDLE, 'run', 'run-b');
    store.addReference(HANDLE, 'node', 'node-1'); // lifetime, NOT a run ref
    store.addReference(HANDLE, 'session', 's1'); // authz, NOT a run ref
    expect(new Set(store.runReferenceRunIds())).toEqual(new Set(['run-a', 'run-b']));
  });
});
