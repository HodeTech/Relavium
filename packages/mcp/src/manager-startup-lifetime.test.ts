import { describe, expect, it } from 'vitest';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startMcpClient } from './manager.js';
import { connectSdkTransport } from './sdk-stdio.js';
import { openHttpConnection } from './sdk-http.js';
import { SdkTransportOwner } from './sdk-work.js';
import { McpWorkScope } from './work-scope.js';
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('manager owns failed startup descendants (ADR-0103)', () => {
  it.each(['raw-start', 'raw-close'] as const)(
    'bounded connect rejection transfers %s to the external pre-handle host',
    async (held) => {
      const start = deferred<void>();
      const close = deferred<void>();
      const entered = deferred<void>();
      const root = new McpWorkScope();
      const abort = new AbortController();
      const transport: Transport = {
        start: () => {
          entered.resolve();
          return held === 'raw-start'
            ? start.promise
            : Promise.reject(new Error('offline start refusal'));
        },
        send: () => Promise.resolve(),
        close: () => (held === 'raw-close' ? close.promise : Promise.resolve()),
      };
      const opening = startMcpClient(
        [
          {
            id: 'failing',
            open: (signal, work) =>
              connectSdkTransport(
                'failing',
                transport,
                { timeoutMs: 1000, ...(signal === undefined ? {} : { signal }) },
                new SdkTransportOwner(transport, new McpWorkScope(work)),
              ),
          },
        ],
        abort.signal,
        root,
      );
      const failed = expect(opening).rejects.toBeDefined();
      try {
        await entered.promise;
        abort.abort();
        await failed;
        root.seal();
        await tick();
        expect(root.isComplete).toBe(false);
        start.resolve();
        close.resolve();
        await root.done;
        expect(root.isComplete).toBe(true);
      } finally {
        start.resolve();
        close.resolve();
        abort.abort();
        await opening.catch(() => undefined);
        root.seal();
        await root.done;
      }
    },
  );

  it('actual HTTP adapter transfers failed initialize fetch independently of bounded failure', async () => {
    const raw = deferred<Response>();
    const entered = deferred<void>();
    const root = new McpWorkScope();
    const abort = new AbortController();
    const opening = startMcpClient(
      [
        {
          id: 'http',
          open: (signal, work) =>
            openHttpConnection(
              'http',
              {
                url: 'https://offline.invalid/mcp',
                fetch: () => {
                  entered.resolve();
                  return raw.promise;
                },
              },
              signal,
              work,
            ),
        },
      ],
      abort.signal,
      root,
    );
    const failed = expect(opening).rejects.toMatchObject({ name: 'McpAbortedError' });
    try {
      await entered.promise;
      abort.abort();
      await failed;
      root.seal();
      await tick();
      expect(root.isComplete).toBe(false);
    } finally {
      raw.resolve(new Response('', { status: 400 }));
      abort.abort();
      await opening.catch(() => undefined);
      root.seal();
      await root.done;
    }
  });

  it('partial success plus failed discovery cleans every admitted connection before host completion', async () => {
    const root = new McpWorkScope();
    const held = deferred<void>();
    const closeEntered = deferred<void>();
    const [transport, peer] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'startup-success', version: '1' });
    server.registerTool('echo', { inputSchema: {} }, () => ({ content: [] }));
    await server.connect(peer);
    const nativeClose = transport.close.bind(transport);
    transport.close = async () => {
      closeEntered.resolve();
      await held.promise;
      await nativeClose();
    };

    let settled = false;
    const opening = startMcpClient(
      [
        {
          id: 'live',
          open: (_signal, work) =>
            connectSdkTransport(
              'live',
              transport,
              { timeoutMs: 1000 },
              new SdkTransportOwner(transport, new McpWorkScope(work)),
            ),
        },
        {
          id: 'discovery-fault',
          open: () =>
            Promise.resolve({
              listTools: () => Promise.reject(new Error('offline tools/list fault')),
              callTool: () => Promise.resolve({ content: [], isError: false }),
              close: () => Promise.resolve(),
            }),
        },
      ],
      undefined,
      root,
    ).catch(() => {
      settled = true;
    });
    try {
      await closeEntered.promise;
      root.seal();
      await tick();
      expect(settled).toBe(false);
      expect(root.isComplete).toBe(false);
    } finally {
      held.resolve();
      await opening;
      await root.done;
      await server.close();
    }
  });

  it('pre-aborted connect enters no raw transport and leaves no startup debt', async () => {
    const root = new McpWorkScope();
    const abort = new AbortController();
    abort.abort();
    let starts = 0;
    const transport: Transport = {
      start: () => {
        starts++;
        return Promise.resolve();
      },
      send: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    await expect(
      startMcpClient(
        [
          {
            id: 'pre-aborted',
            open: (signal, work) =>
              connectSdkTransport(
                'pre-aborted',
                transport,
                { timeoutMs: 1000, ...(signal === undefined ? {} : { signal }) },
                new SdkTransportOwner(transport, new McpWorkScope(work)),
              ),
          },
        ],
        abort.signal,
        root,
      ),
    ).rejects.toBeDefined();
    root.seal();
    await root.done;
    expect(starts).toBe(0);
  });
});
