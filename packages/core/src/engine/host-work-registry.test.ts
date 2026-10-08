import { describe, expect, it, vi } from 'vitest';

import { EngineStateError } from './errors.js';
import { HostWorkRegistry, type HostWorkScope } from './host-work-registry.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('not initialized');
  };
  let reject: (error: unknown) => void = () => {
    throw new Error('not initialized');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function capture<T>(registry: HostWorkRegistry, raw: Promise<T>) {
  let captured: HostWorkScope | undefined;
  const promise = registry.invoke((scope) => {
    captured = scope;
    return raw;
  });
  if (captured === undefined) throw new Error('factory was not invoked synchronously');
  return { scope: captured, promise };
}

function watchJoin(registry: HostWorkRegistry) {
  let joined = false;
  const promise = registry.join().then(() => {
    joined = true;
  });
  return {
    promise,
    get joined() {
      return joined;
    },
  };
}

function expectEnded(scope: HostWorkScope): void {
  expect(scope.assertActive).toThrow(EngineStateError);
  try {
    scope.assertActive();
  } catch (error) {
    expect(error).toMatchObject({ code: 'receipt_scope_ended', runId: 'run-1' });
  }
  const enter = vi.fn(() => Promise.resolve());
  const transfer = vi.fn(() => Promise.resolve());
  expect(() => scope.enter(enter)).toThrow(EngineStateError);
  expect(() => scope.continue(transfer)).toThrow(EngineStateError);
  expect(enter).not.toHaveBeenCalled();
  expect(transfer).not.toHaveBeenCalled();
}

describe('HostWorkRegistry — structured receipt lifetimes (ADR-0103 foundation)', () => {
  it('registers before invoking the factory and observes the exact raw Promise before its caller', async () => {
    const registry = new HostWorkRegistry('run-1');
    const raw = deferred<number>();
    let scope: HostWorkScope | undefined;
    let idleAtFactoryEntry = true;
    const returned = registry.invoke((current) => {
      scope = current;
      idleAtFactoryEntry = registry.isIdle;
      current.assertActive();
      // The lifetime scope has no provider, effect-prepare, media or durable-write capability.
      expect(Object.keys(current).sort()).toEqual(['assertActive', 'continue', 'enter']);
      return raw.promise;
    });
    expect(idleAtFactoryEntry).toBe(false);
    expect(returned).toBe(raw.promise);
    const join = watchJoin(registry);
    expect(join.joined).toBe(false);
    raw.resolve(23);
    expect(await returned).toBe(23);
    expect(registry.isIdle).toBe(true);
    if (scope === undefined) throw new Error('missing scope');
    expectEnded(scope);
    await join.promise;
  });

  it('no-receipt idle join is already fulfilled, and a completed raw invocation needs no explicit release', async () => {
    const registry = new HostWorkRegistry('run-1');
    const idle = watchJoin(registry);
    await Promise.resolve(); // One reaction turn: an idle join has no internal wait to complete.
    expect(idle.joined).toBe(true);
    const raw = Promise.resolve('done');
    const invocation = capture(registry, raw);
    expect(invocation.promise).toBe(raw);
    await invocation.promise;
    expect(registry.isIdle).toBe(true);
    expectEnded(invocation.scope);
    await registry.join();
  });

  it('an abort/grace race ending does not end the held raw lifetime or its receipt authority', async () => {
    const registry = new HostWorkRegistry('run-1');
    const raw = deferred<string>();
    const grace = deferred<string>();
    const invocation = capture(registry, raw.promise);
    const race = Promise.race([invocation.promise, grace.promise]);
    const join = watchJoin(registry);
    grace.resolve('abandoned');
    expect(await race).toBe('abandoned');
    expect(registry.isIdle).toBe(false);
    expect(join.joined).toBe(false);
    await invocation.scope.enter(() => Promise.resolve('late incurred receipt'));
    expect(registry.isIdle).toBe(false);
    raw.resolve('late outcome');
    await invocation.promise;
    await join.promise;
    expectEnded(invocation.scope);
  });

  it('a never-settling raw Promise intentionally holds the host join without spinning or ending authority', async () => {
    const registry = new HostWorkRegistry('run-1');
    const never = new Promise<void>(() => undefined);
    const invocation = capture(registry, never);
    const join = watchJoin(registry);
    await invocation.scope.enter(() => Promise.resolve());
    expect(registry.isIdle).toBe(false);
    expect(join.joined).toBe(false);
    invocation.scope.assertActive();
  });

  it('a never-settling transferred child holds the host join after a receipt-free parent completes', async () => {
    const registry = new HostWorkRegistry('run-1');
    let child: HostWorkScope | undefined;
    await registry.invoke((parent) => {
      void parent.continue((scope) => {
        child = scope;
        return new Promise<void>(() => undefined);
      });
      return Promise.resolve();
    });
    const join = watchJoin(registry);
    if (child === undefined) throw new Error('missing child');
    await child.enter(() => Promise.resolve());
    expect(registry.isIdle).toBe(false);
    expect(join.joined).toBe(false);
    child.assertActive();
  });

  it('entered work survives raw settlement, but the ended original scope cannot enter or transfer again', async () => {
    const registry = new HostWorkRegistry('run-1');
    const raw = deferred<void>();
    const host = deferred<number>();
    const invocation = capture(registry, raw.promise);
    const entered = invocation.scope.enter(() => host.promise);
    expect(entered).toBe(host.promise);
    const firstJoin = watchJoin(registry);
    const secondJoin = watchJoin(registry);
    raw.resolve();
    await invocation.promise;
    expectEnded(invocation.scope);
    expect(registry.isIdle).toBe(false);
    expect(firstJoin.joined).toBe(false);
    expect(secondJoin.joined).toBe(false);
    host.resolve(7);
    expect(await entered).toBe(7);
    await Promise.all([firstJoin.promise, secondJoin.promise]);
    expect(registry.isIdle).toBe(true);
  });

  it('transferred and nested child scopes remain independently active after each parent ends', async () => {
    const registry = new HostWorkRegistry('run-1');
    const raw = deferred<void>();
    const childRaw = deferred<void>();
    const grandchildRaw = deferred<void>();
    const enteredRaw = deferred<void>();
    const parent = capture(registry, raw.promise);
    let child: HostWorkScope | undefined;
    const childPromise = parent.scope.continue((scope) => {
      child = scope;
      return childRaw.promise;
    });
    expect(childPromise).toBe(childRaw.promise);
    const join = watchJoin(registry);
    raw.resolve();
    await parent.promise;
    expectEnded(parent.scope);
    if (child === undefined) throw new Error('missing child');
    child.assertActive();
    let grandchild: HostWorkScope | undefined;
    const grandchildPromise = child.continue((scope) => {
      grandchild = scope;
      return grandchildRaw.promise;
    });
    childRaw.resolve();
    await childPromise;
    expectEnded(child);
    if (grandchild === undefined) throw new Error('missing grandchild');
    grandchild.assertActive();
    expect(registry.isIdle).toBe(false);
    expect(join.joined).toBe(false);
    const entered = grandchild.enter(() => enteredRaw.promise);
    grandchildRaw.resolve();
    await grandchildPromise;
    expectEnded(grandchild);
    expect(registry.isIdle).toBe(false);
    expect(join.joined).toBe(false);
    enteredRaw.resolve();
    await entered;
    await join.promise;
    expect(registry.isIdle).toBe(true);
  });

  it('a held child before first host entry keeps joining after its executor has settled', async () => {
    const registry = new HostWorkRegistry('run-1');
    const permitEntry = deferred<void>();
    const host = deferred<void>();
    const entered = deferred<void>();
    let childPromise: Promise<void> | undefined;
    const executor = registry.invoke((scope) => {
      childPromise = scope.continue(async (child) => {
        await permitEntry.promise;
        await child.enter(() => {
          entered.resolve();
          return host.promise;
        });
      });
      return Promise.resolve();
    });
    const join = watchJoin(registry);
    await executor;
    expect(registry.isIdle).toBe(false);
    expect(join.joined).toBe(false);
    permitEntry.resolve();
    await entered.promise;
    expect(join.joined).toBe(false);
    host.resolve();
    await childPromise;
    await join.promise;
    expect(registry.isIdle).toBe(true);
  });

  it('synchronous invocation throw ends its authority and retains already registered children and operations', async () => {
    const registry = new HostWorkRegistry('run-1');
    const failure = new Error('factory failed');
    const childRaw = deferred<void>();
    const hostRaw = deferred<void>();
    let original: HostWorkScope | undefined;
    let child: HostWorkScope | undefined;
    const returned = registry.invoke((scope) => {
      original = scope;
      void scope.continue((current) => {
        child = current;
        return childRaw.promise;
      });
      void scope.enter(() => hostRaw.promise);
      throw failure;
    });
    if (original === undefined || child === undefined) throw new Error('missing scopes');
    expectEnded(original);
    child.assertActive();
    await expect(returned).rejects.toBe(failure);
    const join = watchJoin(registry);
    childRaw.resolve();
    await childRaw.promise;
    expectEnded(child);
    expect(registry.isIdle).toBe(false);
    expect(join.joined).toBe(false);
    hostRaw.resolve();
    await join.promise;
  });

  it('rejected raw execution ends only its own scope and preserves its original rejection', async () => {
    const registry = new HostWorkRegistry('run-1');
    const raw = deferred<void>();
    const host = deferred<void>();
    const invocation = capture(registry, raw.promise);
    const entered = invocation.scope.enter(() => host.promise);
    const failure = new Error('raw rejection');
    const rejected = expect(invocation.promise).rejects.toBe(failure);
    raw.reject(failure);
    await rejected;
    expectEnded(invocation.scope);
    const join = watchJoin(registry);
    expect(registry.isIdle).toBe(false);
    expect(join.joined).toBe(false);
    host.resolve();
    await entered;
    await join.promise;
  });

  it('synchronous and asynchronous host failures finish only their entered calls, not the enclosing scope', async () => {
    const registry = new HostWorkRegistry('run-1');
    const raw = deferred<void>();
    const parent = capture(registry, raw.promise);
    const failure = new Error('host failure');
    await expect(
      parent.scope.enter(() => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    parent.scope.assertActive();
    const rejected = Promise.reject(failure);
    const returned = parent.scope.enter(() => rejected);
    expect(returned).toBe(rejected);
    await expect(returned).rejects.toBe(failure);
    parent.scope.assertActive();
    expect(registry.isIdle).toBe(false);
    raw.resolve();
    await parent.promise;
    await registry.join();
    expect(registry.isIdle).toBe(true);
  });

  it('child throw and rejection end the child, keep the parent active and remain visible to the owner', async () => {
    const registry = new HostWorkRegistry('run-1');
    const raw = deferred<void>();
    const parent = capture(registry, raw.promise);
    const failure = new Error('child failure');
    let throwingScope: HostWorkScope | undefined;
    await expect(
      parent.scope.continue((scope) => {
        throwingScope = scope;
        throw failure;
      }),
    ).rejects.toBe(failure);
    if (throwingScope === undefined) throw new Error('missing child');
    expectEnded(throwingScope);
    parent.scope.assertActive();
    let rejectedScope: HostWorkScope | undefined;
    const childRaw = Promise.reject(failure);
    const child = parent.scope.continue((scope) => {
      rejectedScope = scope;
      return childRaw;
    });
    expect(child).toBe(childRaw);
    await expect(child).rejects.toBe(failure);
    if (rejectedScope === undefined) throw new Error('missing child');
    expectEnded(rejectedScope);
    parent.scope.assertActive();
    raw.resolve();
    await parent.promise;
    await registry.join(); // Lifetime completion is not a money/effect durability verdict.
  });

  it('rechecks quiescence when another root is admitted after the idle notification, before join resumes', async () => {
    const registry = new HostWorkRegistry('run-1');
    const first = deferred<void>();
    const second = deferred<void>();
    const firstInvocation = capture(registry, first.promise);
    // Queued ahead of join's continuation, but after the registry's first raw settlement reaction.
    const secondInvocation = first.promise.then(() => registry.invoke(() => second.promise));
    const join = watchJoin(registry);
    first.resolve();
    await firstInvocation.promise;
    await Promise.resolve(); // Let the already-notified join perform its required recheck.
    await Promise.resolve(); // Then run watchJoin's reaction if that join incorrectly fulfilled.
    expect(registry.isIdle).toBe(false);
    expect(join.joined).toBe(false);
    second.resolve();
    await secondInvocation;
    await join.promise;
    expect(registry.isIdle).toBe(true);
  });

  it('reentrant factories register independently even when they return the same raw Promise', async () => {
    const registry = new HostWorkRegistry('run-1');
    const raw = deferred<void>();
    const scopes: HostWorkScope[] = [];
    const parent = registry.invoke((scope) => {
      scopes.push(scope);
      void scope.continue((child) => {
        scopes.push(child);
        void child.continue((grandchild) => {
          scopes.push(grandchild);
          return raw.promise;
        });
        return raw.promise;
      });
      return raw.promise;
    });
    const join = watchJoin(registry);
    expect(scopes).toHaveLength(3);
    expect(registry.isIdle).toBe(false);
    raw.resolve();
    await parent;
    for (const scope of scopes) expectEnded(scope);
    await join.promise;
    expect(registry.isIdle).toBe(true);
  });

  it('observes actual native settlement without reading or calling an overridden then', async () => {
    for (const override of ['getter', 'premature', 'attach-and-throw']) {
      const registry = new HostWorkRegistry('run-1');
      const raw = deferred<void>();
      let overrideCalls = 0;
      const honestObserver = raw.promise.then(() => undefined);
      if (override === 'getter') {
        void Object.defineProperty(raw.promise, 'then', {
          get: () => {
            overrideCalls += 1;
            throw new Error('private observer getter');
          },
        });
      } else {
        void Object.defineProperty(raw.promise, 'then', {
          value: (fulfilled: () => void) => {
            overrideCalls += 1;
            if (override === 'premature') fulfilled();
            else {
              void Promise.prototype.then.call(raw.promise, fulfilled);
              throw new Error('private observer setup failure');
            }
            return Promise.resolve();
          },
        });
      }
      const invocation = capture(registry, raw.promise);
      expect(invocation.promise).toBe(raw.promise);
      const join = watchJoin(registry);
      await Promise.resolve();
      expect(overrideCalls).toBe(0);
      expect(registry.observationFailed).toBe(false);
      expect(registry.isIdle).toBe(false);
      expect(join.joined).toBe(false);
      invocation.scope.assertActive();
      raw.resolve();
      await honestObserver;
      await join.promise;
      expectEnded(invocation.scope);
      expect(registry.isIdle).toBe(true);
      expect(overrideCalls).toBe(0);
    }
  });

  it('retains unobservable native raw work after constructor/species setup failure instead of certifying settlement', async () => {
    for (const rejected of [false, true]) {
      for (const failingProperty of ['constructor', 'species']) {
        const registry = new HostWorkRegistry('run-1');
        const raw = deferred<void>();
        let actuallySettled = false;
        const honestObserver = raw.promise.then(
          () => {
            actuallySettled = true;
          },
          () => {
            actuallySettled = true;
          },
        );
        const fail = () => {
          throw new Error('private promise constructor/species');
        };
        if (failingProperty === 'constructor')
          void Object.defineProperty(raw.promise, 'constructor', { get: fail });
        else {
          const constructor = {};
          Object.defineProperty(constructor, Symbol.species, { get: fail });
          void Object.defineProperty(raw.promise, 'constructor', { value: constructor });
        }
        const invocation = capture(registry, raw.promise);
        expect(invocation.promise).toBe(raw.promise);
        expect(registry.observationFailed).toBe(true);
        const join = watchJoin(registry);
        await Promise.resolve();
        expect(actuallySettled).toBe(false);
        expect(join.joined).toBe(false);
        expect(registry.isIdle).toBe(false);
        invocation.scope.assertActive();
        await invocation.scope.enter(() => Promise.resolve());
        const child = invocation.scope.continue(() => Promise.resolve());
        await child;
        expect(registry.isIdle).toBe(false);
        if (rejected) raw.reject(new Error('actual raw rejection'));
        else raw.resolve();
        await honestObserver;
        await Promise.resolve();
        expect(actuallySettled).toBe(true);
        // Honest external observation cannot confer an ACK on this registry's failed observer.
        expect(registry.observationFailed).toBe(true);
        expect(registry.isIdle).toBe(false);
        expect(join.joined).toBe(false);
      }
    }
  });
});
