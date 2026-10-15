import { existsSync } from 'node:fs';

import { MediaAdmissionError } from '@relavium/shared';

import { createClient } from '../client.js';
import { createMediaReferenceStore } from '../media-reference-store.js';

const path = process.argv[2];
const mode = process.argv[3];
const barrier = process.argv[4];
if (path === undefined || (mode !== 'owner' && mode !== 'contender') || barrier === undefined)
  throw new Error('Invalid metadata fixture invocation.');
const client = createClient(path);
const store = createMediaReferenceStore(client.db, () => (mode === 'owner' ? 1000 : 2000));
const descriptor = {
  handle: `media://sha256-${'a'.repeat(64)}`,
  mimeType: 'audio/L16',
  modality: 'audio',
  byteLength: 2,
} as const;
const release = new Promise<void>((resolve) => {
  process.once('message', (message: unknown) => {
    if (message !== 'release') throw new Error('Invalid metadata fixture barrier.');
    resolve();
  });
});
function report(message: object): void {
  process.send?.(message);
}
try {
  if (mode === 'owner') {
    // A fixture-owned outer IMMEDIATE transaction holds the actual native lock across IPC.
    client.sqlite.exec('BEGIN IMMEDIATE');
    store.recordObject(descriptor);
    report({ stage: 'locked' });
    await release;
    client.sqlite.exec('COMMIT');
    report({ stage: 'done', result: 'committed' });
  } else {
    client.sqlite.pragma('busy_timeout = 0');
    const transaction = client.db.transaction.bind(client.db);
    let observedBusy = false;
    client.db.transaction = (...args) => {
      try {
        return transaction(...args);
      } catch (error) {
        if (
          !observedBusy &&
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'SQLITE_BUSY'
        ) {
          observedBusy = true;
          report({ stage: 'native-busy' });
          // An explicit filesystem barrier holds this already-observed native error until the
          // parent has joined the competing commit. No timing delay is used as evidence of lock.
          const deadline = performance.now() + 5000;
          while (!existsSync(barrier)) {
            if (performance.now() >= deadline) throw new Error('Metadata fixture barrier expired.');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        throw error;
      }
    };
    report({ stage: 'ready' });
    await release;
    try {
      store.admitProducedMedia([
        { ...descriptor, handle: `media://sha256-${'b'.repeat(64)}` },
        { ...descriptor, byteLength: 4 },
      ]);
      report({ stage: 'done', result: 'unexpected-admission', observedBusy });
    } catch (error) {
      if (!(error instanceof MediaAdmissionError)) throw error;
      report({ stage: 'done', result: error.code, observedBusy });
    }
  }
} finally {
  client.sqlite.close();
  process.disconnect?.();
}
