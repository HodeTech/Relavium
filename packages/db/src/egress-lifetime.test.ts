import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import {
  connectValidated,
  nodeEgressDeps,
  readBounded,
  SafeEgressError,
  withEgressTimeout,
  type EgressWorkOptions,
  type HopRequest,
} from './safe-egress.js';

vi.mock('node:http', async (original) => {
  const actual = await original<typeof import('node:http')>();
  return { ...actual, request: vi.fn(actual.request) };
});
function throwHostFailure(original: unknown): never {
  throw original;
}
function latch<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function tracking() {
  const pending = new Set<Promise<unknown>>();
  const raw: Promise<unknown>[] = [];
  const work: EgressWorkOptions = {
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
  return { work, raw, pending };
}

it('a DNS result after cancellation never opens a connection', async () => {
  const dns = latch<readonly string[]>();
  const entered = latch<void>();
  const controller = new AbortController();
  let opens = 0;
  const result = connectValidated(
    'https://api.example/x',
    { method: 'GET' },
    {
      resolveHost: () => {
        entered.resolve();
        return dns.promise;
      },
      openConnection: () => {
        opens++;
        throw new Error('unexpected dial');
      },
    },
    controller.signal,
  );
  const rejected = expect(result).rejects.toMatchObject({ code: 'network' });
  await entered.promise;
  controller.abort();
  dns.resolve(['203.0.113.10']);
  await rejected;
  expect(opens).toBe(0);
});
it('timeout returns while the exact raw DNS factory remains owed, then refuses late dial', async () => {
  const dns = latch<readonly string[]>();
  const entered = latch<void>();
  const t = tracking();
  let opens = 0;
  const result = withEgressTimeout(
    undefined,
    2,
    (signal, work) =>
      connectValidated(
        'https://api.example/x',
        { method: 'GET' },
        {
          resolveHost: () => {
            entered.resolve();
            return dns.promise;
          },
          openConnection: () => {
            opens++;
            throw new Error('unexpected dial');
          },
        },
        signal,
        work,
      ),
    t.work,
  );
  const rejected = expect(result).rejects.toMatchObject({
    code: 'network',
    message: 'egress request timed out',
  });
  try {
    await entered.promise;
    await rejected;
    expect(t.raw).toHaveLength(1);
    expect(t.pending.size).toBe(1);
    expect(opens).toBe(0);
  } finally {
    dns.resolve(['203.0.113.10']);
    await Promise.allSettled(t.raw);
  }
  expect(t.pending.size).toBe(0);
  expect(opens).toBe(0);
});
it('trusted pre-entry refusal is opaque and invokes no raw factory', async () => {
  let reflections = 0;
  let calls = 0;
  const failure = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        reflections++;
        throw new Error('unexpected reflection');
      },
    },
  );
  await expect(
    withEgressTimeout(
      undefined,
      100,
      () => {
        calls++;
        return Promise.resolve(1);
      },
      {
        retainWork: () => {
          return throwHostFailure(failure);
        },
      },
    ),
  ).rejects.toBe(failure);
  expect(calls).toBe(0);
  expect(reflections).toBe(0);
});
it('nested native-entry refusal keeps its exact cause while raw I/O failures stay redacted', async () => {
  const failure = Object.freeze({ refused: true });
  let entries = 0;
  let calls = 0;
  await expect(
    withEgressTimeout(
      undefined,
      100,
      async (_signal, work) => {
        await Promise.resolve();
        if (work?.retainWork === undefined) throw new Error('missing native retainer');
        return work.retainWork(() => {
          calls++;
          return Promise.resolve(1);
        });
      },
      {
        retainWork: <T>(factory: () => Promise<T>): Promise<T> => {
          if (++entries === 2) return throwHostFailure(failure);
          return factory();
        },
      },
    ),
  ).rejects.toBe(failure);
  expect(calls).toBe(0);
  await expect(
    withEgressTimeout(undefined, 100, () => Promise.reject(new Error('PRIVATE HOST'))),
  ).rejects.toEqual(new SafeEgressError('network', 'egress request failed'));
});

it('real native headers and dispose do not acknowledge owned request/body close', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.write('first');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing fixture port');
  const t = tracking();
  const controller = new AbortController();
  let response: Awaited<ReturnType<typeof connectValidated>> | undefined;
  try {
    response = await connectValidated(
      `http://127.0.0.1:${address.port}/x`,
      {
        method: 'GET',
        localEndpoint: { host: '127.0.0.1', port: address.port },
      },
      nodeEgressDeps,
      controller.signal,
      t.work,
    );
    expect(t.raw).toHaveLength(1);
    expect(t.pending.size).toBe(1);
    response.dispose();
    expect(t.pending.size).toBe(1);
    await Promise.all(t.raw);
    expect(t.pending.size).toBe(0);
  } finally {
    response?.dispose();
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it('real native connection failure is settled only after its actual close', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing fixture port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const t = tracking();
  const order: string[] = [];
  const actual = vi.mocked(request).getMockImplementation();
  if (actual === undefined) throw new Error('missing native request');
  vi.mocked(request).mockImplementationOnce((...args: Parameters<typeof request>) => {
    const req = actual(...args);
    req.once('error', () => order.push('error'));
    req.once('close', () => order.push('close'));
    return req;
  });
  const hop: HopRequest = {
    url: `http://127.0.0.1:${address.port}/x`,
    hostname: '127.0.0.1',
    scheme: 'http',
    port: address.port,
    pinnedIp: '127.0.0.1',
    method: 'GET',
  };
  await expect(
    nodeEgressDeps.openConnection(hop, new AbortController().signal, t.work),
  ).rejects.toMatchObject({ code: 'network' });
  expect(t.raw).toHaveLength(1);
  await Promise.all(t.raw);
  order.push('lifetime');
  expect(order).toEqual(['error', 'close', 'lifetime']);
  expect(t.pending.size).toBe(0);
});

it('a real finite response joins body and request closure after bounded reading', async () => {
  const server = createServer((_request, response) => {
    response.end('done');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing fixture port');
  const t = tracking();
  let response: Awaited<ReturnType<typeof connectValidated>> | undefined;
  try {
    response = await connectValidated(
      `http://127.0.0.1:${address.port}/x`,
      { method: 'GET', localEndpoint: { host: '127.0.0.1', port: address.port } },
      nodeEgressDeps,
      new AbortController().signal,
      t.work,
    );
    expect(new TextDecoder().decode(await readBounded(response.body, 32, response.dispose))).toBe(
      'done',
    );
    await Promise.all(t.raw);
    expect(t.raw).toHaveLength(1);
    expect(t.pending.size).toBe(0);
  } finally {
    response?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('a native post-entry host refusal preserves identity without leaking the abandoned header rejection', async () => {
  const server = createServer((_request, response) => response.end('done'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing fixture port');
  const t = tracking();
  const controller = new AbortController();
  const failure = Object.freeze({ refused: 'after-native-entry' });
  let caught: unknown;
  try {
    try {
      void nodeEgressDeps.openConnection(
        {
          url: `http://127.0.0.1:${address.port}/x`,
          hostname: '127.0.0.1',
          scheme: 'http',
          port: address.port,
          pinnedIp: '127.0.0.1',
          method: 'GET',
        },
        controller.signal,
        {
          retainWork: <T>(factory: () => Promise<T>): Promise<T> => {
            if (t.work.retainWork === undefined) throw new Error('missing retainer');
            void t.work.retainWork(factory);
            return throwHostFailure(failure);
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(t.raw).toHaveLength(1);
    expect(t.pending.size).toBe(1);
    controller.abort();
    expect(t.pending.size).toBe(1);
    await Promise.all(t.raw);
    expect(t.pending.size).toBe(0);
  } finally {
    controller.abort();
    await Promise.allSettled(t.raw);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
