import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MediaAdmissionError } from '@relavium/shared';

import { fetchMediaBytes, streamMediaBytes } from '../media-egress.js';
import { FilesystemMediaStore } from '../media-store.js';

function latch(): { promise: Promise<void>; release: () => void } {
  let release = (): void => assert.fail('latch not initialized');
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function checkpoint(promise: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('missing native close checkpoint')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const mode = process.argv[2];
const fixture = process.argv[3];
assert.ok(mode === 'whole-buffer' || mode === 'filesystem-store');
assert.ok(fixture !== undefined);
const headers: Readonly<Record<string, readonly string[]>> = {
  compatible: ['Content-Type', 'audio/L16'],
  'compatible-parameters': ['Content-Type', 'Audio/l16; rate=24000'],
  conflicting: ['Content-Type', 'image/png'],
  'compatible-conflicting': ['Content-Type', 'audio/L16', 'Content-Type', 'image/png'],
  'conflicting-compatible': ['Content-Type', 'image/png', 'Content-Type', 'audio/L16'],
  identical: ['Content-Type', 'audio/L16', 'Content-Type', 'audio/L16'],
  'parameters-conflicting': [
    'Content-Type',
    'audio/L16; private_header_sentinel=24000',
    'Content-Type',
    'image/png',
  ],
  'conflicting-parameters': [
    'Content-Type',
    'image/png',
    'Content-Type',
    'audio/L16; private_header_sentinel=24000',
  ],
  'mixed-header-case': ['content-TYPE', 'audio/L16', 'CONTENT-type', 'image/png'],
};
const fields = headers[fixture];
assert.ok(fields !== undefined);
const shouldAccept = fixture === 'compatible' || fixture === 'compatible-parameters';
const sample = Buffer.from([1, 2]);
const handle = 'media://sha256-' + createHash('sha256').update(sample).digest('hex');
const scratch = await mkdtemp(join(tmpdir(), 'relavium-native-headers-'));
const root = join(scratch, 'cas');
const store = new FilesystemMediaStore(root);
const gate = latch();
const closesQueued = latch();
const dispatches: Promise<unknown>[] = [];
const originalRequest = http.request;
let requestQueued = false;
let responseQueued = false;
let requestClosed = false;
let responseClosed = false;
let bodyEntries = 0;
let yields = 0;
let settled = false;
let admissionFailure: string | undefined;
let closeFailure: string | undefined;
type Outcome = { ok: true; value: Uint8Array | string } | { ok: false; error: unknown };
let outcome: Promise<Outcome> | undefined;

// Observe and gate the real native objects only. Transport, raw HTTP fields, bytes and
// production dependency selection stay intact. The queued events are always released/joined.
function holdCloseEvent(
  emitter: http.ClientRequest | http.IncomingMessage,
  request: boolean,
): void {
  const emit = emitter.emit;
  Object.defineProperty(emitter, 'emit', {
    configurable: true,
    value: (event: string | symbol, ...args: unknown[]): boolean => {
      if (event === 'close') {
        if (request) requestQueued = true;
        else responseQueued = true;
        if (requestQueued && responseQueued) closesQueued.release();
        dispatches.push(gate.promise.then(() => Reflect.apply(emit, emitter, [event, ...args])));
        return true;
      }
      const result: unknown = Reflect.apply(emit, emitter, [event, ...args]);
      assert.equal(typeof result, 'boolean');
      return result === true;
    },
  });
}
Object.defineProperty(http, 'request', {
  configurable: true,
  writable: true,
  value: (...args: unknown[]): http.ClientRequest => {
    const request: unknown = Reflect.apply(originalRequest, http, args);
    assert.ok(request instanceof http.ClientRequest);
    request.once('close', () => {
      requestClosed = true;
    });
    request.prependOnceListener('response', (response: http.IncomingMessage) => {
      response.once('close', () => {
        responseClosed = true;
      });
      const nativeIterator = response[Symbol.asyncIterator].bind(response);
      response[Symbol.asyncIterator] = () => {
        bodyEntries++;
        return nativeIterator();
      };
      holdCloseEvent(response, false);
    });
    holdCloseEvent(request, true);
    return request;
  },
});
syncBuiltinESMExports();
const server = http.createServer((_request, response) => {
  // The array sends separate raw header fields, unlike an already normalized record.
  response.writeHead(200, [...fields]);
  response.end(sample);
});

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const options = {
    mimeType: 'audio/L16',
    maxBytes: 100,
    localEndpoint: { host: '127.0.0.1', port: address.port },
  };
  const url = `http://127.0.0.1:${address.port}/synthetic-header-fixture`;
  const operation =
    mode === 'whole-buffer'
      ? fetchMediaBytes(url, options)
      : store.putStream(
          // This observation wrapper is intentionally foreign. Its next still joins the
          // original native generator's finally on rejection or EOF before reporting either.
          (async function* () {
            for await (const chunk of streamMediaBytes(url, options)) {
              yields++;
              yield chunk;
            }
          })(),
          'audio/L16',
        );
  outcome = operation.then(
    (value): Outcome => {
      settled = true;
      return { ok: true, value };
    },
    (error: unknown): Outcome => {
      settled = true;
      return { ok: false, error };
    },
  );
  await checkpoint(closesQueued.promise);
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.equal(settled, false, 'MEDIA_NATIVE_HEADER_CLOSE_JOIN');
    assert.equal(requestClosed, false, 'MEDIA_NATIVE_HEADER_CLOSE_JOIN');
    assert.equal(responseClosed, false, 'MEDIA_NATIVE_HEADER_CLOSE_JOIN');
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    closeFailure = 'MEDIA_NATIVE_HEADER_CLOSE_JOIN';
  }
  gate.release();
  const result = await outcome;
  await Promise.all(dispatches);
  assert.equal(requestClosed, true);
  assert.equal(responseClosed, true);
  try {
    if (shouldAccept) {
      assert.equal(result.ok, true, 'MEDIA_NATIVE_SINGLE_HEADER_CONTROL');
      if (result.ok) {
        if (mode === 'whole-buffer') assert.deepEqual(result.value, new Uint8Array(sample));
        else {
          assert.equal(result.value, handle);
          assert.deepEqual(await store.get(handle), new Uint8Array(sample));
          assert.ok(yields > 0);
        }
      }
      assert.equal(bodyEntries, 1);
    } else {
      assert.equal(result.ok, false, 'MEDIA_NATIVE_HEADER_MULTIPLICITY');
      if (!result.ok) {
        assert.ok(result.error instanceof MediaAdmissionError);
        assert.deepEqual(result.error, new MediaAdmissionError('descriptor_conflict'));
        assert.ok(!result.error.message.includes('private_header_sentinel'));
      }
      assert.equal(bodyEntries, 0, 'MEDIA_NATIVE_HEADER_MULTIPLICITY');
      assert.equal(yields, 0, 'MEDIA_NATIVE_HEADER_MULTIPLICITY');
      if (mode === 'filesystem-store') {
        assert.deepEqual(await store.listHandles(), []);
        assert.deepEqual(await readdir(root), []);
        await assert.rejects(store.get(handle), { reason: 'missing' });
      }
    }
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    admissionFailure = shouldAccept
      ? 'MEDIA_NATIVE_SINGLE_HEADER_CONTROL'
      : 'MEDIA_NATIVE_HEADER_MULTIPLICITY';
  }
} finally {
  gate.release();
  await outcome;
  await Promise.allSettled(dispatches);
  http.request = originalRequest;
  syncBuiltinESMExports();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  await rm(scratch, { recursive: true, force: true });
}
process.stdout.write(
  JSON.stringify({
    mode,
    fixture,
    joined: true,
    admissionFailure: admissionFailure ?? null,
    closeFailure: closeFailure ?? null,
  }) + '\n',
);
