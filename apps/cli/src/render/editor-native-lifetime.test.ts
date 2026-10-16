import { spawn, type ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCliInvocation } from '../process/invocation.js';
import { nativeProcessesForInvocation } from '../process/native-process-owner.js';
import { createNodeSpawnEditor } from './editor.js';

vi.mock('node:child_process', { spy: true });
const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
afterEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(native.spawn);
});

describe('foreground editor actual native lifetime', () => {
  it('requests cancellation on a real native error and retains ownership after the public rejection', async () => {
    const invocation = createCliInvocation();
    const nativeProcesses = nativeProcessesForInvocation(invocation);
    if (nativeProcesses === undefined) throw new Error('explicit invocation missing');
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
    vi.mocked(spawn).mockImplementationOnce((command, args, options) => {
      // Keep the exact production binary/argv/shell/detached choices. Capture a pipe only to acknowledge
      // the inert child's entry instead of opening a real terminal editor in the test runner.
      const created = native.spawn(command, args, {
        ...options,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child = created;
      created.stdout?.once('data', () => acknowledgeReady());
      created.once('close', () => {
        closed = true;
        acknowledgeClosed();
      });
      return created;
    });
    const getChild = (): ChildProcess => {
      if (child === undefined) throw new Error('fixture native entry missing');
      return child;
    };
    const result = createNodeSpawnEditor(nativeProcesses)(
      process.execPath,
      ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
      'synthetic-unused-file',
    ).catch((cause: unknown) => cause);
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      getChild().kill('SIGKILL');
    }, 5000);
    try {
      await ready;
      expect(invocation.registry.activeOwners).toBe(1);
      const fault = new Error('synthetic owned native fault');
      getChild().emit('error', fault);
      expect(await result).toBe(fault);
      expect(invocation.registry.activeOwners, 'EDITOR_ERROR_NOT_NATIVE_ACK').toBe(1);
      await whenClosed;
      const retirement = await invocation.registry.terminate({ kind: 'normal' });
      expect(retirement).toEqual({ kind: 'settled', unacknowledgedOwners: 0 });
      expect(invocation.registry.activeOwners).toBe(0);
      expect(watchdogFired, 'EDITOR_NATIVE_ERROR_CANCEL').toBe(false);
    } finally {
      clearTimeout(watchdog);
      if (!closed) getChild().kill('SIGKILL');
      await whenClosed;
      await result;
    }
  }, 10000);
});
