/**
 * Typed errors thrown by the `WorkflowEngine` **API boundary** (1.N) — `start` / `resume` / `cancel`
 * misuse, validated at the edge before the call touches run state (docs/standards/error-handling.md:
 * Zod/guard the untrusted boundary, then trust the core). They are distinct from the in-stream run
 * failures the engine *emits* as `node:failed` / `run:failed` carrying a closed `ErrorCode`
 * (@relavium/shared): those describe a run that started and then failed; these reject an API call that
 * could not be honoured at all (an unknown run, a resume of a run with no pending gate, a stale gate
 * id). Callers narrow on {@link EngineStateError.code}, never on `message`.
 *
 * Kept in `packages/core/src/engine/` rather than the parser/graph `errors.ts` deliberately: this is the
 * run-loop error family, a sibling not a member of the parse-time family, and the separation keeps the
 * engine subtree self-contained. The message is user-safe and secret-free — it names the run/gate by id
 * (a UUID / opaque id, never a secret) and never carries run inputs, a node output, or a host stack.
 */

/** Stable discriminant for an engine-API-boundary fault — narrow on this, never on `message`. */
export type EngineStateErrorCode =
  | 'unknown_run' // `resume` / `cancel` named a `runId` this engine instance is not tracking
  | 'run_already_terminal' // the run already settled (completed / failed / cancelled) — no resume/cancel
  | 'run_not_paused' // `resume` was called while the run has no pending gate to resolve
  | 'unknown_gate' // the `gateId` does not match any gate currently pending on the run
  | 'invalid_decision' // the supplied `GateDecision` failed schema validation at the boundary
  | 'workflow_mismatch'; // `resumeFromCheckpoint` was handed a workflow that is not the one the run started on

/**
 * A `WorkflowEngine` API call could not be honoured. Thrown synchronously from `start` / `resume` /
 * `cancel`; it never appears on the event stream (a run that *began* and then failed surfaces as a
 * `run:failed` event with an `ErrorCode`, not this).
 */
export class EngineStateError extends Error {
  readonly code: EngineStateErrorCode;
  /** The run this fault concerns, when applicable — a `runId` (UUID), never a secret. */
  readonly runId?: string;
  /** The gate this fault concerns, when applicable — a `gateId` (opaque), never a secret. */
  readonly gateId?: string;

  constructor(
    code: EngineStateErrorCode,
    message: string,
    opts?: { runId?: string; gateId?: string; cause?: unknown },
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'EngineStateError';
    this.code = code;
    if (opts?.runId !== undefined) {
      this.runId = opts.runId;
    }
    if (opts?.gateId !== undefined) {
      this.gateId = opts.gateId;
    }
  }
}
