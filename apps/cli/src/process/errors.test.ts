import { describe, expect, it } from 'vitest';

import { CliError, isCliError, toUserFacing } from './errors.js';
import { EXIT_CODES } from './exit-codes.js';

describe('EXIT_CODES', () => {
  it('matches the documented values (commands.md)', () => {
    expect(EXIT_CODES).toEqual({
      success: 0,
      workflowFailed: 1,
      invalidInvocation: 2,
      gatePaused: 3,
      chatEnded: 4,
    });
  });
});

describe('CliError', () => {
  it('maps invalid_invocation and not_implemented to exit 2', () => {
    expect(new CliError('invalid_invocation', 'bad').exitCode).toBe(EXIT_CODES.invalidInvocation);
    expect(new CliError('not_implemented', 'soon').exitCode).toBe(EXIT_CODES.invalidInvocation);
  });

  it('maps internal to exit 1', () => {
    expect(new CliError('internal', 'oops').exitCode).toBe(EXIT_CODES.workflowFailed);
  });

  it('carries the code discriminant and is identifiable', () => {
    const error = new CliError('invalid_invocation', 'bad');
    expect(error.code).toBe('invalid_invocation');
    expect(isCliError(error)).toBe(true);
    expect(isCliError(new Error('plain'))).toBe(false);
  });

  it('preserves the cause chain', () => {
    const cause = new Error('root');
    expect(new CliError('internal', 'wrap', { cause }).cause).toBe(cause);
  });
});

describe('toUserFacing', () => {
  it('passes a CliError through verbatim', () => {
    expect(toUserFacing(new CliError('invalid_invocation', 'name it'))).toEqual({
      code: 'invalid_invocation',
      message: 'name it',
      exitCode: EXIT_CODES.invalidInvocation,
    });
  });

  it('maps an unknown throw to a generic internal error without leaking detail', () => {
    const userFacing = toUserFacing(new Error('secret stack detail'));
    expect(userFacing.code).toBe('internal');
    expect(userFacing.exitCode).toBe(EXIT_CODES.workflowFailed);
    expect(userFacing.message).not.toContain('secret');
  });
});
