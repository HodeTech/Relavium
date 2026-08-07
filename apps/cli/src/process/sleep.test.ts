import { describe, expect, it, vi } from 'vitest';

import { hostSleep } from './sleep.js';

/**
 * The host timer behind the engine's `sleep` seam (#W15-14). The chain honours a provider's `Retry-After` up
 * to a 60 s ceiling, and both surfaces used to pass a bare `setTimeout` promise nothing could interrupt.
 */
describe('hostSleep', () => {
  it('resolves early AND clears the timer when the signal aborts', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = hostSleep(60_000, controller.signal);
      expect(vi.getTimerCount()).toBe(1);

      controller.abort();
      await expect(pending).resolves.toBeUndefined(); // resolves, never rejects — the wait is simply over
      // Cleared, not merely raced: a pending 60 s timer would hold the event loop open long after the run
      // gave up on it.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never starts a timer for an already-aborted signal', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(hostSleep(60_000, controller.signal)).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still waits the full delay when nothing aborts', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let settled = false;
      const pending = hostSleep(1_000, controller.signal).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('works without a signal at all (the seam parameter is optional)', async () => {
    vi.useFakeTimers();
    try {
      const pending = hostSleep(10);
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
