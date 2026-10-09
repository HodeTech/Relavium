import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PingRequestSchema, isJSONRPCResultResponse } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { OwnedSdkClient } from './sdk-client.js';
import { SdkTransportOwner } from './sdk-work.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function connected() {
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: 'handler-lifetime', version: '1' });
  await server.connect(serverTransport);
  const owner = new SdkTransportOwner(transport);
  const client = new OwnedSdkClient({ name: 'handler-owner', version: '1' }, owner);
  await client.connect(owner.transport);
  return { transport, serverTransport, server, owner, client };
}

describe('actual installed SDK request handler ownership', () => {
  it('refuses peer ID reuse until the exact previous response send settles', async () => {
    const { server, owner, client, transport, serverTransport } = await connected();
    const entered = deferred<string | number>();
    const send = deferred<void>();
    let calls = 0;
    client.setRequestHandler(PingRequestSchema, () => {
      calls += 1;
      return {};
    });
    const originalSend = transport.send.bind(transport);
    transport.send = (message, options) => {
      if (isJSONRPCResultResponse(message)) {
        entered.resolve(message.id);
        return send.promise;
      }
      return originalSend(message, options);
    };
    const peerOutcome = server.server.ping().catch((error: unknown) => error);
    try {
      const id = await entered.promise;
      await expect(
        serverTransport.send({ jsonrpc: '2.0', id, method: 'ping' }),
      ).rejects.toMatchObject({ name: 'McpLifetimeError', code: 'ambiguous' });
      await tick();
      expect(calls).toBe(1);
      let complete = false;
      const closing = owner.close();
      void closing.then(() => {
        complete = true;
      });
      await tick();
      expect(complete).toBe(false);
      send.resolve();
      await closing;
      expect(complete).toBe(true);
    } finally {
      send.resolve();
      await owner.close();
      await server.close();
      await peerOutcome;
    }
  });

  it('retains delivery accepted before close until the SDK actually enters its retired handler', async () => {
    const { server, owner, client } = await connected();
    let calls = 0;
    client.setRequestHandler(PingRequestSchema, () => {
      calls += 1;
      return {};
    });
    const deliver = owner.onmessage;
    if (deliver === undefined) throw new Error('SDK callback was not installed');
    let release: (() => void) | undefined;
    owner.onmessage = (message, extra) => {
      release = () => deliver(message, extra);
    };
    const peerOutcome = server.server.ping().catch((error: unknown) => error);
    let complete = false;
    const closing = owner.close();
    void closing.then(() => {
      complete = true;
    });
    try {
      await tick();
      expect(complete).toBe(false);
      expect(calls).toBe(0);
      expect(release).toBeTypeOf('function');
      release?.();
      await closing;
      expect(complete).toBe(true);
      expect(calls).toBe(0);
      await peerOutcome;
    } finally {
      release?.();
      await closing;
      await server.close();
    }
  });

  it.each(['resolve', 'reject'])(
    'SDK/native close cannot acknowledge a held handler which will %s later',
    async (settlement) => {
      const { server, owner, client, transport } = await connected();
      const entered = deferred<void>();
      const handler = deferred<Record<string, never>>();
      let reflected = 0;
      const opaque = new Proxy(
        {},
        {
          get() {
            reflected += 1;
            throw new Error('opaque handler refusal reflected');
          },
          getPrototypeOf() {
            reflected += 1;
            throw new Error('opaque handler refusal reflected');
          },
        },
      );
      client.setRequestHandler(PingRequestSchema, () => {
        entered.resolve();
        return handler.promise;
      });
      let responses = 0;
      const originalSend = transport.send.bind(transport);
      transport.send = (message, options) => {
        if (isJSONRPCResultResponse(message)) responses += 1;
        return originalSend(message, options);
      };
      const peerOutcome = server.server.ping().catch((error: unknown) => error);
      await entered.promise;
      let complete = false;
      const closing = owner.close();
      void closing.then(() => {
        complete = true;
      });
      try {
        await tick();
        expect(complete).toBe(false);
        expect(responses).toBe(0);
        if (settlement === 'reject') handler.reject(opaque);
        else handler.resolve({});
        await closing;
        await tick();
        expect(complete).toBe(true);
        expect(responses).toBe(0);
        expect(reflected).toBe(0);
        await peerOutcome;
      } finally {
        handler.resolve({});
        await closing;
        await server.close();
      }
    },
  );

  it('same-tick close vetoes the actual SDK queued handler before its factory enters', async () => {
    const { server, owner, client } = await connected();
    let calls = 0;
    client.setRequestHandler(PingRequestSchema, () => {
      calls += 1;
      return {};
    });
    const peerOutcome = server.server.ping().catch((error: unknown) => error);
    try {
      await owner.close();
      await tick();
      expect(calls).toBe(0);
      expect(owner.work.isComplete).toBe(true);
      await peerOutcome;
    } finally {
      await owner.close();
      await server.close();
    }
  });
});
