import { describe, expect, it, vi } from 'vitest';

import { closeQuietly, warnTeardown } from './close-quietly.js';

describe('owned synchronous teardown (#22)', () => {
  it('closes once without a diagnostic when cleanup succeeds', () => {
    const close = vi.fn();
    const writeErr = vi.fn();
    closeQuietly({ writeErr }, 'session store', close);
    expect(close).toHaveBeenCalledTimes(1);
    expect(writeErr).not.toHaveBeenCalled();
  });

  it.each([
    new Error('EIO /private/operator/history.db secret-token\x1b[2J'),
    'secret-token /private/operator/history.db',
    {
      get message(): never {
        throw new Error('must not inspect thrown diagnostics');
      },
    },
  ])('emits only the fixed owned-resource warning for a thrown value (%#)', (failure) => {
    const writeErr = vi.fn();
    closeQuietly({ writeErr }, 'effect journal', () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise an untrusted native boundary's unknown thrown value.
      throw failure;
    });
    expect(writeErr).toHaveBeenCalledExactlyOnceWith('warning: effect journal teardown failed\n');
  });

  it('preserves a returned exit when both close and the diagnostic sink fail', () => {
    const writeErr = vi.fn(() => {
      throw new Error('closed stderr');
    });
    const primary = (): number => {
      try {
        return 3;
      } finally {
        closeQuietly({ writeErr }, 'history database', () => {
          throw new Error('native close');
        });
      }
    };
    expect(primary()).toBe(3);
    expect(writeErr).toHaveBeenCalledTimes(1);
  });

  it('preserves the primary thrown identity and attempts the next cleanup after a failed warning', () => {
    const primary = new Error('primary failure');
    const next = vi.fn();
    const writeErr = vi.fn(() => {
      throw new Error('closed stderr');
    });
    let caught: unknown;
    try {
      try {
        throw primary;
      } finally {
        closeQuietly({ writeErr }, 'persister', () => {
          throw new Error('native close');
        });
        closeQuietly({ writeErr }, 'session store', next);
      }
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toBe(primary);
    expect(next).toHaveBeenCalledTimes(1);
    expect(writeErr).toHaveBeenCalledTimes(1);
  });

  it('contains a failed warning sink independently of a close callback', () => {
    expect(() =>
      warnTeardown(
        {
          writeErr: () => {
            throw new Error('closed stderr');
          },
        },
        'MCP',
      ),
    ).not.toThrow();
  });
});
