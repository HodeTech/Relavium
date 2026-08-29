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
 * **And it paces a consumer that EXISTS.** A stream nobody iterates has no consumer to protect, so
 * `whenDrained` resolves freely until the first `next()`. Without that, the producer-await deadlocked every
 * CLI session: those surfaces attach with `subscribe()`, which is a separate bus subscription and never
 * drains this buffer at all.
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
  /**
   * Whether anyone has ever pulled from this stream — the difference between a SLOW consumer and NO consumer.
   *
   * Backpressure paces a consumer that exists. Parking a producer on a stream nobody iterates is not
   * backpressure, it is a deadlock, and it was a real one: every CLI session surface attaches with
   * `subscribe()` only (a separate bus subscription that never drains this buffer), so `whenDrained()` stopped
   * resolving after `capacity` events and a streaming reply froze mid-sentence. Measured before the fix: with
   * a ceiling of 4 and 10 events pushed, `whenConsumersReady()` never resolved.
   */
  #everPulled = false;
  /** Events declined because nobody had pulled and the buffer was full — see {@link push}. */
  #unpulledOverflow = 0;

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

  /**
   * Offer an event to the consumer: hand it to a waiting `next()`, else buffer it.
   *
   * **Never drops for a consumer that exists. Bounded for one that does not.** Those are different
   * promises, and conflating them is what produced both of this class's defects in turn. A stream someone
   * iterates buffers without limit and pushes back through {@link whenDrained} — that is ADR-0036's no-drop
   * policy and it is unchanged. A stream nobody has EVER pulled has no consumer to owe events to, and the
   * first attempt to protect it by parking the producer deadlocked every CLI session; the second, by letting
   * the producer run free, reopened the unbounded buffer `CR-30` exists to close.
   *
   * So an un-pulled stream stops accepting past the ceiling, keeping the EARLIEST `capacity` events. Keeping
   * the earliest rather than the latest is deliberate: `run:started` and the opening `node:started`s are what
   * a consumer attaching in the same tick needs, and every test that drains a handle depends on them. A
   * consumer that attaches after the ceiling sees a `sequenceNumber` jump, which
   * [ADR-0036](../../../docs/decisions/0036-run-loop-substrate-event-bus-and-execution-host.md) already
   * defines as the resync signal — and it never had those events in the first place, because nothing was
   * holding them for it.
   */
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
    if (!this.#everPulled && this.#buffer.length >= this.#capacity) {
      this.#unpulledOverflow += 1;
      return;
    }
    this.#buffer.push(event);
  }

  /**
   * How many events an un-pulled stream declined past its ceiling — zero for every stream anyone reads.
   *
   * Exposed so the bound is ASSERTABLE and so a surface can tell a late attacher it has a gap, rather than
   * letting the gap show up only as a `sequenceNumber` jump it has to infer.
   */
  get unpulledOverflow(): number {
    return this.#unpulledOverflow;
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
    if (this.#closed || !this.#everPulled || this.#buffer.length < this.#capacity) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }

  #wakeDrainWaiters(): void {
    // A closed or never-pulled stream owes nobody a wait: release everyone.
    if (this.#closed || !this.#everPulled) {
      const all = this.#drainWaiters;
      this.#drainWaiters = [];
      for (const wake of all) wake();
      return;
    }
    // **Wake only as many producers as there are free slots.** Releasing every parked waiter when ONE slot
    // frees lets N concurrent producers each push, so the buffer peaks at `capacity + N - 1` — with a default
    // `max_parallel` of 8 that is 7 over, and with an authored 64 it is 63. The ceiling is supposed to be a
    // ceiling. Each woken producer's next act is exactly one `push`, so one slot is worth exactly one wake.
    const free = this.#capacity - this.#buffer.length;
    if (free <= 0) {
      return;
    }
    const woken = this.#drainWaiters.splice(0, free);
    for (const wake of woken) wake();
  }

  next(): Promise<IteratorResult<E>> {
    this.#everPulled = true; // from here on, a full buffer means a SLOW consumer rather than none
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
