/**
 * Typed, discriminated errors thrown by the engine-side `ToolRegistry` dispatch (1.T). They mirror the
 * parser/sandbox error pattern (a base class with a stable `code` discriminant, narrowed on `code` and
 * never on `message`) and carry the closed-enum {@link ErrorCode} a run surfaces plus the retryable
 * split owned by docs/standards/error-handling.md. Messages are **secret-free**: they name a tool id, a
 * field, or a policy reason — never an argument VALUE (a resolved command/URL), a host stack, or a
 * secret. The taxonomy + the mapping rationale live in
 * [tool-registry.md](../../../../docs/reference/shared-core/tool-registry.md#error-taxonomy) and ADR-0037.
 */

import type { ErrorCode } from '@relavium/shared';

import type { ToolId } from './types.js';

/** Stable discriminant for a tool-dispatch failure — callers narrow on `code`, never on `message`. */
export type ToolErrorCode =
  | 'unknown_tool' // the id was not an exact registry match (a misspelled / hallucinated call)
  | 'tool_denied' // a guardrail or grant denial (unlisted command, blocked domain, not granted, missing gate)
  | 'invalid_args' // the effective argument set failed the tool's validator or the secret-taint check
  | 'capability_unavailable' // the required ToolHost capability was not injected (a host/config gap)
  | 'execution_failed' // the host capability threw a non-cancel error
  | 'cancelled'; // the run's AbortSignal fired during the tool — the cooperative-cancel path

/** Base for every tool-dispatch error — narrow on {@link code}, never on `message`. */
export abstract class ToolDispatchError extends Error {
  /** The tool-error discriminant. */
  abstract readonly code: ToolErrorCode;
  /** The closed run `ErrorCode` this maps to (sse-event-schema.md). */
  abstract readonly runErrorCode: ErrorCode;
  /** A pure function of the fault class — owned by error-handling.md. Only `execution_failed` retries. */
  abstract readonly retryable: boolean;
  /** The tool id involved, when one is known (a name, never a secret). */
  readonly toolId?: ToolId;

  protected constructor(message: string, toolId: ToolId | undefined, cause: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    if (toolId !== undefined) {
      this.toolId = toolId;
    }
  }
}

/** The id was not an exact registry match. The message lists the available ids (names, not secrets). */
export class UnknownToolError extends ToolDispatchError {
  readonly code = 'unknown_tool';
  readonly runErrorCode: ErrorCode = 'tool_failed';
  readonly retryable = false;

  constructor(toolId: ToolId, availableIds: readonly ToolId[]) {
    super(
      `unknown tool \`${toolId}\` — available tools: ${[...availableIds].sort().join(', ')}`,
      toolId,
      undefined,
    );
    this.name = 'UnknownToolError';
  }
}

/**
 * A guardrail or grant denial — fatal, never retried (re-issuing the same denied call just re-denies).
 * The message names the tool + the policy reason; it never echoes the resolved command/URL value.
 */
export class ToolPolicyError extends ToolDispatchError {
  readonly code = 'tool_denied';
  readonly runErrorCode: ErrorCode = 'tool_denied';
  readonly retryable = false;
  /** The policy that denied the call — a stable label, never an authored value. */
  readonly reason: ToolPolicyDenyReason;

  constructor(toolId: ToolId, reason: ToolPolicyDenyReason, message: string) {
    super(message, toolId, undefined);
    this.name = 'ToolPolicyError';
    this.reason = reason;
  }
}
export type ToolPolicyDenyReason =
  | 'not_granted' // the id is registered but not in the node's grant (registered ≠ authorized)
  | 'command_not_allowed' // the resolved command is not in allowedCommands / allowedCommandGlobs (or empty ⇒ deny-all)
  | 'domain_not_allowed' // the URL host is not in allowedDomains (or empty ⇒ deny-all)
  | 'insecure_url' // the URL is not HTTPS (or has credentials-in-URL)
  | 'gate_required'; // git_commit reached without a human-gate approval

/** The effective argument set failed the tool's validator or the secret-taint check. Field names only. */
export class ToolArgsInvalidError extends ToolDispatchError {
  readonly code = 'invalid_args';
  readonly runErrorCode: ErrorCode = 'validation';
  readonly retryable = false;
  /** The offending field paths (names only — never a received value). */
  readonly fields: readonly string[];

  constructor(toolId: ToolId, fields: readonly string[], message: string, cause?: unknown) {
    super(message, toolId, cause);
    this.name = 'ToolArgsInvalidError';
    this.fields = fields;
  }
}

/** The required `ToolHost` capability was not injected — a host/config gap, not the model's fault. */
export class ToolUnavailableError extends ToolDispatchError {
  readonly code = 'capability_unavailable';
  readonly runErrorCode: ErrorCode = 'internal';
  readonly retryable = false;
  /** The missing capability (a name, e.g. `egress`). */
  readonly capability: string;

  constructor(toolId: ToolId, capability: string) {
    super(`tool \`${toolId}\` requires the host \`${capability}\` capability, which is not wired`, toolId, undefined);
    this.name = 'ToolUnavailableError';
    this.capability = capability;
  }
}

/** The host capability threw a non-cancel error. The cause is kept for logs, off the user message. */
export class ToolExecutionError extends ToolDispatchError {
  readonly code = 'execution_failed';
  readonly runErrorCode: ErrorCode = 'tool_failed';
  readonly retryable = true;

  constructor(toolId: ToolId, message: string, cause?: unknown) {
    super(message, toolId, cause);
    this.name = 'ToolExecutionError';
  }
}

/**
 * The run's `AbortSignal` fired during the tool — surfaced on the cooperative-cancel path (`cancelled`),
 * never `tool_failed`, so it composes with ADR-0036's cancel precedence.
 */
export class ToolCancelledError extends ToolDispatchError {
  readonly code = 'cancelled';
  readonly runErrorCode: ErrorCode = 'cancelled';
  readonly retryable = false;

  constructor(toolId: ToolId | undefined, cause?: unknown) {
    super(toolId === undefined ? 'tool dispatch cancelled' : `tool \`${toolId}\` cancelled`, toolId, cause);
    this.name = 'ToolCancelledError';
  }
}
