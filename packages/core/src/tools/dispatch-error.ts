/** Pure dispatch-error base; concrete registry errors keep their existing public home. */
import { RelaviumError } from '@relavium/shared/relavium-error';
import type { ErrorCode } from '@relavium/shared';
import type { ToolId } from './types.js';

/** Stable discriminant for a tool-dispatch failure — callers narrow on `code`, never on `message`. */
export type ToolErrorCode =
  | 'unknown_tool' // the id was not an exact registry match (a misspelled / hallucinated call)
  | 'tool_denied' // a guardrail or grant denial (unlisted command, blocked domain, not granted, missing gate)
  | 'invalid_args' // the effective argument set failed the tool's validator or the secret-taint check
  | 'capability_unavailable' // the required ToolHost capability was not injected (a host/config gap)
  | 'effect_conflict' // another attempt already holds this effect's journal identity (ADR-0080) — a refusal
  | 'effect_unrecorded' // the effect LANDED and its journal record could not be completed (ADR-0080 §7)
  | 'execution_failed' // the host capability threw a non-cancel error
  | 'cancelled'; // the run's AbortSignal fired during the tool — the cooperative-cancel path

/** Base for every tool-dispatch error — narrow on {@link code}, never on `message`. */
export abstract class ToolDispatchError extends RelaviumError {
  /** The tool-error discriminant. */
  abstract readonly code: ToolErrorCode;
  /** The closed run `ErrorCode` this maps to (sse-event-schema.md). */
  abstract readonly runErrorCode: ErrorCode;
  /** A pure function of the fault class — owned by error-handling.md. Only `execution_failed` retries. */
  abstract readonly retryable: boolean;
  /** The tool id involved, when one is known (a name, never a secret). */
  readonly toolId?: ToolId;
  /**
   * Whether this failure is safe to FEED BACK to the model as an `isError` tool result for in-turn CONVERSATIONAL
   * recovery (the ADR-0057 `recoverToolFailures` surfaces — `relavium chat` / the Home / one-shot `agent run`;
   * a WORKFLOW node never sets the flag) instead of ending the turn.
   * Default **false** (fatal — the safe direction; a forgotten opt-in just stays fatal). Set true by the specific
   * throwing class ONLY when re-attempting is safe: an IDEMPOTENT host execution failure (a read — no side-effect
   * hazard), or a SCOPE denial refused BEFORE any side effect (a Step-14 fs scope-tier escape / a media scope
   * denial) so the model can adapt to an in-bounds path. A user / guardrail / SSRF / **confidentiality** /
   * side-effecting denial stays false — re-issuing re-denies, would risk a re-execution, or would leak a
   * probe oracle. Distinct from {@link retryable} (a fresh whole-node retry); this is the stricter in-turn re-attempt.
   */
  readonly recoverable: boolean;

  protected constructor(
    message: string,
    toolId: ToolId | undefined,
    cause: unknown,
    recoverable = false,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    if (toolId !== undefined) {
      this.toolId = toolId;
    }
    this.recoverable = recoverable;
  }
}
