import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { invocationFixture } from '../process/invocation.test-support.js';
import { SessionWorkOwner } from './session-work-owner.js';
import { withSessionReadline } from './session-readline.js';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const f = invocationFixture();
  const work = new SessionWorkOwner(f.invocation, 'chat', {
    cancel: () => {},
    cleanup: () => Promise.resolve(),
  });
  return { ...f, work, input: new PassThrough() };
}

describe('captured headless input lifetime', () => {
  it('joins native construction reentry before retiring input and never enters a stopped body', async () => {
    const f = fixture();
    const body = vi.fn(() => Promise.resolve());
    const unsubscribe = vi.fn();
    f.input.on('newListener', (event) => {
      if (event === 'end') f.work.stop();
    });
    try {
      const result = await f.work
        .enter(() => withSessionReadline(f.input, f.work, () => unsubscribe, body))
        .then(
          () => false,
          (cause: unknown) => f.work.isStoppedFailure(cause),
        );
      expect(result).toBe(true);
      await f.work.close();
      expect(body).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(f.input.listeners('data')).toEqual([]);
      expect(f.input.listeners('error')).toEqual([]);
      expect(f.input.listenerCount('end')).toBe(0);
      expect(f.input.isPaused()).toBe(true);
      expect(f.registry.activeOwners).toBe(0);
      expect(f.registry.observations.exitCode()).toBe(0);
    } finally {
      f.input.removeAllListeners();
      f.input.destroy();
    }
  });

  it('retains uncertain native removal through the original fatal deadline without granting host cleanup', async () => {
    const f = invocationFixture();
    const cleanup = vi.fn(() => Promise.resolve());
    const work = new SessionWorkOwner(f.invocation, 'chat', { cancel: () => {}, cleanup });
    const input = new PassThrough();
    const nativeRemove = input.removeListener.bind(input);
    input.removeListener = (event, listener) => {
      if (event === 'data') throw new Error('PRIVATE_NATIVE_REMOVAL_REFUSAL');
      return nativeRemove(event, listener);
    };
    input.on('newListener', (event) => {
      if (event === 'end') throw new Error('PRIVATE_PARTIAL_CONSTRUCTOR');
    });
    const unsubscribe = vi.fn();
    let settled = false;
    void work
      .enter(() =>
        withSessionReadline(
          input,
          work,
          () => unsubscribe,
          () => Promise.resolve(),
        ),
      )
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    try {
      await turn();
      expect(input.listenerCount('data')).toBe(1);
      expect(input.listenerCount('error')).toBe(0); // Independent removal is still attempted.
      expect(input.isPaused()).toBe(true);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(cleanup).not.toHaveBeenCalled();
      expect(f.registry.activeOwners).toBe(2);
      f.advance(3000);
      expect(await f.invocation.finiteExit.exited).toBe(9);
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
      expect(settled, 'HEADLESS_INPUT_REFUSAL_IS_NOT_RETIREMENT').toBe(false);
      expect(cleanup).not.toHaveBeenCalled();
      expect(f.registry.activeOwners).toBe(2);
    } finally {
      // Test-owned resource recovery does not resolve the product's refused retirement promise.
      input.removeListener = nativeRemove;
      input.removeAllListeners();
      input.destroy();
    }
  });

  it('holds actual driver continuation through stop, then removes late callbacks and pauses input', async () => {
    const f = fixture();
    const release = deferred<void>();
    const entered = deferred<void>();
    const late = vi.fn();
    const unsubscribe = vi.fn();
    const pending = f.work.enter(() =>
      withSessionReadline(
        f.input,
        f.work,
        () => unsubscribe,
        async () => {
          entered.resolve();
          await release.promise;
          // The readline facade is already sealed. The entered continuation can still touch
          // its captured native input; Node 24 correctly refuses reader.resume() after close.
          f.input.resume();
          f.input.on('data', late);
          expect(f.input.isPaused(), 'LATE_DRIVER_ACTUALLY_RESUMED_NATIVE_INPUT').toBe(false);
          expect(f.input.listeners('data')).toContain(late);
          return 'finished';
        },
      ),
    );
    try {
      await entered.promise;
      f.invocation.finiteExit.signal(15);
      await turn();
      expect(f.registry.activeOwners, 'HEADLESS_INPUT_RETAINS_ENTERED_CONTINUATION').toBe(2);
      expect(unsubscribe).not.toHaveBeenCalled();
      release.resolve();
      expect(await pending).toBe('finished');
      await f.work.close();
      expect(f.input.listeners('data')).toEqual([]);
      expect(f.input.isPaused()).toBe(true);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(f.registry.activeOwners).toBe(0);
    } finally {
      release.resolve();
      await pending.catch(() => {});
      await f.work.close();
      f.input.removeAllListeners();
      f.input.destroy();
    }
  });

  it('releases independently owed input after a subscription cleanup fault without replacing the body fault', async () => {
    const f = fixture();
    const primary = new Error('PRIVATE_DRIVER_FAILURE');
    const cleanup = new Error('PRIVATE_UNSUBSCRIBE_FAILURE');
    try {
      await expect(
        f.work.enter(() =>
          withSessionReadline(
            f.input,
            f.work,
            () => () => {
              throw cleanup;
            },
            () => Promise.reject(primary),
          ),
        ),
      ).rejects.toBe(primary);
      await f.work.close();
      expect(f.input.listeners('data')).toEqual([]);
      expect(f.input.listeners('error')).toEqual([]);
      expect(f.input.isPaused()).toBe(true);
      expect(f.registry.activeOwners).toBe(0);
      expect(f.registry.observations.exitCode()).toBe(9);
    } finally {
      f.input.removeAllListeners();
      f.input.destroy();
    }
  });

  it('does not wait for a nonexistent constructor when an ownerless subscription refuses', async () => {
    const input = new PassThrough();
    const primary = new Error('PRIVATE_SUBSCRIPTION_FAILURE');
    const body = vi.fn(() => Promise.resolve());
    await expect(
      withSessionReadline(
        input,
        undefined,
        () => {
          throw primary;
        },
        body,
      ),
    ).rejects.toBe(primary);
    expect(body).not.toHaveBeenCalled();
    expect(input.listenerCount('data')).toBe(0);
    input.destroy();
  });
});
