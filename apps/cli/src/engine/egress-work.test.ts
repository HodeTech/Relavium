import { describe, expect, it } from 'vitest';

import { EgressWorkScope, egressWorkEntryFailure } from './egress-work.js';

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('independently transferred egress work', () => {
  it('registers its own lifetime before any producer can enter and returns exact raw work', async () => {
    const held = deferred<void>();
    const admitted: Promise<unknown>[] = [];
    let entered = false;
    const scope = new EgressWorkScope({
      retainWork: (factory) => {
        expect(entered).toBe(false);
        const raw = factory();
        admitted.push(raw);
        return raw;
      },
    });
    const raw = scope.retainWork(() => {
      entered = true;
      return held.promise;
    });
    expect(raw).toBe(held.promise);
    expect(admitted).toEqual([scope.done]);
    scope.seal();
    expect(scope.isComplete).toBe(false);
    held.resolve();
    await scope.done;
    expect(scope.isComplete).toBe(true);
  });

  it('an empty unsealed producer cannot acknowledge future work', async () => {
    const scope = new EgressWorkScope();
    await Promise.resolve();
    expect(scope.isComplete).toBe(false);
    scope.seal();
    await scope.done;
    expect(scope.isComplete).toBe(true);
  });

  it('a transferred body child can admit pulls after its original fetch producer seals', async () => {
    const root = new EgressWorkScope();
    const body = root.fork();
    root.seal();
    const held = deferred<void>();
    void body.retainWork(() => held.promise);
    body.seal();
    expect(root.isComplete).toBe(false);
    held.resolve();
    await root.done;
    expect(body.isComplete).toBe(true);
  });

  it('a read result does not acknowledge an independent return or native-close tail', async () => {
    const root = new EgressWorkScope();
    const body = root.fork();
    const native = deferred<void>();
    const returned = deferred<void>();
    void root.retainWork(() => native.promise);
    void body.retainWork(() => returned.promise);
    await body.retainWork(() => Promise.resolve('headers'));
    root.seal();
    body.seal();
    expect(root.isComplete).toBe(false);
    native.resolve();
    await Promise.resolve();
    expect(root.isComplete).toBe(false);
    returned.resolve();
    await root.done;
  });

  it.each([false, true])(
    'preserves an opaque parent refusal (%s after registration) without reflection',
    async (after) => {
      let reflections = 0;
      let transferred: Promise<unknown> | undefined;
      const original = new Proxy(new Error('opaque host refusal'), {
        getPrototypeOf() {
          reflections += 1;
          throw new Error('private reflection tripwire');
        },
      });
      let failure: unknown;
      try {
        new EgressWorkScope({
          retainWork: (factory) => {
            if (after) transferred = factory();
            throw original;
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(egressWorkEntryFailure(failure)?.error).toBe(original);
      expect(reflections).toBe(0);
      if (after) await expect(transferred).resolves.toBeUndefined();
      else expect(transferred).toBeUndefined();
    },
  );

  it('a genuine synchronous factory fault retains identity and completes only its slot', async () => {
    const root = new EgressWorkScope();
    const original = new Error('producer fault');
    expect(() =>
      root.retainWork(() => {
        throw original;
      }),
    ).toThrow(original);
    expect(egressWorkEntryFailure(original)).toBeUndefined();
    root.seal();
    await root.done;
  });

  it('a rejected raw promise remains the owner rejection while actual settlement acknowledges lifetime', async () => {
    const root = new EgressWorkScope();
    const original = new Error('producer fault');
    const raw = Promise.reject(original);
    expect(root.retainWork(() => raw)).toBe(raw);
    root.seal();
    await expect(raw).rejects.toBe(original);
    await root.done;
  });

  it('ignores a caller-overridden then protocol and joins only native Promise settlement', async () => {
    const root = new EgressWorkScope();
    const held = deferred<void>();
    void Object.defineProperty(held.promise, 'then', {
      value: () => {
        throw new Error('spoofed then');
      },
    });
    void root.retainWork(() => held.promise);
    root.seal();
    expect(root.observationFailed).toBe(false);
    expect(root.isComplete).toBe(false);
    held.resolve();
    await root.done;
  });

  it('failed native observer setup cannot invent actual settlement or a positive close ACK', async () => {
    const root = new EgressWorkScope();
    const held = deferred<void>();
    void Object.defineProperty(held.promise, 'constructor', {
      get: () => {
        throw new Error('observer fault');
      },
    });
    expect(root.retainWork(() => held.promise)).toBe(held.promise);
    root.seal();
    held.resolve();
    await Promise.resolve();
    expect(root.observationFailed).toBe(true);
    expect(root.isComplete).toBe(false);
  });

  it('sealing is idempotent and refuses a fresh factory without invoking it', async () => {
    const root = new EgressWorkScope();
    root.seal();
    root.seal();
    await root.done;
    let entered = false;
    expect(() =>
      root.retainWork(() => {
        entered = true;
        return Promise.resolve();
      }),
    ).toThrow('egress work scope has ended');
    expect(() => root.fork()).toThrow();
    expect(entered).toBe(false);
    expect(root.isComplete).toBe(true);
  });
});
