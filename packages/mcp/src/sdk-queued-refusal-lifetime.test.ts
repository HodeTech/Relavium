import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  PingRequestSchema,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { OwnedSdkClient } from './sdk-client.js';
import { SdkTransportOwner } from './sdk-work.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('installed SDK pre-handler refusal lifetime', () => {
  it.each(
    ['ordinary', 'task', 'schema'].flatMap((kind) =>
      [false, true].map((closeImmediately) => ({ kind, closeImmediately })),
    ),
  )(
    '$kind request completes with closeImmediately=$closeImmediately',
    async ({ kind, closeImmediately }) => {
      const [transport, peer] = InMemoryTransport.createLinkedPair();
      const server = new McpServer({ name: 'queued-refusal', version: '1' });
      await server.connect(peer);
      const owner = new SdkTransportOwner(transport);
      const client = new OwnedSdkClient({ name: 'queued-client', version: '1' }, owner);
      await client.connect(owner.transport);
      let entered = 0;
      let responses = 0;
      if (kind === 'schema') {
        client.setRequestHandler(
          z.object({ method: z.literal('ping'), params: z.object({ required: z.string() }) }),
          () => {
            entered += 1;
            return {};
          },
        );
      } else {
        client.setRequestHandler(PingRequestSchema, () => {
          entered += 1;
          return {};
        });
      }
      const originalSend = transport.send.bind(transport);
      transport.send = (message, options) => {
        if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) responses += 1;
        return originalSend(message, options);
      };
      const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 'queued-peer',
        method: 'ping',
        ...(kind === 'task' ? { params: { task: { ttl: 1000 } } } : {}),
      };
      const delivered = peer.send(message);
      let complete = false;
      let failed = false;
      try {
        if (!closeImmediately) {
          await delivered;
          await tick();
          expect(entered).toBe(kind === 'ordinary' ? 1 : 0);
          expect(responses).toBe(1);
        }
        const closing = owner.close();
        void closing.then(
          () => {
            complete = true;
          },
          () => {
            failed = true;
          },
        );
        await tick();
        expect(failed).toBe(false);
        expect(complete).toBe(true);
        await closing;
        expect(owner.work.isComplete).toBe(true);
        if (closeImmediately) {
          expect(entered).toBe(0);
          expect(responses).toBe(0);
        }
      } finally {
        await server.close();
      }
    },
  );
});
