/**
 * `RunLoopInvariantError` — a typed, discriminated **internal invariant breach** in the run-loop event
 * substrate (the {@link ./event-bus.ts | RunEventBus} + {@link ./event-stream.ts | BoundedEventStream},
 * ADR-0036). These are "can never happen" conditions a correct producer/consumer cannot reach — a draft
 * with both or neither correlation key, or a second concurrent `next()` on a single-consumer stream. They
 * are not recoverable run failures (those are emitted as `node:failed`/`run:failed` with a closed
 * `ErrorCode`) nor API-boundary faults ({@link ./errors.ts | EngineStateError}); they surface loudly so a
 * bug is caught at its source rather than silently corrupting the gap-free `sequenceNumber` stream.
 *
 * Typed (not a bare `Error`) per docs/standards/error-handling.md: callers/tests narrow on the stable
 * {@link RunLoopInvariantError.code}, never on `message` (which is for humans and may change). The message
 * is secret-free — it describes the structural breach, never a draft payload.
 */

/** Stable discriminant for a run-loop substrate invariant breach — narrow on this, never on `message`. */
export type RunLoopInvariantCode =
  | 'both_correlation_keys' // an event draft carried BOTH runId and sessionId (exactly one is required)
  | 'no_correlation_key' // an event draft carried NEITHER runId nor sessionId
  | 'concurrent_consumer'; // a second next() while one is already parked on a single-consumer stream

export class RunLoopInvariantError extends Error {
  readonly code: RunLoopInvariantCode;

  constructor(code: RunLoopInvariantCode, message: string) {
    super(message);
    this.name = 'RunLoopInvariantError';
    this.code = code;
  }
}
