/**
 * `RunHandle` (1.N) — the surface-agnostic handle `WorkflowEngine.start` returns. Its `events` is the
 * `AsyncIterable<RunEvent>` every surface consumes with the identical `for await … switch (event.type)`
 * loop (sse-event-schema.md §Consuming the stream); `subscribe` is the co-equal push API for additional
 * passive observers (cost, UI). Both ride the one in-house {@link RunEventBus}
 * ([ADR-0036](../../../../docs/decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)).
 *
 * The async iterable is a **thin push→pull adapter over the bus** with a **bounded, no-drop**
 * (producer-await) policy: the buffer never drops an event (a drop would force a `sequenceNumber`
 * resync), and a slow consumer applies backpressure through {@link RunHandle.whenConsumersReady}, which
 * the engine awaits at node boundaries so a pathologically slow reader throttles the producer rather
 * than growing the buffer without bound. The primary stream subscribes at construction — *before* the
 * engine emits `run:started` — so the consumer can attach lazily without a startup race. (Late
 * additional subscribers via {@link RunHandle.subscribe} resync from persisted `run_events` — 1.R; the
 * in-process replay path is out of 1.N scope and noted here.)
 */

import type { RunEvent } from '@relavium/shared';

import type { RunEventBus, RunEventListener } from './event-bus.js';

const TERMINAL_TYPES: ReadonlySet<RunEvent['type']> = new Set([
  'run:completed',
  'run:failed',
  'run:cancelled',
]);

/** Default per-consumer high-water mark — beyond this, the producer is asked to await a drain. */
const DEFAULT_CAPACITY = 256;

/**
 * A single-consumer async queue bridging the push bus to a pull `for await`. No-drop: an event pushed
 * while no consumer is waiting is buffered; backpressure is signalled through {@link whenDrained}
 * rather than by dropping. One active iteration at a time (a second concurrent `next()` rejects); use
 * {@link RunHandle.subscribe} for additional observers.
 */
class RunEventStream implements AsyncIterableIterator<RunEvent> {
  readonly #buffer: RunEvent[] = [];
  readonly #capacity: number;
  #waitingPull: ((result: IteratorResult<RunEvent>) => void) | undefined;
  #drainWaiters: (() => void)[] = [];
  #closed = false;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  /** Offer an event to the consumer (hand to a waiting `next()`, else buffer). Never drops. */
  push(event: RunEvent): void {
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

  next(): Promise<IteratorResult<RunEvent>> {
    const buffered = this.#buffer.shift();
    if (buffered !== undefined) {
      this.#wakeDrainWaiters();
      return Promise.resolve({ value: buffered, done: false });
    }
    if (this.#closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    if (this.#waitingPull !== undefined) {
      return Promise.reject(new Error('RunEventStream: concurrent next() is not supported'));
    }
    return new Promise<IteratorResult<RunEvent>>((resolve) => {
      this.#waitingPull = resolve;
    });
  }

  /** Consumer abandoned the loop (`break` / `return`) — release the stream. */
  return(): Promise<IteratorResult<RunEvent>> {
    this.close(); // settles any parked next() deterministically (don't duplicate that logic here)
    this.#buffer.length = 0; // discard anything still buffered on an early abandon
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<RunEvent> {
    return this;
  }
}

/** The handle `WorkflowEngine.start` returns — the run's id, its event stream, and cooperative cancel. */
export interface RunHandle {
  /** The run id (`runId`) this handle observes — the key on every event in its stream. */
  readonly runId: string;
  /** The canonical event stream — `for await (const event of handle.events)`; completes on a terminal event. */
  readonly events: AsyncIterable<RunEvent>;
  /** Attach an additional passive observer (cost / UI); returns an idempotent unsubscribe. */
  subscribe: (listener: RunEventListener) => () => void;
  /**
   * Request cooperative cancellation of this run (delegates to the engine). A best-effort surface
   * action: **idempotent and safe to call after the run has terminated** (a no-op then), unlike the
   * strict programmatic `engine.cancel(runId)`.
   */
  cancel: () => void;
  /** Resolves when the primary consumer's buffer has drained below capacity — the engine awaits it to throttle. */
  whenConsumersReady: () => Promise<void>;
}

/**
 * Wire a {@link RunHandle} over a bus. Subscribes the primary stream at construction (before
 * `run:started`), and on a terminal event closes the stream and unsubscribes so the `for await`
 * completes exactly once and nothing leaks. Both the primary subscription and the exposed
 * {@link RunHandle.subscribe} are **scoped to this run's `runId`** — so even on a bus shared across
 * runs/sessions (the ADR-0036 "one bus, two namespaces" model) a handle only ever sees its own run's
 * events. (The engine instantiates a bus per run today, so the filter is also a guard against a future
 * shared bus.)
 */
export function createRunHandle(
  bus: RunEventBus,
  runId: string,
  cancel: () => void,
  capacity: number = DEFAULT_CAPACITY,
): RunHandle {
  const primary = new RunEventStream(capacity);
  const unsubscribe = bus.subscribe((event) => {
    if (event.runId !== runId) {
      return; // not this run's event
    }
    primary.push(event);
    if (TERMINAL_TYPES.has(event.type)) {
      primary.close();
      unsubscribe();
    }
  });
  return {
    runId,
    events: primary,
    subscribe: (listener) =>
      bus.subscribe((event) => {
        if (event.runId === runId) {
          listener(event);
        }
      }),
    cancel,
    whenConsumersReady: () => primary.whenDrained(),
  };
}

/**
 * A handle whose stream is already closed — for {@link RunHandle} consumers of a run that **already
 * terminated in a prior process** (1.R `resumeFromCheckpoint` re-delivering a gate decision to a run
 * whose checkpoint is already `completed`/`failed`/`cancelled`). It is a safe idempotent no-op: no event
 * is re-emitted or re-persisted; the `events` iteration completes immediately (the actual terminal
 * outcome is in the persisted `run_events`). `cancel`/`subscribe` are inert (the run is done).
 */
export function createClosedRunHandle(runId: string): RunHandle {
  const primary = new RunEventStream(DEFAULT_CAPACITY);
  primary.close();
  return {
    runId,
    events: primary,
    subscribe: () => () => undefined,
    cancel: () => undefined,
    whenConsumersReady: () => Promise.resolve(),
  };
}
