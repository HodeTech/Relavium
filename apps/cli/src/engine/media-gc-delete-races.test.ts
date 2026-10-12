import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesystemMediaStore } from '@relavium/db';
import { afterEach, expect, it, vi } from 'vitest';

import { runHostMediaGc, type MediaGcDeps } from './media-gc.js';

const boundary = vi.hoisted(() => ({
  beforeRm: vi.fn<() => Promise<void>>(),
  afterRm: vi.fn<() => void>(),
}));
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return {
    ...native,
    rm: async (...args: Parameters<typeof native.rm>) => {
      await boundary.beforeRm();
      try {
        await native.rm(...args);
      } finally {
        boundary.afterRm();
      }
    },
  };
});

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

it('both cooperating grace collectors continue to the orphan phase after one removes their shared blob', async () => {
  boundary.beforeRm.mockResolvedValue(undefined);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-gc-delete-races-')));
  const first = new FilesystemMediaStore(root);
  const second = new FilesystemMediaStore(root);
  const handle = await first.put(Buffer.from('native GC deletion fixture'));
  const digest = handle.slice('media://sha256-'.length);
  const target = join(root, digest.slice(0, 2), digest.slice(2));
  const firstList = vi.spyOn(first, 'listHandles');
  const secondList = vi.spyOn(second, 'listHandles');
  let release = (): void => undefined;
  const completed = new Promise<void>((resolve) => {
    release = resolve;
  });
  boundary.beforeRm.mockImplementationOnce(() => completed);
  boundary.afterRm.mockImplementationOnce(release);
  const deps = (casStore: FilesystemMediaStore): MediaGcDeps => ({
    casStore,
    references: {
      runReferenceRunIds: () => [],
      removeRunReferences: () => 0,
      reclaimExpired: () => [handle],
      listObjectHandles: () => [],
    },
    isReclaimableRun: () => true,
    hasOtherActiveRuns: () => false,
    graceMs: 0,
    orphanMinAgeMs: 0,
    now: () => Date.now(),
  });
  // Both collectors finish synchronous admission before the second native rm removes
  // the blob. Its completion releases the first rm, which observes the missing entry.
  const results = await Promise.allSettled([
    runHostMediaGc(deps(first)),
    runHostMediaGc(deps(second)),
  ]);
  expect(results, 'FS_CAUSAL_CAS_DELETE_GC_CONTINUATION').toEqual([
    {
      status: 'fulfilled',
      value: { reclaimedRuns: 0, graceReclaimed: 1, orphansDeleted: 0, orphanSweepRan: true },
    },
    {
      status: 'fulfilled',
      value: { reclaimedRuns: 0, graceReclaimed: 1, orphansDeleted: 0, orphanSweepRan: true },
    },
  ]);
  expect(firstList).toHaveBeenCalledOnce();
  expect(secondList).toHaveBeenCalledOnce();
  expect(boundary.beforeRm).toHaveBeenCalledTimes(2);
  expect(existsSync(target)).toBe(false);
});
