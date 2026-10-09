import { describe, expect, it } from 'vitest';
import { ProviderInvocationWork, retiringStream } from './invocation-work.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
function owner() {
  const admitted: Promise<unknown>[] = [];
  return {
    admitted,
    options: {
      retainWork: <T>(factory: () => Promise<T>): Promise<T> => {
        const raw = factory();
        admitted.push(raw);
        return raw;
      },
    },
  };
}

describe('invocation-local SDK producer lifetime', () => {
  it.each([false, true])(
    'keeps opaque parent refusal outside all SDK work (post entry=%s)',
    async (entered) => {
      let reflected = 0;
      const opaque = new Proxy(new Error('opaque host refusal'), {
        get() {
          reflected += 1;
          throw new Error('reflection');
        },
        getPrototypeOf() {
          reflected += 1;
          throw new Error('reflection');
        },
      });
      let admitted: Promise<unknown> | undefined;
      let seen: unknown;
      try {
        new ProviderInvocationWork(
          {
            retainWork: (factory) => {
              if (entered) admitted = factory();
              throw opaque;
            },
          },
          undefined,
        );
      } catch (error) {
        seen = error;
      }
      expect(Object.is(seen, opaque)).toBe(true);
      expect(reflected).toBe(0);
      if (admitted !== undefined) await admitted;
    },
  );

  it('keeps raw work and transport children joined after retirement and vetoes fresh fetches', async () => {
    const parent = owner();
    const work = new ProviderInvocationWork(parent.options, undefined);
    const sdk = deferred<void>();
    const transport = deferred<void>();
    expect(work.retainWork(() => sdk.promise)).toBe(sdk.promise);
    void work.retainWork(() => transport.promise);
    let complete = false;
    void work.done.then(() => {
      complete = true;
    });
    work.retire();
    await tick();
    expect(complete).toBe(false);
    let calls = 0;
    expect(() =>
      work.bindFetch(() => {
        calls += 1;
        return Promise.resolve(new Response());
      })('https://example.invalid'),
    ).toThrow('cancelled');
    sdk.resolve();
    await tick();
    expect(complete).toBe(false);
    transport.resolve();
    await work.done;
    expect(calls).toBe(0);
  });

  it('captures native Promise observation despite a forged then property', async () => {
    const work = new ProviderInvocationWork(undefined, undefined);
    const raw = deferred<void>();
    void Object.defineProperty(raw.promise, 'then', {
      value: () => {
        throw new Error('forged then');
      },
    });
    expect(work.retainWork(() => raw.promise)).toBe(raw.promise);
    work.retire();
    raw.resolve();
    await work.done;
  });

  it('observes actual native settlement after the Promise prototype is detached', async () => {
    const work = new ProviderInvocationWork(undefined, undefined);
    const broken = Promise.resolve();
    Object.setPrototypeOf(broken, null);
    // A real native Promise with detached prototype still has native settlement slots.
    void work.retainWork(() => broken);
    work.retire();
    await work.done;
  });

  it('requests stream retirement immediately while both raw next and return remain owed', async () => {
    const parent = owner();
    const next = deferred<IteratorResult<number>>();
    const returned = deferred<IteratorResult<number>>();
    let work: ProviderInvocationWork | undefined;
    let returns = 0;
    const stream = retiringStream<number>(async function* (setWork) {
      work = new ProviderInvocationWork(parent.options, undefined);
      setWork(work);
      try {
        yield* work.ownIterator({
          [Symbol.asyncIterator]: () => ({
            next: () => next.promise,
            return: () => {
              returns += 1;
              return returned.promise;
            },
          }),
        });
      } finally {
        work.retire();
      }
    });
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    await tick();
    const closing = iterator.return?.();
    expect(work?.signal.aborted).toBe(true);
    let complete = false;
    void parent.admitted[0]?.then(() => {
      complete = true;
    });
    next.resolve({ done: false, value: 1 });
    await pending;
    await tick();
    expect(returns).toBe(1);
    expect(complete).toBe(false);
    returned.resolve({ done: true, value: undefined });
    await closing;
    await Promise.all(parent.admitted);
  });

  it('owns actual iterator cleanup after a rejected raw read', async () => {
    const work = new ProviderInvocationWork(undefined, undefined);
    const returned = deferred<IteratorResult<number>>();
    let returns = 0;
    const iterator = work
      .ownIterator({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('SDK read')),
          return: () => {
            returns += 1;
            return returned.promise;
          },
        }),
      })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow('SDK read');
    work.retire();
    let complete = false;
    void work.done.then(() => {
      complete = true;
    });
    await tick();
    expect(returns).toBe(1);
    expect(complete).toBe(false);
    returned.resolve({ done: true, value: undefined });
    await work.done;
  });
});
