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

import type { InputAdmissionIssue } from './input-admission.js';

/** Stable discriminant for an engine-API-boundary fault — narrow on this, never on `message`. */
export type EngineStateErrorCode =
  | 'unknown_run' // `resume`/`cancel` named a `runId` this engine is not tracking, or `resumeFromCheckpoint` found no checkpoint for it
  | 'run_already_active' // `resumeFromCheckpoint` named a run THIS engine already holds in memory — use `resume` instead
  | 'run_already_terminal' // the run already settled (completed / failed / cancelled) — no resume/cancel
  | 'run_not_paused' // `resume` was called while the run has no pending gate to resolve
  | 'unknown_gate' // the `gateId` does not match any gate currently pending on the run
  | 'invalid_decision' // the supplied `GateDecision` failed schema validation at the boundary
  | 'pending_gate_requires_decision' // a media-only `resumeFromCheckpoint` hit a run also parked on a gate (pass gateId + decision)
  | 'workflow_mismatch' // `resumeFromCheckpoint` was handed a workflow that is not the one the run started on
  | 'run_owned_elsewhere' // ANOTHER PROCESS holds a live lease on this run (ADR-0079 §4) — transient; retry later
  // ADR-0083 §1: the caller's inputs did not satisfy the authored contract. A PERMANENT invocation fault —
  // the same call will fail identically forever — and it happens before a run exists, so there is no runId
  // to report, no `run:started`, and nothing in the store.
  | 'input_admission_failed'
  // ADR-0083 §5/§6/§11 — the resume identity taxonomy. `resumeFromCheckpoint` verifies the caller's copies
  // against the run's own admission record rather than trusting them, and each way that can fail gets its
  // own code because each has a different fix: correct the invocation, resume the right run, or re-supply a
  // credential. All PERMANENT — none is worth retrying unchanged.
  | 'input_mismatch' // a supplied input is not the one the run was admitted with, or names a slot it never had
  | 'execution_mode_mismatch' // a supplied `executionMode` is not the one the run started under
  | 'secret_input_missing' // a `secret` the record holds as a masked slot was not re-supplied
  | 'secret_input_unexpected' // a `secret` was supplied for a slot the record does not carry
  | 'workflow_content_mismatch' // the same workflow SLUG, with content the run did not start on
  | 'admission_record_unreadable'; // the frozen definition exists but cannot be read as a workflow

/**
 * The codes that are TRANSIENT — worth retrying unchanged — as opposed to permanent invocation faults.
 *
 * Only one today, and the distinction is the reason it exists: `run_owned_elsewhere` means "somebody else is
 * running this right now", which resolves on its own when they finish or their lease expires. Every other
 * code is a mistake in the call itself (an unknown run, the wrong workflow, a run that already settled) and
 * will fail identically forever. A surface uses this to tell a caller "try again shortly" from "never call
 * this again" — the CLI maps it to its own exit code (ADR-0079 §7).
 */
export const TRANSIENT_ENGINE_STATE_CODES: readonly EngineStateErrorCode[] = [
  'run_owned_elsewhere',
];

/** Whether an {@link EngineStateError} is worth retrying unchanged. */
export function isTransientEngineStateError(error: EngineStateError): boolean {
  return TRANSIENT_ENGINE_STATE_CODES.includes(error.code);
}

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
  /**
   * The per-input refusals behind an `input_admission_failed`, when applicable (ADR-0083 §1).
   *
   * STRUCTURED rather than flattened into `message`, because the message is not the place to carry a list
   * whose length a caller controls — and because a surface that wants to point at the offending field needs
   * the field, not a sentence. `InputAdmissionIssue` guarantees a `name` is echo-safe; the `message` is one
   * of a closed set of structural literals.
   */
  readonly issues?: readonly InputAdmissionIssue[];

  constructor(
    code: EngineStateErrorCode,
    message: string,
    opts?: {
      runId?: string;
      gateId?: string;
      cause?: unknown;
      issues?: readonly InputAdmissionIssue[];
    },
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
    if (opts?.issues !== undefined) {
      this.issues = opts.issues;
    }
  }
}
