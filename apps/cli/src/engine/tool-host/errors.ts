import { ToolDispatchError } from '@relavium/core';
import type { AbortSignalLike, ErrorCode } from '@relavium/shared';

/**
 * Shared error vocabulary for the CLI `ToolHost` capability arms (2.5.A, [ADR-0055](../../../../../docs/decisions/0055-cli-host-capability-seam-tool-environment-factory.md)).
 * Each arm (`fs`, `process`, …) declares a thin named subclass of these two bases so a caller can narrow on the
 * specific arm while the body — the I3 reason-only discipline and the run-error mapping — lives in one place.
 */

/**
 * A **transient** host-capability failure (a not-found path, a timeout, an unexpected OS error) naming a
 * **reason only** — never a path, the bytes, the command, or an env value (the I3 boundary). Maps to the
 * retryable `tool_failed`. `name` is set from the concrete subclass so stacks/logs read accurately.
 */
export class HostCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A **deterministic host-side denial** — a path escaping the fs scope, a forbidden declared env var, a refusal
 * to write through a symlink. It is a {@link ToolDispatchError} (so the registry passes it through verbatim)
 * mapping to the **fatal**, non-retryable `tool_denied`: re-issuing the same call re-denies, so it must never
 * burn the node-retry budget (error-handling.md §tool-dispatch codes).
 */
export class HostDeniedError extends ToolDispatchError {
  readonly code = 'tool_denied';
  readonly runErrorCode: ErrorCode = 'tool_denied';
  readonly retryable = false;
  constructor(message: string) {
    super(message, undefined, undefined);
    this.name = new.target.name;
  }
}

/** The `egress` arm's transient failure — a network error or an over-size response (→ retryable `tool_failed`). */
export class EgressCapabilityError extends HostCapabilityError {}

/** The `egress` arm's deterministic denial — an SSRF range-block or a non-HTTPS / credentialed url (→ fatal `tool_denied`). */
export class EgressDeniedError extends HostDeniedError {}

/** The `os` arm's transient failure — the platform clipboard/notify command was unavailable or errored. */
export class OsCapabilityError extends HostCapabilityError {}

/**
 * Cooperative cancellation — throw a reason-only {@link HostCapabilityError} (carrying the arm's own message)
 * before a potentially slow host operation if the run already aborted. The registry's cancel-precedence then
 * classifies an aborted dispatch as `cancelled` regardless of this error's class.
 */
export function throwIfAborted(signal: AbortSignalLike | undefined, message: string): void {
  if (signal?.aborted === true) {
    throw new HostCapabilityError(message);
  }
}
