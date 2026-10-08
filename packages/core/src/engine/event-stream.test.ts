import { describe, expect, it, vi } from 'vitest';

import { BoundedEventStream } from './event-stream.js';
import { RunLoopInvariantError } from './invariant-error.js';

describe('BoundedEventStream — onClose cleanup hook (1.W)', () => {
  it('invokes onClose exactly once when the stream is closed (idempotent on a second close)', () => {
    const onClose = vi.fn();
    const stream = new BoundedEventStream<number>(8, onClose);
    stream.close();
    stream.close(); // a second close is a no-op (guarded by #closed) — must NOT fire onClose again
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('invokes onClose when the consumer abandons the loop early (return() routes through close())', async () => {
    const onClose = vi.fn();
    const stream = new BoundedEventStream<number>(8, onClose);
    await stream.return(); // a `break`/`return` from a `for await` calls return() — the early-abandon path
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('treats onClose as optional — close() is a no-op without one', () => {
    const stream = new BoundedEventStream<number>(8);
    expect(() => {
      stream.close();
    }).not.toThrow();
  });

  it('rejects a second concurrent next() with a typed RunLoopInvariantError (concurrent_consumer)', async () => {
    const stream = new BoundedEventStream<number>(8);
    const first = stream.next(); // parks waiting for an event
    let caught: unknown;
    try {
      await stream.next();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RunLoopInvariantError);
    expect(caught instanceof RunLoopInvariantError && caught.code).toBe('concurrent_consumer');
    stream.push(1);
    await first;
  });
});

describe('BoundedEventStream — one freed slot wakes one producer (CR-30)', () => {
  it('never lets N concurrent producers overshoot the ceiling by N-1', async () => {
    // Releasing EVERY parked waiter when one slot frees let each woken producer push, so the buffer peaked at
    // `capacity + N - 1` — 7 over at the default `max_parallel` of 8, and 63 over at an authored 64. A
    // ceiling that a legal number of producers can exceed is not a ceiling.
    const CAPACITY = 2;
    const PRODUCERS = 6;
    const stream = new BoundedEventStream<number>(CAPACITY);
    // Fill FIRST, then pull once. A pull on an empty stream parks as a waiting consumer and the next push is
    // handed straight to it, so pulling first would leave the buffer under capacity and every producer would
    // sail through `whenDrained` — the setup would test nothing.
    // Also: an un-pulled stream DECLINES past its ceiling, so the fill has to happen in two stages.
    for (let i = 0; i < CAPACITY; i += 1) stream.push(i);
    await stream.next(); // marks it pulled; buffer drops to CAPACITY - 1
    stream.push(99); // back to exactly CAPACITY, now with `#everPulled` set

    let peak = stream.bufferedCount;
    expect(peak).toBe(CAPACITY); // the premise: producers really do park
    const producers = Array.from({ length: PRODUCERS }, (_, i) =>
      stream.whenDrained().then(() => {
        stream.push(100 + i);
        peak = Math.max(peak, stream.bufferedCount);
      }),
    );
    await Promise.resolve();

    // One pull frees exactly one slot. Every parked producer being woken is the defect.
    await stream.next();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(CAPACITY);

    // Drain the rest so the pending producers settle and the test leaves nothing parked.
    for (let i = 0; i < PRODUCERS + CAPACITY; i += 1) {
      void stream.next();
      for (let j = 0; j < 5; j += 1) await Promise.resolve();
    }
    stream.close();
    await Promise.all(producers);
  });
});

describe('BoundedEventStream — actual delivery observation (ADR-0103)', () => {
  it('marks an offer refused by a closed queue as a gap, without changing actual delivery', async () => {
    const stream = new BoundedEventStream<number>(2);
    stream.push(1);
    stream.close();
    stream.push(2);
    expect(stream.deliveryState).toEqual({
      publishedCount: 2,
      deliveredCount: 0,
      hasGap: true,
      abandoned: false,
    });
    expect(await stream.next()).toEqual({ value: 1, done: false });
    expect(await stream.next()).toEqual({ value: undefined, done: true });
    expect(stream.deliveryState).toEqual({
      publishedCount: 2,
      deliveredCount: 1,
      hasGap: true,
      abandoned: false,
    });
  });

  it('does not count rejected concurrent next, close or return as delivery', async () => {
    const stream = new BoundedEventStream<number>(2);
    const waiting = stream.next();
    await expect(stream.next()).rejects.toBeInstanceOf(RunLoopInvariantError);
    expect(stream.deliveryState.deliveredCount).toBe(0);
    await stream.return();
    expect(await waiting).toEqual({ done: true, value: undefined });
    stream.close();
    expect(stream.deliveryState).toEqual({
      publishedCount: 0,
      deliveredCount: 0,
      hasGap: false,
      abandoned: true,
    });
  });
});
