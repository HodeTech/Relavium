import { invocationFixture } from '../process/invocation.test-support.js';
import { SessionWorkOwner } from '../chat/session-work-owner.js';
import { spawn, type ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { nativeProcessesForInvocation } from '../process/native-process-owner.js';
import { createNodeSpawnEditor } from './editor.js';

vi.mock('node:child_process', { spy: true });
const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
afterEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(native.spawn);
});

describe('foreground editor actual native lifetime', () => {
  it.each(['ENOENT', 'EACCES', 'unknown'])(
    'observes actual native %s before presentation and retains child ownership after public rejection',
    async (code) => {
      const { invocation } = invocationFixture();
      const owner = new SessionWorkOwner(invocation, 'chat', {
        cancel: () => {},
        cleanup: () => Promise.resolve(),
      });
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
      const result = createNodeSpawnEditor(nativeProcesses, owner.failure)(
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
        expect(invocation.registry.activeOwners).toBe(2);
        const fault = Object.assign(new Error('synthetic owned native fault'), { code });
        getChild().emit('error', fault);
        expect(await result).toBe(fault);
        expect(
          invocation.registry.activeOwners,
          'EDITOR_ERROR_NOT_NATIVE_ACK',
        ).toBeGreaterThanOrEqual(1);
        expect(invocation.registry.observations.hasInfrastructureFailure()).toBe(
          code === 'unknown',
        );
        expect(owner.firstFailure?.cause).toBe(code === 'unknown' ? fault : undefined);
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
        await owner.close();
      }
    },
    10000,
  );
});

it('a stop between reservation and actual spawn is not promoted to an unexpected native fault', async () => {
  const f = invocationFixture();
  const actual = nativeProcessesForInvocation(f.invocation);
  if (actual === undefined) throw new Error('missing native controller');
  const owner = new SessionWorkOwner(f.invocation, 'chat', {
    cancel: () => {},
    cleanup: () => Promise.resolve(),
  });
  const result = createNodeSpawnEditor(
    {
      reserve: async (kind) => {
        const native = await actual.reserve(kind);
        f.invocation.finiteExit.signal(15);
        return native;
      },
      observeMcp: actual.observeMcp,
    },
    owner.failure,
  )('must-not-spawn', [], 'unused').catch((cause: unknown) => cause);
  await result;
  await owner.close();
  await f.registry.termination;
  expect(spawn).not.toHaveBeenCalled();
  expect(owner.firstFailure).toBeUndefined();
  expect(f.registry.observations.hasInfrastructureFailure()).toBe(false);
  expect(f.registry.activeOwners).toBe(0);
});

it.each(['ENOENT', 'EACCES', 'unknown'])(
  'synchronous actual spawn %s keeps its native origin disposition',
  async (code) => {
    const f = invocationFixture();
    const owner = new SessionWorkOwner(f.invocation, 'chat', {
      cancel: () => {},
      cleanup: () => Promise.resolve(),
    });
    const cause = Object.assign(new TypeError('PRIVATE_SPAWN_FAULT'), { code });
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw cause;
    });
    const observed = await createNodeSpawnEditor(
      nativeProcessesForInvocation(f.invocation),
      owner.failure,
    )('must-not-spawn', [], 'unused').catch((failure: unknown) => failure);
    expect(observed).toBe(cause);
    expect(f.registry.observations.hasInfrastructureFailure()).toBe(code === 'unknown');
    await owner.close();
    await f.registry.termination;
    expect(f.registry.activeOwners).toBe(0);
  },
);
