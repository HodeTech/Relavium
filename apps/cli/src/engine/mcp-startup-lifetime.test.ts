import { expect, it } from 'vitest';
import { startMcpClient } from '@relavium/mcp';
import { EgressWorkScope } from './egress-work.js';
import { resolveServerConfigs } from './mcp-servers.js';
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
it('WebSocket preflight DNS transfers to the pre-handle lifetime before its abort race', async () => {
  const dns = deferred<readonly string[]>();
  const entered = deferred<void>();
  const root = new EgressWorkScope();
  const abort = new AbortController();
  let connects = 0;
  const configs = resolveServerConfigs(
    [
      {
        id: 'local',
        transport: 'websocket',
        url: 'ws://relay.local:8765',
        allow_local_endpoint: true,
      },
    ],
    '/offline',
    undefined,
    {
      resolveHost: () => {
        entered.resolve();
        return dns.promise;
      },
      websocket: () => {
        connects++;
        throw new Error('cancelled DNS must not connect');
      },
    },
  );
  const opening = startMcpClient(configs, abort.signal, root);
  const failed = expect(opening).rejects.toMatchObject({ name: 'McpAbortedError' });
  try {
    await entered.promise;
    abort.abort();
    await failed;
    root.seal();
    await tick();
    expect(root.isComplete).toBe(false);
    expect(connects).toBe(0);
  } finally {
    dns.resolve(['127.0.0.1']);
    abort.abort();
    await opening.catch(() => undefined);
    root.seal();
    await root.done;
  }
});
