import { describe, expect, it } from 'vitest';
import { ToolDispatchError as RootBase, ToolPolicyError } from '../index.js';
import { RelaviumError } from '@relavium/shared/relavium-error';
import { ToolDispatchError } from './dispatch-error.js';

class LeafProbe extends ToolDispatchError {
  readonly code = 'tool_denied';
  readonly runErrorCode = 'tool_denied';
  readonly retryable = false;
  constructor(cause?: unknown) {
    super('safe reason', 'write_file', cause, true);
  }
}

describe('pure tool dispatch error base compatibility', () => {
  it('retains the same exported constructor and concrete-family instanceof relationship', () => {
    expect(ToolDispatchError).toBe(RootBase);
    const concrete = new ToolPolicyError('write_file', 'not_granted', 'safe denial');
    expect(concrete).toBeInstanceOf(ToolDispatchError);
    expect(concrete).toBeInstanceOf(RelaviumError);
    expect(concrete).toMatchObject({
      code: 'tool_denied',
      runErrorCode: 'tool_denied',
      retryable: false,
    });
  });
  it('preserves inherited tool id, recoverability and opaque cause identity', () => {
    const cause = Object.freeze({ private: 'synthetic cause' });
    const value = new LeafProbe(cause);
    expect(value).toBeInstanceOf(RootBase);
    expect(value).toMatchObject({
      message: 'safe reason',
      toolId: 'write_file',
      recoverable: true,
    });
    expect(value.cause).toBe(cause);
    expect(new LeafProbe()).not.toHaveProperty('cause');
  });
});
