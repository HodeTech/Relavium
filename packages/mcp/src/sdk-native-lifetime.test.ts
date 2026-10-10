import { describe, expect, it } from 'vitest';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { openStdioConnection, liveMcpChildPids } from './index.js';
import type { ToolHostCallOptions } from '@relavium/core';
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
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('native fixture transition did not complete');
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

describe('actual installed SDK native transport acknowledgement', () => {
  it('an actual WebSocket constructor refusal proves empty start without an invented close', async () => {
    const work = new McpWorkScope();
    let acknowledged = 0;
    const transport = new WebSocketClientTransport(new URL('ftp://127.0.0.1/'));
    const owner = new SdkTransportOwner(transport, work, undefined, {
      onAcknowledged: () => {
        acknowledged += 1;
      },
    });
    await expect(owner.start()).rejects.toBeDefined();
    await owner.close();
    expect(acknowledged).toBe(1);
    await work.done;
  });

  it('actual failed spawn still waits for the SDK native close callback', async () => {
    const work = new McpWorkScope();
    const closed = deferred<void>();
    const release = deferred<void>();
    const transport = new StdioClientTransport({
      command: '/relavium-missing-native-fixture',
      env: {},
      stderr: 'ignore',
    });
    let acknowledged = 0;
    const owner = new SdkTransportOwner(transport, work, undefined, {
      onAcknowledged: () => {
        acknowledged += 1;
      },
    });
    const deliver = transport.onclose;
    transport.onclose = () => {
      closed.resolve();
      void release.promise.then(() => deliver?.());
    };
    try {
      await expect(owner.start()).rejects.toBeDefined();
      let complete = false;
      const closing = owner.close().then(() => {
        complete = true;
      });
      await closed.promise;
      await tick();
      expect(complete).toBe(false);
      expect(acknowledged).toBe(0);
      release.resolve();
      await closing;
      expect(acknowledged).toBe(1);
    } finally {
      release.resolve();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'TERM-ignoring stdio child is actually killed, but a held close acknowledgement remains owed',
    async () => {
      const work = new McpWorkScope();
      const closed = deferred<void>();
      const release = deferred<void>();
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        env: {},
        stderr: 'ignore',
      });
      const owner = new SdkTransportOwner(transport, work, undefined, {});
      const deliver = transport.onclose;
      transport.onclose = () => {
        closed.resolve();
        void release.promise.then(() => deliver?.());
      };
      let pid: number | undefined;
      try {
        await owner.start();
        pid = transport.pid ?? undefined;
        expect(pid).toBeDefined();
        let complete = false;
        const closing = owner.close().then(() => {
          complete = true;
        });
        await closed.promise;
        if (pid === undefined) throw new Error('missing fixture pid');
        expect(alive(pid)).toBe(false);
        await tick();
        expect(complete).toBe(false);
        release.resolve();
        await closing;
        expect(complete).toBe(true);
      } finally {
        release.resolve();
        if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
      }
    },
    15000,
  );

  it.skipIf(process.platform === 'win32')(
    'a public pre-initialize cancellation keeps its latched native child registered until actual close',
    async () => {
      const before = new Set(liveMcpChildPids());
      const abort = new AbortController();
      const opening = openStdioConnection(
        'pre-initialize',
        {
          command: process.execPath,
          args: ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
          env: {},
          connectTimeoutMs: 10000,
        },
        abort.signal,
      );
      const outcome = opening.catch((error: unknown) => error);
      const pid = liveMcpChildPids().find((value) => !before.has(value));
      try {
        expect(pid).toBeDefined();
        abort.abort();
        expect(await outcome).toMatchObject({ name: 'McpAbortedError' });
        if (pid === undefined) throw new Error('missing registered fixture pid');
        expect(liveMcpChildPids()).toContain(pid);
        expect(alive(pid)).toBe(true);
        await until(() => !liveMcpChildPids().includes(pid));
        expect(alive(pid)).toBe(false);
      } finally {
        abort.abort();
        if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
      }
    },
    15000,
  );

  it.skipIf(process.platform === 'win32')(
    'public cancellation retains actual SDK stdin backpressure until real drain, while a sibling remains usable',
    async () => {
      const child = String.raw`
const keepAlive=setInterval(()=>{},1000);
let buffered='';
const result=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
process.on('SIGUSR2',()=>process.stdin.resume());
process.stdin.on('end',()=>{clearInterval(keepAlive);process.exit(0)});
process.stdin.on('data',chunk=>{
 buffered+=chunk.toString();
 while(buffered.includes('\n')){
  const i=buffered.indexOf('\n');const line=buffered.slice(0,i);buffered=buffered.slice(i+1);
  const m=JSON.parse(line);
  if(m.method==='initialize') result(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'native-fixture',version:'1'}});
  else if(m.method==='tools/call'){
   if(m.params.name==='arm') process.stdin.pause();
   result(m.id,{content:[{type:'text',text:'ok'}]});
  }
 }
});`;
      const connection = await openStdioConnection('backpressure', {
        command: process.execPath,
        args: ['-e', child],
        env: {},
        connectTimeoutMs: 10000,
      });
      const admitted: Promise<unknown>[] = [];
      const options: ToolHostCallOptions = {
        retainWork: <T>(factory: () => Promise<T>): Promise<T> => {
          const raw = factory();
          admitted.push(raw);
          return raw;
        },
      };
      const abort = new AbortController();
      const pid = connection.childPid;
      try {
        await connection.callTool('arm', {});
        const call = connection.callTool(
          'hold',
          { payload: 'x'.repeat(2 * 1024 * 1024) },
          abort.signal,
          options,
        );
        const outcome = call.catch((error: unknown) => error);
        await tick();
        abort.abort();
        expect(await outcome).toMatchObject({ name: 'McpAbortedError' });
        expect(admitted).toHaveLength(1);
        let complete = false;
        const joined = Promise.all(admitted).then(() => {
          complete = true;
        });
        await tick();
        expect(complete).toBe(false);
        if (pid === undefined) throw new Error('missing backpressure fixture pid');
        process.kill(pid, 'SIGUSR2');
        await joined;
        expect(complete).toBe(true);
        expect((await connection.callTool('echo', {})).content).toEqual([
          { type: 'text', text: 'ok' },
        ]);
      } finally {
        abort.abort();
        if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGUSR2');
        await connection.close();
      }
      expect(connection.childPid).toBeUndefined();
      expect(liveMcpChildPids()).not.toContain(pid);
    },
    15000,
  );
});
