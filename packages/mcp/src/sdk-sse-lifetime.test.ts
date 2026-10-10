import { describe, expect, it, vi } from 'vitest';
import {
  JSONRPCMessageSchema,
  isJSONRPCRequest,
  isJSONRPCNotification,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { openSseConnection, type SseServerSpec } from './index.js';
import type { ToolHostCallOptions } from '@relavium/core';

type McpFetch = SseServerSpec['fetch'];
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
function parent() {
  const admitted: Promise<unknown>[] = [];
  const options: ToolHostCallOptions = {
    retainWork: <T>(factory: () => Promise<T>): Promise<T> => {
      const raw = factory();
      admitted.push(raw);
      return raw;
    },
  };
  return { admitted, options };
}
interface Send {
  readonly message: JSONRPCMessage;
  readonly options: Parameters<McpFetch>[2];
  reply(this: void, result: unknown): void;
}
const textResult = { content: [{ type: 'text', text: 'legacy-ok' }] };
function wire(onCall: (send: Send) => Promise<Response>, getNative = Promise.resolve()) {
  const encoder = new TextEncoder();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamClosed = false;
  let getAborted = false;
  let gets = 0;
  const sent: JSONRPCMessage[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
      controller.enqueue(encoder.encode('event: endpoint\ndata: /messages\n\n'));
    },
  });
  const end = () => {
    if (streamClosed) return;
    streamClosed = true;
    stream?.close();
  };
  const reply = (id: string | number, result: unknown) => {
    if (streamClosed) throw new Error('late fixture server reply');
    stream?.enqueue(
      encoder.encode('data: ' + JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n\n'),
    );
  };
  const fetch: McpFetch = (_url, init, options) => {
    if (init?.method !== 'POST') {
      gets += 1;
      if (options?.retainWork === undefined) throw new Error('missing manager GET scope');
      void options.retainWork(() => getNative);
      init?.signal?.addEventListener(
        'abort',
        () => {
          getAborted = true;
          end();
        },
        { once: true },
      );
      return Promise.resolve(
        new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      );
    }
    if (typeof init.body !== 'string') throw new Error('missing SDK POST envelope');
    const message = JSONRPCMessageSchema.parse(JSON.parse(init.body));
    sent.push(message);
    if (isJSONRPCRequest(message) && message.method === 'initialize') {
      reply(message.id, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'legacy-offline', version: '1' },
      });
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    if (isJSONRPCNotification(message) && message.method === 'notifications/initialized')
      return Promise.resolve(new Response(null, { status: 202 }));
    return onCall({
      message,
      options,
      reply: (result) => {
        if (!isJSONRPCRequest(message)) throw new Error('reply requires actual request');
        reply(message.id, result);
      },
    });
  };
  return { fetch, sent, end, gets: () => gets, getAborted: () => getAborted };
}

describe('actual installed legacy SSE session lifetime', () => {
  it('binds root SDK POST identities and retains a tail without capturing a sibling', async () => {
    const native = deferred<void>();
    const host = parent();
    const sibling = parent();
    let firstSignal: AbortSignal | undefined;
    const fixture = wire(({ message, options, reply }) => {
      if (!isJSONRPCRequest(message)) throw new Error('unexpected control');
      if (message.params?.['name'] === 'hold-tail') {
        if (options?.retainWork === undefined) throw new Error('missing POST lifetime');
        firstSignal = options.signal;
        void options.retainWork(() => native.promise);
      }
      reply(textResult);
      return Promise.resolve(new Response(null, { status: 202 }));
    });
    const connection = await openSseConnection('sse', {
      url: 'https://legacy.example/events',
      fetch: fixture.fetch,
    });
    let complete = false;
    try {
      expect(
        (
          await connection.callTool(
            'hold-tail',
            { id: 900, requestId: 'forged', method: 'initialize' },
            undefined,
            host.options,
          )
        ).content,
      ).toEqual(textResult.content);
      const joined = Promise.all(host.admitted).then(() => {
        complete = true;
      });
      await tick();
      expect(complete).toBe(false);
      expect(firstSignal?.aborted).toBe(true);
      expect(
        (await connection.callTool('sibling', {}, undefined, sibling.options)).content,
      ).toEqual(textResult.content);
      await Promise.all(sibling.admitted);
      expect(complete).toBe(false);
      expect(fixture.gets()).toBe(1);
      expect(
        fixture.sent.filter(
          (message) => isJSONRPCRequest(message) && message.method === 'initialize',
        ),
      ).toHaveLength(1);
      native.resolve();
      await joined;
      expect(complete).toBe(true);
    } finally {
      native.resolve();
      await connection.close();
      fixture.end();
    }
  });

  it('same-tick retirement vetoes ordinary POST and independently joins cancellation work', async () => {
    const cancellation = deferred<void>();
    const host = parent();
    const abort = new AbortController();
    const methods: string[] = [];
    let controlSignalAborted: boolean | undefined;
    const fixture = wire(({ message, options }) => {
      if ('method' in message) methods.push(message.method);
      if (options?.retainWork === undefined) throw new Error('missing cancellation lifetime');
      controlSignalAborted = options.signal?.aborted;
      void options.retainWork(() => cancellation.promise);
      return Promise.resolve(new Response(null, { status: 202 }));
    });
    const connection = await openSseConnection('sse', {
      url: 'https://legacy.example/events',
      fetch: fixture.fetch,
    });
    let complete = false;
    try {
      const call = connection.callTool('echo', {}, abort.signal, host.options);
      const outcome = call.catch((error: unknown) => error);
      abort.abort();
      expect(await outcome).toMatchObject({ name: 'McpAbortedError' });
      await tick();
      expect(methods).toEqual(['notifications/cancelled']);
      expect(controlSignalAborted).toBe(false);
      const joined = Promise.all(host.admitted).then(() => {
        complete = true;
      });
      await tick();
      expect(complete).toBe(false);
      cancellation.resolve();
      await joined;
      expect(complete).toBe(true);
    } finally {
      cancellation.resolve();
      await connection.close();
      fixture.end();
    }
  });

  it('close waits for the independent GET tail after actual SDK abort and prevents reconnect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const native = deferred<void>();
    const fixture = wire(() => {
      throw new Error('unexpected ordinary POST');
    }, native.promise);
    let connection: Awaited<ReturnType<typeof openSseConnection>> | undefined;
    try {
      connection = await openSseConnection('sse', {
        url: 'https://legacy.example/events',
        fetch: fixture.fetch,
      });
      let quiet = false;
      const closing = connection.close().then(() => {
        quiet = true;
      });
      await tick();
      expect(fixture.getAborted()).toBe(true);
      expect(quiet).toBe(false);
      native.resolve();
      await closing;
      expect(quiet).toBe(true);
      await vi.advanceTimersByTimeAsync(10000);
      expect(fixture.gets()).toBe(1);
    } finally {
      native.resolve();
      await connection?.close();
      fixture.end();
      vi.useRealTimers();
    }
  });
});
