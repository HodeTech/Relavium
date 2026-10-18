import { RelaviumError } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { McpAbortedError, McpConnectError, McpDeadlineError, McpError } from './index.js';

describe('MCP error family compatibility', () => {
  it('preserves native options forwarding and the code-free family name', () => {
    const absent = new McpError('MCP failed');
    const empty = new McpError('MCP failed', {});
    const explicit = new McpError('MCP failed', { cause: undefined });
    const cause = Object.freeze({ detail: 'connection diagnostic' });
    const wrapped = new McpError('MCP failed', { cause });
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped).toBeInstanceOf(RelaviumError);
    expect(wrapped).toMatchObject({ name: 'McpError', message: 'MCP failed' });
    expect(wrapped.cause).toBe(cause);
    expect(Object.hasOwn(absent, 'cause')).toBe(false);
    expect(Object.hasOwn(empty, 'cause')).toBe(false);
    expect(Object.hasOwn(explicit, 'cause')).toBe(true);
    expect(explicit.cause).toBeUndefined();
    expect(Object.hasOwn(wrapped, 'code')).toBe(false);
  });

  it('retains deadline and cancellation descendants and their own phase context', () => {
    const deadline = new McpDeadlineError('server-1', 'connect', 250);
    const cancelled = new McpAbortedError('server-1', 'connect');
    for (const error of [deadline, cancelled]) {
      expect(error).toBeInstanceOf(RelaviumError);
      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({ serverId: 'server-1', phase: 'connect' });
      expect(Object.hasOwn(error, 'code')).toBe(false);
      expect(Object.hasOwn(error, 'cause')).toBe(false);
    }
    expect(deadline.name).toBe('McpDeadlineError');
    expect(deadline.timeoutMs).toBe(250);
    expect(cancelled.name).toBe('McpAbortedError');
  });

  it('retains structural connect classification and opaque foreign cause identity', () => {
    // This independently defined native error simulates a foreign transport, not a bundled package.
    class ForeignNetworkError extends Error {
      readonly code = 'ECONNREFUSED';
    }
    const cause = new ForeignNetworkError('connection refused');
    const error = new McpConnectError('server-1', { cause });
    expect(error).toBeInstanceOf(RelaviumError);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      name: 'McpConnectError',
      serverId: 'server-1',
      reason: 'network',
    });
    expect(error.cause).toBe(cause);
    expect(Object.hasOwn(error, 'code')).toBe(false);
  });
});
