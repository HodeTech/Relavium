/**
 * `RunHandle` (1.N) — the surface-agnostic handle `WorkflowEngine.start` returns. Its `events` is the
 * `AsyncIterable<RunEvent>` every surface consumes with the identical `for await … switch (event.type)`
 * loop (sse-event-schema.md §Consuming the stream); `subscribe` is the co-equal push API for additional
 * passive observers (cost, UI). Both ride the one in-house {@link RunEventBus}
 * ([ADR-0036](../../../../docs/decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)).
 *
 * The async iterable is a **thin push→pull adapter** over the bus — the bounded, no-drop
 * {@link BoundedEventStream} (shared with `SessionHandle`, 1.W). The buffer never drops an event (a drop
 * would force a `sequenceNumber` resync); a slow consumer applies backpressure through
 * {@link RunHandle.whenConsumersReady}, which the engine awaits at node boundaries. The primary stream
 * subscribes at construction — *before* the engine emits `run:started` — so the consumer can attach
 * lazily without a startup race. (Late additional subscribers via {@link RunHandle.subscribe} resync from
 * persisted `run_events` — 1.R; the in-process replay path is out of 1.N scope and noted here.)
 */

import type { RunEvent, RunOrSessionEvent } from '@relavium/shared';

import type { RunEventBus, RunEventListener } from './event-bus.js';
import { BoundedEventStream, DEFAULT_STREAM_CAPACITY } from './event-stream.js';

const TERMINAL_TYPES: ReadonlySet<RunEvent['type']> = new Set([
  'run:completed',
  'run:failed',
  'run:cancelled',
]);

/** True iff `event` carries this run's `runId` — the bus is shared across runs/sessions (ADR-0036), so a
 *  run handle filters by key. Session events (no `runId`) and other runs are excluded; narrows to `RunEvent`. */
function isForRun(event: RunOrSessionEvent, runId: string): event is RunEvent {
  return 'runId' in event && event.runId === runId;
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
  capacity: number = DEFAULT_STREAM_CAPACITY,
): RunHandle {
  const primary = new BoundedEventStream<RunEvent>(capacity);
  const unsubscribe = bus.subscribe((event) => {
    if (!isForRun(event, runId)) {
      return; // not this run's event (another run, or a session event with no runId)
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
        if (isForRun(event, runId)) {
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
  const primary = new BoundedEventStream<RunEvent>(DEFAULT_STREAM_CAPACITY);
  primary.close();
  return {
    runId,
    events: primary,
    subscribe: () => () => undefined,
    cancel: () => undefined,
    whenConsumersReady: () => Promise.resolve(),
  };
}
