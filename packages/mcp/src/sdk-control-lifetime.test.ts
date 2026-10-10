import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { SdkTransportOwner, type SdkLaneFactory } from './sdk-work.js';

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
const target = (): Transport => ({
  start: () => Promise.resolve(),
  send: () => Promise.resolve(),
  close: () => Promise.resolve(),
});

async function activeRequest(controlFactory: SdkLaneFactory) {
  const request = deferred<void>();
  const sent = deferred<void>();
  let incoming: Transport | undefined;
  const owner = new SdkTransportOwner(target(), undefined, (lifetime) => {
    if (incoming !== undefined) return controlFactory(lifetime);
    incoming = target();
    incoming.send = () => {
      sent.resolve();
      return Promise.resolve();
    };
    return incoming;
  });
  await owner.start();
  const invocation = owner.invoke(undefined, () => {
    void owner.send({ jsonrpc: '2.0', id: 'outgoing', method: 'tools/call' }).catch(sent.reject);
    return request.promise;
  });
  await sent.promise;
  return {
    owner,
    invocation,
    async reply(id: number) {
      if (incoming?.onmessage === undefined) throw new Error('request callback unavailable');
      incoming.onmessage({ jsonrpc: '2.0', id, method: 'ping' });
      await owner.handleServerRequest(id, new AbortController().signal, () => Promise.resolve({}));
      await owner.send({ jsonrpc: '2.0', id, result: {} });
    },
    cancel() {
      return owner.send({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'outgoing' },
      });
    },
    async finish() {
      request.resolve();
      await invocation.raw;
      await owner.close();
    },
  };
}

describe('completed MCP control-lane reference release', () => {
  it.each([
    ['reply', 'resolve'],
    ['reply', 'reject'],
    ['cancel', 'resolve'],
    ['cancel', 'reject'],
  ] as const)('prunes a %s lane after its exact send and cleanup %s', async (kind, result) => {
    const send = deferred<void>();
    let closes = 0;
    const fixture = await activeRequest(() => ({
      ...target(),
      send: () => send.promise,
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    }));
    const failure = new Error('controlled send refusal');
    try {
      const operation = kind === 'reply' ? fixture.reply(1) : fixture.cancel();
      const outcome = operation.then(
        () => undefined,
        (error: unknown) => error,
      );
      await tick();
      expect(fixture.owner.pendingControlLaneCount).toBe(1);
      if (result === 'reject') send.reject(failure);
      else send.resolve();
      expect(await outcome).toBe(result === 'reject' ? failure : undefined);
      await tick();
      expect(closes).toBe(1);
      // The outer request remains unresolved: this cannot pass merely because its state left #live.
      expect(fixture.owner.pendingControlLaneCount).toBe(0);
    } finally {
      send.resolve();
      await fixture.finish();
    }
  });

  it.each(['native-close', 'body-descendant'] as const)(
    'keeps a publicly retired request control lane until its held %s actually settles',
    async (heldWork) => {
      const tail = deferred<void>();
      const fixture = await activeRequest((lifetime) => ({
        ...target(),
        send: () => {
          if (heldWork === 'body-descendant') void lifetime.work.retainWork(() => tail.promise);
          return Promise.resolve();
        },
        close: () => (heldWork === 'native-close' ? tail.promise : Promise.resolve()),
      }));
      try {
        await fixture.reply(1);
        fixture.invocation.retire();
        await tick();
        expect(fixture.owner.pendingControlLaneCount).toBe(1);
        tail.resolve();
        await tick();
        expect(fixture.owner.pendingControlLaneCount).toBe(0);
      } finally {
        tail.resolve();
        await fixture.finish();
      }
    },
  );

  it('does not accumulate sequential completed replies while their outer request stays active', async () => {
    let closes = 0;
    const fixture = await activeRequest(() => ({
      ...target(),
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    }));
    try {
      for (let id = 1; id <= 4; id += 1) {
        await fixture.reply(id);
        await tick();
        expect(closes).toBe(id);
        expect(fixture.owner.pendingControlLaneCount).toBe(0);
      }
    } finally {
      await fixture.finish();
    }
  });
});
