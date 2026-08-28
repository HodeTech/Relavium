/**
 * `BoundedEventStream<E>` — the single-consumer, **bounded, no-drop** async queue that bridges the push
 * {@link RunEventBus} to a pull `for await`. It is the shared machinery behind both {@link RunHandle}
 * (`E = RunEvent`) and `SessionHandle` (1.W) — the only difference between the two handles is which
 * correlation key they filter on and which event closes the stream, so the queue itself is generic and
 * lives here once (no duplication).
 *
 * No-drop: an event pushed while no consumer is waiting is buffered; backpressure is signalled through
 * {@link whenDrained} rather than by dropping — a drop would force a `sequenceNumber` resync. One active
 * iteration at a time (a second concurrent `next()` rejects); additional observers attach via the handle's
 * `subscribe`, not a second iterator.
 *
 * **How the ceiling is actually held (`CR-30`).** `push` is synchronous and never drops, so the queue alone
 * cannot cap itself — the three properties "synchronous push", "no drop" and "hard ceiling" are not
 * simultaneously satisfiable, and ADR-0036 resolves that by naming the third party: the PRODUCER awaits.
 * This class therefore owns two things and claims no more: it never drops, and {@link whenDrained} tells the
 * truth about whether the ceiling is exceeded. Enforcement is the producers' side of the contract, and every
 * producer that can emit an unbounded number of events now honours it — the workflow run loop once per node,
 * and the agent turn's chunk loop once per chunk, which is the case that actually grows without a bound.
 * {@link highWaterMark} exposes the ceiling so a test can assert the bound rather than infer it, and
 * {@link bufferedCount} exposes the depth for the same reason.
 *
 * The optional `onClose` callback fires **once**, deterministically, when the stream closes — whether on a
 * terminal event or when the consumer abandons the loop early (`break` / `return`, which routes through
 * {@link return} → {@link close}). The owning handle passes its bus `unsubscribe` here so an early-abandoned
 * stream stops the bus subscription immediately (no leaked listener / wasted fan-out on a long-lived bus),
 * instead of lingering until the next terminal event.
 */

import { RunLoopInvariantError } from './invariant-error.js';

/** Default per-consumer high-water mark — beyond this, the producer is asked to await a drain. */
export const DEFAULT_STREAM_CAPACITY = 256;

export class BoundedEventStream<E> implements AsyncIterableIterator<E> {
  readonly #buffer: E[] = [];
  readonly #capacity: number;
  readonly #onClose: (() => void) | undefined;
  #waitingPull: ((result: IteratorResult<E>) => void) | undefined;
  #drainWaiters: (() => void)[] = [];
  #closed = false;

  constructor(capacity: number, onClose?: () => void) {
    this.#capacity = capacity;
    this.#onClose = onClose;
  }

  /** The per-consumer ceiling this stream was built with (ADR-0036's "bounded per consumer"). */
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
    this.#onClose?.(); // once (guarded by #closed above) — lets the owning handle unsubscribe deterministically
  }

  /**
   * Resolves once there is **room for one more** event — the backpressure knob.
   *
   * **Strictly below the ceiling, not at it, and that one character is the bound (`CR-30`).** The
   * predicate answers a producer's question, and the producer's next action is a `push`: resolving at
   * `length === capacity` grants permission for a push that lands at `capacity + 1`, so a producer that
   * obeyed the contract perfectly still exceeded the ceiling by one on every cycle. Measured — the
   * acceptance test read `expected 5 to be less than or equal to 4` against the older `<=` form.
   *
   * A closed stream always resolves: there is no consumer left to protect, and parking a producer on a
   * dead stream would hang it.
   */
  whenDrained(): Promise<void> {
    if (this.#closed || this.#buffer.length < this.#capacity) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }

  #wakeDrainWaiters(): void {
    if (this.#closed || this.#buffer.length < this.#capacity) {
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
    this.close(); // settles any parked next() deterministically (don't duplicate that logic here)
    this.#buffer.length = 0; // discard anything still buffered on an early abandon
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<E> {
    return this;
  }
}
