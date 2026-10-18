import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import Module, { register, syncBuiltinESMExports } from 'node:module';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { isServiceSpecifier } from './policy.mjs';

const options = JSON.parse(process.env.RELAVIUM_BOOTSTRAP_WITNESS_OPTIONS);
// appendFileSync internally calls mutable fs.writeFileSync, so retain an already-open
// descriptor and the primitive writer instead of recursing through a patched API.
const witnessFd = fs.openSync(options.witness, 'a');
const savedWrite = fs.writeSync;
const savedClose = fs.closeSync;
process.once('exit', () => savedClose(witnessFd));
let bytes = 0;
function record(event) {
  const line = `${JSON.stringify(event)}\n`;
  bytes += Buffer.byteLength(line);
  if (bytes > 1024 * 1024) throw new Error('bootstrap filesystem witness exceeded limit');
  savedWrite(witnessFd, line);
}
// Node 22.0 supports this async loader API; registerHooks is deliberately not used.
register(new URL('./loader.mjs', import.meta.url), { data: options });

function pathValue(value, base = process.cwd()) {
  if (value instanceof URL && value.protocol === 'file:') return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return resolve(base, value.toString());
  return typeof value === 'string' ? resolve(base, value) : null;
}
function inside(root, candidate) {
  const suffix = relative(root, candidate);
  return (
    suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}
function guard(method, args) {
  const paths = args
    .slice(0, /^(?:rename|copyFile|cp|symlink|link)(?:Sync)?$/u.test(method) ? 2 : 1)
    .map((value) => pathValue(value));
  // A relative symlink target is interpreted from the link's parent, not cwd.
  if (method.startsWith('symlink') && paths[1] !== null && paths[1] !== undefined)
    paths[0] = pathValue(args[0], dirname(paths[1]));
  const observedPaths = paths.filter((path) => path !== null);
  const denied = observedPaths.some((path) =>
    options.protectedRoots.some((root) => inside(root, path)),
  );
  record({ kind: 'fs', method, paths: observedPaths, denied });
  if (denied) throw new Error('synthetic bootstrap application filesystem access refused');
}
// Only protected application paths are refused. Loader/module/package reads elsewhere are
// recorded and allowed; this does not mistake Node's own module reading for product config IO.
const operations = [
  'access',
  'appendFile',
  'chmod',
  'chown',
  'copyFile',
  'cp',
  'exists',
  'lstat',
  'link',
  'mkdir',
  'mkdtemp',
  'open',
  'opendir',
  'readFile',
  'readdir',
  'readlink',
  'realpath',
  'rename',
  'rm',
  'rmdir',
  'stat',
  'symlink',
  'truncate',
  'unlink',
  'watch',
  'writeFile',
];
for (const base of operations) {
  for (const method of [base, `${base}Sync`]) {
    const original = fs[method];
    if (typeof original === 'function') {
      fs[method] = function (...args) {
        guard(method, args);
        return Reflect.apply(original, this, args);
      };
      if (typeof original.native === 'function') {
        fs[method].native = function (...args) {
          guard(`${method}.native`, args);
          return Reflect.apply(original.native, this, args);
        };
      }
    }
  }
  const original = fsPromises[base];
  if (typeof original === 'function')
    fsPromises[base] = async function (...args) {
      guard(base, args);
      return await Reflect.apply(original, this, args);
    };
}
for (const method of ['createReadStream', 'createWriteStream']) {
  const original = fs[method];
  fs[method] = function (...args) {
    guard(method, args);
    return Reflect.apply(original, this, args);
  };
}
const originalLoad = Module._load;
Module._load = function (specifier, ...args) {
  const denied = isServiceSpecifier(specifier);
  record({ kind: 'require', specifier, denied });
  if (denied) throw new Error('synthetic bootstrap CommonJS service import refused');
  return Reflect.apply(originalLoad, this, [specifier, ...args]);
};
globalThis.fetch = async () => {
  record({ kind: 'fetch', denied: true });
  throw new Error('synthetic bootstrap fetch refused');
};
globalThis.WebSocket = function () {
  record({ kind: 'service', category: 'websocket', method: 'WebSocket', denied: true });
  throw new Error('synthetic bootstrap WebSocket refused');
};
for (const [owner, names, category] of [
  [net, ['connect', 'createConnection', 'createServer'], 'net'],
  [net.Socket.prototype, ['connect'], 'socket'],
  [tls, ['connect', 'createServer'], 'tls'],
  [http, ['request', 'get', 'createServer'], 'http'],
  [https, ['request', 'get', 'createServer'], 'https'],
  [http2, ['connect', 'createServer', 'createSecureServer'], 'http2'],
  [dns, ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse'], 'dns'],
  [dnsPromises, ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse'], 'dns-promises'],
  [dgram, ['createSocket'], 'dgram'],
  [
    childProcess,
    ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
    'child-process',
  ],
])
  for (const method of names)
    owner[method] = function () {
      record({ kind: 'service', category, method, denied: true });
      throw new Error('synthetic bootstrap service dispatch refused');
    };
syncBuiltinESMExports();
record({ kind: 'preload-ready' });
