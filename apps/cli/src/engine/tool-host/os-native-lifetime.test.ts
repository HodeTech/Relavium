import { spawn, type ChildProcess } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { createCliInvocation } from '../../process/invocation.js';
import { nativeProcessesForInvocation } from '../../process/native-process-owner.js';
import { createNodeOsCapability, type OsSpawnFn } from './os.js';
import { OsCapabilityError } from './errors.js';

/** Real inert Node child at the explicit spawn seam; no clipboard/notification program is executed. */
function ownedFixture() {
  let child: ChildProcess | undefined;
  let closed = false;
  let acknowledgeReady = (): void => undefined;
  let acknowledgeClosed = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    acknowledgeReady = resolve;
  });
  const whenClosed = new Promise<void>((resolve) => {
    acknowledgeClosed = resolve;
  });
  const spawnImpl: OsSpawnFn = () => {
    const created = spawn(
      process.execPath,
      ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
      },
    );
    child = created;
    created.stdout?.once('data', () => acknowledgeReady());
    created.once('close', () => {
      closed = true;
      acknowledgeClosed();
    });
    return created;
  };
  const getChild = (): ChildProcess => {
    if (child === undefined) throw new Error('fixture native entry missing');
    return child;
  };
  return { spawnImpl, ready, whenClosed, isClosed: () => closed, getChild };
}

describe('OS helper actual native lifetime', () => {
  it('retains real errored helper ownership until native close instead of returning from error', async () => {
    const fixture = ownedFixture();
    const invocation = createCliInvocation();
    const nativeProcesses = nativeProcessesForInvocation(invocation);
    if (nativeProcesses === undefined) throw new Error('explicit invocation missing');
    const os = createNodeOsCapability({
      platform: 'linux',
      spawnImpl: fixture.spawnImpl,
      nativeProcesses,
    });
    const result = os
      .notify({ title: 'synthetic', body: 'synthetic' })
      .catch((cause: unknown) => cause);
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      fixture.getChild().kill('SIGKILL');
    }, 5000);
    try {
      await fixture.ready;
      expect(invocation.registry.activeOwners).toBe(1);
      fixture.getChild().emit('error', new Error('synthetic owned native fault'));
      const failure = await result;
      expect(failure).toBeInstanceOf(OsCapabilityError);
      expect(fixture.isClosed(), 'OS_NATIVE_ERROR_CLOSE_JOIN').toBe(true);
      expect(invocation.registry.activeOwners, 'OS_NATIVE_ERROR_CLOSE_JOIN').toBe(0);
      expect(watchdogFired, 'OS_NATIVE_ERROR_CANCEL').toBe(false);
    } finally {
      clearTimeout(watchdog);
      if (!fixture.isClosed()) fixture.getChild().kill('SIGKILL');
      await fixture.whenClosed;
      await result;
    }
  }, 10000);
});
