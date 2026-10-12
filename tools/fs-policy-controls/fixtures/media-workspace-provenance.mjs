/** Actual built-entry ownership domain and deliberately unsupported separate-copy witness. */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
// These imports intentionally exercise built entry points, never source aliases.
import {
  createInMemoryHost,
  parseWorkflow,
  WorkflowEngine,
} from '../../../packages/core/dist/index.js';
import { FilesystemMediaStore } from '../../../packages/db/dist/index.js';
import { registerNativeMediaIterator } from '../../../packages/shared/dist/index.js';

const scratch = await mkdtemp(join(tmpdir(), 'relavium-media-workspace-domain-'));
function latch() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function source(register) {
  const held = latch(),
    started = latch();
  const returned = held.promise.then(() => ({ done: true, value: undefined }));
  const iterator = register({
    next: () => Promise.resolve({ done: false, value: new Uint8Array(128) }),
    return: () => {
      started.release();
      return returned;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  });
  return { iterator, held, started, returned };
}
async function checkpoint(promise) {
  const deadline = new globalThis.AbortController();
  try {
    await Promise.race([
      promise,
      setTimeout(10_000, undefined, { signal: deadline.signal }).then(() => {
        throw new Error('Built media-domain checkpoint missing');
      }),
    ]);
  } finally {
    deadline.abort();
  }
}
async function rawStore(register, native, directory) {
  const upstream = source(register);
  const store = new FilesystemMediaStore(directory);
  let settled = false;
  const result = store.putStream(upstream.iterator, 'image/png').then(
    () => {
      settled = true;
      return undefined;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  try {
    await checkpoint(upstream.started.promise);
    await setImmediate();
    assert.deepEqual(
      await readdir(directory),
      [],
      'Owned temporary removed before acknowledgement',
    );
    assert.equal(
      settled,
      !native,
      native ? 'MEDIA_BUILT_DB_NATIVE_JOIN' : 'MEDIA_SEPARATE_COPY_IS_FOREIGN',
    );
    upstream.held.release();
    await checkpoint(result);
    const failure = await result;
    assert.equal(failure?.code, 'invalid_format');
  } finally {
    upstream.held.release();
    await Promise.all([upstream.returned, result]);
  }
}

try {
  await rawStore(registerNativeMediaIterator, true, join(scratch, 'native'));
  const upstream = source(registerNativeMediaIterator);
  const root = join(scratch, 'core');
  const run = new WorkflowEngine({
    host: createInMemoryHost({
      mediaStore: new FilesystemMediaStore(root),
      streamMedia: () => upstream.iterator,
    }),
    executor: {
      execute: () =>
        Promise.resolve({
          kind: 'completed',
          output: {
            type: 'media',
            mimeType: 'image/png',
            source: { kind: 'url', url: 'https://fixture.invalid/media' },
          },
        }),
    },
  }).start({
    workflow: parseWorkflow(
      "schema_version: '1.0'\nworkflow:\n  id: built-domain\n  nodes: [{ id: work, type: output }]\n  edges: []",
    ),
  });
  let settled = false;
  const consume = (async () => {
    const events = [];
    for await (const event of run.events) events.push(event);
    await run.depart();
    settled = true;
    return events;
  })();
  void consume.catch(() => undefined);
  try {
    await checkpoint(upstream.started.promise);
    await setImmediate();
    assert.deepEqual(await readdir(root), []);
    assert.equal(settled, false, 'MEDIA_BUILT_CORE_DEINLINE_NATIVE_JOIN');
    upstream.held.release();
    await checkpoint(consume);
    assert.equal((await consume).at(-1)?.type, 'run:failed');
  } finally {
    upstream.held.release();
    run.cancel();
    await Promise.allSettled([upstream.returned, consume, run.depart()]);
  }

  // A physical copy gives media-iterator.js a genuinely different module identity.
  // A query string on index.js alone would still share its relative helper module.
  const separate = join(scratch, 'separate-shared');
  await cp(new URL('../../../packages/shared/dist', import.meta.url), separate, {
    recursive: true,
  });
  await writeFile(join(separate, 'package.json'), '{"type":"module"}');
  await symlink(
    new URL('../../../packages/shared/node_modules', import.meta.url).pathname,
    join(separate, 'node_modules'),
    'junction',
  );
  // eslint-disable-next-line no-restricted-syntax -- Exact owned physical copy is the negative module-domain fixture.
  const copy = await import(pathToFileURL(join(separate, 'index.js')).href);
  assert.notEqual(copy.registerNativeMediaIterator, registerNativeMediaIterator);
  await rawStore(copy.registerNativeMediaIterator, false, join(scratch, 'foreign'));
  process.stdout.write(
    'built shared/core/db share native ownership; separate shared copy remains foreign\n',
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
