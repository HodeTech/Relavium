import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { McpError } from './errors.js';
import { openHttpConnection } from './sdk-http.js';
import { openSseConnection } from './sdk-sse.js';
import { connectSdkTransport } from './sdk-stdio.js';
import { openWebSocketConnection } from './sdk-websocket.js';

/**
 * The network transport adapters surface only Relavium shapes; a full LIVE-network connect needs a real server
 * (the stdio e2e fixture exercises the same `connectSdkTransport` wrapper over a real transport). Here we cover:
 * the two host-observable failure arms without a server (a malformed url is a typed connect failure; the
 * websocket adapter fails LOUD on a runtime with no global `WebSocket`, Node < 22), AND the success path that
 * every network adapter delegates to — `connectSdkTransport` — over a deterministic in-memory transport pair
 * (no port, no network), so the initialize handshake + listTools + callTool + close are genuinely exercised.
 */

describe('openHttpConnection / openSseConnection (malformed url)', () => {
  it('a malformed url is a typed McpConnectError, not a raw throw', async () => {
    await expect(openHttpConnection('h', { url: 'not a url' })).rejects.toThrow(McpError);
    await expect(openSseConnection('s', { url: ':::bad' })).rejects.toThrow(McpError);
  });
});

describe('connectSdkTransport (the success path every network adapter delegates to)', () => {
  it('runs the initialize handshake, then listTools + callTool round-trip, then close — over an in-memory pair', async () => {
    // Deterministic, no network/port: an SDK McpServer over one end of a linked in-memory transport pair; the
    // Relavium `connectSdkTransport` wrapper drives the OTHER end exactly as the http/sse/websocket adapters do.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'mem', version: '1.0.0' });
    server.registerTool(
      'echo',
      { description: 'echo back', inputSchema: { text: z.string() } },
      ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    await server.connect(serverTransport);

    const conn = await connectSdkTransport('mem', clientTransport);
    try {
      const tools = await conn.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo']);
      const result = await conn.callTool('echo', { text: 'hi' });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    } finally {
      await conn.close();
      await server.close();
    }
  });
});

describe('openWebSocketConnection (global WebSocket guard)', () => {
  const saved = Reflect.get(globalThis, 'WebSocket') as unknown;
  afterEach(() => {
    // Restore whatever the runtime had (a function on Node 22+, undefined otherwise).
    Reflect.set(globalThis, 'WebSocket', saved);
  });

  it('fails loud with a clear, typed McpError when there is no global WebSocket (Node < 22)', async () => {
    Reflect.set(globalThis, 'WebSocket', undefined);
    const promise = openWebSocketConnection('w', { url: 'wss://host/ws' });
    await expect(promise).rejects.toBeInstanceOf(McpError); // a TYPED error, not a plain Error
    await expect(promise).rejects.toThrow(
      /websocket transport requires a global WebSocket \(Node 22\+\)/,
    );
  });

  it('a malformed url is a typed McpConnectError (past the guard, before any connect)', async () => {
    // Stub a global WebSocket so the Node-22 guard passes; the malformed url then trips the adapter's own
    // `new URL()` parse — a typed McpConnectError — BEFORE `new WebSocketClientTransport` is ever reached,
    // so no socket is opened. This covers the websocket adapter's error-surface arm the http/sse test covers.
    Reflect.set(globalThis, 'WebSocket', function StubWebSocket() {});
    await expect(openWebSocketConnection('w', { url: ':::bad' })).rejects.toThrow(McpError);
  });
});
