import { describe, expect, it, vi } from 'vitest';

import { CliError } from '../process/cli-error.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { OwnedTtyInput } from '../test-support.js';
import { SessionInkInput } from './session-ink-input.js';

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function fixture(acknowledge = vi.fn(() => Promise.resolve())) {
  const f = invocationFixture();
  const input = new OwnedTtyInput();
  const failure = vi.fn(() => f.invocation.finiteExit.fail('cli_internal'));
  const lease = new SessionInkInput({ input, invocation: f.invocation, acknowledge, failure });
  return { ...f, input, failure, lease, acknowledge };
}

describe('captured native Ink input final release', () => {
  it('rechecks callback multiplicity when a native remover consumes a sibling occurrence', async () => {
    const f = fixture();
    const shared = vi.fn();
    f.input.on('readable', shared);
    f.lease.enter();
    f.input.on('readable', shared);
    f.input.on('readable', shared);
    f.input.once('removeListener', (event, listener: unknown) => {
      if (event === 'readable' && listener === shared) f.input.removeListener('readable', shared);
    });
    await f.lease.close();
    expect(f.input.listeners('readable'), 'SESSION_INK_INPUT_REMOVAL_REENTRY_BASELINE').toEqual([
      shared,
    ]);
    f.input.destroy();
  });
  it('joins reentrant close during native observer registration before removing the late observer', async () => {
    const f = fixture();
    let closing: Promise<void> | undefined;
    const hook = (event: string | symbol): void => {
      if (event === 'newListener') closing = f.lease.close();
    };
    f.input.on('newListener', hook);
    f.lease.enter();
    expect(closing).toBeDefined();
    await closing;
    expect(f.input.listeners('newListener'), 'SESSION_INK_INPUT_REGISTRATION_REENTRY').toEqual([
      hook,
    ]);
    expect(f.acknowledge).toHaveBeenCalledOnce();
    f.input.destroy();
  });

  it('a throwing failure reporter cannot skip independent release or replace the primary remover failure', async () => {
    const f = invocationFixture();
    const input = new OwnedTtyInput();
    const primary = new Error('PRIVATE_PRIMARY_REMOVER');
    const observer = new Error('PRIVATE_FAILURE_OBSERVER');
    const acknowledge = vi.fn(() => Promise.resolve());
    const lease = new SessionInkInput({
      input,
      invocation: f.invocation,
      acknowledge,
      failure: () => {
        throw observer;
      },
    });
    lease.enter();
    const first = vi.fn();
    input.on('readable', first);
    input.on('readable', vi.fn());
    input.setRawMode(true);
    input.on('removeListener', (event, listener: unknown) => {
      if (event === 'readable' && listener === first) throw primary;
    });
    await expect(lease.close()).rejects.toBe(primary);
    expect(input.listenerCount('readable')).toBe(0);
    expect(input.isRaw).toBe(false);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(f.registry.observations.exitCode()).toBe(9);
    input.destroy();
  });

  it('removes only introduced occurrences when Ink and a prior reader share a callback identity', async () => {
    const f = fixture();
    const shared = vi.fn();
    f.input.on('readable', shared);
    f.lease.enter();
    f.input.on('readable', shared);
    await f.lease.close();
    expect(f.input.listeners('readable'), 'SESSION_INK_INPUT_BASELINE_MULTIPLICITY').toEqual([
      shared,
    ]);
    f.input.destroy();
  });

  it('refuses an extra baseline callback introduced after observer removal', async () => {
    const f = fixture();
    const shared = vi.fn();
    f.input.on('readable', shared);
    f.lease.enter();
    f.input.on('removeListener', (event) => {
      if (event === 'newListener') f.input.on('readable', shared);
    });
    await expect(f.lease.close()).rejects.toBeInstanceOf(CliError);
    expect(f.input.listeners('readable')).toEqual([shared, shared]);
    f.input.destroy();
  });

  it('removes only the mount callbacks, preserving pre-existing captured-stream readers', async () => {
    const f = fixture();
    const unrelated = vi.fn();
    const native = vi.fn();
    f.input.on('readable', unrelated);
    f.lease.enter();
    f.input.on('readable', native);
    f.input.setRawMode(true);
    await f.lease.close();
    expect(f.input.listeners('readable')).toEqual([unrelated]);
    expect(f.input.listenerCount('newListener')).toBe(0);
    expect(f.input.isRaw).toBe(false);
    expect(f.input.isPaused()).toBe(true);
    expect(f.failure).not.toHaveBeenCalled();
    f.input.destroy();
  });

  it('waits for actual final control delivery and publishes shared close before reentrant callbacks', async () => {
    let deliver: () => void = () => undefined;
    const delivery = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const f = fixture(vi.fn(() => delivery));
    f.lease.enter();
    const native = vi.fn();
    f.input.on('readable', native);
    let reentered: Promise<void> | undefined;
    f.input.on('removeListener', (event) => {
      if (event === 'readable') reentered = f.lease.close();
    });
    const close = f.lease.close();
    let acknowledged = false;
    void close.then(() => {
      acknowledged = true;
    });
    await turn();
    expect(reentered).toBe(close);
    expect(f.lease.close()).toBe(close);
    expect(f.acknowledge).toHaveBeenCalledOnce();
    expect(acknowledged, 'SESSION_INK_CONTROL_DELIVERY_ACK_REQUIRED').toBe(false);
    deliver();
    await close;
    f.input.destroy();
  });

  it('independently removes sibling input callbacks and pauses input after a remover throws', async () => {
    const f = fixture();
    const primary = new Error('PRIVATE_NATIVE_REMOVER');
    f.lease.enter();
    const first = vi.fn();
    const second = vi.fn();
    f.input.on('readable', first);
    f.input.on('readable', second);
    f.input.setRawMode(true);
    f.input.on('removeListener', (event, listener: unknown) => {
      if (event === 'readable' && listener === first) throw primary;
    });
    await expect(f.lease.close()).rejects.toBe(primary);
    expect(f.input.listenerCount('readable')).toBe(0);
    expect(f.input.isRaw).toBe(false);
    expect(f.input.isPaused()).toBe(true);
    expect(f.acknowledge).toHaveBeenCalledOnce();
    f.input.destroy();
  });

  it('withholds release if removal reentry leaves an input callback after the observer is detached', async () => {
    const f = fixture();
    f.lease.enter();
    const late = vi.fn();
    f.input.on('removeListener', (event) => {
      if (event === 'newListener') f.input.on('readable', late);
    });
    await expect(f.lease.close()).rejects.toBeInstanceOf(CliError);
    expect(f.input.listeners('readable')).toEqual([late]);
    expect(f.failure).toHaveBeenCalled();
    f.input.destroy();
  });

  it('does not start a final asynchronous control write after the original budget expired', async () => {
    const f = fixture();
    f.lease.enter();
    f.input.on('readable', vi.fn());
    f.input.setRawMode(true);
    f.invocation.finiteExit.fail('cli_internal');
    f.advance(3000);
    let acknowledged = false;
    void f.lease.close().then(() => {
      acknowledged = true;
    });
    await turn();
    expect(f.input.isRaw).toBe(false);
    expect(f.input.listenerCount('readable')).toBe(0);
    expect(f.acknowledge).not.toHaveBeenCalled();
    expect(acknowledged).toBe(false);
    f.input.destroy();
  });

  it('a final delivery refusal remains the fixed output disposition', async () => {
    const primary = new CliError('output_unavailable', '');
    const f = fixture(vi.fn(() => Promise.reject(primary)));
    f.lease.enter();
    await expect(f.lease.close()).rejects.toBe(primary);
    expect(f.failure).toHaveBeenCalledWith(primary);
    expect(f.input.listenerCount('newListener')).toBe(0);
    f.input.destroy();
  });
});
