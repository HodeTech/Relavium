/**
 * `BoundedEventStream<E>` — the single-consumer, **bounded, no-drop** async queue that bridges the push
 * {@link RunEventBus} to a pull `for await`. It is the shared machinery behind both {@link RunHandle}
 * (`E = RunEvent`) and `SessionHandle` (1.W) — the only difference between the two handles is which
 * correlation key they filter on and which event closes the stream, so the queue itself is generic and
 * lives here once (no duplication).
 *
 * No-drop: an event pushed while no consumer is waiting is buffered; backpressure is signalled through
 * {@link whenDrained} (which the engine awaits at node boundaries) rather than by dropping — a drop would
 * force a `sequenceNumber` resync. One active iteration at a time (a second concurrent `next()` rejects);
 * additional observers attach via the handle's `subscribe`, not a second iterator.
 */

/** Default per-consumer high-water mark — beyond this, the producer is asked to await a drain. */
export const DEFAULT_STREAM_CAPACITY = 256;

export class BoundedEventStream<E> implements AsyncIterableIterator<E> {
  readonly #buffer: E[] = [];
  readonly #capacity: number;
  #waitingPull: ((result: IteratorResult<E>) => void) | undefined;
  #drainWaiters: (() => void)[] = [];
  #closed = false;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  /** Offer an event to the consumer (hand to a waiting `next()`, else buffer). Never drops. */
  push(event: E): void {
    if (this.#closed) {
      return;
    }
    if (this.#waitingPull !== undefined) {
      const resolve = this.#waitingPull;
      this.#waitingPull = undefined;
      resolve({ value: event, done: false });
      return;
    }
    this.#buffer.push(event);
  }

  /** Signal end-of-stream — drains what is buffered, then the iteration completes. */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#waitingPull !== undefined) {
      const resolve = this.#waitingPull;
      this.#waitingPull = undefined;
      resolve({ value: undefined, done: true });
    }
    this.#wakeDrainWaiters();
  }

  /** Resolves once the buffer is at or below capacity (or the stream is closed) — the backpressure knob. */
  whenDrained(): Promise<void> {
    if (this.#closed || this.#buffer.length <= this.#capacity) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }

  #wakeDrainWaiters(): void {
    if (this.#closed || this.#buffer.length <= this.#capacity) {
      const waiters = this.#drainWaiters;
      this.#drainWaiters = [];
      for (const wake of waiters) {
        wake();
      }
    }
  }

  next(): Promise<IteratorResult<E>> {
    const buffered = this.#buffer.shift();
    if (buffered !== undefined) {
      this.#wakeDrainWaiters();
      return Promise.resolve({ value: buffered, done: false });
    }
    if (this.#closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    if (this.#waitingPull !== undefined) {
      return Promise.reject(new Error('BoundedEventStream: concurrent next() is not supported'));
    }
    return new Promise<IteratorResult<E>>((resolve) => {
      this.#waitingPull = resolve;
    });
  }

  /** Consumer abandoned the loop (`break` / `return`) — release the stream. */
  return(): Promise<IteratorResult<E>> {
    this.close(); // settles any parked next() deterministically (don't duplicate that logic here)
    this.#buffer.length = 0; // discard anything still buffered on an early abandon
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<E> {
    return this;
  }
}
