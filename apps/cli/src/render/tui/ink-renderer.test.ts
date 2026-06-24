import type { RunEvent } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { createInkRenderer, type InkMountInstance } from './ink-renderer.js';

const TS = '2026-06-23T12:00:00.000Z';
const RUN = 'run-1';

const COMPLETED: RunEvent = {
  type: 'run:completed',
  runId: RUN,
  timestamp: TS,
  sequenceNumber: 2,
  outputs: {},
  totalTokensUsed: { input: 1, output: 2 },
  totalCostMicrocents: 0,
  durationMs: 5,
};

/** A fake ink mount so the adapter's finalize logic is exercised without rendering React to a TTY. */
function fakeMount(): {
  mount: () => InkMountInstance;
  unmount: ReturnType<typeof vi.fn>;
  waitUntilExit: ReturnType<typeof vi.fn>;
} {
  const unmount = vi.fn();
  const waitUntilExit = vi.fn(() => Promise.resolve());
  return { mount: () => ({ unmount, waitUntilExit }), unmount, waitUntilExit };
}

/** Like {@link fakeMount} but counts mount() calls — so suspend/resume re-mount cycles (2.G) are observable. */
function countingMount(): {
  mount: () => InkMountInstance;
  unmount: ReturnType<typeof vi.fn>;
  mountCount: () => number;
} {
  let mounts = 0;
  const unmount = vi.fn();
  const waitUntilExit = vi.fn(() => Promise.resolve());
  return {
    mount: () => {
      mounts += 1;
      return { unmount, waitUntilExit };
    },
    unmount,
    mountCount: () => mounts,
  };
}

describe('createInkRenderer', () => {
  it('finalize unmounts, awaits exit, then writes the persistent summary — and is idempotent', async () => {
    const { mount, unmount, waitUntilExit } = fakeMount();
    const summaries: string[] = [];
    const renderer = createInkRenderer({
      color: false,
      mount,
      writeSummary: (text) => summaries.push(text),
    });

    renderer.onEvent({
      type: 'node:started',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 1,
      nodeId: 'a',
      nodeType: 'agent',
    });
    renderer.onEvent({
      type: 'node:completed',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 2,
      nodeId: 'a',
      output: null,
      tokensUsed: { input: 1, output: 1 },
      durationMs: 5,
    });
    renderer.onEvent({ ...COMPLETED, sequenceNumber: 3 });

    await renderer.finalize?.();
    await renderer.finalize?.(); // second call is a no-op

    expect(unmount).toHaveBeenCalledTimes(1);
    expect(waitUntilExit).toHaveBeenCalledTimes(1);
    expect(summaries).toHaveLength(1); // written exactly once
    expect(summaries[0]).toContain('run completed');
    expect(summaries[0]).toContain('✓ a');
  });

  it('writes the summary via the injected writeSummary, not stdout', async () => {
    const { mount } = fakeMount();
    const writeSummary = vi.fn();
    const renderer = createInkRenderer({ color: true, mount, writeSummary });
    renderer.onEvent({ type: 'run:cancelled', runId: RUN, timestamp: TS, sequenceNumber: 1 });
    await renderer.finalize?.();
    expect(writeSummary).toHaveBeenCalledTimes(1);
    expect(writeSummary.mock.calls[0]?.[0]).toContain('run cancelled');
  });

  it('suspend unmounts the live view WITHOUT a summary; resume re-mounts from the same store (2.G gate prompt)', async () => {
    const { mount, unmount, mountCount } = countingMount();
    const summaries: string[] = [];
    const renderer = createInkRenderer({
      color: false,
      mount,
      writeSummary: (text) => summaries.push(text),
    });
    expect(mountCount()).toBe(1); // initial mount at construction

    // Suspend to hand the terminal to the gate prompt: unmount, but the run is NOT over → no summary.
    await renderer.suspend?.();
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(summaries).toHaveLength(0);

    // Resume re-mounts a fresh ink instance over the retained store.
    await renderer.resume?.();
    expect(mountCount()).toBe(2);

    // Finalize then tears down the second instance and writes the persistent summary exactly once.
    await renderer.finalize?.();
    expect(unmount).toHaveBeenCalledTimes(2);
    expect(summaries).toHaveLength(1);
  });

  it('resume after finalize is a no-op — a late resume never re-opens a torn-down TUI', async () => {
    const { mount, mountCount } = countingMount();
    const renderer = createInkRenderer({ color: false, mount, writeSummary: () => {} });
    await renderer.finalize?.();
    await renderer.resume?.();
    expect(mountCount()).toBe(1); // still just the initial mount — finalize is terminal
  });

  it('resume while already mounted is idempotent (no double-mount without a preceding suspend)', async () => {
    const { mount, mountCount } = countingMount();
    const renderer = createInkRenderer({ color: false, mount, writeSummary: () => {} });
    await renderer.resume?.();
    expect(mountCount()).toBe(1);
  });

  it('clears the frame loop and re-throws if mount() throws during construction', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    expect(() =>
      createInkRenderer({
        color: false,
        mount: () => {
          throw new Error('mount failed');
        },
      }),
    ).toThrow('mount failed');
    expect(clearSpy).toHaveBeenCalled(); // the setInterval frame loop was cleared, not leaked (finalize never runs)
    clearSpy.mockRestore();
  });
});
