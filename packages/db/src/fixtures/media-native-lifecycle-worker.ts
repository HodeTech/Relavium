import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeMediaIterator,
  deInlineMedia,
  MediaAdmissionError,
  registerNativeMediaIterator,
} from '@relavium/shared';

import { fetchMediaBytes, nodeMediaEgressDeps, streamMediaBytes } from '../media-egress.js';
import { FilesystemMediaStore } from '../media-store.js';
import { MediaStoreFilesystemError } from '../media-store-paths.js';

function latch(): { promise: Promise<void>; release: () => void } {
  let release = (): void => assert.fail('latch not initialized');
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// Watchdogs diagnose a missing checkpoint; the causal witness is a held native barrier,
// completed file cleanup, and the still-pending operation, never an elapsed timeout.
async function checkpoint(promise: Promise<unknown>, name: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Missing native checkpoint: ${name}`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const mode = process.argv[2];
const gate = latch();
const destroying = latch();
const physicalClosed = latch();
const fileClosed = latch();
const closeRequested = latch();
const scratch = await mkdtemp(join(tmpdir(), 'relavium-native-media-'));
const originalRequest = http.request;
const originalOpen = fs.promises.open;
const pendingDispatches: Promise<unknown>[] = [];
let requestClosed = false;
let responseClosed = false;
let requestDestroy = false;
let responseDestroy = false;
let requests = 0;
let writes = 0;
let descriptorClosed = false;
let outcome: Promise<unknown> | undefined;
let iterator: AsyncIterator<Uint8Array> | undefined;
let settled = false;
let witnessFailure: string | undefined;
const holdAcknowledgement = mode === 'eof' || mode === 'whole-buffer';
const failWrite = mode === 'deinline-eio' || mode === 'direct-store-eio';
const checkClosed = (): void => {
  if (requestClosed && responseClosed) physicalClosed.release();
};
const checkDestroy = (): void => {
  if (requestDestroy && responseDestroy) destroying.release();
};

// Patch only the real HTTP objects' retirement dispatch. DNS, request creation,
// response bytes, shared registration, generator finally and CAS are production.
Object.defineProperty(http, 'request', {
  configurable: true,
  writable: true,
  value: (...args: unknown[]): http.ClientRequest => {
    const request: unknown = Reflect.apply(originalRequest, http, args);
    assert.ok(request instanceof http.ClientRequest);
    requests += 1;
    request.on('close', () => {
      requestClosed = true;
      checkClosed();
    });
    const destroyRequest = request.destroy.bind(request);
    request.destroy = (error?: Error): http.ClientRequest => {
      requestDestroy = true;
      checkDestroy();
      if (holdAcknowledgement) return destroyRequest(error);
      pendingDispatches.push(gate.promise.then(() => destroyRequest(error)));
      return request;
    };
    request.prependListener('response', (response: http.IncomingMessage) => {
      response.on('close', () => {
        responseClosed = true;
        checkClosed();
      });
      const destroyResponse = response.destroy.bind(response);
      response.destroy = (error?: Error): http.IncomingMessage => {
        responseDestroy = true;
        checkDestroy();
        if (holdAcknowledgement) return destroyResponse(error);
        pendingDispatches.push(gate.promise.then(() => destroyResponse(error)));
        return response;
      };
      if (holdAcknowledgement) holdCloseEvent(response);
    });
    if (holdAcknowledgement) holdCloseEvent(request);
    return request;
  },
});
function holdCloseEvent(emitter: http.ClientRequest | http.IncomingMessage): void {
  const emit = emitter.emit;
  Object.defineProperty(emitter, 'emit', {
    configurable: true,
    value: (event: string | symbol, ...args: unknown[]): boolean => {
      if (event === 'close') {
        closeRequested.release();
        pendingDispatches.push(
          gate.promise.then(() => Reflect.apply(emit, emitter, [event, ...args])),
        );
        return true;
      }
      const result: unknown = Reflect.apply(emit, emitter, [event, ...args]);
      assert.equal(typeof result, 'boolean');
      return result === true;
    },
  });
}
fs.promises.open = async (path, flags, permissions) => {
  const file = await originalOpen(path, flags, permissions);
  if (String(path).includes('media-v1.')) {
    if (failWrite)
      file.write = () => {
        writes += 1;
        return Promise.reject(Object.assign(new Error('fixture filesystem EIO'), { code: 'EIO' }));
      };
    const close = file.close.bind(file);
    file.close = async () => {
      await close();
      descriptorClosed = true;
      fileClosed.release();
    };
  }
  return file;
};
syncBuiltinESMExports();
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'audio/L16' });
  response.write(Buffer.from([1, 2]));
  if (holdAcknowledgement) response.end();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address !== null && typeof address !== 'string');
const options = {
  mimeType: 'audio/L16',
  maxBytes: 100,
  localEndpoint: { host: '127.0.0.1', port: address.port },
};
const url = `http://127.0.0.1:${address.port}/native-fixture`;
const store = new FilesystemMediaStore(join(scratch, 'cas'));
const track = <T>(promise: Promise<T>): Promise<T> =>
  promise.finally(() => {
    settled = true;
  });
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

try {
  if (mode === 'lazy') {
    const source = streamMediaBytes(url, { ...options, mimeType: 'not-a-media-type' });
    iterator = source[Symbol.asyncIterator]();
    assert.equal(requests, 0, 'construction is lazy');
    let alreadyRegistered = false;
    try {
      registerNativeMediaIterator(iterator);
    } catch (error) {
      assert.ok(error instanceof MediaAdmissionError);
      assert.equal(error.code, 'source_failed');
      alreadyRegistered = true;
    }
    assert.equal(alreadyRegistered, true, 'MEDIA_NATIVE_CONSTRUCTOR_REGISTERED');
    await closeMediaIterator(iterator);
    assert.equal(requests, 0, 'unstarted close opens no native transport');
    const firstPull = streamMediaBytes(url, { ...options, mimeType: 'not-a-media-type' })[
      Symbol.asyncIterator
    ]();
    await assert.rejects(firstPull.next(), MediaAdmissionError);
    assert.equal(requests, 0, 'lazy invalid MIME refuses on first pull');
  } else if (mode === 'injected-foreign') {
    const source = streamMediaBytes(
      url,
      { ...options, mimeType: 'not-a-media-type' },
      { ...nodeMediaEgressDeps },
    );
    iterator = source[Symbol.asyncIterator]();
    let explicitlyAdopted = true;
    try {
      registerNativeMediaIterator(iterator);
    } catch (error) {
      assert.ok(error instanceof MediaAdmissionError);
      assert.equal(error.code, 'source_failed');
      explicitlyAdopted = false;
    }
    assert.equal(explicitlyAdopted, true, 'MEDIA_NATIVE_INJECTED_FOREIGN');
    assert.equal(requests, 0, 'injected construction and explicit opt-in remain lazy');
    await closeMediaIterator(iterator);
    assert.equal(requests, 0, 'closing an unstarted injected iterator opens no transport');
  } else if (mode === 'deinline-eio' || mode === 'direct-store-eio') {
    const source = streamMediaBytes(url, options);
    iterator = source[Symbol.asyncIterator]();
    const operation =
      mode === 'direct-store-eio'
        ? store.putStream(source, 'audio/L16')
        : deInlineMedia(
            { type: 'media', mimeType: 'audio/L16', source: { kind: 'url', url } },
            store,
            { streamUrl: () => source },
          );
    outcome = track(operation).then(
      () => assert.fail('EIO must refuse publication'),
      (error: unknown) => {
        assert.ok(error instanceof MediaStoreFilesystemError);
        assert.equal(error.reason, 'io');
        return error;
      },
    );
    await checkpoint(destroying.promise, 'both real destroy calls');
    await checkpoint(fileClosed.promise, 'store-owned file closed before native join');
    await turn();
    assert.equal(writes, 1);
    assert.equal(descriptorClosed, true);
    assert.deepEqual(await readdir(join(scratch, 'cas')), []);
    assert.equal(requestClosed, false);
    assert.equal(responseClosed, false);
    assert.equal(settled, false, 'FS_CAUSAL_MEDIA_NATIVE_CLOSE_JOIN');
    gate.release();
    await outcome;
    await checkpoint(physicalClosed.promise, 'both real closes');
  } else if (mode === 'abandon') {
    iterator = streamMediaBytes(url, options)[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, Buffer.from([1, 2]));
    assert.ok(iterator.return !== undefined);
    outcome = track(iterator.return());
    await checkpoint(destroying.promise, 'direct iterator abandonment');
    await turn();
    assert.equal(settled, false, 'FS_CAUSAL_MEDIA_NATIVE_CLOSE_JOIN');
    const helperClose = closeMediaIterator(iterator);
    assert.equal(closeMediaIterator(iterator), helperClose, 'pending acknowledgement is cached');
    assert.equal(requestClosed, false);
    assert.equal(responseClosed, false);
    gate.release();
    await Promise.all([outcome, helperClose]);
    await checkpoint(physicalClosed.promise, 'direct and helper return join');
  } else if (mode === 'adopted-eof') {
    const source = streamMediaBytes(url, options);
    iterator = source[Symbol.asyncIterator]();
    const upstream = iterator;
    let first = true;
    let eofReported = false;
    const adopted: AsyncIterableIterator<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (first) {
          first = false;
          return upstream.next();
        }
        // A finite view must join upstream before *natural* EOF, as well as return.
        await closeMediaIterator(upstream);
        eofReported = true;
        return { done: true, value: undefined };
      },
      async return() {
        await closeMediaIterator(upstream);
        return { done: true, value: undefined };
      },
    };
    registerNativeMediaIterator(adopted);
    outcome = track(store.putStream(adopted, 'audio/L16'));
    await checkpoint(destroying.promise, 'finite-view upstream close');
    await turn();
    assert.equal(eofReported, false, 'FS_CAUSAL_MEDIA_ADOPTED_EOF_JOIN');
    assert.equal(settled, false, 'finite-view publication must remain pending');
    assert.equal(requestClosed, false);
    assert.equal(responseClosed, false);
    const unpublished = await readdir(join(scratch, 'cas'));
    assert.equal(
      unpublished.length,
      1,
      'finite-view CAS still owns exactly one unpublished temporary',
    );
    assert.ok(unpublished.every((name) => name.startsWith('media-v1.')));
    gate.release();
    assert.match(String(await outcome), /^media:\/\/sha256-/);
    await checkpoint(physicalClosed.promise, 'adopted EOF native retirement');
    assert.equal(eofReported, true);
  } else if (mode === 'eof' || mode === 'whole-buffer') {
    if (mode === 'whole-buffer') outcome = track(fetchMediaBytes(url, options));
    else {
      const source = streamMediaBytes(url, options);
      iterator = source[Symbol.asyncIterator]();
      outcome = track(store.putStream(source, 'audio/L16'));
    }
    await checkpoint(closeRequested.promise, 'natural EOF real close acknowledgement');
    await turn();
    assert.equal(settled, false, 'FS_CAUSAL_MEDIA_NATIVE_CLOSE_JOIN');
    gate.release();
    const value = await outcome;
    if (mode === 'whole-buffer') assert.deepEqual(value, new Uint8Array([1, 2]));
    else assert.match(String(value), /^media:\/\/sha256-/);
    await checkpoint(physicalClosed.promise, 'EOF native closure');
  } else assert.fail('unknown native lifecycle mode');
} catch (error) {
  const marker =
    error instanceof assert.AssertionError ? error.message.split('\n', 1)[0] : undefined;
  if (
    error instanceof assert.AssertionError &&
    ((error.actual === true &&
      error.expected === false &&
      (marker === 'FS_CAUSAL_MEDIA_NATIVE_CLOSE_JOIN' ||
        marker === 'FS_CAUSAL_MEDIA_ADOPTED_EOF_JOIN')) ||
      (error.actual === false &&
        error.expected === true &&
        (marker === 'MEDIA_NATIVE_INJECTED_FOREIGN' ||
          marker === 'MEDIA_NATIVE_CONSTRUCTOR_REGISTERED')))
  )
    witnessFailure = marker;
  else throw error;
} finally {
  gate.release();
  // Always release and join, including failed witnesses and faulted operations.
  await outcome?.catch(() => undefined);
  await iterator?.return?.();
  await Promise.allSettled(pendingDispatches);
  http.request = originalRequest;
  fs.promises.open = originalOpen;
  syncBuiltinESMExports();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  await rm(scratch, { recursive: true, force: true });
}
process.stdout.write(
  JSON.stringify({ mode, joined: true, witnessFailure: witnessFailure ?? null }) + '\n',
);
