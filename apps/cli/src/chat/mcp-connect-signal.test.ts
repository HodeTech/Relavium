import type { AbortSignalLike } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { combineMcpConnectSignals } from './mcp-connect-signal.js';

function signalFixture() {
  let aborted = false;
  const listeners = new Set<() => void>();
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener: vi.fn((_type: 'abort', listener: () => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: 'abort', listener: () => void) => {
      listeners.delete(listener);
    }),
  } satisfies AbortSignalLike;
  return {
    signal,
    listeners,
    abort: () => {
      aborted = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('owned MCP connect signal subscriptions', () => {
  it.each(['owner', 'caller'] as const)(
    '%s abort delivers once and unlinks both inputs',
    (side) => {
      const owner = signalFixture();
      const caller = signalFixture();
      const failure = vi.fn();
      const signal = combineMcpConnectSignals(owner.signal, caller.signal, failure);
      const notify = vi.fn();
      signal.addEventListener('abort', notify);
      signal.addEventListener('abort', notify);
      expect(owner.listeners.size).toBe(1);
      expect(caller.listeners.size).toBe(1);
      (side === 'owner' ? owner : caller).abort();
      owner.abort();
      caller.abort();
      expect(notify).toHaveBeenCalledOnce();
      expect(signal.aborted).toBe(true);
      expect(owner.listeners.size).toBe(0);
      expect(caller.listeners.size).toBe(0);
      expect(failure).not.toHaveBeenCalled();
    },
  );

  it.each(['owner', 'caller'] as const)(
    'a failing %s unlink cannot suppress cancellation or its sibling unlink',
    (side) => {
      const owner = signalFixture();
      const caller = signalFixture();
      const fault = new Error('foreign unlink refused');
      const broken = side === 'owner' ? owner : caller;
      broken.signal.removeEventListener.mockImplementation(() => {
        throw fault;
      });
      // The real owner reports uncertainty by synchronously stopping, which reenters notify.
      const failure = vi.fn<(cause: unknown) => void>(() => owner.abort());
      const signal = combineMcpConnectSignals(owner.signal, caller.signal, failure);
      const notify = vi.fn();
      signal.addEventListener('abort', notify);
      expect(() => caller.abort(), 'UNLINK_FAILURE_MUST_NOT_SUPPRESS_CANCEL').not.toThrow();
      expect(notify).toHaveBeenCalledOnce();
      expect(owner.signal.removeEventListener).toHaveBeenCalled();
      expect(caller.signal.removeEventListener).toHaveBeenCalled();
      expect(failure).toHaveBeenCalledWith(fault);
      expect(broken.listeners.size).toBe(1);
      // Possible ownership remains retryable; the original cause is already retained by the owner.
      broken.signal.removeEventListener.mockImplementation((_type, listener) => {
        broken.listeners.delete(listener);
      });
      signal.removeEventListener('abort', notify);
      expect(broken.listeners.size).toBe(0);
      expect(notify).toHaveBeenCalledOnce();
    },
  );

  it('attempts both removals when both fail and reports the first cause', () => {
    const owner = signalFixture();
    const caller = signalFixture();
    const first = new Error('owner unlink');
    const second = new Error('caller unlink');
    owner.signal.removeEventListener.mockImplementation(() => {
      throw first;
    });
    caller.signal.removeEventListener.mockImplementation(() => {
      throw second;
    });
    const failure = vi.fn();
    const signal = combineMcpConnectSignals(owner.signal, caller.signal, failure);
    const notify = vi.fn();
    signal.addEventListener('abort', notify);
    caller.abort();
    expect(notify).toHaveBeenCalledOnce();
    expect(owner.signal.removeEventListener).toHaveBeenCalledOnce();
    expect(caller.signal.removeEventListener).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledExactlyOnceWith(first);
  });

  it('rolls back both possible attachments when caller add attaches then throws', () => {
    const owner = signalFixture();
    const caller = signalFixture();
    const fault = new Error('partial add');
    caller.signal.addEventListener.mockImplementation((_type, listener) => {
      caller.listeners.add(listener);
      throw fault;
    });
    const failure = vi.fn<(cause: unknown) => void>(() => owner.abort());
    const signal = combineMcpConnectSignals(owner.signal, caller.signal, failure);
    const notify = vi.fn();
    expect(() => signal.addEventListener('abort', notify)).toThrow(fault);
    expect(owner.listeners.size).toBe(0);
    expect(caller.listeners.size).toBe(0);
    expect(owner.signal.removeEventListener).toHaveBeenCalledOnce();
    expect(caller.signal.removeEventListener).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledWith(fault);
    expect(notify).not.toHaveBeenCalled();
  });

  it('removes a foreign attachment made after a reentrant abort during add', () => {
    const owner = signalFixture();
    const caller = signalFixture();
    caller.signal.addEventListener.mockImplementation((_type, listener) => {
      owner.abort();
      caller.listeners.add(listener);
    });
    const failure = vi.fn();
    const signal = combineMcpConnectSignals(owner.signal, caller.signal, failure);
    const notify = vi.fn();
    signal.addEventListener('abort', notify);
    expect(notify).toHaveBeenCalledOnce();
    expect(caller.signal.removeEventListener).toHaveBeenCalledOnce();
    expect(owner.listeners.size).toBe(0);
    expect(caller.listeners.size).toBe(0);
    expect(failure).not.toHaveBeenCalled();
  });

  it('retains the original partial-add cause before a secondary rollback fault', () => {
    const owner = signalFixture();
    const caller = signalFixture();
    const primary = new Error('partial attachment');
    const secondary = new Error('rollback unlink refused');
    caller.signal.addEventListener.mockImplementation((_type, listener) => {
      caller.listeners.add(listener);
      throw primary;
    });
    owner.signal.removeEventListener.mockImplementation(() => {
      throw secondary;
    });
    const failure = vi.fn<(cause: unknown) => void>(() => owner.abort());
    const signal = combineMcpConnectSignals(owner.signal, caller.signal, failure);
    expect(() => signal.addEventListener('abort', vi.fn())).toThrow(primary);
    expect(failure.mock.calls.map(([cause]) => cause)).toEqual([primary, secondary]);
    expect(caller.listeners.size).toBe(0);
    expect(owner.listeners.size).toBe(1);
  });

  it('a settled consumer stays unsubscribed when failed cleanup reenters abort', () => {
    const owner = signalFixture();
    const caller = signalFixture();
    const fault = new Error('remove after settlement');
    caller.signal.removeEventListener.mockImplementation(() => {
      throw fault;
    });
    const failure = vi.fn<(cause: unknown) => void>(() => owner.abort());
    const signal = combineMcpConnectSignals(owner.signal, caller.signal, failure);
    const notify = vi.fn();
    signal.addEventListener('abort', notify);
    signal.removeEventListener('abort', notify);
    expect(notify).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith(fault);
    expect(caller.listeners.size).toBe(1);
  });

  it('retains a throwing consumer cause while still attempting both input removals', () => {
    const owner = signalFixture();
    const caller = signalFixture();
    const fault = new Error('consumer callback');
    const failure = vi.fn<(cause: unknown) => void>(() => owner.abort());
    const signal = combineMcpConnectSignals(owner.signal, caller.signal, failure);
    signal.addEventListener('abort', () => {
      throw fault;
    });
    expect(() => caller.abort()).not.toThrow();
    expect(owner.listeners.size).toBe(0);
    expect(caller.listeners.size).toBe(0);
    expect(failure).toHaveBeenCalledWith(fault);
  });
});
