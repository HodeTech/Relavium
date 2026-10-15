import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

import {
  closeMediaIterator,
  deInlineMedia,
  MediaAdmissionError,
  registerNativeMediaIterator,
} from '@relavium/shared';

import { FilesystemMediaStore, InMemoryMediaStore } from '../media-store.js';

const ownership = process.argv[2];
if (ownership !== 'foreign' && ownership !== 'registered') throw new Error('invalid fixture mode');
const nativeThen = (() => {
  const operation: unknown = Reflect.get(Promise.prototype, 'then');
  if (typeof operation !== 'function') throw new Error('missing intrinsic promise observer');
  return operation;
})();
const unhandled: Array<{ reason: unknown; promise: unknown }> = [];
const originals: unknown[] = [];
const privateReason = new Error('synthetic private return sentinel');
const accessorReason = new Error('synthetic private accessor sentinel');
const onUnhandled = (reason: unknown, promise: unknown): void => {
  unhandled.push({ reason, promise });
};
const onHandled = (): void => {};
process.on('unhandledRejection', onUnhandled);
process.on('rejectionHandled', onHandled);
const scratch = await mkdtemp(join(tmpdir(), 'relavium-return-diagnostics-'));
const report = {
  ownership,
  cases: 0,
  joined: false,
  unhandledRejections: 0,
  originalUnhandledRejections: 0,
  acknowledgementsCorrect: true,
  cachedOnce: true,
  pendingContract: true,
  primaryFailuresPreserved: true,
  unpublished: true,
  diagnosticsPrivate: true,
};

function latch(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const done = (): IteratorResult<Uint8Array> => ({ done: true, value: undefined });
const turn = async (): Promise<void> => {
  await setImmediate();
  await setImmediate();
};
const typed = (error: unknown, code: string): boolean =>
  error instanceof MediaAdmissionError &&
  error.code === code &&
  error.message === new MediaAdmissionError(error.code).message;
const privateDiagnostic = (error: unknown): boolean =>
  error === privateReason ||
  error === accessorReason ||
  (error instanceof Error && /synthetic private/.test(error.message));

type Outcome = { success: true } | { success: false; error: unknown };
function observe(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    () => ({ success: true }),
    (error: unknown) => ({ success: false, error }),
  );
}

interface Fixture {
  readonly returned: unknown;
  readonly branded: boolean;
  readonly rejects: boolean;
  readonly release: () => void;
  readonly join: () => Promise<void>;
}
function fixture(kind: string): Fixture {
  const gate = latch();
  let dispatch: Promise<void> | undefined;
  let returned: unknown;
  const branded = kind.startsWith('promise-') || kind.startsWith('cross-realm-');
  const rejects = kind.includes('reject') || kind === 'thenable-getter';
  if (kind.startsWith('cross-realm-')) {
    // A genuine different-realm Promise: no instanceof/prototype guess and no pre-observation.
    returned = runInNewContext('Promise.reject(new Error("synthetic private realm sentinel"))');
  } else if (branded) {
    returned = rejects ? Promise.reject(privateReason) : Promise.resolve(done());
  } else if (kind === 'thenable-getter') {
    returned = Object.defineProperty({}, 'then', {
      get: () => {
        throw accessorReason;
      },
    });
  } else {
    returned = {
      then: (
        resolve: (value: IteratorResult<Uint8Array>) => void,
        reject: (error: unknown) => void,
      ) => {
        if (kind === 'thenable-pending') dispatch = gate.promise.then(() => resolve(done()));
        else if (rejects) reject(privateReason);
        else resolve(done());
      },
    };
  }
  if (branded) {
    originals.push(returned);
    if (kind.endsWith('-getter'))
      Object.defineProperty(returned, 'then', {
        get: () => {
          throw accessorReason;
        },
      });
    if (kind.endsWith('-method'))
      Object.defineProperty(returned, 'then', {
        value: () => {
          throw accessorReason;
        },
      });
  }
  return {
    returned,
    branded,
    rejects,
    release: gate.release,
    join: async () => {
      await dispatch;
    },
  };
}

// Called ONLY after diagnostic checkpoints. Installing this observer earlier would hide the bug.
async function retire(current: Fixture | undefined): Promise<void> {
  if (current === undefined) return;
  current.release();
  await current.join();
  if (current.branded) {
    const retired: unknown = Reflect.apply(nativeThen, current.returned, [
      () => undefined,
      () => undefined,
    ]);
    await retired;
  }
  await turn();
}

async function direct(kind: string): Promise<void> {
  let current: Fixture | undefined;
  let calls = 0;
  const iterator: AsyncIterator<Uint8Array> = { next: () => Promise.resolve(done()) };
  Object.defineProperty(iterator, 'return', {
    value: () => {
      calls++;
      current = fixture(kind);
      return current.returned;
    },
  });
  if (ownership === 'registered') registerNativeMediaIterator(iterator);
  let outcome: Promise<Outcome> | undefined;
  try {
    const first = closeMediaIterator(iterator);
    report.cachedOnce &&= closeMediaIterator(iterator) === first && calls === 1;
    let settled = false;
    outcome = observe(first).then((result) => {
      settled = true;
      return result;
    });
    if (kind === 'thenable-pending') {
      await turn();
      report.pendingContract &&= settled === (ownership === 'foreign');
      current?.release();
    }
    const result = await outcome;
    report.acknowledgementsCorrect &&=
      ownership === 'registered' && current?.rejects === true
        ? !result.success && typed(result.error, 'source_failed')
        : result.success;
    if (!result.success) report.diagnosticsPrivate &&= !privateDiagnostic(result.error);
    await turn();
    report.cases++;
  } finally {
    current?.release();
    await outcome;
    await retire(current);
  }
}

async function consumer(mode: 'memory' | 'filesystem' | 'deinline'): Promise<void> {
  const root = join(scratch, mode);
  const store = mode === 'memory' ? new InMemoryMediaStore() : new FilesystemMediaStore(root);
  const invalid = new Uint8Array(128);
  const handle = 'media://sha256-' + createHash('sha256').update(invalid).digest('hex');
  let current: Fixture | undefined;
  let calls = 0;
  const iterator: AsyncIterableIterator<Uint8Array> = {
    next: () => Promise.resolve({ done: false, value: invalid }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  Object.defineProperty(iterator, 'return', {
    value: () => {
      calls++;
      // Create the rejected promise at actual return entry, after filesystem setup/byte refusal.
      current = fixture('promise-reject-getter');
      return current.returned;
    },
  });
  if (ownership === 'registered') registerNativeMediaIterator(iterator);
  let outcome: Promise<Outcome> | undefined;
  try {
    outcome = observe(
      mode === 'deinline'
        ? deInlineMedia(
            {
              type: 'media',
              mimeType: 'image/png',
              source: { kind: 'url', url: 'https://fixture.invalid/media' },
            },
            store,
            { streamUrl: () => iterator },
          )
        : store.putStream(iterator, 'image/png'),
    );
    const result = await outcome;
    report.primaryFailuresPreserved &&= !result.success && typed(result.error, 'invalid_format');
    if (!result.success) report.diagnosticsPrivate &&= !privateDiagnostic(result.error);
    report.cachedOnce &&= calls === 1;
    const absent = await observe(store.get(handle));
    report.unpublished &&= !absent.success;
    if (store instanceof FilesystemMediaStore)
      report.unpublished &&=
        (await store.listHandles()).length === 0 && (await readdir(root)).length === 0;
    await turn();
    report.cases++;
  } finally {
    await outcome;
    await retire(current);
  }
}

try {
  for (const kind of [
    'promise-fulfill',
    'promise-reject',
    'promise-fulfill-getter',
    'promise-reject-getter',
    'promise-reject-method',
    'cross-realm-reject-getter',
    'thenable-fulfill',
    'thenable-reject',
    'thenable-getter',
    'thenable-pending',
  ])
    await direct(kind);
  for (const mode of ['memory', 'filesystem', 'deinline'] as const) await consumer(mode);
} finally {
  await turn();
  report.unhandledRejections = unhandled.length;
  report.originalUnhandledRejections = unhandled.filter((event) =>
    originals.includes(event.promise),
  ).length;
  process.off('unhandledRejection', onUnhandled);
  process.off('rejectionHandled', onHandled);
  await rm(scratch, { recursive: true, force: true });
}
report.joined = true;
process.stdout.write(JSON.stringify(report) + '\n');
