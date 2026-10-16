import {
  AgentParseError,
  EngineStateError,
  TRANSIENT_ENGINE_STATE_CODES,
  WorkflowParseError,
} from '@relavium/core';
import {
  DbOpenError,
  isOwnedStorageFailure,
  isProviderHeaderPolicyError,
  ProviderHeaderPolicyError,
  SessionMessageBoundaryError,
} from '@relavium/db';

import { EXIT_CODES } from './exit-codes.js';
import {
  CLI_ERROR_POLICY,
  cliErrorExitCode,
  CliError,
  isCliError,
  projectCliError,
  type UserFacingError,
} from './cli-error.js';
export { CliError, isCliError } from './cli-error.js';
export type { CliErrorCode, UserFacingError } from './cli-error.js';

/** Safe runtime projection; a hostile reflection/classifier fault is itself infrastructure failure. */
export function toUserFacing(value: unknown): UserFacingError {
  try {
    return projectUserFacing(value);
  } catch {
    // Never coerce the incoming object, inspect its cause or retry a hostile accessor.
    return fixedFailure('cli_internal');
  }
}

function projectUserFacing(value: unknown): UserFacingError {
  const cli = projectCliError(value);
  if (cli !== undefined) return cli;
  // Only the actual DB/native/media boundary may add this private identity fact. Constructors,
  // errno-shaped objects and convincing causes never supply storage authority to this classifier.
  if (isOwnedStorageFailure(value)) return fixedFailure('storage_unavailable');
  if (value instanceof DbOpenError && ownData(value, 'code') === 'uri_unsupported') {
    return {
      code: 'invalid_invocation',
      message:
        "SQLite URI paths are not supported by createClient — pass ':memory:' or a filesystem path",
      exitCode: EXIT_CODES.invalidInvocation,
    };
  }
  // This DB guard already requires own data descriptors, retaining stable cross-bundle compatibility.
  if (isProviderHeaderPolicyError(value)) {
    return {
      code: 'invalid_invocation',
      message: new ProviderHeaderPolicyError().message,
      exitCode: EXIT_CODES.invalidInvocation,
    };
  }
  // Read and write validation share this fixed message; neither message/body nor cause is inspected.
  if (value instanceof SessionMessageBoundaryError) {
    return {
      code: 'invalid_invocation',
      message:
        'A session message has an invalid persistence format. Restore a safe history backup or start a new session.',
      exitCode: EXIT_CODES.invalidInvocation,
    };
  }
  // History permits compatible errors from another bundle. Preflight own data directly rather than
  // calling structural guards that read arbitrary code/message accessors. The typed store messages are
  // echo-safe by their contract and retain their existing operational-1 recovery advice.
  if (value instanceof Error) {
    const code = ownData(value, 'code');
    const message =
      code === 'unreadable_run_event_log' || code === 'corrupt_run_event'
        ? ownData(value, 'message')
        : undefined;
    if (typeof message === 'string' && code === 'unreadable_run_event_log') {
      return {
        code: 'internal',
        message: `${message} Its history is still readable — \`relavium logs\` and \`status\` are unaffected.`,
        exitCode: EXIT_CODES.workflowFailed,
      };
    }
    if (typeof message === 'string' && code === 'corrupt_run_event') {
      return {
        code: 'internal',
        message: `${message}. Other runs are still listable.`,
        exitCode: EXIT_CODES.workflowFailed,
      };
    }
  }
  if (value instanceof EngineStateError) {
    const engineCode = ownData(value, 'code');
    const message = ownData(value, 'message');
    if (typeof engineCode !== 'string' || typeof message !== 'string')
      return fixedFailure('cli_internal');
    // Read the existing engine authority against the captured data, never invoke a getter on the error.
    const code = TRANSIENT_ENGINE_STATE_CODES.some((candidate) => candidate === engineCode)
      ? 'run_owned_elsewhere'
      : 'invalid_invocation';
    return { code, message, exitCode: cliErrorExitCode(code) };
  }
  // Parser/graph messages carry validated source labels/identifiers, never authored values.
  if (value instanceof AgentParseError || value instanceof WorkflowParseError) {
    const message = ownData(value, 'message');
    if (typeof message !== 'string') return fixedFailure('cli_internal');
    return { code: 'invalid_invocation', message, exitCode: EXIT_CODES.invalidInvocation };
  }
  return fixedFailure('cli_internal');
}

/** Local to this projection: no property reads, inherited values, getters or coercion. */
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function fixedFailure(code: 'cli_internal' | 'storage_unavailable'): UserFacingError {
  return {
    code,
    message: CLI_ERROR_POLICY[code].fixedMessage ?? '',
    exitCode: cliErrorExitCode(code),
  };
}

/** Normalize an escaping runtime error while its already-loaded classifier is available. */
export function toCliError(value: unknown): CliError {
  const projected = toUserFacing(value);
  try {
    if (
      isCliError(value) &&
      ownData(value, 'code') === projected.code &&
      ownData(value, 'message') === projected.message &&
      ownData(value, 'exitCode') === projected.exitCode
    )
      return value;
  } catch {
    // Hostile public errors cannot bypass the fixed projection.
  }
  return new CliError(projected.code, projected.message, { cause: value });
}
