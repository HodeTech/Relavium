import { afterEach, describe, expect, it } from 'vitest';

import { McpError } from './errors.js';
import { openHttpConnection } from './sdk-http.js';
import { openSseConnection } from './sdk-sse.js';
import { openWebSocketConnection } from './sdk-websocket.js';

/**
 * The network transport adapters surface only Relavium shapes; a full connect needs a live server (the e2e
 * fixture's job). Here we cover the two host-observable arms without a server: a malformed url is a typed
 * connect failure, and the websocket adapter fails LOUD on a runtime with no global `WebSocket` (Node < 22).
 */

describe('openHttpConnection / openSseConnection (malformed url)', () => {
  it('a malformed url is a typed McpConnectError, not a raw throw', async () => {
    await expect(openHttpConnection('h', { url: 'not a url' })).rejects.toThrow(McpError);
    await expect(openSseConnection('s', { url: ':::bad' })).rejects.toThrow(McpError);
  });
});

describe('openWebSocketConnection (global WebSocket guard)', () => {
  const saved = Reflect.get(globalThis, 'WebSocket') as unknown;
  afterEach(() => {
    // Restore whatever the runtime had (a function on Node 22+, undefined otherwise).
    Reflect.set(globalThis, 'WebSocket', saved);
  });

  it('fails loud with a clear, typed error when there is no global WebSocket (Node < 22)', async () => {
    Reflect.set(globalThis, 'WebSocket', undefined);
    await expect(openWebSocketConnection('w', { url: 'wss://host/ws' })).rejects.toThrow(
      /websocket transport requires a global WebSocket \(Node 22\+\)/,
    );
  });
});
