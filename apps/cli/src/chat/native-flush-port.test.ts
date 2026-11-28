/**
 * The flush of the chat's native card ([`native-flush-port.ts`](native-flush-port.ts); MVP-11 step 5, correctness round 1): the flush of the host
 * mounted for the card active NOW, never one of a host that has gone, and a way to wait for the host of a card that has just begun.
 */
import { describe, expect, it, vi } from 'vitest';

import type { NoticeFlush } from '../engine/effect-retention.js';
import {
  createNativeFlushPort,
  NATIVE_HOST_MOUNT_MS,
  NativeHostUnavailableError,
} from './native-flush-port.js';

/** A card channel as far as the port reads it: a snapshot with `active`, and listeners told when it changes. */
function fakeUi() {
  let active = false;
  const listeners = new Set<() => void>();
  return {
    ui: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      getSnapshot: () =>
        ({ active }) as ReturnType<Parameters<typeof createNativeFlushPort>[0]['getSnapshot']>,
    },
    set: (next: boolean): void => {
      active = next;
      for (const listener of [...listeners]) listener();
    },
    listeners: () => listeners.size,
  };
}

/** A timer the test fires itself. */
function manualTimer() {
  const pending = new Map<number, () => void>();
  let id = 0;
  return {
    timer: (fire: () => void, ms: number): (() => void) => {
      expect(ms).toBe(NATIVE_HOST_MOUNT_MS);
      const mine = (id += 1);
      pending.set(mine, fire);
      return () => {
        pending.delete(mine);
      };
    },
    fire: (): void => {
      for (const fire of [...pending.values()]) fire();
    },
    pending: (): number => pending.size,
  };
}

const flushA: NoticeFlush = () => Promise.resolve();
const flushB: NoticeFlush = () => Promise.resolve();

describe('the flush of the host mounted for the card active now', () => {
  it('there is none before a host mounted, and none while no card is active', () => {
    const f = fakeUi();
    const port = createNativeFlushPort(f.ui);
    expect(port.current()).toBeUndefined();
    f.set(true);
    expect(port.current()).toBeUndefined(); // the card is active, its host has not mounted yet: the bug this port exists for
    port.ready(flushA);
    expect(port.current()).toBe(flushA);
    f.set(false);
    expect(port.current()).toBeUndefined();
  });

  it('the flush of a host that has gone is never handed to the next card’s flow', () => {
    const f = fakeUi();
    const port = createNativeFlushPort(f.ui);
    f.set(true);
    port.ready(flushA);
    f.set(false); // the card ended: its host unmounted, and its flush now rejects
    f.set(true); // the next card begins, its host not mounted yet
    expect(port.current()).toBeUndefined();
    port.ready(flushB);
    expect(port.current()).toBe(flushB);
  });
});

describe('waiting for the host of a card that has just begun', () => {
  it('resolves at once when the host is already mounted', async () => {
    const f = fakeUi();
    const port = createNativeFlushPort(f.ui);
    f.set(true);
    port.ready(flushA);
    await expect(port.mounted()).resolves.toBe(flushA);
  });

  it('resolves with the flush of the host that mounts after the card began, and holds no timer afterwards', async () => {
    const f = fakeUi();
    const t = manualTimer();
    const port = createNativeFlushPort(f.ui, { timer: t.timer });
    f.set(true);
    port.ready(flushA); // an earlier card's host…
    f.set(false); // …gone
    f.set(true);
    const asked = port.mounted();
    expect(t.pending()).toBe(1);
    port.ready(flushB);
    await expect(asked).resolves.toBe(flushB);
    expect(t.pending()).toBe(0);
  });

  it('rejects when no host mounts in time: the card could not be shown', async () => {
    const f = fakeUi();
    const t = manualTimer();
    const port = createNativeFlushPort(f.ui, { timer: t.timer });
    f.set(true);
    const asked = port.mounted();
    t.fire();
    await expect(asked).rejects.toBeInstanceOf(NativeHostUnavailableError);
    // A host that mounts afterwards is for the next ask, not this one.
    port.ready(flushA);
    await expect(port.mounted()).resolves.toBe(flushA);
  });

  it('rejects when the flow is cancelled first, and at once for a flow already cancelled', async () => {
    const f = fakeUi();
    const t = manualTimer();
    const port = createNativeFlushPort(f.ui, { timer: t.timer });
    f.set(true);
    const controller = new AbortController();
    const asked = port.mounted(controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(asked).rejects.toBeInstanceOf(NativeHostUnavailableError);
    expect(t.pending()).toBe(0);
    await expect(port.mounted(controller.signal)).rejects.toBeInstanceOf(
      NativeHostUnavailableError,
    );
    expect(t.pending()).toBe(0);
  });

  it('the chat’s end stops listening and rejects whoever still waits', async () => {
    const f = fakeUi();
    const t = manualTimer();
    const port = createNativeFlushPort(f.ui, { timer: t.timer });
    f.set(true);
    const asked = port.mounted();
    port.dispose();
    await expect(asked).rejects.toBeInstanceOf(NativeHostUnavailableError);
    expect(f.listeners()).toBe(0);
    expect(t.pending()).toBe(0);
  });

  it('uses the real timer by default: a host that mounts within the bound answers the ask, and one that never does is refused at it', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeUi();
      const port = createNativeFlushPort(f.ui);
      f.set(true);
      const inTime = port.mounted();
      await vi.advanceTimersByTimeAsync(NATIVE_HOST_MOUNT_MS - 1);
      port.ready(flushA);
      await expect(inTime).resolves.toBe(flushA);
      await vi.advanceTimersByTimeAsync(NATIVE_HOST_MOUNT_MS); // the answered ask's timer was cancelled: nothing rejects afterwards
      f.set(false);
      f.set(true);
      const never = expect(port.mounted()).rejects.toBeInstanceOf(NativeHostUnavailableError);
      await vi.advanceTimersByTimeAsync(NATIVE_HOST_MOUNT_MS);
      await never;
    } finally {
      vi.useRealTimers();
    }
  });
});
