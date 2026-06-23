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
