import type { EgressDeps } from '@relavium/db';
import type { ToolHostCallOptions } from '@relavium/core';
import { expect, it } from 'vitest';
import { createNodeEgressCapability } from './egress.js';

function latch<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function tracking() {
  const raw: Promise<unknown>[] = [];
  const pending = new Set<Promise<unknown>>();
  const options: ToolHostCallOptions = {
    retainWork: <T>(factory: () => Promise<T>): Promise<T> => {
      const promise = factory();
      raw.push(promise);
      pending.add(promise);
      void promise.then(
        () => {
          pending.delete(promise);
        },
        () => {
          pending.delete(promise);
        },
      );
      return promise;
    },
  };
  return { options, raw, pending };
}
function throwHostFailure(original: unknown): never {
  throw original;
}
const request = { method: 'GET', url: 'https://api.example/x' } as const;

it('host entry refusal happens before credential resolution or DNS and needs no throwable reflection', () => {
  let reads = 0;
  let resolves = 0;
  let reflections = 0;
  const failure = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        reflections++;
        throw new Error('unexpected reflection');
      },
    },
  );
  const egress = createNodeEgressCapability({
    resolveCredential: () => {
      reads++;
      return Promise.resolve('synthetic');
    },
    deps: {
      resolveHost: () => {
        resolves++;
        return Promise.resolve(['203.0.113.10']);
      },
      openConnection: () => {
        throw new Error('unexpected connection');
      },
    },
  });
  let caught: unknown;
  try {
    void egress.fetch({ ...request, credentialRef: 'synthetic-ref' }, undefined, {
      retainWork: () => {
        return throwHostFailure(failure);
      },
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
  expect(reads).toBe(0);
  expect(resolves).toBe(0);
  expect(reflections).toBe(0);
});

it('a post-entry host refusal stays exact while the admitted credential producer remains owed', async () => {
  const credential = latch<string | undefined>();
  const entered = latch<void>();
  const t = tracking();
  const controller = new AbortController();
  let reflections = 0;
  let resolves = 0;
  const failure = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        reflections++;
        throw new Error('unexpected reflection');
      },
    },
  );
  const egress = createNodeEgressCapability({
    resolveCredential: () => {
      entered.resolve();
      return credential.promise;
    },
    deps: {
      resolveHost: () => {
        resolves++;
        return Promise.resolve(['203.0.113.10']);
      },
      openConnection: () => {
        throw new Error('unexpected connection');
      },
    },
  });
  let caught: unknown;
  try {
    void egress.fetch({ ...request, credentialRef: 'synthetic-ref' }, controller.signal, {
      retainWork: <T>(factory: () => Promise<T>): Promise<T> => {
        if (t.options.retainWork === undefined) throw new Error('missing retainer');
        void t.options.retainWork(factory);
        return throwHostFailure(failure);
      },
    });
  } catch (error) {
    caught = error;
  }
  try {
    await entered.promise;
    expect(caught).toBe(failure);
    expect(t.raw).toHaveLength(1);
    expect(t.pending.size).toBe(1);
    expect(reflections).toBe(0);
    controller.abort();
  } finally {
    controller.abort();
    credential.resolve(undefined);
    await Promise.allSettled(t.raw);
  }
  expect(t.pending.size).toBe(0);
  expect(resolves).toBe(0);
});

it('a bounded DNS timeout retains its raw operation and cannot dial on a late answer', async () => {
  const dns = latch<readonly string[]>();
  const entered = latch<void>();
  const t = tracking();
  let opens = 0;
  const deps: EgressDeps = {
    resolveHost: () => {
      entered.resolve();
      return dns.promise;
    },
    openConnection: () => {
      opens++;
      throw new Error('unexpected connection');
    },
  };
  const result = createNodeEgressCapability({ deps, timeoutMs: 2 }).fetch(
    request,
    undefined,
    t.options,
  );
  const rejected = expect(result).rejects.toMatchObject({ message: 'egress request timed out' });
  try {
    await entered.promise;
    await rejected;
    expect(t.raw).toHaveLength(2);
    expect(t.pending.size).toBe(1);
    expect(opens).toBe(0);
  } finally {
    dns.resolve(['203.0.113.10']);
    await Promise.allSettled(t.raw);
  }
  expect(t.pending.size).toBe(0);
  expect(opens).toBe(0);
});

it('a bounded body timeout keeps the admitted reader owed until its actual settlement', async () => {
  const body = latch<void>();
  const entered = latch<void>();
  const t = tracking();
  let opens = 0;
  let disposed = 0;
  const deps: EgressDeps = {
    resolveHost: () => Promise.resolve(['203.0.113.10']),
    openConnection: () => {
      opens++;
      return Promise.resolve({
        status: 200,
        location: undefined,
        body: (async function* () {
          entered.resolve();
          await body.promise;
          yield new TextEncoder().encode('late');
        })(),
        dispose: () => {
          disposed++;
        },
      });
    },
  };
  const result = createNodeEgressCapability({ deps, timeoutMs: 2 }).fetch(
    request,
    undefined,
    t.options,
  );
  const rejected = expect(result).rejects.toMatchObject({ message: 'egress request timed out' });
  try {
    await entered.promise;
    await rejected;
    expect(t.raw).toHaveLength(2);
    expect(t.pending.size).toBe(1);
    expect(opens).toBe(1);
  } finally {
    body.resolve();
    await Promise.allSettled(t.raw);
  }
  expect(t.pending.size).toBe(0);
  expect(opens).toBe(1);
  expect(disposed).toBe(1);
});

it('a nested connection-entry refusal is preserved without entering native work', async () => {
  const refusal = Object.freeze({ refused: 'connection' });
  let entries = 0;
  let nativeCalls = 0;
  const deps: EgressDeps = {
    resolveHost: () => Promise.resolve(['203.0.113.10']),
    openConnection: (_request, _signal, work) => {
      if (work?.retainWork === undefined) throw new Error('missing native work authority');
      return work.retainWork(() => {
        nativeCalls++;
        throw new Error('unexpected native work');
      });
    },
  };
  await expect(
    createNodeEgressCapability({ deps }).fetch(request, undefined, {
      retainWork: <T>(factory: () => Promise<T>): Promise<T> => {
        if (++entries === 3) return throwHostFailure(refusal);
        return factory();
      },
    }),
  ).rejects.toBe(refusal);
  expect(entries).toBe(3);
  expect(nativeCalls).toBe(0);
});
