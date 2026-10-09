import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolHostCallOptions } from '@relavium/core';
import { describe, expect, it } from 'vitest';
import { connectSdkTransport } from './sdk-stdio.js';
import { SdkTransportOwner } from './sdk-work.js';
import { McpWorkScope } from './work-scope.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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
  return { admitted, options };
}

describe('MCP raw protocol ownership', () => {
  it('preserves an opaque trusted retainer getter refusal before SDK tool entry', async () => {
    const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'getter-refusal', version: '1' });
    let calls = 0;
    server.registerTool('echo', { inputSchema: {} }, () => {
      calls += 1;
      return { content: [] };
    });
    await server.connect(serverTransport);
    const connection = await connectSdkTransport('getter', transport, { timeoutMs: 1000 });
    let reflected = 0;
    const opaque = new Proxy(new Error('opaque host refusal'), {
      get() {
        reflected += 1;
        throw new Error('opaque reflection');
      },
      getPrototypeOf() {
        reflected += 1;
        throw new Error('opaque reflection');
      },
    });
    const options: ToolHostCallOptions = {
      get retainWork(): NonNullable<ToolHostCallOptions['retainWork']> {
        throw opaque;
      },
    };
    try {
      let refusal: unknown;
      try {
        await connection.callTool('echo', {}, undefined, options);
      } catch (error) {
        refusal = error;
      }
      expect(Object.is(refusal, opaque)).toBe(true);
      expect(reflected).toBe(0);
      expect(calls).toBe(0);
    } finally {
      await connection.close();
      await server.close();
    }
  });

  it('preserves a method-style retainer receiver through the real SDK connection', async () => {
    const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'method-receiver', version: '1' });
    server.registerTool('echo', { inputSchema: {} }, () => ({ content: [] }));
    await server.connect(serverTransport);
    const connection = await connectSdkTransport('receiver', transport, { timeoutMs: 1000 });
    const admitted: Promise<unknown>[] = [];
    const options = {
      admitted,
      retainWork<T>(factory: () => Promise<T>): Promise<T> {
        const raw = factory();
        this.admitted.push(raw);
        return raw;
      },
    };
    try {
      expect((await connection.callTool('echo', {}, undefined, options)).content).toEqual([]);
      expect(admitted).toHaveLength(1);
      await Promise.all(admitted);
    } finally {
      await connection.close();
      await server.close();
    }
  });

  it.each([false, true])(
    'preserves opaque retention refusal before SDK entry (entered=%s)',
    async (entered) => {
      const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new McpServer({ name: 'ownership', version: '1' });
      let calls = 0;
      server.registerTool('echo', { inputSchema: {} }, () => {
        calls += 1;
        return { content: [{ type: 'text', text: 'ok' }] };
      });
      await server.connect(serverTransport);
      const conn = await connectSdkTransport('test', transport, { timeoutMs: 1000 });
      let reflected = 0;
      const opaque = new Proxy(
        {},
        {
          get() {
            reflected += 1;
            throw new Error('reflection');
          },
          getPrototypeOf() {
            reflected += 1;
            throw new Error('reflection');
          },
        },
      );
      let owned: Promise<unknown> | undefined;
      let seen: unknown;
      try {
        try {
          await conn.callTool('echo', {}, undefined, {
            retainWork: (factory) => {
              if (entered) owned = factory();
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- adversarial opaque host refusal must remain uninspected
              throw opaque;
            },
          });
        } catch (error) {
          seen = error;
        }
        expect(Object.is(seen, opaque)).toBe(true);
        expect(reflected).toBe(0);
        expect(calls).toBe(0);
        if (owned !== undefined) await owned;
      } finally {
        await conn.close();
        await server.close();
      }
    },
  );

  it('a successful SDK response does not release a separately held actual send', async () => {
    const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
    const original = transport.send.bind(transport);
    const tail = deferred<void>();
    transport.send = async (message, options) => {
      await original(message, options);
      if ('method' in message && message.method === 'tools/call') await tail.promise;
    };
    const server = new McpServer({ name: 'send-tail', version: '1' });
    server.registerTool('echo', { inputSchema: {} }, () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    await server.connect(serverTransport);
    const conn = await connectSdkTransport('test', transport, { timeoutMs: 1000 });
    const host = parent();
    try {
      expect((await conn.callTool('echo', {}, undefined, host.options)).content).toEqual([
        { type: 'text', text: 'ok' },
      ]);
      let complete = false;
      void Promise.all(host.admitted).then(() => {
        complete = true;
      });
      await tick();
      expect(complete).toBe(false);
      tail.resolve();
      await Promise.all(host.admitted);
      expect(complete).toBe(true);
    } finally {
      tail.resolve();
      await conn.close();
      await server.close();
    }
  });

  it('a cancellation POST remains joined after bounded caller rejection and preserves siblings', async () => {
    const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
    const original = transport.send.bind(transport);
    const cancellation = deferred<void>();
    const entered = deferred<void>();
    transport.send = async (message, options) => {
      await original(message, options);
      if ('method' in message && message.method === 'notifications/cancelled')
        await cancellation.promise;
    };
    const server = new McpServer({ name: 'cancel-tail', version: '1' });
    server.registerTool('hold', { inputSchema: {} }, () => {
      entered.resolve();
      return new Promise(() => {});
    });
    server.registerTool('echo', { inputSchema: {} }, () => ({
      content: [{ type: 'text', text: 'sibling' }],
    }));
    await server.connect(serverTransport);
    const conn = await connectSdkTransport('test', transport, { timeoutMs: 1000 });
    const host = parent();
    const controller = new AbortController();
    try {
      const call = conn.callTool('hold', {}, controller.signal, host.options);
      const rejected = call.catch((error: unknown) => error);
      await entered.promise;
      controller.abort();
      expect(await rejected).toMatchObject({ name: 'McpAbortedError' });
      expect((await conn.callTool('echo', {})).content).toEqual([
        { type: 'text', text: 'sibling' },
      ]);
      let complete = false;
      void Promise.all(host.admitted).then(() => {
        complete = true;
      });
      await tick();
      expect(complete).toBe(false);
      cancellation.resolve();
      await Promise.all(host.admitted);
      expect(complete).toBe(true);
    } finally {
      cancellation.resolve();
      await conn.close();
      await server.close();
    }
  });

  it.each(['resolve', 'reject'])(
    'publishes the same close before reentrant transport entry and retains its %s tail',
    async (outcome) => {
      const tail = deferred<void>();
      let calls = 0;
      let reentered: Promise<void> | undefined;
      let reflected = 0;
      const fault = new Proxy(new Error('opaque close refusal'), {
        get() {
          reflected += 1;
          throw new Error('close refusal reflected');
        },
        getPrototypeOf() {
          reflected += 1;
          throw new Error('close refusal reflected');
        },
      });
      const transport: Transport = {
        start: () => Promise.resolve(),
        send: () => Promise.resolve(),
        close: () => {
          calls += 1;
          if (calls === 1) {
            reentered = owner.close();
            void reentered.then(
              () => {},
              () => {},
            );
          }
          return tail.promise;
        },
      };
      const owner = new SdkTransportOwner(transport);
      await owner.start();
      const first = owner.close();
      let settled = false;
      let failure: unknown;
      const observed = first.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          failure = error;
        },
      );
      try {
        expect(calls).toBe(1);
        expect(reentered).toBe(first);
        expect(owner.close()).toBe(first);
        await tick();
        expect(settled).toBe(false);
        if (outcome === 'reject') tail.reject(fault);
        else tail.resolve();
        await observed;
        expect(settled).toBe(true);
        expect(Object.is(failure, outcome === 'reject' ? fault : undefined)).toBe(true);
        expect(reflected).toBe(0);
        expect(owner.close()).toBe(first);
        expect(calls).toBe(1);
      } finally {
        tail.resolve();
        await observed;
        await reentered?.then(
          () => {},
          () => {},
        );
      }
    },
  );

  it('SDK close fulfillment and native errors cannot acknowledge native close', async () => {
    const errors: Error[] = [];
    const previousErrors: Error[] = [];
    const transport: Transport = {
      start: () => Promise.resolve(),
      send: () => Promise.resolve(),
      close: () => Promise.resolve(),
      onerror: (error) => {
        previousErrors.push(error);
      },
    };
    const owner = new SdkTransportOwner(transport, undefined, undefined, {});
    owner.onerror = (error) => {
      errors.push(error);
    };
    await owner.start();
    const activeFault = new Error('active native error');
    transport.onerror?.(activeFault);
    expect(errors).toEqual([activeFault]);
    expect(previousErrors).toEqual([activeFault]);
    let complete = false;
    const closing = owner.close();
    void closing.then(() => {
      complete = true;
    });
    transport.onerror?.(new Error('late native error'));
    await tick();
    expect(complete).toBe(false);
    expect(errors).toEqual([activeFault]);
    expect(previousErrors).toEqual([activeFault]);
    transport.onclose?.();
    await closing;
    expect(complete).toBe(true);
  });

  it.each(['protocol', 'start'])(
    'partially configured request target cleanup stays owned when %s entry throws',
    async (phase) => {
      const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new McpServer({ name: 'partial-entry', version: '1' });
      await server.connect(serverTransport);
      const cleanup = deferred<void>();
      const fault = new Error('request target entry refused');
      let closes = 0;
      const owner = new SdkTransportOwner(transport, undefined, () => ({
        setProtocolVersion: () => {
          if (phase === 'protocol') throw fault;
        },
        start: () => {
          throw fault;
        },
        send: () => Promise.resolve(),
        close: () => {
          closes += 1;
          return cleanup.promise;
        },
      }));
      const connection = await connectSdkTransport(
        'partial',
        transport,
        { timeoutMs: 1000 },
        owner,
      );
      const host = parent();
      let complete = false;
      try {
        await expect(connection.callTool('echo', {}, undefined, host.options)).rejects.toBe(fault);
        void Promise.all(host.admitted).then(() => {
          complete = true;
        });
        await tick();
        expect(closes).toBe(1);
        expect(complete).toBe(false);
        cleanup.resolve();
        await Promise.all(host.admitted);
        await tick();
        expect(complete).toBe(true);
      } finally {
        cleanup.resolve();
        await connection.close();
        await server.close();
      }
    },
  );

  it('partial target cleanup rejection survives the original request error and reaches close', async () => {
    const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'partial-cleanup-fault', version: '1' });
    await server.connect(serverTransport);
    const entryFault = new Error('entry refused');
    const cleanupFault = Object.freeze({ cleanup: 'refused' });
    const owner = new SdkTransportOwner(transport, undefined, () => ({
      setProtocolVersion: () => {
        throw entryFault;
      },
      start: () => Promise.resolve(),
      send: () => Promise.resolve(),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercise an opaque cleanup fault, not a formatted diagnostic
      close: () => Promise.reject(cleanupFault),
    }));
    const connection = await connectSdkTransport('partial', transport, { timeoutMs: 1000 }, owner);
    try {
      await expect(connection.callTool('echo', {})).rejects.toBe(entryFault);
      await expect(connection.close()).rejects.toBe(cleanupFault);
      await expect(connection.close()).rejects.toBe(cleanupFault);
    } finally {
      await server.close();
    }
  });

  it('bounded connect failure starts cleanup without awaiting an uncooperative start', async () => {
    const start = deferred<void>();
    const closed = deferred<void>();
    const transport: Transport = {
      start: () => start.promise,
      send: () => Promise.resolve(),
      close: () => {
        closed.resolve();
        return Promise.resolve();
      },
    };
    const owner = new SdkTransportOwner(transport);
    await expect(
      connectSdkTransport('bounded', transport, { timeoutMs: 20 }, owner),
    ).rejects.toMatchObject({ name: 'McpDeadlineError' });
    await closed.promise;
    let quiet = false;
    void owner.work.done.then(() => {
      quiet = true;
    });
    await tick();
    expect(quiet).toBe(false);
    start.resolve();
    await owner.close();
    expect(quiet).toBe(true);
  });

  it('transfers an initialized child lifetime before exposing it and observes detached native promises', async () => {
    const parentScope = new McpWorkScope();
    const child = parentScope.fork();
    const raw = deferred<void>();
    Object.setPrototypeOf(raw.promise, null);
    expect(child.retainWork(() => raw.promise)).toBe(raw.promise);
    child.seal();
    parentScope.seal();
    await tick();
    expect(parentScope.isComplete).toBe(false);
    raw.resolve();
    await tick();
    expect(parentScope.isComplete).toBe(true);
    await parentScope.done;
  });
  it.each([false, true])(
    'transfer-caused synchronous abort has no unhandled guard (throws=%s)',
    async (throws) => {
      const [transport, peer] = InMemoryTransport.createLinkedPair();
      const server = new McpServer({ name: 'synchronous-transfer-cancel', version: '1' });
      let calls = 0;
      server.registerTool('echo', { inputSchema: {} }, () => {
        calls += 1;
        return { content: [] };
      });
      await server.connect(peer);
      const connection = await connectSdkTransport('transfer-cancel', transport, {
        timeoutMs: 1000,
      });
      const controller = new AbortController();
      const primary = new Error('trusted synchronous transfer refused');
      const admitted: Promise<unknown>[] = [];
      try {
        const result = connection.callTool('echo', {}, controller.signal, {
          retainWork: (factory) => {
            const raw = factory();
            admitted.push(raw);
            controller.abort();
            if (throws) throw primary;
            return raw;
          },
        });
        if (throws) await expect(result).rejects.toBe(primary);
        else await expect(result).rejects.toMatchObject({ name: 'McpAbortedError' });
        expect(calls).toBe(0);
        expect(admitted).toHaveLength(1);
        await Promise.all(admitted);
        await tick();
      } finally {
        await connection.close();
        await server.close();
      }
    },
  );
});
