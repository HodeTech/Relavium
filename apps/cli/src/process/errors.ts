import { isCorruptRunEventError } from '@relavium/db';

import { EXIT_CODES, type ExitCode } from './exit-codes.js';

/**
 * The closed set of CLI-level error codes — callers and tests narrow on `.code`, never on
 * `.message` (error-handling.md). Run-level outcomes (a workflow failing, a gate pausing)
 * are NOT modelled here: they come from the engine's terminal `RunEvent` and are mapped to
 * exit codes by `relavium run` (2.D). These codes are the CLI's own faults.
 */
export type CliErrorCode =
  /** Bad args / unknown command|option / missing arg / not found / schema error → exit 2. */
  | 'invalid_invocation'
  /** A malformed/invalid configuration layer (TOML syntax or schema) → exit 2. */
  | 'config_error'
  /** A documented command whose implementing workstream has not landed yet → exit 2. */
  | 'not_implemented'
  /** An unexpected CLI fault → exit 1 (the user-facing message stays generic). */
  | 'internal';

const EXIT_CODE_BY_ERROR: Readonly<Record<CliErrorCode, ExitCode>> = {
  invalid_invocation: EXIT_CODES.invalidInvocation,
  config_error: EXIT_CODES.invalidInvocation,
  not_implemented: EXIT_CODES.invalidInvocation,
  internal: EXIT_CODES.workflowFailed,
};

/**
 * A typed, discriminated CLI error (error-handling.md) — mirrors the engine's
 * `EngineStateError` shape. Carries a stable `code` and the `exitCode` it maps to; the
 * `message` is **user-facing** and must never contain a secret, raw payload, stack trace,
 * or internal path.
 */
export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: ExitCode;

  constructor(code: CliErrorCode, message: string, opts?: { readonly cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'CliError';
    this.code = code;
    this.exitCode = EXIT_CODE_BY_ERROR[code];
  }
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}

/** A user-safe projection of any thrown value — what the renderer prints. */
export interface UserFacingError {
  readonly code: CliErrorCode;
  readonly message: string;
  readonly exitCode: ExitCode;
}

/**
 * Map any thrown value to a user-safe projection. A `CliError` passes through; anything else
 * is an unexpected fault reported generically as `internal` — its raw message/stack is never
 * promoted to primary output (the renderer may still write the stack to stderr under `--verbose`).
 */
export function toUserFacing(value: unknown): UserFacingError {
  if (isCliError(value)) {
    return { code: value.code, message: value.message, exitCode: value.exitCode };
  }
  // A damaged `run_events` row (ADR-0074 §5 / ADR-0050). The generic fallback below would report a corrupt row
  // out of a 4,000-event log as `An unexpected internal error occurred.` — no run, no row, no next step. The
  // store's typed error already carries the run id, the `seq`, and the `event_type`, none of which is user
  // content or a secret, so promote them and name the recovery. Still exit 1: the read genuinely failed.
  // No remedy is prescribed because the CLI genuinely has none for a single bad row: there is no run-delete
  // command, and upgrading does not repair corruption (that is the OTHER half of §5 — a skipped row, which is
  // reported as a note, not an error). Naming the run and the row is the actionable part; it is what makes the
  // failure diagnosable at all, and what lets a user restore just that history DB from a backup.
  if (isCorruptRunEventError(value)) {
    return {
      code: 'internal',
      message: `${value.message}. The rest of your history is unaffected.`,
      exitCode: EXIT_CODES.workflowFailed,
    };
  }
  return {
    code: 'internal',
    message: 'An unexpected internal error occurred.',
    exitCode: EXIT_CODES.workflowFailed,
  };
}
