import { describe, expect, it, vi } from 'vitest';

import { invocationFixture } from '../process/invocation.test-support.js';
import { createSuspendPort } from '../render/suspend.js';
import { SessionInkMount } from './session-ink-mount.js';
import { SessionInkInput } from './session-ink-input.js';
import { OwnedTtyInput } from '../test-support.js';

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fixture(
  overrides: {
    readonly stopInput?: () => void;
    readonly drainNative?: () => Promise<void>;
  } = {},
) {
  const f = invocationFixture();
  const failure = vi.fn(() => f.invocation.finiteExit.fail('cli_internal'));
  const port = createSuspendPort();
  const mount = new SessionInkMount({
    invocation: f.invocation,
    assertEntering: () => f.registry.assertAdmitting(),
    failure,
    suspendPort: port,
    stopInput: overrides.stopInput ?? vi.fn(),
    drainNative: overrides.drainNative ?? (() => Promise.resolve()),
  });
  return { ...f, mount, port, failure };
}

describe('actual session Ink mount custody', () => {
  it('refuses native render after input registration reenters termination', async () => {
    const f = invocationFixture();
    const input = new OwnedTtyInput();
    const failure = () => f.invocation.finiteExit.fail('cli_internal');
    const mount = new SessionInkMount({
      invocation: f.invocation,
      assertEntering: () => f.registry.assertAdmitting(),
      failure,
      suspendPort: createSuspendPort(),
      stopInput: () => undefined,
      drainNative: () => Promise.resolve(),
      input: new SessionInkInput({
        input,
        invocation: f.invocation,
        failure,
        acknowledge: () => Promise.resolve(),
      }),
    });
    const hook = (event: string | symbol): void => {
      if (event === 'newListener') failure();
    };
    input.on('newListener', hook);
    const create = vi.fn(() => ({
      unmount: () => undefined,
      waitUntilExit: () => Promise.resolve(),
    }));
    expect(() => mount.acquire(create)).toThrow();
    await turn();
    expect(create, 'SESSION_INK_REGISTRATION_REENTRY_NO_NATIVE_ENTRY').not.toHaveBeenCalled();
    expect(input.listeners('newListener')).toEqual([hook]);
    expect(f.registry.activeOwners).toBe(1);
    input.destroy();
  });

  it('releases captured input even when the native exit acknowledgement is still held', async () => {
    const f = invocationFixture();
    const input = new OwnedTtyInput();
    const exit = gate();
    const mount = new SessionInkMount({
      invocation: f.invocation,
      assertEntering: () => f.registry.assertAdmitting(),
      failure: () => f.invocation.finiteExit.fail('cli_internal'),
      suspendPort: createSuspendPort(),
      stopInput: () => undefined,
      drainNative: () => Promise.resolve(),
      input: new SessionInkInput({
        input,
        invocation: f.invocation,
        acknowledge: () => Promise.resolve(),
        failure: () => f.invocation.finiteExit.fail('cli_internal'),
      }),
    });
    mount.acquire(() => ({ unmount: () => undefined, waitUntilExit: () => exit.promise }));
    input.setRawMode(true);
    input.on('readable', vi.fn());
    const closing = mount.close();
    await turn();
    expect(input.isRaw, 'SESSION_INK_HELD_EXIT_CANNOT_DELAY_INPUT_RELEASE').toBe(false);
    expect(input.listenerCount('readable')).toBe(0);
    expect(f.registry.activeOwners).toBe(1);
    exit.release();
    await closing;
    await turn();
    expect(f.registry.activeOwners).toBe(0);
    input.destroy();
  });

  it('captures the native exit before unmount and waits for its actual acknowledgement', async () => {
    const f = fixture();
    const exit = gate();
    let unmounted = false;
    const unmount = vi.fn(() => {
      unmounted = true;
    });
    const waitUntilExit = vi.fn(() => {
      expect(unmounted).toBe(false);
      return exit.promise;
    });
    f.mount.acquire(() => ({ unmount, waitUntilExit }));
    const close = f.mount.close();
    expect(f.mount.close()).toBe(close);
    await turn();
    expect(unmount).toHaveBeenCalledOnce();
    expect(waitUntilExit).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners, 'SESSION_INK_NATIVE_EXIT_ACK_REQUIRED').toBe(1);
    exit.release();
    await close;
    await turn();
    expect(f.registry.activeOwners).toBe(0);
  });

  it('finishes job control and full endSuspend before final unmount', async () => {
    const endSuspend = gate();
    const resumeJob = gate();
    const trace: string[] = [];
    const f = fixture({
      stopInput: () => trace.push('seal'),
      drainNative: async () => {
        trace.push('finish-job');
        resumeJob.release();
        await endSuspend.promise;
      },
    });
    f.mount.acquire(() => ({
      unmount: () => trace.push('unmount'),
      waitUntilExit: () => Promise.resolve(),
    }));
    f.mount.port.attach(async (body) => {
      await body();
      trace.push('native-resume');
      await endSuspend.promise;
      trace.push('native-redraw');
    });
    const raw = f.port.current()?.(() => resumeJob.promise);
    const close = f.mount.close();
    await turn();
    expect(trace).toEqual(['seal', 'finish-job', 'native-resume']);
    expect(f.port.current()).toBeUndefined();
    expect(f.registry.activeOwners).toBe(1);
    endSuspend.release();
    await raw;
    await close;
    expect(trace).toEqual(['seal', 'finish-job', 'native-resume', 'native-redraw', 'unmount']);
  });

  it('retains constructor uncertainty and uses the original finite budget without forging no acquisition', async () => {
    const f = fixture();
    const primary = new Error('PRIVATE_PARTIAL_INK');
    expect(() =>
      f.mount.acquire(() => {
        throw primary;
      }),
    ).toThrow(primary);
    let released = false;
    void f.mount.close().then(() => {
      released = true;
    });
    await turn();
    expect(f.failure).toHaveBeenCalledWith(primary);
    expect(f.registry.activeOwners).toBe(1);
    f.advance(3000);
    await turn();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    expect(released).toBe(false);
  });

  it('seals already-published attachment authority when a partial native constructor throws', async () => {
    const stopInput = vi.fn();
    const drainNative = vi.fn(() => Promise.resolve());
    const f = fixture({ stopInput, drainNative });
    const native = vi.fn(async (body: () => Promise<void>) => body());
    const primary = new Error('PRIVATE_ATTACHED_PARTIAL_INK');
    expect(() =>
      f.mount.acquire(() => {
        f.mount.port.attach(native);
        throw primary;
      }),
    ).toThrow(primary);
    await turn();
    expect(stopInput).toHaveBeenCalledOnce();
    expect(drainNative).toHaveBeenCalledOnce();
    expect(f.port.current(), 'SESSION_PARTIAL_INK_PREENTRY_SEAL').toBeUndefined();
    f.mount.port.attach(native);
    expect(f.port.current()).toBeUndefined();
    expect(native).not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(1);
    f.advance(3000);
    await turn();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
  });

  it('still attempts attachment/job-control seals when input sealing throws', async () => {
    const primary = new Error('PRIVATE_INPUT_SEAL');
    const finish = vi.fn(() => Promise.resolve());
    const f = fixture({
      stopInput: () => {
        throw primary;
      },
      drainNative: finish,
    });
    const unmount = vi.fn();
    f.mount.acquire(() => ({ unmount, waitUntilExit: () => Promise.resolve() }));
    f.mount.port.attach(async (body) => body());
    let released = false;
    void f.mount.close().then(() => {
      released = true;
    });
    await turn();
    expect(f.port.current()).toBeUndefined();
    expect(finish).toHaveBeenCalledOnce();
    expect(unmount).toHaveBeenCalledOnce();
    expect(released).toBe(false);
    expect(f.registry.activeOwners).toBe(1);
  });

  it('observes autonomous Ink failure before an independently held suspension can finish', async () => {
    let rejectExit: (cause: unknown) => void = () => undefined;
    const exit = new Promise<void>((_resolve, reject) => {
      rejectExit = reject;
    });
    const f = fixture();
    const endSuspend = gate();
    const unmount = vi.fn();
    f.mount.acquire(() => ({ unmount, waitUntilExit: () => exit }));
    f.mount.port.attach(async (body) => {
      await body();
      await endSuspend.promise;
    });
    const raw = f.port.current()?.(() => Promise.resolve());
    const primary = new Error('PRIVATE_INK_FAILURE');
    rejectExit(primary);
    await turn();
    expect(f.failure).toHaveBeenCalledWith(primary);
    expect(f.registry.budget.remainingMs()).toBe(3000);
    expect(unmount).not.toHaveBeenCalled();
    endSuspend.release();
    await raw;
    f.advance(3000);
    await turn();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    expect(f.registry.activeOwners).toBe(1);
  });
});
