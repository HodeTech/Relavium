/**
 * `RunLoopInvariantError` — a typed, discriminated **internal invariant breach** in the run-loop event
 * substrate (the {@link ./event-bus.ts | RunEventBus} + {@link ./event-stream.ts | BoundedEventStream},
 * ADR-0036). Most are "can never happen" conditions a correct producer/consumer cannot reach — a draft with
 * both or neither correlation key, or a second concurrent `next()` on a single-consumer stream. They are not
 * API-boundary faults ({@link ./errors.ts | EngineStateError}); they surface loudly so a bug is caught at its
 * source rather than silently corrupting the gap-free `sequenceNumber` stream.
 *
 * **Two members are not impossibilities, and saying so is more useful than pretending otherwise.**
 * `media_store_unavailable` is a host-wiring gap and `event_too_large` is a run that produced more than the
 * durable boundary accepts — both are reachable by a correct engine given a wrong host or an oversized
 * payload. They live here rather than in the `ErrorCode` taxonomy because they are raised at the emit choke
 * point, where no `nodeId` is in scope and no `node:failed` can be constructed; both are caught by the same
 * `#onOutcome` / `#begin` backstops and become a single `run:failed`, which is where the closed `ErrorCode`
 * a surface switches on is finally assigned. So the run failure is recoverable and typed — this class is the
 * transport, not the report.
 *
 * Typed (not a bare `Error`) per docs/standards/error-handling.md: callers/tests narrow on the stable
 * {@link RunLoopInvariantError.code}, never on `message` (which is for humans and may change). The message
 * is secret-free — it describes the structural breach, never a draft payload.
 */

/** Stable discriminant for a run-loop substrate invariant breach — narrow on this, never on `message`. */
export type RunLoopInvariantCode =
  | 'both_correlation_keys' // an event draft carried BOTH runId and sessionId (exactly one is required)
  | 'no_correlation_key' // an event draft carried NEITHER runId nor sessionId
  | 'concurrent_consumer' // a second next() while one is already parked on a single-consumer stream
  | 'media_store_unavailable' // a media-bearing event was emitted but no MediaStore was injected (1.AF, I3)
  | 'event_too_large'; // a NON-terminal durable event exceeded CR-32's size bound (ADR-0086); a terminal never does

export class RunLoopInvariantError extends Error {
  readonly code: RunLoopInvariantCode;

  constructor(code: RunLoopInvariantCode, message: string) {
    super(message);
    this.name = 'RunLoopInvariantError';
    this.code = code;
  }
}
