import { RelaviumError } from '@relavium/shared/relavium-error';

import { EXIT_CODES, type ExitCode } from './exit-codes.js';

/** CLI classifications only; engine ErrorCode and actual run outcomes remain separate. */
export type CliErrorCode =
  | 'invalid_invocation'
  | 'config_error'
  | 'not_implemented'
  | 'run_owned_elsewhere'
  /** Historical known operational refusals. Do not globally reinterpret this as infrastructure. */
  | 'internal'
  | 'cli_internal'
  | 'output_unavailable'
  | 'storage_unavailable'
  | 'config_write_refused';

export type CliFailureOrigin =
  | 'invocation'
  | 'operational'
  | 'ownership'
  | 'storage'
  | 'output'
  | 'infrastructure';

interface CliErrorPolicy {
  readonly origin: CliFailureOrigin;
  readonly exitCode: ExitCode;
  readonly fixedMessage?: string;
}

/** One lightweight code/origin/exit authority, shared by early and runtime boundaries. */
export const CLI_ERROR_POLICY: Readonly<Record<CliErrorCode, CliErrorPolicy>> = Object.freeze({
  invalid_invocation: Object.freeze({
    origin: 'invocation',
    exitCode: EXIT_CODES.invalidInvocation,
  }),
  config_error: Object.freeze({ origin: 'invocation', exitCode: EXIT_CODES.invalidInvocation }),
  not_implemented: Object.freeze({ origin: 'invocation', exitCode: EXIT_CODES.invalidInvocation }),
  run_owned_elsewhere: Object.freeze({
    origin: 'ownership',
    exitCode: EXIT_CODES.runOwnedElsewhere,
  }),
  internal: Object.freeze({ origin: 'operational', exitCode: EXIT_CODES.workflowFailed }),
  cli_internal: Object.freeze({
    origin: 'infrastructure',
    exitCode: EXIT_CODES.infrastructureFailed,
    fixedMessage:
      'An unexpected CLI failure occurred. Use --verbose for safe diagnostics. Inspect existing work before repeating paid or effectful operations.',
  }),
  output_unavailable: Object.freeze({
    origin: 'output',
    exitCode: EXIT_CODES.infrastructureFailed,
    fixedMessage:
      'CLI output could not be delivered. Inspect existing work before repeating paid or effectful operations.',
  }),
  storage_unavailable: Object.freeze({
    origin: 'storage',
    exitCode: EXIT_CODES.workflowFailed,
    fixedMessage:
      'Local storage is unavailable. Check permissions and free space. Inspect existing work before repeating paid or effectful operations.',
  }),
  config_write_refused: Object.freeze({
    origin: 'invocation',
    exitCode: EXIT_CODES.invalidInvocation,
    fixedMessage:
      'The settings file could not be safely updated. Use a regular writable file and retry the settings change.',
  }),
});

export function cliErrorExitCode(code: CliErrorCode): ExitCode {
  return CLI_ERROR_POLICY[code].exitCode;
}

/** Existing family identity/name/cause semantics; new fixed diagnostics never promote incoming text. */
export class CliError extends RelaviumError {
  readonly code: CliErrorCode;
  readonly exitCode: ExitCode;

  constructor(code: CliErrorCode, message: string, opts?: { readonly cause?: unknown }) {
    super(
      CLI_ERROR_POLICY[code].fixedMessage ?? message,
      opts?.cause === undefined ? undefined : { cause: opts.cause },
    );
    this.name = 'CliError';
    this.code = code;
    this.exitCode = cliErrorExitCode(code);
  }
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}

export interface UserFacingError {
  readonly code: CliErrorCode;
  readonly message: string;
  readonly exitCode: ExitCode;
}

/** Lightweight own-data projection; never load the engine to classify an early CLI failure. */
export function projectCliError(value: unknown): UserFacingError | undefined {
  try {
    if (!isCliError(value)) return undefined;
    const code = ownData(value, 'code');
    if (typeof code !== 'string' || !isCliCode(code)) return fixedInternalFailure();
    const message = CLI_ERROR_POLICY[code].fixedMessage ?? ownData(value, 'message');
    if (typeof message !== 'string') return fixedInternalFailure();
    return { code, message, exitCode: cliErrorExitCode(code) };
  } catch {
    return fixedInternalFailure();
  }
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function isCliCode(value: string): value is CliErrorCode {
  return Object.hasOwn(CLI_ERROR_POLICY, value);
}

function fixedInternalFailure(): UserFacingError {
  return {
    code: 'cli_internal',
    message: CLI_ERROR_POLICY.cli_internal.fixedMessage ?? '',
    exitCode: 9,
  };
}
