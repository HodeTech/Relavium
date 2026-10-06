import type { RunEvent } from '@relavium/shared';
import { expect, it } from 'vitest';
import { createInkRenderer } from './ink-renderer.js';

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const paused: RunEvent = {
  type: 'run:paused',
  runId: 'summary-barrier',
  timestamp: '2026-10-06T19:00:00.000Z',
  sequenceNumber: 1,
  pendingGateCount: 1,
  gateIds: ['g'],
};
const cancelled: RunEvent = {
  type: 'run:cancelled',
  runId: 'summary-barrier',
  timestamp: '2026-10-06T19:00:01.000Z',
  sequenceNumber: 2,
};
for (const stopFails of [false, true]) {
  it(`writes the settled cancellation summary after unmount, including rejected stop: ${stopFails}`, async () => {
    const entered = latch(),
      release = latch();
    const summaries: string[] = [];
    const stopError = new Error('held unmount failure');
    let unmounted = false;
    const renderer = createInkRenderer({
      color: false,
      writeSummary: (text) => summaries.push(text),
      mount: () => ({
        unmount: () => {
          unmounted = true;
        },
        waitUntilExit: () => (stopFails ? Promise.reject(stopError) : Promise.resolve()),
      }),
    });
    renderer.onEvent(paused);
    const work = Promise.resolve(
      renderer.finalize?.(async () => {
        expect(unmounted).toBe(true);
        entered.release();
        await release.promise;
      }),
    );
    const settled = work.then(
      () => 'finished' as const,
      () => 'failed' as const,
    );
    try {
      expect(await Promise.race([entered.promise.then(() => 'barrier' as const), settled])).toBe(
        'barrier',
      );
      expect(summaries).toHaveLength(0);
      renderer.onEvent(cancelled);
    } finally {
      release.release();
    }
    if (stopFails) await expect(work).rejects.toBe(stopError);
    else await work;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('run cancelled');
    expect(summaries[0]).not.toContain('run paused');
    await renderer.finalize?.();
    expect(summaries).toHaveLength(1);
  });
}
