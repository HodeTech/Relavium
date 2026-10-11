/**
 * Single-consumer queue bridging the push event bus to pull iteration (ADR-0036, ADR-0087 §1).
 * Consumption is fixed at construction: an `iterated` stream owes every publication, even before
 * its first pull; a `subscribe-only` stream has no primary buffer or delivery authority.
 *
 * Iterated producers await {@link BoundedEventStream.whenDrained} before emitting. Readiness is
 * advisory, not a reserved permit: concurrent fast-path callers or repeated pulls before resumed
 * producers push can still overshoot capacity (ADR-0087 Correction 2 and W8 preflight correction).
 * Synchronous lifecycle publications can also exceed capacity; none are dropped. Exact-capacity
 * admission remains outside this consumption-mode repair.
 *
 * The optional close callback fires once on terminal closure or early consumer return. Handles
 * use it to detach their construction-time bus listener deterministically.
 */

import { RunLoopInvariantError } from './invariant-error.js';

/** Default per-consumer high-water mark — beyond this, the producer is asked to await a drain. */
export const DEFAULT_STREAM_CAPACITY = 256;

/** How the handle's primary event stream is consumed, fixed at construction (ADR-0087 §1). */
export type EventConsumption = 'iterated' | 'subscribe-only';

/**
 * Internal primary-delivery observation (ADR-0103). Counts belong to this queue's publications,
 * not the durable sequence source. A gap or abandonment permanently prevents consumption from
 * certifying a paused departure, even when the remaining buffer has been drained.
 */
export interface EventStreamDeliveryState {
  readonly publishedCount: number;
  readonly deliveredCount: number;
  readonly hasGap: boolean;
  readonly abandoned: boolean;
}

export class BoundedEventStream<E> implements AsyncIterableIterator<E> {
  readonly #buffer: E[] = [];
  readonly #capacity: number;
  readonly #onClose: (() => void) | undefined;
  readonly #eventConsumption: EventConsumption;
  #waitingPull: ((result: IteratorResult<E>) => void) | undefined;
  #drainWaiters: (() => void)[] = [];
  #closed = false;
  #publishedCount = 0;
  #deliveredCount = 0;
  #hasGap = false;
  #abandoned = false;

  constructor(
    capacity: number,
    onClose?: () => void,
    eventConsumption: EventConsumption = 'iterated',
  ) {
    this.#capacity = capacity;
    this.#onClose = onClose;
    this.#eventConsumption = eventConsumption;
  }

  /** The primary high-water mark; readiness remains advisory rather than exact-capacity admission. */
  get highWaterMark(): number {
    return this.#capacity;
  }

  /**
   * How many events are buffered right now.
   *
   * Exposed so a test can assert the ceiling DIRECTLY. The test that stood here before `CR-30` inferred
   * backpressure from `whenDrained()` resolving after two pulls, having first pushed four events into a
   * capacity-2 stream — it demonstrated the ceiling being exceeded and called that backpressure. A property
   * that is only observable by inference is a property that can be asserted while false.
   */
  get bufferedCount(): number {
    return this.#buffer.length;
  }

  /** Read-only, content-free snapshot for internal handle construction; never an acknowledgement API. */
  get deliveryState(): EventStreamDeliveryState {
    return Object.freeze({
      publishedCount: this.#publishedCount,
      deliveredCount: this.#deliveredCount,
      hasGap: this.#hasGap,
      abandoned: this.#abandoned,
    });
  }

  /** Offer to a waiting primary pull, else buffer losslessly; subscribe-only owns no primary. */
  push(event: E): void {
    if (this.#eventConsumption === 'subscribe-only') return;
    // Observe publication before offering it to a waiting pull or the buffer, including refusal.
    // No observer callback runs here: arbitrary code cannot acknowledge or interfere with delivery.
    this.#publishedCount += 1;
    if (this.#closed) {
      this.#hasGap = true;
      return;
    }
    if (this.#waitingPull !== undefined) {
      const resolve = this.#waitingPull;
      this.#waitingPull = undefined;
      this.#deliveredCount += 1;
      resolve({ value: event, done: false });
      return;
    }
    this.#buffer.push(event);
  }

  /** Compatibility observation: explicit consumption modes never decline unpulled events. */
  get unpulledOverflow(): number {
    return 0;
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
    this.#onClose?.(); // once (guarded by #closed above) — lets the owning handle unsubscribe deterministically
  }

  /**
   * Readiness below capacity, including before the first pull. Closure and subscribe-only resolve
   * immediately. This is an observation, not a slot reservation; see the concurrent-grant residual above.
   */
  whenDrained(): Promise<void> {
    if (
      this.#closed ||
      this.#eventConsumption === 'subscribe-only' ||
      this.#buffer.length < this.#capacity
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }

  #wakeDrainWaiters(): void {
    // A closed or subscribe-only stream owes nobody a wait: release everyone.
    if (this.#closed || this.#eventConsumption === 'subscribe-only') {
      const all = this.#drainWaiters;
      this.#drainWaiters = [];
      for (const wake of all) wake();
      return;
    }
    // Limit this wake to currently free slots. Outstanding grants are not tracked, so repeated
    // pulls before producer continuations run can still oversubscribe (the recorded residual).
    const free = this.#capacity - this.#buffer.length;
    if (free <= 0) {
      return;
    }
    const woken = this.#drainWaiters.splice(0, free);
    for (const wake of woken) wake();
  }

  next(): Promise<IteratorResult<E>> {
    if (this.#eventConsumption === 'subscribe-only') {
      return Promise.reject(this.#invalidConsumerMode());
    }
    const buffered = this.#buffer.shift();
    if (buffered !== undefined) {
      this.#deliveredCount += 1;
      this.#wakeDrainWaiters();
      return Promise.resolve({ value: buffered, done: false });
    }
    if (this.#closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    if (this.#waitingPull !== undefined) {
      return Promise.reject(
        new RunLoopInvariantError(
          'concurrent_consumer',
          'BoundedEventStream: a second concurrent next() is not supported (single-consumer stream)',
        ),
      );
    }
    return new Promise<IteratorResult<E>>((resolve) => {
      this.#waitingPull = resolve;
    });
  }

  /** Consumer abandoned the loop (`break` / `return`) — release the stream. */
  return(): Promise<IteratorResult<E>> {
    // A normal, fully drained close is not abandonment. Returning an open stream or throwing away
    // closed-but-undelivered events is. Neither case acknowledges an event or clears a prior gap.
    if (!this.#closed || this.#buffer.length > 0) {
      this.#abandoned = true;
    }
    this.close(); // settles any parked next() deterministically (don't duplicate that logic here)
    this.#buffer.length = 0; // discard anything still buffered on an early abandon
    return Promise.resolve({ value: undefined, done: true });
  }

  #invalidConsumerMode(): RunLoopInvariantError {
    return new RunLoopInvariantError(
      'invalid_consumer_mode',
      'BoundedEventStream: a subscribe-only stream cannot be iterated',
    );
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<E> {
    if (this.#eventConsumption === 'subscribe-only') throw this.#invalidConsumerMode();
    return this;
  }
}
