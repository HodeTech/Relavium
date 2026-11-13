import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { register, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dns from 'node:dns';
import child from 'node:child_process';
import dgram from 'node:dgram';
import fsPromises from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { record, denied } from './guard-log.mjs';
import { createNativeSpawnWitness } from './native-spawn-witness.mjs';

register('./module-guard.mjs', import.meta.url);
net.connect = denied('net.connect');
net.createConnection = denied('net.createConnection');
net.Socket.prototype.connect = denied('Socket.connect');
net.createServer = denied('net.createServer');
tls.connect = denied('tls.connect');
dgram.createSocket = denied('dgram.createSocket');
for (const module of [http, https]) {
  module.request = denied('http.request');
  module.get = denied('http.get');
  module.createServer = denied('http.createServer');
}
for (const name of ['connect', 'createServer', 'createSecureServer'])
  http2[name] = denied(`http2.${name}`);
for (const [label, module] of [
  ['dns', dns],
  ['dns.promises', dns.promises],
])
  for (const name of Object.keys(module))
    if (
      typeof module[name] === 'function' &&
      !['getServers', 'setDefaultResultOrder', 'getDefaultResultOrder'].includes(name)
    )
      module[name] = denied(`${label}.${name}`);
const originalSpawn = child.spawn;
const nativeWitness = process.env.RELAVIUM_PACKAGE_SMOKE_NATIVE
  ? createNativeSpawnWitness(process.env.RELAVIUM_PACKAGE_SMOKE_NATIVE, originalSpawn)
  : undefined;
if (nativeWitness !== undefined) {
  nativeWitness.installSignalDiagnostics();
  fsPromises.access = nativeWitness.wrapFacilityAccess(fsPromises.access);
}
child.spawn = (...args) => {
  const native = nativeWitness?.trySpawn(...args);
  if (native !== undefined) {
    record({ operation: 'native-owned-spawn', executable: args[0], args: args[1] });
    return native;
  }
  // Older macOS needs the product's joined, fixed-purpose mask-query child.
  // Admit that exact infrastructure call only for the installed native-write case.
  if (
    process.env.RELAVIUM_PACKAGE_SMOKE_WRITE === '1' &&
    args[0] === process.execPath &&
    JSON.stringify(args[1]) ===
      JSON.stringify([
        '-e',
        String.raw`process.stdout.write(process.umask().toString(8).padStart(4,'0')+'\n')`,
      ]) &&
    JSON.stringify(Object.keys(args[2] ?? {}).sort()) ===
      JSON.stringify(['env', 'stdio', 'windowsHide']) &&
    args[2].env !== null &&
    typeof args[2].env === 'object' &&
    Object.keys(args[2].env).length === 0 &&
    JSON.stringify(args[2].stdio) === JSON.stringify(['ignore', 'pipe', 'ignore']) &&
    args[2].windowsHide === true
  ) {
    record({ operation: 'native-creation-mask-probe' });
    return originalSpawn(...args);
  }
  // The separate existing MCP fixture remains exact; no generic process/shell spawning is admitted.
  const expected = process.env.RELAVIUM_PACKAGE_SMOKE_MCP;
  if (
    expected &&
    args[0] === process.execPath &&
    args[1]?.length === 1 &&
    args[1][0] === expected &&
    !args[2]?.shell
  ) {
    record({ operation: 'mcp-spawn', executable: args[0], args: args[1] });
    return originalSpawn(...args);
  }
  return denied('child_process.spawn')();
};
for (const name of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
  child[name] = denied(`child_process.${name}`);
globalThis.WebSocket = denied('WebSocket');
syncBuiltinESMExports();
const localFetch = globalThis.fetch;
let writeDispatches = 0;
globalThis.fetch = async (input, init) => {
  if (typeof input === 'string' && input.startsWith('data:application/octet-stream;base64,'))
    return localFetch(input, init);
  if (!process.env.RELAVIUM_PACKAGE_SMOKE_PROMPT) return denied('fetch')();
  const request = new globalThis.Request(input, init);
  const raw = await request.text();
  assert.ok(Buffer.byteLength(raw) <= 65536, 'Synthetic request too large');
  const body = JSON.parse(raw);
  const writeFixture = process.env.RELAVIUM_PACKAGE_SMOKE_WRITE === '1';
  const secondWriteCall = writeFixture && writeDispatches === 1;
  const valid =
    request.url === 'https://api.openai.com/v1/chat/completions' &&
    request.method === 'POST' &&
    request.headers.get('authorization') === 'Bearer sk-relavium-synthetic-package-smoke' &&
    body.model === 'gpt-4o-mini' &&
    body.stream === true &&
    body.stream_options?.include_usage === true &&
    Array.isArray(body.messages) &&
    (secondWriteCall
      ? body.messages.at(-1)?.role === 'tool' &&
        body.messages.at(-1)?.tool_call_id === 'packaged-native-write' &&
        body.messages.some(
          (message) =>
            message.role === 'user' &&
            message.content === process.env.RELAVIUM_PACKAGE_SMOKE_PROMPT,
        )
      : body.messages.at(-1)?.role === 'user' &&
        body.messages.at(-1)?.content === process.env.RELAVIUM_PACKAGE_SMOKE_PROMPT) &&
    (!writeFixture || writeDispatches < 2);
  if (!valid) return denied('unexpected-fetch')();
  record({
    operation: 'sdk-fetch',
    url: request.url,
    method: request.method,
    body,
    synthetic: true,
  });
  if (secondWriteCall) await awaitOwnedWriteBarrier();
  const base = {
    id: 'chatcmpl-synthetic-package-smoke',
    object: 'chat.completion.chunk',
    created: 1792100000,
    model: 'gpt-4o-mini',
  };
  if (writeFixture) writeDispatches += 1;
  const toolCall = writeFixture && !secondWriteCall;
  const frames = [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: toolCall
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'packaged-native-write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({
                        path: 'native-write-target.txt',
                        content: 'installed native reviewed bytes 🙂\n',
                      }),
                    },
                  },
                ],
              }
            : { role: 'assistant', content: process.env.RELAVIUM_PACKAGE_SMOKE_REPLY },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
    },
    {
      ...base,
      choices: [],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    },
  ];
  return new globalThis.Response(
    frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n',
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'synthetic-package-smoke' },
    },
  );
};

async function awaitOwnedWriteBarrier() {
  const barrier = process.env.RELAVIUM_PACKAGE_SMOKE_WRITE_BARRIER;
  assert.ok(barrier, 'Explicit owned SDK response barrier required');
  writeFileSync(barrier + '.ready', '', { flag: 'wx', mode: 0o600 });
  const deadline = Date.now() + 20_000;
  while (!existsSync(barrier + '.release')) {
    assert.ok(Date.now() < deadline, 'Owned SDK response barrier timed out');
    await sleep(10);
  }
}
