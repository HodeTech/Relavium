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
