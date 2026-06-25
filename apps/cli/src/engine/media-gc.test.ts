import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHostMediaGc, sweepHostMediaBestEffort, type MediaGcDeps } from './media-gc.js';

const H = (c: string): string => `media://sha256-${c.repeat(64)}`;

/** A fake CAS that records deletes + returns a fixed handle listing — isolates the GC orchestration. */
function fakeCas(handles: string[] = []): {
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

/** A fake reference junction recording the run ids whose refs were swept. */
function fakeRefs(over: {
  expired?: string[];
  objectHandles?: string[];
  runRefRunIds?: string[];
}): { refs: MediaGcDeps['references']; removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    refs: {
      reclaimExpired: () => over.expired ?? [],
      removeRunReferences: (runId) => {
        removed.push(runId);
        return 1;
      },
      listObjectHandles: () => over.objectHandles ?? [],
      runReferenceRunIds: () => over.runRefRunIds ?? [],
    },
  };
}

describe('runHostMediaGc (2.S/D-GC, ADR-0042 §4)', () => {
  it('reclaim-retry: sweeps ONLY terminal, non-current runs with lingering run-refs', async () => {
    const { refs, removed } = fakeRefs({ runRefRunIds: ['terminal-a', 'active-b', 'current'] });
    const report = await runHostMediaGc({
      casStore: fakeCas().store,
      references: refs,
      // active-b is still running; current is the in-flight run — neither is reclaimed.
      isTerminalRun: (id) => id === 'terminal-a',
      hasOtherActiveRuns: () => false,
      graceMs: 0,
      currentRunId: 'current',
    });
    expect(removed).toEqual(['terminal-a']);
    expect(report.reclaimedRuns).toBe(1);
  });

  it('grace-GC: deletes the CAS bytes of every grace-expired handle reclaimExpired returns', async () => {
    const cas = fakeCas();
    const { refs } = fakeRefs({ expired: [H('a'), H('b')] });
    const report = await runHostMediaGc({
      casStore: cas.store,
      references: refs,
      isTerminalRun: () => true,
      hasOtherActiveRuns: () => false,
      graceMs: 1000,
      currentRunId: 'r',
    });
    expect(cas.deleted).toEqual([H('a'), H('b')]);
    expect(report.graceReclaimed).toBe(2);
  });

  it('orphan-sweep: deletes CAS blobs with NO media_objects row (and keeps the known ones)', async () => {
    const cas = fakeCas([H('a'), H('b'), H('c')]);
    const { refs } = fakeRefs({ objectHandles: [H('a')] }); // only `a` has a row
    const report = await runHostMediaGc({
      casStore: cas.store,
      references: refs,
      isTerminalRun: () => true,
      hasOtherActiveRuns: () => false,
      graceMs: 0,
      currentRunId: 'r',
    });
    expect(cas.deleted).toEqual([H('b'), H('c')]); // the row-less orphans, never `a`
    expect(report.orphansDeleted).toBe(2);
    expect(report.orphanSweepRan).toBe(true);
  });

  it('orphan-sweep: SKIPPED entirely while another run is active (protects a concurrent writer)', async () => {
    const cas = fakeCas([H('a'), H('b')]); // both row-less — but must NOT be touched
    const { refs } = fakeRefs({ objectHandles: [] });
    const report = await runHostMediaGc({
      casStore: cas.store,
      references: refs,
      isTerminalRun: () => true,
      hasOtherActiveRuns: () => true, // a concurrent run could be mid-put — defer the sweep
      graceMs: 0,
      currentRunId: 'r',
    });
    expect(cas.deleted).toEqual([]); // nothing swept
    expect(report.orphansDeleted).toBe(0);
    expect(report.orphanSweepRan).toBe(false);
  });
});

describe('sweepHostMediaBestEffort (the run/gate run-end wrapper)', () => {
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
});
