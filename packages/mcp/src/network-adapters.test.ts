import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { McpConnection } from './connection.js';
import { MCP_DEADLINES, McpDeadlineError, openWindow, raceDeadline } from './deadlines.js';
import { McpError } from './errors.js';
import { openHttpConnection } from './sdk-http.js';
import { openSseConnection } from './sdk-sse.js';
import { connectSdkTransport, MAX_TOOL_PAGES } from './sdk-stdio.js';
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

    const conn = await connectSdkTransport('mem', clientTransport, {
      timeoutMs: MCP_DEADLINES.networkConnectMs,
    });
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

describe('SdkConnection — the bound and the cancel actually reach the SDK request', () => {
  /**
   * **The layer a review proved untested.** Two mutations were applied to `#request` and BOTH left the whole
   * package green: dropping the bridged `signal` from the SDK options, and removing `raceDeadline` entirely
   * (making discovery and `tools/call` unbounded again). The manager tests assert the signal reaches the
   * `McpConnection` seam — the boundary — and stop there, so everything below it was deletable at zero cost.
   * `MCP_DEADLINES.callMs` and `.discoveryMs` could likewise be set to 1 ms unnoticed.
   *
   * These drive a REAL `McpServer` over an in-memory transport pair with a tool that never answers, so the
   * only things that can end the call are the ones under test.
   */
  const hangingServer = async (): Promise<{
    conn: McpConnection;
    close: () => Promise<void>;
    /** Did the SERVER learn the call was cancelled? The only end-to-end proof of the SDK handoff. */
    serverSawCancel: () => boolean;
  }> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'hang', version: '1.0.0' });
    let cancelled = false;
    server.registerTool(
      'hang',
      { description: 'never answers', inputSchema: {} },
      (_args, extra) => {
        // The MCP server aborts a handler's `signal` when it receives `notifications/cancelled` — which the
        // SDK sends ONLY if it was given a `RequestOptions.signal`. This is the observation that makes the
        // handoff testable from outside: our own race rejects the CALLER either way, so a test that watched
        // only the caller's promise stayed green with the handoff deleted (measured).
        extra.signal.addEventListener('abort', () => {
          cancelled = true;
        });
        return new Promise(() => undefined);
      },
    );
    await server.connect(serverTransport);
    const conn = await connectSdkTransport('hang', clientTransport, {
      timeoutMs: MCP_DEADLINES.networkConnectMs,
    });
    return {
      conn,
      serverSawCancel: () => cancelled,
      close: async () => {
        await conn.close();
        await server.close();
      },
    };
  };

  it('an aborted in-flight tools/call rejects promptly, rather than running to the deadline', async () => {
    // ADR-0088 §1.2's measurement 2, at the layer that actually carries it: before this the signal had
    // nowhere to go and an aborted call was still pending 500 ms later. `callMs` is 60 s, so a rejection here
    // can only come from the abort.
    const { conn, close, serverSawCancel } = await hangingServer();
    try {
      const controller = new AbortController();
      const started = Date.now();
      const call = conn.callTool('hang', {}, controller.signal);
      // Let the request reach the server before cancelling — otherwise the pre-abort refusal short-circuits
      // and nothing is ever in flight, which is a different (also tested) property.
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      await expect(call).rejects.toBeInstanceOf(McpError);
      expect(Date.now() - started).toBeLessThan(5_000); // nowhere near MCP_DEADLINES.callMs
      // **The half that binds the SDK handoff.** Without `RequestOptions.signal` the caller still rejects —
      // our race sees to that — but the server never learns, and the remote effect keeps running. That is
      // precisely the harm ADR-0088's Context names, and it is invisible from the caller's promise.
      await vi.waitFor(() => expect(serverSawCancel()).toBe(true));
    } finally {
      await close();
    }
  }, 30_000);

  it('refuses a PRE-ABORTED call before a byte is written, rather than racing it', async () => {
    // **Renamed to what it proves.** It was called "…ended by ITS OWN deadline, not by the SDK default" and
    // its comment claimed a window was overridden — neither was true. It passes a pre-aborted signal and
    // asserts `McpAbortedError`, which is the CANCELLATION arm; nothing in it could distinguish `callMs` from
    // the SDK's own timeout. The deadline claim now has its own test below, and this keeps the property it
    // really covers: `Promise.race` evaluates its array before racing, so an unguarded version still puts the
    // request on the wire for a call the caller had already cancelled.
    const { conn, close } = await hangingServer();
    try {
      const aborted = AbortSignal.abort();
      await expect(conn.callTool('hang', {}, aborted)).rejects.toMatchObject({
        name: 'McpAbortedError',
        phase: 'call',
      });
    } finally {
      await close();
    }
  }, 30_000);

  it('ends a never-answering tools/call at MCP_DEADLINES.callMs, by OUR timer not the SDK’s', async () => {
    // The claim the renamed test above only asserted in its title. Driven on fake timers so the real 60 s
    // constant is exercised rather than a stand-in: advance to just under `callMs` and the call is still
    // pending; cross it and OUR `McpDeadlineError` is what surfaces.
    //
    // That it is ours and not the SDK's is `SDK_TIMER_MARGIN_MS`: `#request` hands the SDK
    // `remainingMs(window) + 250`, so at every instant our timer is due first. Set the margin negative and
    // this test reports the SDK's own timeout error instead — which is the whole reason the margin exists.
    vi.useFakeTimers();
    try {
      const { conn, close } = await hangingServer();
      try {
        const call = conn.callTool('hang', {});
        const settled = vi.fn();
        void call.catch(settled);
        await vi.advanceTimersByTimeAsync(MCP_DEADLINES.callMs - 1_000);
        expect(settled).not.toHaveBeenCalled(); // still in flight, well past any default we did not set
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(call).rejects.toMatchObject({ name: 'McpDeadlineError', phase: 'call' });
      } finally {
        await close();
      }
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('raceDeadline itself keeps one window across repeated calls', () => {
    // The primitive, in isolation. Kept because it is cheap and pins the arithmetic, but it is NOT the
    // whole-walk guarantee: it hand-rolls the loop `listTools` composes, so `listTools` could open a window
    // per page and this would still be green. The test below is the one that binds that.
    const window = openWindow(120);
    const slowPage = async (): Promise<{ tools: []; nextCursor: string }> => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { tools: [], nextCursor: 'more' };
    };
    return expect(
      (async () => {
        for (;;) {
          await raceDeadline('s', 'discovery', window, slowPage);
        }
      })(),
    ).rejects.toBeInstanceOf(McpDeadlineError);
  });

  it('`listTools` bounds the WHOLE paged walk by one window, not each page', async () => {
    // **The seam the test above stops one layer above.** A server that answers every page just inside a
    // per-page bound outlives any deadline simply by paginating, which is the hole `MAX_TOOL_PAGES` closes
    // for the page COUNT and this window closes for elapsed TIME. Nothing bound it to `listTools`: a version
    // that called `openWindow(discoveryMs)` inside the page fetcher rather than around the walk left the
    // repeated-call test above untouched.
    //
    // A real paginating server on fake timers. Each page burns a third of `discoveryMs` and hands back a
    // cursor, so a per-page window would never expire and the walk would run to `MAX_TOOL_PAGES` (100 pages,
    // a DIFFERENT error) — while one walk-wide window dies on the fourth page.
    vi.useFakeTimers();
    try {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: 'pages', version: '1.0.0' }, { capabilities: { tools: {} } });
      let pages = 0;
      server.setRequestHandler(ListToolsRequestSchema, () => {
        pages += 1;
        vi.advanceTimersByTime(MCP_DEADLINES.discoveryMs / 3);
        return { tools: [], nextCursor: `page-${pages}` };
      });
      await server.connect(serverTransport);
      const conn = await connectSdkTransport('pages', clientTransport, {
        timeoutMs: MCP_DEADLINES.networkConnectMs,
      });
      try {
        const walk = conn.listTools();
        const settled = vi.fn();
        void walk.catch(settled);
        await vi.advanceTimersByTimeAsync(MCP_DEADLINES.discoveryMs + 1_000);
        await expect(walk).rejects.toMatchObject({ name: 'McpDeadlineError', phase: 'discovery' });
        // The walk-wide window, not the page cap: it died in a handful of pages, nowhere near 100.
        expect(pages).toBeLessThan(MAX_TOOL_PAGES);
      } finally {
        await conn.close();
        await server.close();
      }
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});

describe('the injected fetch actually reaches the SDK transport (ADR-0088 §2.1)', () => {
  /**
   * **The layer a review proved untested — for the second time in this package, one level up.** Deleting
   * `spec.fetch === undefined ? undefined : { fetch: spec.fetch }` from BOTH adapters left every suite in the
   * repository green: the host could build the pinned, scope-carrying `fetch`, thread it through
   * `ServerOpeners`, and the adapter could throw it away — restoring DNS-rebind and SDK-followed redirects —
   * with nothing noticing. `mcp-servers.test.ts` asserts the fetch reaches a FAKE opener; that is the seam,
   * and everything below it was deletable at zero cost.
   *
   * The oracle needs no server and no network: both SDK transports call the injected `fetch` during `start()`,
   * so a stub that records the url and answers `500` is enough to prove the handoff — and enough to redden
   * the moment it is dropped.
   */
  const recordingFetch = (): {
    fetch: (url: string | URL) => Promise<Response>;
    urls: string[];
  } => {
    const urls: string[] = [];
    return {
      urls,
      fetch: (url) => {
        urls.push(String(url));
        return Promise.resolve(new Response('no', { status: 500 }));
      },
    };
  };

  it('openHttpConnection routes its requests through the injected fetch', async () => {
    const { fetch, urls } = recordingFetch();
    await openHttpConnection('h', { url: 'https://never.example/mcp', fetch }).catch(
      () => undefined,
    );
    expect(urls).toEqual(['https://never.example/mcp']);
  }, 30_000);

  it('openSseConnection routes its requests through the injected fetch', async () => {
    const { fetch, urls } = recordingFetch();
    await openSseConnection('s', { url: 'https://never.example/sse', fetch }).catch(
      () => undefined,
    );
    expect(urls).toEqual(['https://never.example/sse']);
  }, 30_000);
});
