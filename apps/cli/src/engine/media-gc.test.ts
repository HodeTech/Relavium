import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createMediaReferenceStore,
  FilesystemMediaStore,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedRun } from '../test-support.js';
import { runHostMediaGc, sweepHostMediaBestEffort, type MediaGcDeps } from './media-gc.js';

const H = (c: string): string => `media://sha256-${c.repeat(64)}`;

/** A fake CAS recording deletes + returning a fixed `{handle, mtimeMs}` listing — isolates the orchestration. */
function fakeCas(handles: Array<{ handle: string; mtimeMs: number }> = []): {
  store: MediaGcDeps['casStore'];
  deleted: string[];
} {
  const deleted: string[] = [];
  return {
    deleted,
    store: {
      delete: (handle) => {
        deleted.push(handle);
        return Promise.resolve();
      },
      listHandles: () => Promise.resolve(handles),
    },
  };
}

/** A fake reference junction; `removeCount` lets a test exercise the `> 0` reclaim guard. */
function fakeRefs(over: {
  expired?: string[];
  objectHandles?: string[];
  runRefRunIds?: string[];
  removeCount?: (runId: string) => number;
}): { refs: MediaGcDeps['references']; removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    refs: {
      reclaimExpired: () => over.expired ?? [],
      removeRunReferences: (runId) => {
        removed.push(runId);
        return over.removeCount?.(runId) ?? 1;
      },
      listObjectHandles: () => over.objectHandles ?? [],
      runReferenceRunIds: () => over.runRefRunIds ?? [],
    },
  };
}

/** Base deps with the orphan age-guard disabled (orphanMinAgeMs 0) and a fixed clock, so a test opts into age. */
function baseDeps(over: Partial<MediaGcDeps>): MediaGcDeps {
  return {
    casStore: fakeCas().store,
    references: fakeRefs({}).refs,
    isReclaimableRun: () => true,
    hasOtherActiveRuns: () => false,
    graceMs: 0,
    now: () => 10_000,
    orphanMinAgeMs: 0,
    currentRunId: 'current',
    ...over,
  };
}

describe('runHostMediaGc (2.S/D-GC, ADR-0042 §4)', () => {
  it('reclaim-retry: sweeps ONLY reclaimable (settled), non-current runs with lingering run-refs', async () => {
    const { refs, removed } = fakeRefs({ runRefRunIds: ['settled-a', 'active-b', 'current'] });
    const report = await runHostMediaGc(
      baseDeps({
        references: refs,
        isReclaimableRun: (id) => id === 'settled-a', // active-b is live; current is excluded by id
      }),
    );
    expect(removed).toEqual(['settled-a']);
    expect(report.reclaimedRuns).toBe(1);
  });

  it('reclaim-retry: a run whose removeRunReferences returns 0 is NOT counted as reclaimed', async () => {
    const { refs } = fakeRefs({
      runRefRunIds: ['a', 'b'],
      removeCount: (id) => (id === 'a' ? 0 : 1), // `a` had no rows left to remove
    });
    const report = await runHostMediaGc(baseDeps({ references: refs, currentRunId: 'x' }));
    expect(report.reclaimedRuns).toBe(1); // only `b`
  });

  it('grace-GC: deletes the CAS bytes of every grace-expired handle reclaimExpired returns', async () => {
    const cas = fakeCas();
    const { refs } = fakeRefs({ expired: [H('a'), H('b')] });
    const report = await runHostMediaGc(baseDeps({ casStore: cas.store, references: refs }));
    expect(cas.deleted).toEqual([H('a'), H('b')]);
    expect(report.graceReclaimed).toBe(2);
  });

  it('orphan-sweep: deletes settled row-less blobs (no media_objects row), keeps the known ones', async () => {
    const cas = fakeCas([
      { handle: H('a'), mtimeMs: 0 },
      { handle: H('b'), mtimeMs: 0 },
      { handle: H('c'), mtimeMs: 0 },
    ]);
    const { refs } = fakeRefs({ objectHandles: [H('a')] }); // only `a` has a row
    const report = await runHostMediaGc(baseDeps({ casStore: cas.store, references: refs }));
    expect(cas.deleted).toEqual([H('b'), H('c')]); // the row-less orphans, never `a`
    expect(report.orphansDeleted).toBe(2);
    expect(report.orphanSweepRan).toBe(true);
  });

  it('orphan-sweep: age-guard SKIPS a fresh row-less blob (a concurrent put not yet recordObject-ed)', async () => {
    const cas = fakeCas([
      { handle: H('old'), mtimeMs: 1_000 }, // older than the settle window
      { handle: H('fresh'), mtimeMs: 9_999 }, // within the window (now 10_000, age 5_000)
    ]);
    const { refs } = fakeRefs({ objectHandles: [] });
    const report = await runHostMediaGc(
      baseDeps({ casStore: cas.store, references: refs, now: () => 10_000, orphanMinAgeMs: 5_000 }),
    );
    expect(cas.deleted).toEqual([H('old')]); // the fresh blob is protected
    expect(report.orphansDeleted).toBe(1);
  });

  it('orphan-sweep: SKIPPED entirely while another run is active (protects a concurrent writer)', async () => {
    const cas = fakeCas([{ handle: H('a'), mtimeMs: 0 }]);
    const report = await runHostMediaGc(
      baseDeps({ casStore: cas.store, hasOtherActiveRuns: () => true }),
    );
    expect(cas.deleted).toEqual([]);
    expect(report.orphansDeleted).toBe(0);
    expect(report.orphanSweepRan).toBe(false);
  });

  it('runs the steps in order: reclaim retry → grace GC → orphan sweep (the fresh-window ordering)', async () => {
    // The grace GC (step 2) must run AFTER the reclaim retry (step 1) so a handle the retry just dropped to zero
    // refs keeps the fresh window removeRunReferences gave it, rather than being reclaimed the same pass. The
    // invariant is structural (unobservable in one pass — the handle is referenced when grace would otherwise
    // run, or fresh-windowed after), so pin the CALL ORDER directly.
    const calls: string[] = [];
    const refs: MediaGcDeps['references'] = {
      runReferenceRunIds: () => ['settled'],
      removeRunReferences: () => {
        calls.push('removeRunReferences');
        return 1;
      },
      reclaimExpired: () => {
        calls.push('reclaimExpired');
        return [];
      },
      listObjectHandles: () => {
        calls.push('listObjectHandles');
        return [];
      },
    };
    await runHostMediaGc(
      baseDeps({ references: refs, isReclaimableRun: () => true, currentRunId: 'x' }),
    );
    expect(calls).toEqual(['removeRunReferences', 'reclaimExpired', 'listObjectHandles']);
  });
});

describe('sweepHostMediaBestEffort (the run/gate run-end wrapper — real db + CAS)', () => {
  let client: DbClient;
  let casRoot: string;
  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    casRoot = mkdtempSync(join(tmpdir(), 'relavium-gc-cas-'));
  });
  afterEach(() => {
    try {
      client.sqlite.close();
    } catch {
      // already closed by a test
    }
    rmSync(casRoot, { recursive: true, force: true });
  });

  it('returns a report on the happy path (empty db + CAS ⇒ nothing reclaimed)', async () => {
    const report = await sweepHostMediaBestEffort({
      db: client.db,
      casRoot,
      currentRunId: 'run-1',
    });
    expect(report).toEqual({
      reclaimedRuns: 0,
      graceReclaimed: 0,
      orphansDeleted: 0,
      orphanSweepRan: true,
    });
  });

  it('swallows a fault and returns undefined — a GC failure is never a run-correctness break', async () => {
    client.sqlite.close(); // any store query now throws — the wrapper must not propagate it
    const report = await sweepHostMediaBestEffort({
      db: client.db,
      casRoot,
      currentRunId: 'run-1',
    });
    expect(report).toBeUndefined();
  });

  it('reclaims a terminal run’s lingering ref but DEFERS the orphan sweep while another run is active', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'terminal-run', state: 'completed' });
    await seedRun(client.db, { slug: 'wf', runId: 'active-run', state: 'running' });
    const refs = createMediaReferenceStore(client.db);
    refs.recordObject({ handle: H('a'), mimeType: 'image/png', modality: 'image', byteLength: 5 });
    refs.addReference(H('a'), 'run', 'terminal-run'); // a crash-dropped run-ref on the terminal run
    refs.addReference(H('a'), 'run', 'active-run'); // a legitimately-live ref on the running run

    const report = await sweepHostMediaBestEffort({
      db: client.db,
      casRoot,
      currentRunId: 'gate-run',
      orphanMinAgeMs: 0,
    });
    expect(report?.reclaimedRuns).toBe(1); // ONLY the terminal run — never the active (running) one
    expect(report?.orphanSweepRan).toBe(false); // the active run defers the sweep (TOCTOU protection)
    // The active run keeps its ref; the terminal run's ref is gone.
    expect(refs.runReferenceRunIds()).toEqual(['active-run']);
  });

  it('sweeps a row-less CAS orphan when no run is active (the current run is excluded)', async () => {
    const cas = new FilesystemMediaStore(casRoot);
    const orphan = await cas.put(new Uint8Array([1, 2, 3])); // bytes written, NO media_objects row recorded
    const report = await sweepHostMediaBestEffort({
      db: client.db,
      casRoot,
      currentRunId: 'run-1',
      orphanMinAgeMs: 0, // treat the just-written blob as settled for the test
    });
    expect(report?.orphanSweepRan).toBe(true);
    expect(report?.orphansDeleted).toBe(1);
    await expect(cas.get(orphan)).rejects.toThrow(); // the orphan bytes are gone
  });
});
