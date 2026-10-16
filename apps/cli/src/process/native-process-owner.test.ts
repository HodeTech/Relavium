import { ChildProcess, spawn } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { createCliInvocation } from './invocation.js';
import { InvocationRegistry } from './invocation-registry.js';
import {
  createNativeProcessController,
  nativeProcessesForInvocation,
  type NativeProcessPorts,
} from './native-process-owner.js';
import { WindowsTeardownUnavailableError } from './windows-teardown.js';

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Explicit simulated native events: these test ownership protocol, not OS containment. */
function child(pid = 40): ChildProcess {
  const target = new ChildProcess();
  Object.defineProperty(target, 'pid', { value: pid });
  vi.spyOn(target, 'kill').mockReturnValue(true);
  return target;
}

function harness(platform: NodeJS.Platform = 'linux') {
  let now = 0;
  const scheduled = new Map<() => void, number>();
  const schedule = (milliseconds: number, fire: () => void): (() => void) => {
    scheduled.set(fire, now + milliseconds);
    return () => scheduled.delete(fire);
  };
  const registry = new InvocationRegistry({ now: () => now, schedule });
  const helper = child(80);
  const request = vi.fn(() => helper);
  const verify = vi.fn(() => Promise.resolve({ spawn: request }));
  const signal = vi.fn<(pid: number, signal: 0 | 'SIGKILL') => void>(() => undefined);
  const helperKill = vi.spyOn(helper, 'kill');
  const removeExit = vi.fn();
  let exit: (() => void) | undefined;
  const subscribeExit = vi.fn((listener: () => void) => {
    exit = listener;
    return removeExit;
  });
  const ports: NativeProcessPorts = {
    platform,
    now: () => now,
    schedule,
    signal,
    verifyWindows: verify,
    subscribeExit,
  };
  const controller = createNativeProcessController(registry, ports);
  const advance = (milliseconds: number): void => {
    now += milliseconds;
    for (const [fire, at] of [...scheduled]) {
      if (at > now || !scheduled.has(fire)) continue;
      scheduled.delete(fire);
      fire();
    }
  };
  return {
    registry,
    controller,
    ports,
    helper,
    helperKill,
    request,
    verify,
    signal,
    subscribeExit,
    removeExit,
    scheduled,
    advance,
    exit: () => exit?.(),
    now: () => now,
  };
}

describe('creation-owned native processes', () => {
  it('constructs inertly and binds only the explicit original invocation identity', () => {
    const h = harness('win32');
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.subscribeExit).not.toHaveBeenCalled();
    expect(h.registry.activeOwners).toBe(0);
    const invocation = createCliInvocation();
    expect(nativeProcessesForInvocation(invocation)).toBe(nativeProcessesForInvocation(invocation));
    expect(nativeProcessesForInvocation(invocation)).not.toBe(
      nativeProcessesForInvocation(createCliInvocation()),
    );
    expect(nativeProcessesForInvocation(undefined)).toBeUndefined();
  });

  it('reserves before Windows verification and refuses a stopped creation before native entry', async () => {
    const h = harness('win32');
    const verified = deferred<{ readonly spawn: (pid: number) => ChildProcess }>();
    const controller = createNativeProcessController(h.registry, {
      ...h.ports,
      verifyWindows: () => verified.promise,
    });
    const prepared = controller.reserve('pid').catch((cause: unknown) => cause);
    expect(h.registry.activeOwners, 'NATIVE_PREENTRY_REGISTRATION').toBe(1);
    const termination = h.registry.terminate({ kind: 'normal' });
    verified.resolve({ spawn: h.request });
    expect(await prepared).toMatchObject({ code: 'cli_internal' });
    expect(await termination).toMatchObject({ kind: 'settled', unacknowledgedOwners: 0 });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.removeExit).toHaveBeenCalledTimes(1);
  });

  it('preserves fixed facility refusal and retires only the proved-empty reservation', async () => {
    const h = harness('win32');
    const controller = createNativeProcessController(h.registry, {
      ...h.ports,
      verifyWindows: () => Promise.reject(new WindowsTeardownUnavailableError()),
    });
    await expect(controller.reserve('group')).rejects.toBeInstanceOf(
      WindowsTeardownUnavailableError,
    );
    expect(h.registry.activeOwners).toBe(0);
    expect(h.signal).not.toHaveBeenCalled();
  });

  it('caches only the invocation facility, never target PID or eligibility', async () => {
    const h = harness('win32');
    const first = await h.controller.reserve('pid');
    const second = await h.controller.reserve('pid');
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.registry.activeOwners).toBe(2);
    expect(h.subscribeExit).toHaveBeenCalledTimes(1);
    first.abandon();
    expect(h.removeExit).not.toHaveBeenCalled();
    second.abandon();
    await second.whenClosed;
    expect(h.removeExit).toHaveBeenCalledTimes(1);
    const third = await h.controller.reserve('pid');
    expect(h.subscribeExit).toHaveBeenCalledTimes(2);
    third.abandon();
  });

  it('retains a native error and successful kill request until actual close', async () => {
    const h = harness();
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    target.emit('error', new Error('untrusted command error'));
    await Promise.resolve(); // Observe any erroneous retirement reaction before asking for cancellation.
    expect(h.registry.activeOwners, 'NATIVE_ERROR_NOT_ACK').toBe(1);
    const stop = lease.stop();
    let settled = false;
    void stop.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled, 'NATIVE_REQUEST_NOT_ACK').toBe(false);
    expect(h.registry.activeOwners).toBe(1);
    expect(h.signal.mock.calls).toEqual([
      [40, 0],
      [40, 'SIGKILL'],
    ]);
    target.emit('close', null);
    await stop;
    expect(h.registry.activeOwners).toBe(0);
  });

  it('uses group authority after leader exit and releases it after final close reap', async () => {
    const h = harness();
    const lease = await h.controller.reserve('group');
    const target = child();
    lease.bindChild(target);
    target.emit('exit', 0);
    expect(h.signal).toHaveBeenCalledWith(-40, 'SIGKILL');
    expect(h.registry.activeOwners).toBe(1);
    target.emit('close', 0);
    await lease.whenClosed;
    expect(h.signal.mock.calls, 'NATIVE_GROUP_FINAL_REAP').toEqual([
      [-40, 'SIGKILL'],
      [-40, 'SIGKILL'],
    ]);
    h.registry.reapNativeAtExit();
    expect(h.signal).toHaveBeenCalledTimes(2);
    expect(h.registry.activeOwners).toBe(0);
  });

  it('never promotes a shared foreground PID to group authority', async () => {
    const h = harness();
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    target.emit('exit', 0);
    h.exit();
    expect(h.signal).not.toHaveBeenCalled();
    target.emit('close', 0);
    await lease.whenClosed;
  });

  it('keeps a Windows helper and target as two independent native close obligations', async () => {
    const h = harness('win32');
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    const closed = lease.stop();
    expect(h.request).toHaveBeenCalledExactlyOnceWith(40);
    h.helper.emit('close', 0);
    await Promise.resolve();
    expect(h.registry.activeOwners, 'WINDOWS_TARGET_JOIN').toBe(1);
    target.emit('close', null);
    await closed;
    expect(h.registry.activeOwners).toBe(0);
    expect(h.scheduled.size).toBe(0);
  });

  it('retains helper authority when target closes first and never repeats taskkill', async () => {
    const h = harness('win32');
    const lease = await h.controller.reserve('group');
    const target = child();
    lease.bindChild(target);
    const stopped = lease.stop();
    target.emit('close', null);
    await Promise.resolve();
    expect(h.registry.activeOwners, 'WINDOWS_HELPER_JOIN').toBe(1);
    void lease.stop();
    expect(h.request).toHaveBeenCalledTimes(1);
    h.helper.emit('close', 0);
    await stopped;
    expect(h.registry.activeOwners).toBe(0);
  });

  it('preserves normal outcome when taskkill loses a race with actual cooperative root close', async () => {
    const h = harness('win32');
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    void lease.stop();
    target.emit('close', 0);
    h.helper.emit('close', 128);
    await lease.whenClosed;
    expect(h.registry.termination).toBeUndefined();
    expect(h.registry.observations.exitCode()).toBe(0);
    expect(h.registry.activeOwners).toBe(0);
  });

  it('retains helper error as a failure and joins both actual native closes', async () => {
    const h = harness('win32');
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    void lease.stop();
    h.helper.emit('error', new Error('private helper fault'));
    expect(h.registry.observations.exitCode()).toBe(9);
    expect(h.registry.activeOwners, 'WINDOWS_HELPER_ERROR_JOIN').toBe(1);
    target.emit('close', null);
    await Promise.resolve();
    expect(h.registry.activeOwners, 'WINDOWS_HELPER_ERROR_JOIN').toBe(1);
    h.helper.emit('close', null);
    await lease.whenClosed;
    expect(h.registry.activeOwners).toBe(0);
  });

  it('retains a fixed infrastructure fault when taskkill fails while its owned root remains live', async () => {
    const h = harness('win32');
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    void lease.stop();
    h.helper.emit('close', 1);
    expect(h.registry.observations.exitCode()).toBe(9);
    expect(h.registry.activeOwners).toBe(1);
    expect(h.request).toHaveBeenCalledTimes(1);
    target.emit('close', null);
    await lease.whenClosed;
  });

  it('does not enter taskkill for a root whose exit precedes stdio close', async () => {
    const h = harness('win32');
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    target.emit('exit', 0);
    const stopped = lease.stop();
    expect(h.request, 'WINDOWS_ROOT_EXIT_REFUSAL').not.toHaveBeenCalled();
    expect(h.registry.activeOwners).toBe(1);
    target.emit('close', 0);
    await stopped;
  });

  it('performs immediate best-effort live-root checking before taskkill', async () => {
    const h = harness('win32');
    h.signal.mockImplementation(() => {
      const error = new Error('absent');
      Object.defineProperty(error, 'code', { value: 'ESRCH' });
      throw error;
    });
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    void lease.stop();
    expect(h.request, 'WINDOWS_LIVE_ROOT_CHECK').not.toHaveBeenCalled();
    expect(h.registry.activeOwners).toBe(1);
    target.emit('close', null);
    await lease.whenClosed;
  });

  it('shortens an already-entered ordinary helper to later fatal and earlier signal deadlines', async () => {
    const h = harness('win32');
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    void lease.stop();
    expect([...h.scheduled.values()]).toEqual([3000]);
    h.advance(500);
    void h.registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    // Ordinary helper's original limit is earlier than the newly observed fatal bound.
    expect([...h.scheduled.values()].sort()).toEqual([3000, 3500]);
    void h.registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 1000 });
    expect([...h.scheduled.values()], 'WINDOWS_CHANGED_BUDGET').toEqual([1000, 1000]);
    h.advance(499);
    expect(h.helperKill).not.toHaveBeenCalled();
    h.advance(1);
    expect(h.helperKill).toHaveBeenCalled();
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.registry.activeOwners).toBe(1); // expiry never fabricates close
    target.emit('close', null);
    h.helper.emit('close', null);
    await lease.whenClosed;
    expect(h.registry.activeOwners).toBe(0);
  });

  it('does not renew an ordinary helper deadline on equal or later failures', async () => {
    const h = harness('win32');
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    void lease.stop();
    h.advance(400);
    void h.registry.terminate({ kind: 'infrastructure', code: 'output_unavailable' });
    h.advance(400);
    void h.registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    expect([...h.scheduled.values()].sort(), 'WINDOWS_ORIGINAL_BOUND').toEqual([3000, 3400]);
    target.emit('close', 0);
    h.helper.emit('close', 0);
    await lease.whenClosed;
  });

  it('at expiry performs finite existing requests without starting a helper or acknowledging closure', async () => {
    const h = harness('win32');
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    const closing = h.registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 0 });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.signal).toHaveBeenCalledWith(40, 'SIGKILL');
    expect(await closing).toMatchObject({ kind: 'deadline', unacknowledgedOwners: 1 });
    target.emit('close', null);
    await lease.whenClosed;
  });

  it('rechecks the live budget when immediate liveness work synchronously expires it', async () => {
    const h = harness('win32');
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    h.signal.mockImplementation((_pid, signal) => {
      if (signal === 0)
        void h.registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 0 });
    });
    void lease.stop();
    expect(h.request, 'WINDOWS_PREHELPER_BUDGET').not.toHaveBeenCalled();
    expect(h.registry.budget.remainingMs()).toBe(0);
    expect(h.signal).toHaveBeenCalledWith(40, 'SIGKILL');
    expect(h.registry.activeOwners).toBe(1);
    target.emit('close', null);
    await lease.whenClosed;
  });

  it('finite exit cleanup kills only active owned resources and starts no taskkill helper', async () => {
    const h = harness('win32');
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    h.exit();
    expect(h.signal.mock.calls).toEqual([
      [40, 0],
      [40, 'SIGKILL'],
    ]);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.registry.activeOwners).toBe(1);
    target.emit('close', null);
    await lease.whenClosed;
    h.exit();
    expect(h.signal).toHaveBeenCalledTimes(2);
  });

  it('a finite exit failure records a fixed diagnosis without entering normal async shutdown', async () => {
    const h = harness('win32');
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    h.signal.mockImplementation(() => {
      throw new Error('native signal failure');
    });
    h.exit();
    expect(h.registry.termination, 'NATIVE_EXIT_NO_TERMINATE').toBeUndefined();
    expect(h.registry.observations.exitCode()).toBe(9);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.scheduled.size).toBe(0);
    expect(h.registry.activeOwners).toBe(1);
    target.emit('close', 0);
    await lease.whenClosed;
  });

  it('finite exit still cancels an existing helper after target close without reauthorizing the root', async () => {
    const h = harness('win32');
    const lease = await h.controller.reserve('pid');
    const target = child();
    lease.bindChild(target);
    void lease.stop();
    target.emit('close', 0);
    h.signal.mockClear();
    h.exit();
    expect(h.helperKill, 'NATIVE_EXIT_EXISTING_HELPER').toHaveBeenCalledTimes(1);
    expect(h.signal).not.toHaveBeenCalled();
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.registry.activeOwners).toBe(1);
    h.helper.emit('close', 0);
    await lease.whenClosed;
  });

  it('retains SDK close independently from public cancellation and uses positive live PID only', async () => {
    const h = harness();
    const observer = await h.controller.observeMcp();
    const nativeClosed = deferred<void>();
    let closed = false;
    const close = vi.fn(() => Promise.resolve());
    observer.attach({
      readPid: () => 70,
      isClosed: () => closed,
      whenClosed: nativeClosed.promise,
      close,
    });
    void h.registry.terminate({ kind: 'normal' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(h.signal.mock.calls, 'MCP_POSITIVE_PID').toEqual([
      [70, 0],
      [70, 'SIGKILL'],
    ]);
    await Promise.resolve();
    expect(h.registry.activeOwners).toBe(1);
    observer.abandonIfUnattached();
    expect(h.registry.activeOwners).toBe(1);
    closed = true;
    nativeClosed.resolve();
    await vi.waitFor(() => expect(h.registry.activeOwners).toBe(0));
  });

  it('releases a bridge refusal before SDK attachment without losing an attached native obligation', async () => {
    const h = harness();
    const observer = await h.controller.observeMcp();
    expect(h.registry.activeOwners).toBe(1);
    observer.abandonIfUnattached();
    await vi.waitFor(() => expect(h.registry.activeOwners).toBe(0));
    expect(() => observer.beforeStart()).toThrow();
    expect(h.signal).not.toHaveBeenCalled();
  });
});

describe('actual owned native child lifetime', () => {
  it('registers before spawn, terminates a real owned child and joins native close', async () => {
    const invocation = createCliInvocation();
    const controller = nativeProcessesForInvocation(invocation);
    if (controller === undefined) throw new Error('missing explicit invocation');
    const lease = await controller.reserve('pid');
    expect(invocation.registry.activeOwners, 'NATIVE_REAL_PREENTRY').toBe(1);
    const target = spawn(
      process.execPath,
      ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
      },
    );
    lease.bindChild(target);
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      target.kill('SIGKILL');
    }, 5000);
    try {
      await new Promise<void>((resolve, reject) => {
        target.stdout?.once('data', () => resolve());
        target.once('error', reject);
      });
      await lease.stop();
      expect(watchdogFired, 'NATIVE_OWNER_PID_CANCEL').toBe(false);
      if (process.platform === 'win32')
        expect(target.exitCode !== null || target.signalCode !== null).toBe(true);
      else expect(target.signalCode).toBe('SIGKILL');
      expect(invocation.registry.activeOwners).toBe(0);
    } finally {
      clearTimeout(watchdog);
      target.kill('SIGKILL');
      await lease.whenClosed;
    }
  }, 10000);

  it.runIf(process.platform !== 'win32')(
    'reaps an explicitly detached group when leader exit leaves inherited pipes open',
    async () => {
      const invocation = createCliInvocation();
      const controller = nativeProcessesForInvocation(invocation);
      if (controller === undefined) throw new Error('missing explicit invocation');
      const lease = await controller.reserve('group');
      const target = spawn(
        process.execPath,
        [
          '-e',
          [
            'const {spawn}=require("node:child_process");',
            'const descendant=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore",1,2]});',
            'process.stdout.write("descendant "+descendant.pid+"\\n");',
            'descendant.unref();',
          ].join(''),
        ],
        { detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
      );
      lease.bindChild(target);
      let closed = false;
      let watchdogFired = false;
      target.once('close', () => {
        closed = true;
      });
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        if (!closed && target.pid !== undefined) process.kill(-target.pid, 'SIGKILL');
      }, 5000);
      try {
        await lease.whenClosed;
        expect(watchdogFired, 'NATIVE_OWNER_GROUP_EXIT_REAP').toBe(false);
        expect(target.exitCode).toBe(0); // leader completed naturally; its descendant held the inherited pipe
        expect(closed).toBe(true);
        expect(invocation.registry.activeOwners).toBe(0);
      } finally {
        clearTimeout(watchdog);
        if (!closed && target.pid !== undefined) process.kill(-target.pid, 'SIGKILL');
        await lease.whenClosed;
      }
    },
    10000,
  );
});
