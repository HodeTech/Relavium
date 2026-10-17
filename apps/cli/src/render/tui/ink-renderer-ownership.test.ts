import { describe, expect, it, vi } from 'vitest';
import type { RunRenderer } from '../renderer.js';
import { createInkRenderer } from './ink-renderer.js';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe('Ink construction custody and permanent shutdown seal', () => {
  it('pre-adopts the native owner before a partially allocating mount can throw', async () => {
    let owner: Pick<RunRenderer, 'seal' | 'releaseInput'> | undefined;
    let ownedBeforeMount = false;
    const mount = vi.fn(() => {
      ownedBeforeMount = typeof owner?.releaseInput === 'function';
      throw new Error('PRIVATE_INK_CONSTRUCTION');
    });
    expect(() =>
      createInkRenderer({
        color: false,
        mount,
        creation: {
          acknowledgeNoAcquisition: () => {
            throw new Error('Ink cannot attest no acquisition.');
          },
          adopt: (value) => {
            owner = value;
          },
        },
      }),
    ).toThrow('PRIVATE_INK_CONSTRUCTION');
    expect(ownedBeforeMount, 'INK_PREENTRY_CUSTODY').toBe(true);
    expect(mount).toHaveBeenCalledOnce();
    let released = false;
    owner?.seal?.();
    void Promise.resolve(owner?.releaseInput?.()).then(() => {
      released = true;
    });
    await turn();
    expect(released).toBe(false); // A construction throw and absent handle are not native ACK.
  });
  it('retains an unacknowledged remount instead of treating missing instance as released', async () => {
    let mounts = 0;
    const renderer = createInkRenderer({
      color: false,
      mount: () => {
        if (++mounts === 2) throw new Error('PRIVATE_REMOUNT');
        return { unmount: () => undefined, waitUntilExit: () => Promise.resolve() };
      },
    });
    await renderer.suspend?.();
    expect(() => renderer.resume?.()).toThrow('PRIVATE_REMOUNT');
    let released = false;
    renderer.seal?.();
    void Promise.resolve(renderer.releaseInput?.()).then(() => {
      released = true;
    });
    await turn();
    expect(released).toBe(false);
    expect(mounts).toBe(2);
  });
  it('attempts unmount even when acquiring waitUntilExit itself throws, then requires both actual ACKs on retry', async () => {
    const unmount = vi.fn();
    const waitUntilExit = vi
      .fn(() => Promise.resolve())
      .mockImplementationOnce(() => {
        throw new Error('ACK setup failed');
      });
    const renderer = createInkRenderer({ color: false, mount: () => ({ unmount, waitUntilExit }) });
    renderer.seal?.();
    await expect(renderer.releaseInput?.()).rejects.toThrow('ACK setup failed');
    expect(unmount).toHaveBeenCalledOnce();
    await renderer.releaseInput?.();
    expect(unmount).toHaveBeenCalledTimes(2);
    expect(waitUntilExit).toHaveBeenCalledTimes(2);
  });
  it('seals event rendering, notices, remount and summary while preserving actual input release', async () => {
    const life = deferred();
    const unmount = vi.fn();
    const mount = vi.fn(() => ({ unmount, waitUntilExit: () => life.promise }));
    const summary = vi.fn();
    const notice = vi.fn();
    const renderer = createInkRenderer({
      color: false,
      mount,
      writeSummary: summary,
      writeTerminalNotice: notice,
    });
    renderer.seal?.();
    renderer.onEvent({
      type: 'run:cancelled',
      runId: 'sealed',
      timestamp: '2026-10-16T00:00:00Z',
      sequenceNumber: 1,
    });
    await renderer.resume?.();
    let finalized = false;
    const done = Promise.resolve(renderer.finalize?.()).then(() => {
      finalized = true;
    });
    await turn();
    expect(mount).toHaveBeenCalledOnce();
    expect(unmount).toHaveBeenCalledOnce();
    expect(notice).not.toHaveBeenCalled();
    expect(summary).not.toHaveBeenCalled();
    expect(finalized).toBe(false);
    life.resolve();
    await done;
    expect(summary).not.toHaveBeenCalled();
  });
});
