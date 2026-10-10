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

it('writes one latest summary only after actual input and host acknowledgements', async () => {
  const inputEntered = latch(),
    inputRelease = latch(),
    hostEntered = latch(),
    hostRelease = latch();
  const summaries: string[] = [];
  let unmounts = 0;
  const renderer = createInkRenderer({
    color: false,
    writeSummary: (text) => summaries.push(text),
    mount: () => ({
      unmount: () => {
        unmounts++;
      },
      waitUntilExit: () => {
        inputEntered.release();
        return inputRelease.promise;
      },
    }),
  });
  renderer.onEvent(paused);
  // Mirror the real driver's ownership order, including events delivered during input release.
  const work = (async () => {
    await renderer.releaseInput?.();
    hostEntered.release();
    await hostRelease.promise;
    await renderer.finalize?.();
  })();
  try {
    await inputEntered.promise;
    expect(unmounts).toBe(1);
    expect(summaries).toHaveLength(0);
    inputRelease.release();
    await hostEntered.promise;
    expect(summaries).toHaveLength(0);
    renderer.onEvent(cancelled);
  } finally {
    inputRelease.release();
    hostRelease.release();
    await work;
  }
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toContain('run cancelled');
  expect(summaries[0]).not.toContain('run paused');
  await renderer.finalize?.();
  expect(summaries).toHaveLength(1);
});

for (const fault of ['unmount', 'wait'] as const) {
  it(`retains the input capability after ${fault} rejection until a real retry acknowledges`, async () => {
    const secondEntered = latch(),
      secondRelease = latch();
    const stopError = new Error('synthetic input release fault');
    const summaries: string[] = [];
    let unmounts = 0,
      waits = 0;
    const renderer = createInkRenderer({
      color: false,
      writeSummary: (text) => summaries.push(text),
      mount: () => ({
        unmount: () => {
          unmounts++;
          if (fault === 'unmount' && unmounts === 1) throw stopError;
        },
        waitUntilExit: () => {
          waits++;
          if (fault === 'wait' && waits === 1) return Promise.reject(stopError);
          secondEntered.release();
          return secondRelease.promise;
        },
      }),
    });
    renderer.onEvent(paused);
    await expect(Promise.resolve(renderer.finalize?.())).rejects.toBe(stopError);
    expect(summaries).toHaveLength(0);
    const release = renderer.releaseInput;
    if (release === undefined) throw new Error('input release capability required');
    const acknowledged = Promise.resolve(release());
    const final = Promise.resolve(renderer.finalize?.());
    try {
      await secondEntered.promise;
      expect(unmounts).toBe(2);
      expect(summaries).toHaveLength(0);
      renderer.onEvent(cancelled);
    } finally {
      secondRelease.release();
      await Promise.all([acknowledged, final]);
    }
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('run cancelled');
    await renderer.finalize?.();
    expect(summaries).toHaveLength(1);
  });
}

it('does not repeat an irreversible summary after a cosmetic write failure following acknowledgements', async () => {
  const writeError = new Error('synthetic summary sink fault');
  let inputAcks = 0,
    writes = 0;
  const renderer = createInkRenderer({
    color: false,
    mount: () => ({
      unmount: () => {},
      waitUntilExit: () => {
        inputAcks++;
        return Promise.resolve();
      },
    }),
    writeSummary: () => {
      writes++;
      throw writeError;
    },
  });
  renderer.onEvent(cancelled);
  await expect(Promise.resolve(renderer.finalize?.())).rejects.toBe(writeError);
  expect({ inputAcks, writes }).toEqual({ inputAcks: 1, writes: 1 });
  await renderer.releaseInput?.();
  await renderer.finalize?.();
  expect({ inputAcks, writes }).toEqual({ inputAcks: 1, writes: 1 });
});
