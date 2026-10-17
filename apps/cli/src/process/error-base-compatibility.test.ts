import { ToolDispatchError } from '@relavium/core';
import { RelaviumError } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../config/errors.js';
import {
  EgressCapabilityError,
  EgressDeniedError,
  HostCapabilityError,
  HostDeniedError,
} from '../engine/tool-host/errors.js';
import { CliError, isCliError, toUserFacing } from './errors.js';

describe('CLI error family compatibility', () => {
  it('retains config descendants, contextual fields, cause identity and exit projection', () => {
    const cause = new SyntaxError('invalid TOML');
    const error = new ConfigError('config.toml', 'invalid syntax', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RelaviumError);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({
      name: 'ConfigError',
      code: 'config_error',
      filePath: 'config.toml',
      message: 'config.toml: invalid syntax',
      exitCode: 2,
    });
    expect(error.cause).toBe(cause);
    expect(isCliError(error)).toBe(true);
    expect(toUserFacing(error)).toEqual({
      code: 'config_error',
      message: 'config.toml: invalid syntax',
      exitCode: 2,
    });
  });

  it('preserves CLI optional-cause omission instead of adopting native explicit-undefined presence', () => {
    for (const error of [
      new CliError('invalid_invocation', 'invalid invocation'),
      new CliError('invalid_invocation', 'invalid invocation', { cause: undefined }),
      new ConfigError('config.toml', 'invalid syntax', { cause: undefined }),
    ]) {
      expect(Object.hasOwn(error, 'cause')).toBe(false);
    }
    expect(isCliError(new EgressCapabilityError('network failed'))).toBe(false);
  });

  it('retains new.target names and the distinct host capability and denial family contracts', () => {
    const capability = new EgressCapabilityError('connection failed');
    expect(capability).toBeInstanceOf(RelaviumError);
    expect(capability).toBeInstanceOf(HostCapabilityError);
    expect(capability.name).toBe('EgressCapabilityError');
    expect(Object.hasOwn(capability, 'code')).toBe(false);

    const denied = new EgressDeniedError('domain denied', true);
    expect(denied).toBeInstanceOf(RelaviumError);
    expect(denied).toBeInstanceOf(ToolDispatchError);
    expect(denied).toBeInstanceOf(HostDeniedError);
    expect(denied).toMatchObject({
      name: 'EgressDeniedError',
      code: 'tool_denied',
      runErrorCode: 'tool_denied',
      retryable: false,
      recoverable: true,
    });
    expect(new EgressDeniedError('domain denied').recoverable).toBe(false);
    expect(denied.toolId).toBeUndefined();
    expect(Object.hasOwn(denied, 'cause')).toBe(false);
  });
});
