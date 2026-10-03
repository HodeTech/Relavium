import { appendFileSync } from 'node:fs';
import { register, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';

const record = (operation) =>
  appendFileSync(process.env.RELAVIUM_SMOKE_GUARD_LOG, JSON.stringify({ operation }) + '\n', {
    mode: 0o600,
  });
const denied = (operation) => () => {
  record(operation);
  throw new Error(`Budget smoke offline guard: ${operation} forbidden`);
};
// The existing async module hook API also works at the repository's Node 22.13 floor.
register('./budget-module-guard.mjs', import.meta.url);

const localFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (typeof input === 'string' && input.startsWith('data:application/octet-stream;base64,'))
    return localFetch(input, init);
  return denied('fetch')();
};
globalThis.WebSocket = denied('WebSocket');
net.connect = denied('net.connect');
net.createConnection = denied('net.createConnection');
net.Socket.prototype.connect = denied('Socket.connect');
tls.connect = denied('tls.connect');
for (const module of [http, https]) {
  module.request = denied('http.request');
  module.get = denied('http.get');
}
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']) {
  dns[name] = denied(`dns.${name}`);
  dns.promises[name] = denied(`dns.promises.${name}`);
}
syncBuiltinESMExports();
