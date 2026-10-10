import { describe, expect, it } from 'vitest';
import {
  SafeEgressError,
  type EgressDeps,
  type EgressWorkOptions,
  type HopRequest,
  type HopResponse,
} from '@relavium/db';

import { createValidatedFetch } from './validated-fetch.js';

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
const empty = async function* (): AsyncIterable<Uint8Array> {};

function response(overrides: Partial<HopResponse> = {}): HopResponse {
  return { status: 204, location: undefined, body: empty(), dispose: () => {}, ...overrides };
}

function observer(): {
  readonly work: { readonly retainWork: <T>(factory: () => Promise<T>) => Promise<T> };
  readonly admitted: Promise<unknown>[];
  readonly isComplete: () => boolean;
} {
  const admitted: Promise<unknown>[] = [];
  let complete = false;
  return {
    work: {
      retainWork: (factory) => {
        const raw = factory();
        admitted.push(raw);
        void raw.then(
          () => {
            complete = true;
          },
          () => {
            complete = true;
          },
        );
        return raw;
      },
    },
    admitted,
    isComplete: () => complete,
  };
}

describe('validated provider fetch descendant lifetime', () => {
  it('refuses pre-aborted entry before any normalize, DNS, native or lifetime transfer', async () => {
    let entries = 0;
    const observed = observer();
    const deps: EgressDeps = {
      resolveHost: () => {
        entries += 1;
        return Promise.resolve(['93.184.216.34']);
      },
      openConnection: () => {
        entries += 1;
        return Promise.resolve(response());
      },
    };
    const abort = new AbortController();
    abort.abort();
    await expect(
      createValidatedFetch(deps)(
        'https://fixture.example',
        { signal: abort.signal },
        observed.work,
      ),
    ).rejects.toThrow('cancelled');
    expect(entries).toBe(0);
    expect(observed.admitted).toHaveLength(0);
  });

  it('public cancellation does not acknowledge held body normalization or admit native I/O later', async () => {
    const normalize = deferred<void>();
    const started = deferred<void>();
    const observed = observer();
    let entries = 0;
    const deps: EgressDeps = {
      resolveHost: () => {
        entries += 1;
        return Promise.resolve(['93.184.216.34']);
      },
      openConnection: () => {
        entries += 1;
        return Promise.resolve(response());
      },
    };
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        started.resolve();
        await normalize.promise;
        controller.enqueue(new TextEncoder().encode('fixture'));
        controller.close();
      },
    });
    const abort = new AbortController();
    const pending = createValidatedFetch(deps)(
      'https://fixture.example',
      { method: 'POST', body, signal: abort.signal },
      observed.work,
    );
    await started.promise;
    await tick();
    abort.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(observed.isComplete()).toBe(false);
    normalize.resolve();
    await Promise.all(observed.admitted);
    expect(entries).toBe(0);
  });

  it('public cancellation keeps raw DNS joined and prevents post-DNS native entry', async () => {
    const dns = deferred<readonly string[]>();
    const entered = deferred<void>();
    const observed = observer();
    let sockets = 0;
    const deps: EgressDeps = {
      resolveHost: () => {
        entered.resolve();
        return dns.promise;
      },
      openConnection: () => {
        sockets += 1;
        return Promise.resolve(response());
      },
    };
    const abort = new AbortController();
    const pending = createValidatedFetch(deps)(
      'https://fixture.example',
      { signal: abort.signal },
      observed.work,
    );
    await entered.promise;
    abort.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(observed.isComplete()).toBe(false);
    dns.resolve(['93.184.216.34']);
    await Promise.all(observed.admitted);
    expect(sockets).toBe(0);
  });

  it('request retirement also reaches a fresh SDK RequestInit with its own live signal', async () => {
    const dns = deferred<readonly string[]>();
    const entered = deferred<void>();
    const observed = observer();
    let sockets = 0;
    const retire = new AbortController();
    const sdk = new AbortController();
    const deps: EgressDeps = {
      resolveHost: () => {
        entered.resolve();
        return dns.promise;
      },
      openConnection: () => {
        sockets += 1;
        return Promise.resolve(response());
      },
    };
    const pending = createValidatedFetch(deps)(
      'https://fixture.example',
      { signal: sdk.signal },
      { ...observed.work, signal: retire.signal },
    );
    await entered.promise;
    retire.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(sdk.signal.aborted).toBe(false);
    dns.resolve(['93.184.216.34']);
    await Promise.all(observed.admitted);
    expect(sockets).toBe(0);
  });

  it('a retired request cannot invalidate another request using the same reusable fetch', async () => {
    const dns = deferred<readonly string[]>();
    const entered = deferred<void>();
    let resolutions = 0;
    let sockets = 0;
    const deps: EgressDeps = {
      resolveHost: () => {
        resolutions += 1;
        if (resolutions === 1) {
          entered.resolve();
          return dns.promise;
        }
        return Promise.resolve(['93.184.216.34']);
      },
      openConnection: () => {
        sockets += 1;
        return Promise.resolve(response());
      },
    };
    const fetch = createValidatedFetch(deps);
    const first = observer();
    const second = observer();
    const abort = new AbortController();
    const a = fetch('https://fixture.example/a', { signal: abort.signal }, first.work);
    await entered.promise;
    abort.abort();
    await expect(a).rejects.toThrow('cancelled');
    expect((await fetch('https://fixture.example/b', undefined, second.work)).status).toBe(204);
    await Promise.all(second.admitted);
    expect(second.isComplete()).toBe(true);
    expect(first.isComplete()).toBe(false);
    dns.resolve(['93.184.216.34']);
    await Promise.all(first.admitted);
    expect(sockets).toBe(1);
  });

  it('headers and Web Streams cancellation do not acknowledge independent next, return or native-close holds', async () => {
    const next = deferred<IteratorResult<Uint8Array>>();
    const returned = deferred<IteratorResult<Uint8Array>>();
    const closed = deferred<void>();
    let reads = 0;
    let returns = 0;
    let disposals = 0;
    const observed = observer();
    const abort = new AbortController();
    const iterator: AsyncIterator<Uint8Array> = {
      next: () => {
        reads += 1;
        return next.promise;
      },
      return: () => {
        returns += 1;
        return returned.promise;
      },
    };
    const deps: EgressDeps = {
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      openConnection: (_request, _signal, work) => {
        void work?.retainWork?.(() => closed.promise);
        return Promise.resolve(
          response({
            status: 200,
            body: { [Symbol.asyncIterator]: () => iterator },
            dispose: () => {
              disposals += 1;
            },
          }),
        );
      },
    };
    const result = await createValidatedFetch(deps)(
      'https://fixture.example',
      { signal: abort.signal },
      observed.work,
    );
    await tick();
    expect(observed.isComplete()).toBe(false);
    expect(reads).toBe(1);
    await result.body?.cancel();
    abort.abort();
    expect(returns).toBe(1);
    expect(disposals).toBe(1);
    next.resolve({ done: false, value: new Uint8Array([1]) });
    closed.resolve();
    await tick();
    expect(observed.isComplete()).toBe(false);
    expect(reads).toBe(1);
    returned.resolve({ done: true, value: undefined });
    await Promise.all(observed.admitted);
  });

  it('a completed SDK body still owes its actual transport close acknowledgement', async () => {
    const closed = deferred<void>();
    const observed = observer();
    const deps: EgressDeps = {
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      openConnection: (_request, _signal, work) => {
        void work?.retainWork?.(() => closed.promise);
        return Promise.resolve(
          response({
            status: 200,
            body: (async function* () {
              await Promise.resolve();
              yield new TextEncoder().encode('fixture');
            })(),
          }),
        );
      },
    };
    const result = await createValidatedFetch(deps)(
      'https://fixture.example',
      undefined,
      observed.work,
    );
    expect(await result.text()).toBe('fixture');
    expect(observed.isComplete()).toBe(false);
    closed.resolve();
    await Promise.all(observed.admitted);
  });

  it.each([204, 200])(
    'an SDK-skipped null/empty body (%s) creates no pull and still retains native close',
    async (status) => {
      const closed = deferred<void>();
      const observed = observer();
      let iterators = 0;
      let disposed = 0;
      const deps: EgressDeps = {
        resolveHost: () => Promise.resolve(['93.184.216.34']),
        openConnection: (_request, _signal, work) => {
          void work?.retainWork?.(() => closed.promise);
          return Promise.resolve(
            response({
              status,
              headers: { 'content-length': '0' },
              body: {
                [Symbol.asyncIterator]: () => {
                  iterators += 1;
                  return { next: () => Promise.resolve({ done: true, value: undefined }) };
                },
              },
              dispose: () => {
                disposed += 1;
              },
            }),
          );
        },
      };
      const result = await createValidatedFetch(deps)(
        'https://fixture.example',
        undefined,
        observed.work,
      );
      expect(await result.text()).toBe('');
      expect(iterators).toBe(0);
      expect(disposed).toBe(1);
      expect(observed.isComplete()).toBe(false);
      closed.resolve();
      await Promise.all(observed.admitted);
    },
  );

  it('invalid response headers are rejected before an eager body is created and dispose native work', async () => {
    const closed = deferred<void>();
    const observed = observer();
    let iterators = 0;
    let disposed = 0;
    const deps: EgressDeps = {
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      openConnection: (_request, _signal, work) => {
        void work?.retainWork?.(() => closed.promise);
        return Promise.resolve(
          response({
            status: 200,
            headers: { bad: 'private\r\nheader' },
            body: {
              [Symbol.asyncIterator]: () => {
                iterators += 1;
                return { next: () => Promise.resolve({ done: true, value: undefined }) };
              },
            },
            dispose: () => {
              disposed += 1;
            },
          }),
        );
      },
    };
    await expect(
      createValidatedFetch(deps)('https://fixture.example', undefined, observed.work),
    ).rejects.toThrow('could not be mapped');
    expect(iterators).toBe(0);
    expect(disposed).toBe(1);
    expect(observed.isComplete()).toBe(false);
    closed.resolve();
    await Promise.all(observed.admitted);
  });

  it.each([false, true])(
    'preserves the original opaque parent refusal (%s post-transfer) without starting DNS',
    async (post) => {
      let reflections = 0;
      let dns = 0;
      let retained: Promise<unknown> | undefined;
      const original = new Proxy(new Error('opaque host refusal'), {
        getPrototypeOf() {
          reflections += 1;
          throw new Error('private reflection tripwire');
        },
      });
      const deps: EgressDeps = {
        resolveHost: () => {
          dns += 1;
          return Promise.resolve(['93.184.216.34']);
        },
        openConnection: () => Promise.resolve(response()),
      };
      const failure = await createValidatedFetch(deps)('https://fixture.example', undefined, {
        retainWork: (factory) => {
          if (post) retained = factory();
          throw original;
        },
      }).catch((error: unknown) => error);
      expect(failure).toBe(original);
      expect(reflections).toBe(0);
      expect(dns).toBe(0);
      if (post) await expect(retained).resolves.toBeUndefined();
    },
  );

  it('materializes a FormData boundary with the body from the same normalizer', async () => {
    let request: HopRequest | undefined;
    const deps: EgressDeps = {
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      openConnection: (hop) => {
        request = hop;
        return Promise.resolve(response());
      },
    };
    const body = new FormData();
    body.set('prompt', 'synthetic-video-prompt');
    await createValidatedFetch(deps)('https://fixture.example', { method: 'POST', body });
    const contentType = request?.headers?.['content-type'];
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    const boundary = contentType?.split('boundary=')[1];
    expect(request?.body).toContain(`--${boundary}\r\n`);
    expect(request?.body).toContain('synthetic-video-prompt');
  });
});

describe('validated fetch trusted retainer receiver', () => {
  it('preserves a method-style lifetime owner and retains its native descendant', async () => {
    const native = deferred<void>();
    const admitted: Promise<unknown>[] = [];
    const authority = {
      admitted,
      retainWork<T>(factory: () => Promise<T>): Promise<T> {
        const raw = factory();
        this.admitted.push(raw);
        return raw;
      },
    };
    const fetch = createValidatedFetch({
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      openConnection: (_request, _signal, work) => {
        void work?.retainWork?.(() => native.promise);
        return Promise.resolve(response());
      },
    });
    try {
      expect((await fetch('https://fixture.example', undefined, authority)).status).toBe(204);
      expect(authority.admitted).toHaveLength(1);
      let complete = false;
      const joined = Promise.all(authority.admitted).then(() => {
        complete = true;
      });
      await tick();
      expect(complete).toBe(false);
      native.resolve();
      await joined;
      expect(complete).toBe(true);
    } finally {
      native.resolve();
    }
  });
});

describe('validated fetch retainer acquisition provenance', () => {
  it('preserves an opaque throwing getter without reflection or producer entry', async () => {
    let reflections = 0;
    let dns = 0;
    let connections = 0;
    const original = new Proxy(new Error('opaque getter refusal'), {
      get() {
        reflections += 1;
        throw new Error('opaque getter refusal reflected');
      },
      getPrototypeOf() {
        reflections += 1;
        throw new Error('opaque getter refusal reflected');
      },
    });
    const authority: EgressWorkOptions = {
      get retainWork(): NonNullable<EgressWorkOptions['retainWork']> {
        throw original;
      },
    };
    const fetch = createValidatedFetch({
      resolveHost: () => {
        dns += 1;
        return Promise.resolve(['93.184.216.34']);
      },
      openConnection: () => {
        connections += 1;
        return Promise.resolve(response());
      },
    });
    let failure: unknown;
    try {
      await fetch('https://fixture.example', undefined, authority);
    } catch (error) {
      failure = error;
    }
    expect(Object.is(failure, original)).toBe(true);
    expect(reflections).toBe(0);
    expect(dns).toBe(0);
    expect(connections).toBe(0);
  });

  it('selects a getter-backed method once and preserves its receiver and raw descendant', async () => {
    const native = deferred<void>();
    function retain<T>(
      this: { admitted: Promise<unknown>[] },
      factory: () => Promise<T>,
    ): Promise<T> {
      const raw = factory();
      this.admitted.push(raw);
      return raw;
    }
    const authority = {
      selected: 0,
      admitted: new Array<Promise<unknown>>(),
      get retainWork() {
        this.selected += 1;
        return retain;
      },
    };
    const fetch = createValidatedFetch({
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      openConnection: (_request, _signal, work) => {
        void work?.retainWork?.(() => native.promise);
        return Promise.resolve(response());
      },
    });
    try {
      expect((await fetch('https://fixture.example', undefined, authority)).status).toBe(204);
      expect(authority.selected).toBe(1);
      expect(authority.admitted).toHaveLength(1);
      let complete = false;
      const joined = Promise.all(authority.admitted).then(() => {
        complete = true;
      });
      await tick();
      expect(complete).toBe(false);
      native.resolve();
      await joined;
      expect(complete).toBe(true);
    } finally {
      native.resolve();
    }
  });

  it('keeps an entered resolver fault on the ordinary reason-only network boundary', async () => {
    const original = new Error('private resolver detail');
    const admitted: Promise<unknown>[] = [];
    const fetch = createValidatedFetch({
      resolveHost: () => {
        throw original;
      },
      openConnection: () => Promise.resolve(response()),
    });
    let failure: unknown;
    try {
      await fetch('https://fixture.example', undefined, {
        retainWork: (factory) => {
          const raw = factory();
          admitted.push(raw);
          return raw;
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(Object.is(failure, original)).toBe(false);
    expect(failure).toBeInstanceOf(SafeEgressError);
    expect(failure).toMatchObject({ code: 'network', message: 'egress request failed' });
    expect(admitted).toHaveLength(1);
    await Promise.all(admitted);
  });
});
