import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { register, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import child from 'node:child_process';
import dgram from 'node:dgram';
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
child.spawn = (...args) => {
  const native = nativeWitness?.trySpawn(...args);
  if (native !== undefined) {
    record({ operation: 'native-owned-spawn', executable: args[0], args: args[1] });
    return native;
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
globalThis.fetch = async (input, init) => {
  if (typeof input === 'string' && input.startsWith('data:application/octet-stream;base64,'))
    return localFetch(input, init);
  if (!process.env.RELAVIUM_PACKAGE_SMOKE_PROMPT) return denied('fetch')();
  const request = new globalThis.Request(input, init);
  const raw = await request.text();
  assert.ok(Buffer.byteLength(raw) <= 65536, 'Synthetic request too large');
  const body = JSON.parse(raw);
  const valid =
    request.url === 'https://api.openai.com/v1/chat/completions' &&
    request.method === 'POST' &&
    request.headers.get('authorization') === 'Bearer sk-relavium-synthetic-package-smoke' &&
    body.model === 'gpt-4o-mini' &&
    body.stream === true &&
    body.stream_options?.include_usage === true &&
    Array.isArray(body.messages) &&
    body.messages.at(-1)?.role === 'user' &&
    body.messages.at(-1)?.content === process.env.RELAVIUM_PACKAGE_SMOKE_PROMPT;
  if (!valid) return denied('unexpected-fetch')();
  record({
    operation: 'sdk-fetch',
    url: request.url,
    method: request.method,
    body,
    synthetic: true,
  });
  const base = {
    id: 'chatcmpl-synthetic-package-smoke',
    object: 'chat.completion.chunk',
    created: 1792100000,
    model: 'gpt-4o-mini',
  };
  const frames = [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: process.env.RELAVIUM_PACKAGE_SMOKE_REPLY },
          finish_reason: null,
        },
      ],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
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
