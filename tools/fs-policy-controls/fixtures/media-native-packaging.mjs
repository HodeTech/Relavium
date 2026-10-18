/**
 * ADR-0109 actual CLI packaging/lifetime witness. Invoke after the CLI build:
 *   node tools/fs-policy-controls/fixtures/media-native-packaging.mjs
 *
 * Imports the untouched built CLI entry and runs a real transform workflow through
 * its bundled core/shared/db graph. The exact fixture HTTPS endpoint is rerouted to
 * real loopback HTTP at the native dispatch edge. This is NOT TLS or SSRF evidence.
 * No provider, keychain lookup, user history, source alias, or test product export.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { clearTimeout, setImmediate, setTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Tool-only artifact selection; no fixture flag or exported hook enters the product.
assert.ok(process.argv.length === 2 || process.argv.length === 3, 'one optional CLI entry');
if (process.argv[2] !== undefined) assert.ok(isAbsolute(process.argv[2]), 'absolute CLI entry');
const entry =
  process.argv[2] === undefined
    ? new URL('../../../apps/cli/dist/index.js', import.meta.url)
    : pathToFileURL(process.argv[2]);
await access(entry).catch(() => {
  throw new Error(
    'Build apps/cli before running the actual CLI native-lifecycle packaging witness',
  );
});
const scratch = await realpath(await mkdtemp(join(os.tmpdir(), 'relavium-cli-native-packaging-')));
const original = {
  httpsRequest: https.request,
  open: fs.promises.open,
  homedir: os.homedir,
  argv: process.argv,
  cwd: process.cwd(),
  exitCode: process.exitCode,
};
function latch() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const gate = latch();
const destroying = latch();
const fileClosed = latch();
const nativeClosed = latch();
const dispatches = [];
let requestDestroy = false;
let responseDestroy = false;
let requestClosed = false;
let responseClosed = false;
let closedFilePath;
let writes = 0;
let requests = 0;
let commandSettled = false;
let command;
let watchdog;
const fail = latch();
function checkDestroy() {
  if (requestDestroy && responseDestroy) destroying.release();
}
function checkClosed() {
  if (requestClosed && responseClosed) nativeClosed.release();
}
async function checkpoint(promise) {
  await Promise.race([
    promise,
    fail.promise.then(() => {
      throw new Error('CLI native lifecycle checkpoint missing');
    }),
  ]);
}
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'audio/L16' });
  response.write(Buffer.from([1, 2]));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');

try {
  const workflow = join(scratch, 'native.relavium.yaml');
  const fixtureUrl = 'https://93.184.216.34/relavium-native-packaging';
  await writeFile(
    workflow,
    `schema_version: '1.0'
workflow:
  id: native-packaging
  name: Native packaging lifetime
  nodes:
    - { id: start, type: input }
    - id: media
      type: transform
      transform: '({ type: "media", mimeType: "audio/L16", source: { kind: "url", url: "${fixtureUrl}" } })'
    - { id: out, type: output }
  edges:
    - { from: start, to: media }
    - { from: media, to: out }
`,
  );
  const syntheticHome = join(scratch, 'home');
  await mkdir(syntheticHome);
  // Alter the OS seam before the actual entry is loaded; never alter the user's HOME.
  os.homedir = () => syntheticHome;
  https.request = (options, callback) => {
    assert.equal(options.hostname, '93.184.216.34', 'No non-fixture network dispatch is permitted');
    assert.equal(options.path, '/relavium-native-packaging');
    requests += 1;
    const request = http.request(
      {
        ...options,
        protocol: 'http:',
        hostname: '127.0.0.1',
        port: address.port,
        lookup: undefined,
      },
      callback,
    );
    request.on('close', () => {
      requestClosed = true;
      checkClosed();
    });
    const destroy = request.destroy.bind(request);
    request.destroy = (...args) => {
      requestDestroy = true;
      checkDestroy();
      dispatches.push(gate.promise.then(() => destroy(...args)));
      return request;
    };
    request.prependListener('response', (response) => {
      response.on('close', () => {
        responseClosed = true;
        checkClosed();
      });
      const destroyResponse = response.destroy.bind(response);
      response.destroy = (...args) => {
        responseDestroy = true;
        checkDestroy();
        dispatches.push(gate.promise.then(() => destroyResponse(...args)));
        return response;
      };
    });
    return request;
  };
  fs.promises.open = async (...args) => {
    const path = String(args[0]);
    if (path.includes('media-v1.')) {
      const child = relative(scratch, path);
      assert.ok(
        child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child),
        'Only a synthetic-home CAS may be written',
      );
    }
    const file = await original.open(...args);
    if (path.includes('media-v1.')) {
      file.write = () => {
        writes += 1;
        return Promise.reject(Object.assign(new Error('packaging fixture EIO'), { code: 'EIO' }));
      };
      const close = file.close.bind(file);
      file.close = async () => {
        await close();
        closedFilePath = path;
        fileClosed.release();
      };
    }
    return file;
  };
  syncBuiltinESMExports();
  process.chdir(scratch);
  process.argv = [
    process.execPath,
    fileURLToPath(entry),
    'run',
    workflow,
    '--json',
    '--cwd',
    scratch,
  ];
  watchdog = setTimeout(() => fail.release(), 15_000);
  // Observe failure immediately; only the checkpoint assertions define the witness.
  // eslint-disable-next-line no-restricted-syntax -- exact local untouched CLI dist entry proves its shipped ownership domain; never a provider module
  command = import(entry.href).finally(() => {
    commandSettled = true;
  });
  void command.catch(() => undefined);
  await checkpoint(destroying.promise);
  await checkpoint(fileClosed.promise);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(writes, 1);
  assert.equal(typeof closedFilePath, 'string');
  assert.deepEqual(await readdir(dirname(closedFilePath)), []);
  assert.equal(requestClosed, false);
  assert.equal(responseClosed, false);
  // Caller-facing terminal timing is ADR-0103 policy. The command/host departure
  // must still own this real native retirement; no claim about early receipt timing.
  assert.equal(commandSettled, false, 'FS_CAUSAL_MEDIA_CLI_PACKAGED_NATIVE_JOIN');
  gate.release();
  await checkpoint(command);
  await checkpoint(nativeClosed.promise);
  assert.equal(process.exitCode, 1, 'Real workflow preserves the media I/O failure');
  process.stdout.write(
    'actual CLI bundled native registration/consumption joined after owned-file cleanup\n',
  );
} finally {
  clearTimeout(watchdog);
  gate.release();
  await command?.catch(() => undefined);
  await Promise.allSettled(dispatches);
  https.request = original.httpsRequest;
  fs.promises.open = original.open;
  os.homedir = original.homedir;
  syncBuiltinESMExports();
  process.argv = original.argv;
  process.chdir(original.cwd);
  process.exitCode = original.exitCode;
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(scratch, { recursive: true, force: true });
}
