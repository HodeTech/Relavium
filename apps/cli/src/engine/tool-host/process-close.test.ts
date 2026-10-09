import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNodeProcessCapability, ProcessCapabilityError } from './process.js';

vi.mock('node:child_process', { spy: true });
const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
let workspace: string;
beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'relavium-process-close-')));
});
afterEach(async () => {
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(native.spawn);
  await rm(workspace, { recursive: true, force: true });
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function captureChild(): {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  readonly child: () => ChildProcess;
  readonly isClosed: () => boolean;
} {
  const ready = deferred();
  const closed = deferred();
  let child: ChildProcess | undefined;
  let isClosed = false;
  vi.mocked(spawn).mockImplementationOnce((command, args, options) => {
    child = native.spawn(command, args, options);
    child.stdout?.once('data', () => ready.resolve());
    child.once('close', () => {
      isClosed = true;
      closed.resolve();
    });
    return child;
  });
  return {
    ready: ready.promise,
    closed: closed.promise,
    child: () => {
      if (child === undefined) throw new Error('native child was not started');
      return child;
    },
    isClosed: () => isClosed,
  };
}

async function stopAndJoin(capture: ReturnType<typeof captureChild>): Promise<void> {
  if (!capture.isClosed()) capture.child().kill('SIGKILL');
  await capture.closed;
}

function start(signal?: AbortSignal): Promise<unknown> {
  return createNodeProcessCapability({ workspaceDir: workspace }).spawn(
    process.execPath,
    ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 30000)'],
    {},
    {},
    signal,
  );
}

describe('native child resource lifetime after an error (ADR-0103)', () => {
  it('rejects only after the actual native child and stdio close', async () => {
    const capture = captureChild();
    const call = start().catch((error: unknown) => error);
    try {
      await capture.ready;
      // Inject a native API fault on a REAL running child. No fake child, close event or timer ACK.
      capture.child().emit('error', new Error('synthetic native fault'));
      const error = await call;
      expect(error).toBeInstanceOf(ProcessCapabilityError);
      expect(capture.isClosed()).toBe(true);
    } finally {
      await stopAndJoin(capture);
    }
  });

  it('keeps cancellation precedence and joins close when an error also arrives', async () => {
    const capture = captureChild();
    const controller = new AbortController();
    const call = start(controller.signal).catch((error: unknown) => error);
    try {
      await capture.ready;
      controller.abort();
      capture.child().emit('error', new Error('synthetic native fault'));
      const error = await call;
      expect(error).toBeInstanceOf(ProcessCapabilityError);
      expect(error).toMatchObject({ message: 'the command was aborted' });
      expect(capture.isClosed()).toBe(true);
    } finally {
      await stopAndJoin(capture);
    }
  });

  it('joins the actual failed-spawn close and preserves the fixed failure reason', async () => {
    let closed = false;
    vi.mocked(spawn).mockImplementationOnce((command, args, options) => {
      const child = native.spawn(command, args, options);
      child.once('close', () => {
        closed = true;
      });
      return child;
    });
    const error: unknown = await createNodeProcessCapability({ workspaceDir: workspace })
      .spawn(join(workspace, 'absent-executable'), [], {}, {})
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProcessCapabilityError);
    expect(error).toMatchObject({ message: 'the command failed to run' });
    expect(closed).toBe(true);
  });
});
