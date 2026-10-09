import { describe, expect, it } from 'vitest';
import {
  JSONRPCMessageSchema,
  isJSONRPCRequest,
  isJSONRPCNotification,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { openHttpConnection, type HttpServerSpec } from './index.js';
type McpFetch = HttpServerSpec['fetch'];
import type { ToolHostCallOptions } from '@relavium/core';

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
  let complete = false;
  return {
    admitted,
    options,
    observe: () => {
      void Promise.all(admitted).then(() => {
        complete = true;
      });
    },
    complete: () => complete,
  };
}
function jsonReply(id: string | number, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'content-type': 'application/json', 'mcp-session-id': 'offline-session' },
  });
}
interface Send {
  readonly message: JSONRPCMessage;
  readonly headers: Headers;
  readonly options: Parameters<McpFetch>[2];
}
function wire(onCall: (send: Send) => Promise<Response>) {
  const sent: Send[] = [];
  const fetch: McpFetch = (_url, init, options) => {
    if (init?.method === 'GET') return Promise.resolve(new Response(null, { status: 405 }));
    if (init?.method === 'DELETE') throw new Error('unexpected session deletion');
    if (typeof init?.body !== 'string') throw new Error('missing SDK envelope');
    const message = JSONRPCMessageSchema.parse(JSON.parse(init.body));
    const send = { message, headers: new Headers(init.headers), options };
    sent.push(send);
    if (isJSONRPCRequest(message) && message.method === 'initialize') {
      return Promise.resolve(
        jsonReply(message.id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'offline', version: '1' },
        }),
      );
    }
    if (isJSONRPCNotification(message) && message.method === 'notifications/initialized')
      return Promise.resolve(new Response(null, { status: 202 }));
    return onCall(send);
  };
  return { fetch, sent };
}
const textResult = { content: [{ type: 'text', text: 'ok' }] };
function requestId(message: JSONRPCMessage) {
  if (!isJSONRPCRequest(message)) throw new Error('expected SDK request');
  return message.id;
}

describe('one initialized SDK HTTP session, independent request ownership', () => {
  it('success keeps an independently retained transport tail and reuses handshake/session', async () => {
    const native = deferred<void>();
    const host = parent();
    const fixture = wire(({ message, options }) => {
      if (options?.retainWork === undefined) throw new Error('missing HTTP scope');
      void options.retainWork(() => native.promise);
      return Promise.resolve(jsonReply(requestId(message), textResult));
    });
    const connection = await openHttpConnection('http', {
      url: 'https://offline.example/mcp',
      fetch: fixture.fetch,
    });
    try {
      expect((await connection.callTool('echo', {}, undefined, host.options)).content).toEqual(
        textResult.content,
      );
      host.observe();
      await tick();
      expect(host.complete()).toBe(false);
      const call = fixture.sent.find(
        ({ message }) => isJSONRPCRequest(message) && message.method === 'tools/call',
      );
      expect(call?.headers.get('mcp-session-id')).toBe('offline-session');
      expect(call?.headers.get('mcp-protocol-version')).toBe('2025-11-25');
      expect(
        fixture.sent.filter(
          ({ message }) => isJSONRPCRequest(message) && message.method === 'initialize',
        ),
      ).toHaveLength(1);
      native.resolve();
      await Promise.all(host.admitted);
      await tick();
      expect(host.complete()).toBe(true);
    } finally {
      native.resolve();
      await connection.close();
    }
  });

  it('cancellation has independent live scope after ordinary retirement and leaves a sibling usable', async () => {
    const entered = deferred<void>();
    const cancellation = deferred<void>();
    const host = parent();
    const abort = new AbortController();
    let cancellationSignalAborted: boolean | undefined;
    const fixture = wire(({ message, options }) => {
      if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
        cancellationSignalAborted = options?.signal?.aborted;
        if (options?.retainWork === undefined) throw new Error('missing cancellation scope');
        void options.retainWork(() => cancellation.promise);
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      if (isJSONRPCRequest(message) && message.params?.['name'] === 'hold') {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            options?.signal?.addEventListener(
              'abort',
              () => {
                controller.close();
              },
              { once: true },
            );
          },
        });
        entered.resolve();
        return Promise.resolve(
          new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
        );
      }
      return Promise.resolve(jsonReply(requestId(message), textResult));
    });
    const connection = await openHttpConnection('http', {
      url: 'https://offline.example/mcp',
      fetch: fixture.fetch,
    });
    try {
      const call = connection.callTool('hold', {}, abort.signal, host.options);
      const outcome = call.catch((error: unknown) => error);
      await entered.promise;
      abort.abort();
      expect(await outcome).toMatchObject({ name: 'McpAbortedError' });
      expect((await connection.callTool('echo', {})).content).toEqual(textResult.content);
      await tick();
      expect(cancellationSignalAborted).toBe(false);
      host.observe();
      await tick();
      expect(host.complete()).toBe(false);
      cancellation.resolve();
      await Promise.all(host.admitted);
      await tick();
      expect(host.complete()).toBe(true);
      expect(
        fixture.sent.filter(
          ({ message }) => isJSONRPCRequest(message) && message.method === 'initialize',
        ),
      ).toHaveLength(1);
    } finally {
      cancellation.resolve();
      await connection.close();
    }
  });

  it.each(['ping', 'unknown/method'])(
    'owns the SDK server %s reply independently of the tools/call response',
    async (method) => {
      const native = deferred<void>();
      const host = parent();
      let replies = 0;
      const fixture = wire(({ message, options }) => {
        if (!isJSONRPCRequest(message)) {
          replies += 1;
          if (options?.retainWork === undefined) throw new Error('missing server reply scope');
          void options.retainWork(() => native.promise);
          return Promise.resolve(new Response(null, { status: 202 }));
        }
        // The peer may reuse an outgoing ID in the opposite direction; it grants no outgoing authority.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: ' +
                  JSON.stringify({ jsonrpc: '2.0', id: message.id, method }) +
                  '\n\n' +
                  'data: ' +
                  JSON.stringify({ jsonrpc: '2.0', id: message.id, result: textResult }) +
                  '\n\n',
              ),
            );
            controller.close();
          },
        });
        return Promise.resolve(
          new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
        );
      });
      const connection = await openHttpConnection('http', {
        url: 'https://offline.example/mcp',
        fetch: fixture.fetch,
      });
      try {
        expect((await connection.callTool('echo', {}, undefined, host.options)).content).toEqual(
          textResult.content,
        );
        await tick();
        expect(replies).toBe(1);
        host.observe();
        await tick();
        expect(host.complete()).toBe(false);
        native.resolve();
        await Promise.all(host.admitted);
        await tick();
        expect(host.complete()).toBe(true);
      } finally {
        native.resolve();
        await connection.close();
      }
    },
  );

  it('same-tick retirement before SDK headers forbids ordinary POST while cancellation remains owned', async () => {
    const host = parent();
    const abort = new AbortController();
    const methods: string[] = [];
    const fixture = wire(({ message }) => {
      if ('method' in message) methods.push(message.method);
      return Promise.resolve(new Response(null, { status: 202 }));
    });
    const connection = await openHttpConnection('http', {
      url: 'https://offline.example/mcp',
      fetch: fixture.fetch,
    });
    try {
      const call = connection.callTool('echo', {}, abort.signal, host.options);
      const outcome = call.catch((error: unknown) => error);
      abort.abort();
      expect(await outcome).toMatchObject({ name: 'McpAbortedError' });
      await Promise.all(host.admitted);
      await tick();
      expect(methods).toEqual(['notifications/cancelled']);
    } finally {
      await connection.close();
    }
  });
  it.each([
    {
      label: 'ordinary',
      task: false,
      id: 'cancelled-peer',
      cancelId: 'cancelled-peer',
      reason: 'cancelled',
      replies: 0,
    },
    {
      label: 'task refusal',
      task: true,
      id: 'cancelled-peer',
      cancelId: 'cancelled-peer',
      reason: 'cancelled',
      replies: 0,
    },
    {
      label: 'zero ID ignored by SDK',
      task: true,
      id: 0,
      cancelId: 0,
      reason: 'cancelled',
      replies: 1,
    },
    {
      label: 'empty ID ignored by SDK',
      task: true,
      id: '',
      cancelId: '',
      reason: 'cancelled',
      replies: 1,
    },
    {
      label: 'missing ID ignored by SDK',
      task: true,
      id: 'queued-peer',
      cancelId: undefined,
      reason: 'cancelled',
      replies: 1,
    },
    {
      label: 'unmatched ID leaves another reply live',
      task: true,
      id: 'queued-peer',
      cancelId: 'other-peer',
      reason: 'cancelled',
      replies: 1,
    },
    {
      label: 'malformed cancellation ignored by SDK',
      task: true,
      id: 'cancelled-peer',
      cancelId: 'cancelled-peer',
      reason: 7,
      replies: 1,
    },
  ])(
    'peer $label cancellation releases only its queued reply while the session stays usable',
    async ({ task, id, cancelId, reason, replies: expectedReplies }) => {
      const host = parent();
      let replies = 0;
      let calls = 0;
      const fixture = wire(({ message }) => {
        if (!isJSONRPCRequest(message)) {
          replies += 1;
          return Promise.resolve(new Response(null, { status: 202 }));
        }
        calls += 1;
        if (calls > 1) return Promise.resolve(jsonReply(message.id, textResult));
        const messages: JSONRPCMessage[] = [
          {
            jsonrpc: '2.0',
            id,
            method: 'ping',
            ...(task ? { params: { task: { ttl: 1000 } } } : {}),
          },
          {
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: cancelId, reason },
          },
          { jsonrpc: '2.0', id: message.id, result: textResult },
        ];
        const bytes = new TextEncoder().encode(
          messages.map((entry) => 'data: ' + JSON.stringify(entry) + '\n\n').join(''),
        );
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      });
      const connection = await openHttpConnection('http', {
        url: 'https://offline.example/mcp',
        fetch: fixture.fetch,
      });
      try {
        expect((await connection.callTool('echo', {}, undefined, host.options)).content).toEqual(
          textResult.content,
        );
        host.observe();
        await tick();
        expect(host.complete()).toBe(true);
        expect(replies).toBe(expectedReplies);
        expect((await connection.callTool('echo', {})).content).toEqual(textResult.content);
        expect(calls).toBe(2);
        await connection.close();
      } finally {
        // A failed original ghost-reservation assertion must stay a semantic failure, not
        // turn into a timeout by awaiting the known unresolved close in test cleanup.
        if (host.complete()) await connection.close();
      }
    },
  );
});
