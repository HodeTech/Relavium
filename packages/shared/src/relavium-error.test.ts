import { describe, expect, it } from 'vitest';

import {
  AppendConflictError,
  CorruptRunEventError,
  isAppendConflictError,
  isCorruptRunEventError,
  RelaviumError,
} from './index.js';

// No constructor or fields: exercise the public base's inherited native constructor directly.
class NativeForwardingError extends RelaviumError {}

describe('RelaviumError native compatibility', () => {
  it('retains native defaults without imposing a family name or discriminant', () => {
    const error = new NativeForwardingError();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RelaviumError);
    expect(error).toBeInstanceOf(NativeForwardingError);
    expect(error.name).toBe('Error');
    expect(error.message).toBe('');
    for (const key of ['name', 'message', 'cause', 'code', 'kind', 'reason', 'context']) {
      expect(Object.hasOwn(error, key)).toBe(false);
    }
  });

  it('preserves native message descriptors and stack diagnostics', () => {
    const error = new NativeForwardingError('native forwarding');
    expect(Object.getOwnPropertyDescriptor(error, 'message')).toEqual({
      value: 'native forwarding',
      writable: true,
      enumerable: false,
      configurable: true,
    });
    expect(error.toString()).toBe('Error: native forwarding');
    expect(error.stack).toContain('Error: native forwarding');
    expect(Object.keys(error)).toEqual([]);
  });

  it('distinguishes absent cause from an explicitly supplied undefined cause', () => {
    for (const error of [
      new NativeForwardingError('message'),
      new NativeForwardingError('message', undefined),
      new NativeForwardingError('message', {}),
    ]) {
      expect(Object.hasOwn(error, 'cause')).toBe(false);
    }
    expect(
      Object.getOwnPropertyDescriptor(
        new NativeForwardingError('message', { cause: undefined }),
        'cause',
      ),
    ).toEqual({ value: undefined, writable: true, enumerable: false, configurable: true });
  });

  it('forwards a cause by identity without cloning or changing it', () => {
    const cause = Object.freeze({ detail: 'diagnostic context' });
    const error = new NativeForwardingError('message', { cause });
    expect(error.cause, 'NATIVE_ERROR_CAUSE_IDENTITY').toBe(cause);
    expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false);
  });

  it('preserves actual shared constructor context and mandatory cause semantics', () => {
    const cause = new SyntaxError('invalid stored JSON');
    const corrupt = new CorruptRunEventError('run-1', 3, 'run:started', cause);
    expect(corrupt).toBeInstanceOf(RelaviumError);
    expect(corrupt).toMatchObject({
      name: 'CorruptRunEventError',
      code: 'corrupt_run_event',
      runId: 'run-1',
      sequenceNumber: 3,
      eventType: 'run:started',
    });
    expect(corrupt.cause).toBe(cause);
    expect(
      Object.hasOwn(new CorruptRunEventError('run-1', 3, 'run:started', undefined), 'cause'),
    ).toBe(true);

    const append = new AppendConflictError('run-1', 2, 3);
    expect(append).toBeInstanceOf(RelaviumError);
    expect(append).toMatchObject({
      name: 'AppendConflictError',
      runId: 'run-1',
      expectedLastSequenceNumber: 2,
      actualLastSequenceNumber: 3,
    });
    for (const key of ['code', 'cause']) {
      expect(Object.hasOwn(append, key)).toBe(false);
    }
    expect(append.incomingSequenceNumber).toBeUndefined();
    expect(new AppendConflictError('run-1', 2, 3, 2).incomingSequenceNumber).toBe(2);
    expect(isAppendConflictError(append)).toBe(true);
    expect(isAppendConflictError(corrupt)).toBe(false);
  });

  it('keeps the corruption guard structural across a simulated foreign class identity', () => {
    // An independently defined class models another bundle; this is not an actual bundle execution.
    class ForeignCorruptRunEventError extends Error {
      readonly code = 'corrupt_run_event';
    }
    const foreign = new ForeignCorruptRunEventError('damaged row');
    expect(foreign).not.toBeInstanceOf(CorruptRunEventError);
    expect(foreign).not.toBeInstanceOf(RelaviumError);
    expect(isCorruptRunEventError(foreign)).toBe(true);
    expect(isCorruptRunEventError({ code: 'corrupt_run_event' })).toBe(false);
    expect(isCorruptRunEventError(new Error('corrupt_run_event'))).toBe(false);
  });
});
