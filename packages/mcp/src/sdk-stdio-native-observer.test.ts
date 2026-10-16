import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  liveMcpChildPids,
  McpAbortedError,
  McpConnectError,
  openStdioConnection,
  type StdioNativeLifetime,
  type StdioNativeObserver,
} from './index.js';
import { SdkTransportOwner } from './sdk-work.js';
import { McpWorkScope } from './work-scope.js';

const silentServer = fileURLToPath(
  new URL('../test-fixtures/silent-mcp-server.mjs', import.meta.url),
);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('native observer fixture transition did not complete');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function observe(beforeStart: () => void = () => {}) {
  let lifetime: StdioNativeLifetime | undefined;
  const read = (): StdioNativeLifetime => {
    if (lifetime === undefined) throw new Error('stdio native lifetime was not attached');
    return lifetime;
  };
  const observer: StdioNativeObserver = {
    attach: (value) => {
      lifetime = value;
      expect(value.readPid()).toBeUndefined();
      expect(value.isClosed()).toBe(false);
    },
    beforeStart,
  };
  return { observer, read };
}

/** Failed semantic assertions must still join the exact fixture owner, without inventing native ACK. */
async function cleanupObserved(lifetime: StdioNativeLifetime | undefined, work?: McpWorkScope) {
  work?.seal();
  const pid = lifetime?.readPid();
  if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
  await lifetime?.close();
  await lifetime?.whenClosed;
  await work?.done;
}

describe('stdio host projection of actual native ownership', () => {
  it('exposes the actual pre-initialize child and retains its PID through bounded failure and SDK close', async () => {
    const before = liveMcpChildPids();
    const abort = new AbortController();
    const work = new McpWorkScope();
    const { observer, read } = observe();
    const opening = openStdioConnection(
      'observed-pre-initialize',
      {
        command: process.execPath,
        args: [silentServer],
        env: {},
        connectTimeoutMs: 10000,
        nativeObserver: observer,
      },
      abort.signal,
      work,
    );
    const outcome = opening.catch((error: unknown) => error);
    const lifetime = read();
    const pid = lifetime.readPid();
    let nativeClosed = false;
    void lifetime.whenClosed.then(() => {
      nativeClosed = true;
    });
    try {
      expect(pid).toBeDefined();
      if (pid === undefined) throw new Error('missing observed native child PID');
      expect(before).not.toContain(pid);
      expect(alive(pid)).toBe(true);
      expect(liveMcpChildPids()).toContain(pid);
      // The fixture never answers initialize: native ownership cannot wait for a connection handle.
      await tick();
      expect(nativeClosed).toBe(false);
      abort.abort();
      expect(await outcome).toBeInstanceOf(McpAbortedError);
      work.seal();
      const closing = lifetime.close();
      expect(lifetime.close()).toBe(closing);
      expect(lifetime.readPid()).toBe(pid);
      expect(lifetime.isClosed()).toBe(false);
      expect(nativeClosed).toBe(false);
      expect(work.isComplete).toBe(false);
      await lifetime.whenClosed;
      expect(lifetime.isClosed()).toBe(true);
      expect(lifetime.readPid()).toBeUndefined();
      expect(liveMcpChildPids()).not.toContain(pid);
      expect(alive(pid)).toBe(false);
      await closing;
      await work.done;
    } finally {
      abort.abort();
      if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
      await lifetime.close();
      work.seal();
      await work.done;
    }
  }, 15000);

  it.each(['refusal', 'cancellation', 'close'] as const)(
    'before-start %s refuses actual native entry and acknowledges only the empty lifetime',
    async (kind) => {
      const before = liveMcpChildPids();
      const work = new McpWorkScope();
      const abort = new AbortController();
      const refusal = new Error('host admission refused');
      const { observer, read } = observe(() => {
        expect(read().readPid()).toBeUndefined();
        if (kind === 'refusal') throw refusal;
        if (kind === 'cancellation') abort.abort();
        else
          void read()
            .close()
            .catch(() => undefined);
      });
      const outcome = await openStdioConnection(
        'refused-before-start',
        {
          command: process.execPath,
          args: [silentServer],
          env: {},
          connectTimeoutMs: 1000,
          nativeObserver: observer,
        },
        abort.signal,
        work,
      ).catch((error: unknown) => error);
      const lifetime = read();
      try {
        if (kind === 'cancellation') {
          expect(outcome, 'MCP_SDK_PRESTART_CANCELLATION').toBeInstanceOf(McpAbortedError);
        } else {
          if (kind === 'refusal') {
            expect(outcome, 'MCP_SDK_PRESTART_ADMISSION').toHaveProperty('cause', refusal);
          } else {
            expect(outcome, 'MCP_SDK_PRESTART_REENTRANT').toHaveProperty('cause.code', 'closed');
          }
          expect(outcome).toBeInstanceOf(McpConnectError);
        }
        // Check before waiting for an accidentally spawned resource to finish cleanup.
        expect(lifetime.isClosed(), 'MCP_SDK_EMPTY_START').toBe(true);
        expect(lifetime.readPid()).toBeUndefined();
        expect(liveMcpChildPids()).toEqual(before);
      } finally {
        abort.abort();
        await cleanupObserved(lifetime, work);
      }
      expect(work.isComplete).toBe(true);
    },
    15000,
  );

  it.each([false, true])(
    'attachment refusal releases the acquired empty owner (reentrant close: %s)',
    async (reentrant) => {
      const before = liveMcpChildPids();
      const work = new McpWorkScope();
      const refusal = new Error('native attachment refused');
      let lifetime: StdioNativeLifetime | undefined;
      const opening = openStdioConnection(
        'refused-attachment',
        {
          command: process.execPath,
          args: [silentServer],
          env: {},
          nativeObserver: {
            attach: (value) => {
              lifetime = value;
              if (reentrant) void value.close().catch(() => undefined);
              throw refusal;
            },
            beforeStart: () => {
              throw new Error('native start entered after refused attachment');
            },
          },
        },
        undefined,
        work,
      );
      try {
        await expect(opening).rejects.toBe(refusal);
        if (lifetime === undefined) throw new Error('missing refused native attachment');
        expect(lifetime.isClosed()).toBe(true);
        expect(lifetime.readPid()).toBeUndefined();
        expect(liveMcpChildPids()).toEqual(before);
      } finally {
        await cleanupObserved(lifetime, work);
      }
      expect(work.isComplete).toBe(true);
    },
  );

  it('an already cancelled connect still attaches and releases a verified empty native lifetime', async () => {
    const abort = new AbortController();
    abort.abort();
    const { observer, read } = observe(() => {
      throw new Error('SDK start entered for pre-cancelled connect');
    });
    await expect(
      openStdioConnection(
        'cancelled-before-attach',
        { command: process.execPath, args: [silentServer], env: {}, nativeObserver: observer },
        abort.signal,
      ),
    ).rejects.toBeInstanceOf(McpAbortedError);
    await read().whenClosed;
    await read().close();
    expect(read().isClosed()).toBe(true);
    expect(read().readPid()).toBeUndefined();
  });

  it.each(['attach', 'beforeStart'] as const)(
    '%s refuses an unexpected async return, observing native rejection without reading a then getter',
    async (phase) => {
      const before = liveMcpChildPids();
      const work = new McpWorkScope();
      const { observer, read } = observe();
      let getterReads = 0;
      const returned = (): unknown => {
        const promise = Promise.reject(new Error('unexpected asynchronous observer failure'));
        void Object.defineProperty(promise, 'then', {
          get: () => {
            getterReads += 1;
            throw new Error('foreign then getter must not be read');
          },
        });
        return promise;
      };
      const outcome = await openStdioConnection(
        'async-native-observer',
        {
          command: process.execPath,
          args: [silentServer],
          env: {},
          connectTimeoutMs: 1000,
          nativeObserver: {
            attach: (value) => {
              observer.attach(value);
              return phase === 'attach' ? returned() : undefined;
            },
            beforeStart: () => (phase === 'beforeStart' ? returned() : undefined),
          },
        },
        undefined,
        work,
      ).catch((error: unknown) => error);
      try {
        expect(outcome, 'MCP_SYNC_CALLBACK_REFUSAL').toHaveProperty(
          phase === 'attach' ? 'code' : 'cause.code',
          'observer_unavailable',
        );
        expect(read().isClosed()).toBe(true);
        expect(read().readPid()).toBeUndefined();
        await tick();
        expect(getterReads).toBe(0);
        expect(liveMcpChildPids()).toEqual(before);
      } finally {
        await cleanupObserved(read(), work);
      }
    },
    15000,
  );

  it('refuses a foreign thenable without invoking its protocol or getters', async () => {
    const { observer, read } = observe();
    let getterReads = 0;
    const thenable: unknown = Object.defineProperty({}, 'then', {
      get: () => {
        getterReads += 1;
        throw new Error('foreign then protocol must not run');
      },
    });
    const outcome = await openStdioConnection('foreign-native-observer', {
      command: process.execPath,
      args: [silentServer],
      env: {},
      connectTimeoutMs: 1000,
      nativeObserver: {
        attach: (value) => {
          observer.attach(value);
          return thenable;
        },
        beforeStart: () => {},
      },
    }).catch((error: unknown) => error);
    try {
      expect(outcome, 'MCP_FOREIGN_CALLBACK_REFUSAL').toHaveProperty(
        'code',
        'observer_unavailable',
      );
      expect(read().isClosed()).toBe(true);
      expect(read().readPid()).toBeUndefined();
      expect(getterReads).toBe(0);
    } finally {
      await cleanupObserved(read());
    }
  });
});

describe('installed SDK native start callback failures', () => {
  it('observes rejected raw start before a post-entry hook fails, preserving verified empty-start ACK', async () => {
    // The real SDK wraps native argument validation in its start Promise; no child/error/close is created.
    const transport = new StdioClientTransport({ command: '', env: {}, stderr: 'ignore' });
    const refusal = new Error('post-entry observer refused');
    const work = new McpWorkScope();
    const owner = new SdkTransportOwner(transport, work, undefined, {
      onStartEntered: () => {
        throw refusal;
      },
    });
    try {
      expect(() => owner.start()).toThrow(refusal);
    } finally {
      await owner.close();
      await work.done;
    }
    expect(transport.pid).toBeNull();
    expect(owner.nativeCloseAcknowledged).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'native error and post-start hook failure cannot acknowledge a real child whose close remains owed',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'relavium-mcp-native-observer-'));
      const ready = join(directory, 'ready');
      const child = String.raw`
process.on('SIGTERM',()=>{});
process.stdin.resume();
setInterval(()=>{},1000);
require('node:fs').writeFileSync(process.argv[1],'ready');
process.stdout.write('invalid-json\n');`;
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['-e', child, ready],
        env: {},
        stderr: 'ignore',
      });
      const errors: Error[] = [];
      transport.onerror = (error) => errors.push(error);
      const work = new McpWorkScope();
      const heldWork = deferred();
      void work.retainWork(() => heldWork.promise);
      const refusal = new Error('post-start hook refused');
      const owner = new SdkTransportOwner(transport, work, undefined, {
        onStartEntered: () => {
          throw refusal;
        },
      });
      let pid: number | undefined;
      try {
        expect(() => owner.start()).toThrow(refusal);
        pid = transport.pid ?? undefined;
        if (pid === undefined) throw new Error('missing real post-entry child PID');
        await until(() => existsSync(ready) && errors.length > 0);
        expect(owner.nativeCloseAcknowledged, 'MCP_SDK_ERROR_NOT_ACK').toBe(false);
        expect(alive(pid)).toBe(true);
        let complete = false;
        const closing = owner.close().then(() => {
          complete = true;
        });
        // SDK close makes its public getter blind before EOF/TERM/KILL or actual native close.
        expect(transport.pid).toBeNull();
        await tick();
        expect(owner.nativeCloseAcknowledged).toBe(false);
        expect(complete).toBe(false);
        expect(work.isComplete).toBe(false);
        await owner.nativeClosed;
        expect(owner.nativeCloseAcknowledged).toBe(true);
        expect(alive(pid)).toBe(false);
        // Native ACK does not release the independent producer work joined by owner.close().
        expect(complete).toBe(false);
        expect(work.isComplete).toBe(false);
        heldWork.resolve();
        await closing;
        expect(complete).toBe(true);
      } finally {
        heldWork.resolve();
        if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
        await owner.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    15000,
  );
});
