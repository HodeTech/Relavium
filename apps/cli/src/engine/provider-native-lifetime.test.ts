import { createServer, request, type ClientRequest, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import { nodeEgressDeps } from '@relavium/db';
import { createValidatedFetch } from './validated-fetch.js';

vi.mock('node:http', async (original) => {
  const native = await original<typeof import('node:http')>();
  return { ...native, request: vi.fn(native.request) };
});
const nativeRequest = vi.mocked(request).getMockImplementation();

function latch() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function holdClose(target: ClientRequest | IncomingMessage) {
  const arrived = latch();
  const original = target.once;
  let release = () => {};
  // Withhold only safe-egress's close acknowledgement, letting Node's own iterator lifecycle
  // receive the actual event. Blocking emit itself would also block SDK body completion.
  Object.defineProperty(target, 'once', {
    configurable: true,
    value: (event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event !== 'close' || !new Error().stack?.includes('safe-egress')) {
        Reflect.apply(original, target, [event, listener]);
        return target;
      }
      Reflect.apply(original, target, [
        event,
        (...args: unknown[]) => {
          release = () => {
            listener.call(target, ...args);
          };
          arrived.resolve();
        },
      ]);
      return target;
    },
  });
  return { arrived: arrived.promise, release: () => release() };
}
for (const first of ['request', 'response'] as const)
  it(`actual SDK completion still owes both native close callbacks (${first} first)`, async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'c',
          object: 'chat.completion',
          created: 0,
          model: 'custom-text',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing port');
    const native = vi.mocked(request);
    const original = nativeRequest;
    if (original === undefined) throw new Error('missing native request implementation');
    let reqClose: ReturnType<typeof holdClose> | undefined;
    let resClose: ReturnType<typeof holdClose> | undefined;
    native.mockImplementationOnce((...args: Parameters<typeof request>) => {
      const req = original(...args);
      reqClose = holdClose(req);
      req.prependOnceListener('response', (res: IncomingMessage) => {
        resClose = holdClose(res);
      });
      return req;
    });
    // Only this test transport redirects the already policy-validated hop to a real loopback
    // server. Shipping HTTPS admission, DNS pinning and TLS behavior are not relaxed.
    const adapter = createOpenAiAdapter({
      baseURL: 'https://native-fixture.example/v1',
      fetch: createValidatedFetch({
        resolveHost: () => Promise.resolve(['93.184.216.34']),
        openConnection: (req, signal, work) =>
          nodeEgressDeps.openConnection(
            {
              ...req,
              url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
              scheme: 'http',
              hostname: '127.0.0.1',
              port: address.port,
              pinnedIp: '127.0.0.1',
            },
            signal,
            work,
          ),
      }),
    });
    const admitted: Promise<unknown>[] = [];
    let completed = false;
    try {
      const result = await adapter.generate(
        {
          model: 'custom-text',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'offline native fixture' }] }],
        },
        'fixture-key',
        {
          retainWork: (factory) => {
            const raw = factory();
            admitted.push(raw);
            void raw.then(() => {
              completed = true;
            });
            return raw;
          },
        },
      );
      expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
      expect(admitted).toHaveLength(1);
      if (reqClose === undefined || resClose === undefined)
        throw new Error('missing native close hooks');
      await Promise.all([reqClose.arrived, resClose.arrived]);
      expect(completed).toBe(false);
      (first === 'request' ? reqClose : resClose).release();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(completed).toBe(false);
      (first === 'request' ? resClose : reqClose).release();
      await Promise.all(admitted);
      expect(completed).toBe(true);
    } finally {
      reqClose?.release();
      resClose?.release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      vi.restoreAllMocks();
    }
  });
