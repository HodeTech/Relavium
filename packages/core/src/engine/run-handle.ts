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

import type { ErrorCode, RunDurability, RunEvent, RunOrSessionEvent } from '@relavium/shared';

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
  /**
   * Resolves when the primary consumer's buffer is at or below its ceiling — ADR-0036's producer-await half.
   *
   * Awaited in two places, bounding two different things: the run loop awaits it once per node, and a
   * streaming agent turn awaits it once per chunk (`CR-30`). The second is the one that matters — a node
   * boundary comes around once per node, while a model can emit thousands of token deltas between two of
   * them.
   */
  whenConsumersReady: () => Promise<void>;
  /** The per-consumer ceiling (ADR-0036's "bounded per consumer"), exposed so a bound can be ASSERTED. */
  highWaterMark: number;
  /** Events buffered for the primary consumer right now — the other half of an assertable bound. */
  readonly bufferedCount: number;
  /**
   * Whether the run's terminal reached the durable log (ADR-0078 §5). `'pending'` until a terminal is
   * delivered; then `'durable'`, or `'uncertain'` when the write did not land and the terminal was handed to
   * the host's {@link TerminalOutbox} instead.
   *
   * **Read it after the stream completes**, not during. A caller that only drains `events` and acts on the
   * terminal type is doing what every surface did before this existed, and is exactly the caller CR-92 is
   * about: it can be told a run completed while the durable record says otherwise.
   */
  durability: () => RunDurability;
  /**
   * The `ErrorCode` on this run's `run:failed`, or `undefined` if it did not fail.
   *
   * **Read it after the stream completes**, like {@link RunHandle.durability}, and for the same reason —
   * and never re-derive it from your own `subscribe()`. That is a live bus subscription with no replay, so
   * a terminal emitted before the caller receives the handle is invisible to it; `resumeFromCheckpoint`
   * does exactly that when the resume gate refuses.
   *
   * Distinct from the disposition on purpose: `durability()` answers "did the terminal's write land"
   * ([ADR-0078](../../../docs/decisions/0078-ordered-durable-append-and-the-terminal-outbox.md) §5), and a
   * run can fail for a reason that needs its own remedy while its terminal lands perfectly
   * ([effect-journal.md](../../../docs/reference/shared-core/effect-journal.md) §8).
   */
  terminalError: () => ErrorCode | undefined;
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
  /** Read by {@link RunHandle.durability}; the engine sets it as the terminal's write settles (ADR-0078 §5). */
  readDurability: () => RunDurability = () => 'pending',
  /**
   * Handed the stream's closer, so the engine can end the iteration WITHOUT a terminal event.
   *
   * The one caller is ADR-0079 §5's fenced run: it must not write a terminal (the run belongs to another
   * process now) but its consumer's `for await` must still complete rather than hang forever. Every other
   * close is terminal-driven, which is why this is a deliberate escape hatch rather than a general API.
   */
  onCloser: (close: () => void) => void = () => undefined,
): RunHandle {
  // `onClose: unsubscribe` detaches the bus subscription on ANY close — the terminal event below OR an early
  // consumer abandon (`break`/`return` → BoundedEventStream.return() → close()) — not only on a terminal.
  const primary = new BoundedEventStream<RunEvent>(capacity, () => unsubscribe());
  // Captured HERE, on the subscription registered at construction, and read after the stream completes —
  // exactly like `durability`. It cannot be captured by a caller's own `subscribe()`: that is a LIVE bus
  // subscription with no replay, and a terminal can be emitted before the caller ever receives the handle
  // (`resumeFromCheckpoint` awaits `beginResume`, which settles the resume gate's refusal inline). A review
  // measured that: `relavium gate`'s late subscriber saw `undefined` and the run reported exit 1 for a run
  // that had stopped for an unresolved external effect — the one code that must never be retried.
  let terminalError: ErrorCode | undefined;
  const unsubscribe = bus.subscribe((event) => {
    if (!isForRun(event, runId)) {
      return; // not this run's event (another run, or a session event with no runId)
    }
    if (event.type === 'run:failed') {
      terminalError = event.error.code;
    }
    primary.push(event);
    if (TERMINAL_TYPES.has(event.type)) {
      primary.close(); // close() fires onClose -> unsubscribe()
    }
  });
  onCloser(() => {
    primary.close();
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
    highWaterMark: primary.highWaterMark,
    get bufferedCount() {
      // A GETTER, not a snapshot: the depth changes as the consumer pulls, and a value captured at handle
      // construction would report 0 forever — an assertion that can never fail.
      return primary.bufferedCount;
    },
    durability: readDurability,
    terminalError: () => terminalError,
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
    // A closed stream buffers nothing and throttles nobody, so the ceiling is reported as the default and
    // the depth as zero. Stated rather than omitted: a producer awaiting this handle is told "go ahead",
    // which is right — there is no consumer left to protect.
    highWaterMark: DEFAULT_STREAM_CAPACITY,
    bufferedCount: 0,
    // The run terminated in a PRIOR process and its terminal is in the persisted log — that is what makes
    // this handle closed at all. Reporting anything else would be a guess about a write we did not make.
    durability: () => 'durable',
    // The terminal is in the PERSISTED log, not in this process — re-delivering a closed handle re-emits
    // nothing, so there is no code to report. A caller that needs it reads `relavium logs <runId>`.
    terminalError: () => undefined,
  };
}
