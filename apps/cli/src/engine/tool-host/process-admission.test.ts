import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostCapabilityError } from './errors.js';
import { createNodeProcessCapability } from './process.js';

vi.mock('node:fs/promises', { spy: true });
const nativeFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let workspace: string;
beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'relavium-process-admission-')));
});
afterEach(async () => {
  vi.mocked(realpath).mockReset();
  vi.mocked(realpath).mockImplementation(nativeFs.realpath);
  await rm(workspace, { recursive: true, force: true });
});

function start(signal: AbortSignal, cwd?: string): Promise<unknown> {
  return createNodeProcessCapability({ workspaceDir: workspace }).spawn(
    process.execPath,
    ['-e', 'require("node:fs").writeFileSync("spawned", "unexpected")'],
    {},
    cwd === undefined ? {} : { cwd },
    signal,
  );
}

async function assertRefused(call: Promise<unknown>, marker: string): Promise<void> {
  await expect(call).rejects.toBeInstanceOf(HostCapabilityError);
  await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('native process entry after asynchronous resolution (ADR-0103)', () => {
  it('does not spawn when cancellation lands during executable resolution', async () => {
    const controller = new AbortController();
    const call = start(controller.signal);
    controller.abort();
    await assertRefused(call, join(workspace, 'spawned'));
  });

  it('does not spawn when cancellation lands during workspace canonicalization', async () => {
    const entered = deferred();
    const release = deferred();
    vi.mocked(realpath).mockImplementationOnce(async (path) => {
      entered.resolve();
      await release.promise;
      return nativeFs.realpath(path);
    });
    const controller = new AbortController();
    const call = start(controller.signal);
    try {
      await entered.promise;
      controller.abort();
    } finally {
      release.resolve();
    }
    await assertRefused(call, join(workspace, 'spawned'));
  });

  it('does not spawn when cancellation lands during the selected cwd canonicalization', async () => {
    const cwd = join(workspace, 'nested');
    await mkdir(cwd);
    const entered = deferred();
    const release = deferred();
    vi.mocked(realpath).mockImplementationOnce(nativeFs.realpath);
    vi.mocked(realpath).mockImplementationOnce(async (path) => {
      entered.resolve();
      await release.promise;
      return nativeFs.realpath(path);
    });
    const controller = new AbortController();
    const call = start(controller.signal, cwd);
    try {
      await entered.promise;
      controller.abort();
    } finally {
      release.resolve();
    }
    await assertRefused(call, join(cwd, 'spawned'));
  });
});
