import { RelaviumError } from '@relavium/shared/relavium-error';
import { describe, expect, it } from 'vitest';

import {
  CliError,
  CLI_ERROR_POLICY,
  cliErrorExitCode,
  isCliError,
  type CliErrorCode,
  type CliFailureOrigin,
  type UserFacingError,
} from './cli-error.js';

describe('closed CLI diagnostic authority', () => {
  const codes: readonly CliErrorCode[] = [
    'invalid_invocation',
    'config_error',
    'not_implemented',
    'run_owned_elsewhere',
    'internal',
    'cli_internal',
    'output_unavailable',
    'storage_unavailable',
    'config_write_refused',
  ];

  it('contains exactly the approved CLI codes in one immutable table', () => {
    expect(Object.keys(CLI_ERROR_POLICY).sort()).toEqual([...codes].sort());
    expect(Object.isFrozen(CLI_ERROR_POLICY)).toBe(true);
    for (const code of codes) expect(Object.isFrozen(CLI_ERROR_POLICY[code])).toBe(true);
  });

  it.each([
    ['invalid_invocation', 'invocation'],
    ['config_error', 'invocation'],
    ['not_implemented', 'invocation'],
    ['run_owned_elsewhere', 'ownership'],
    ['internal', 'operational'],
    ['cli_internal', 'infrastructure'],
    ['output_unavailable', 'output'],
    ['storage_unavailable', 'storage'],
    ['config_write_refused', 'invocation'],
  ] satisfies readonly (readonly [CliErrorCode, CliFailureOrigin])[])(
    'assigns %s the explicit %s origin',
    (code, origin) => {
      expect(CLI_ERROR_POLICY[code].origin).toBe(origin);
    },
  );

  it.each([
    ['invalid_invocation', 2],
    ['config_error', 2],
    ['not_implemented', 2],
    ['run_owned_elsewhere', 6],
    ['internal', 1],
    ['cli_internal', 9],
    ['output_unavailable', 9],
    ['storage_unavailable', 1],
    ['config_write_refused', 2],
  ] satisfies readonly (readonly [CliErrorCode, number])[])(
    'maps %s to explicit exit %s',
    (code, exitCode) => {
      expect(cliErrorExitCode(code)).toBe(exitCode);
      expect(CLI_ERROR_POLICY[code].exitCode).toBe(exitCode);
      expect(new CliError(code, 'constructor-message-canary').exitCode).toBe(exitCode);
    },
  );

  it.each([
    'invalid_invocation',
    'config_error',
    'not_implemented',
    'run_owned_elsewhere',
    'internal',
  ] satisfies readonly CliErrorCode[])(
    'preserves the historical constructor contract for %s',
    (code) => {
      const cause = { source: 'cause-identity-canary' };
      const error = new CliError(code, 'owned historical message', { cause });
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(RelaviumError);
      expect(error.name).toBe('CliError');
      expect(error.code).toBe(code);
      expect(error.message).toBe('owned historical message');
      expect(error.cause).toBe(cause);
      expect(isCliError(error)).toBe(true);
      expect(new CliError(code, 'without cause').cause).toBeUndefined();
    },
  );

  it.each([
    'cli_internal',
    'output_unavailable',
    'storage_unavailable',
    'config_write_refused',
  ] satisfies readonly CliErrorCode[])(
    'fixes the %s message independently of arbitrary constructor text',
    (code) => {
      const cause = new Error('arbitrary-cause-secret-canary');
      const first = new CliError(code, 'first-arbitrary-secret-canary', { cause });
      const second = new CliError(code, 'second-arbitrary-secret-canary');
      const fixed = CLI_ERROR_POLICY[code].fixedMessage;
      expect(fixed).toEqual(expect.any(String));
      expect(fixed?.length).toBeGreaterThan(0);
      expect(first.message).toBe(fixed);
      expect(second.message).toBe(fixed);
      expect(first.cause).toBe(cause);
      expect(first.name).toBe('CliError');
      expect(first.message).not.toContain('canary');
      const projection: UserFacingError = {
        code: first.code,
        message: first.message,
        exitCode: first.exitCode,
      };
      expect(JSON.stringify(projection)).not.toContain('canary');
    },
  );

  it('keeps known operational internal/1 distinct from unexpected CLI infrastructure/9', () => {
    expect(new CliError('internal', 'known history refusal').exitCode).toBe(1);
    expect(new CliError('internal', 'known history refusal').message).toBe('known history refusal');
    expect(new CliError('cli_internal', 'private detail').exitCode).toBe(9);
    expect(new CliError('cli_internal', 'private detail').message).not.toContain('--verbose');
    expect(new CliError('cli_internal', 'private detail').message).toContain(
      'Inspect existing work',
    );
  });

  it('retains an inspection remedy before repeating potentially effectful infrastructure failures', () => {
    for (const code of ['cli_internal', 'output_unavailable'] satisfies readonly CliErrorCode[]) {
      expect(CLI_ERROR_POLICY[code].fixedMessage).toMatch(/inspect/i);
      expect(CLI_ERROR_POLICY[code].fixedMessage).toMatch(/repeat|retry/i);
    }
    expect(CLI_ERROR_POLICY.storage_unavailable.fixedMessage).toMatch(/permission|capacity/i);
  });

  it.each([
    undefined,
    null,
    false,
    'cli_internal',
    new Error('plain'),
    { code: 'internal', name: 'CliError', exitCode: 1 },
  ])('does not promote arbitrary lookalike %j to the local class identity', (value) =>
    expect(isCliError(value)).toBe(false),
  );
});
