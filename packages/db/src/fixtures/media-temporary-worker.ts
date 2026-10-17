import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

process.send?.({ phase: 'worker-entry' });

const root = process.argv[2];
const mode = process.argv[3];
const stage = process.argv[4];
if (root === undefined || mode === undefined) throw new Error('invalid fixture arguments');
let release = (): void => {
  throw new Error('uninitialized barrier');
};
const released = new Promise<void>((resolve) => {
  release = resolve;
});
const stageReleases = new Map<string, () => void>();
process.on('message', (message: unknown) => {
  if (message === 'release') {
    release();
    for (const resume of stageReleases.values()) resume();
  }
});
function report(value: unknown): void {
  process.send?.(value);
}
async function barrier(name: string): Promise<void> {
  if (!stage?.split(',').includes(name)) return;
  const resumed = new Promise<void>((resolve) => {
    stageReleases.set(name, resolve);
  });
  report({ stage: name, pid: process.pid });
  await resumed;
  stageReleases.delete(name);
}
const nativeRename = fs.promises.rename;
fs.promises.rename = async (from, to) => {
  if (basename(String(to)) === 'blob') await barrier('preclaim');
  await nativeRename(from, to);
  if (basename(String(to)) === 'blob') await barrier('moved');
};
const nativeUnlink = fs.promises.unlink;
fs.promises.unlink = async (path) => {
  await nativeUnlink(path);
  if (basename(String(path)) === 'blob') await barrier('postunlink');
  if (basename(String(path)).startsWith('recovery-v1.')) await barrier('marker-removed');
};
const nativeRmdir = fs.promises.rmdir;
fs.promises.rmdir = async (path, ...args) => {
  if (basename(String(path)).startsWith('media-claim-')) await barrier('claim-remove');
  await nativeRmdir(path, ...args);
  if (basename(String(path)).startsWith('media-claim-')) await barrier('claim-removed');
};
const nativeOpen = fs.promises.open;
fs.promises.open = async (path, ...args) => {
  const file = await nativeOpen(path, ...args);
  if (basename(String(path)).startsWith('recovery-v1.')) await barrier('recovery');
  if (basename(String(path)).startsWith('media-maintenance-v1.')) await barrier('maintenance');
  if (basename(String(path)).startsWith('media-v1.')) report({ phase: 'producer-open' });
  if (basename(String(path)).startsWith('media-v1.')) await barrier('producer-open');
  return file;
};
syncBuiltinESMExports();
const { FilesystemMediaStore } = await import('../media-store.js');
report({ phase: 'store-imported' });
const store = new FilesystemMediaStore(root);
try {
  if (mode === 'producer') {
    const handle = await store.putStream(
      (async function* () {
        yield new Uint8Array([1, 2]);
        report({ stage: 'writing', pid: process.pid });
        report({ phase: 'writing' });
        await released;
        yield new Uint8Array([3, 4]);
      })(),
      'audio/L16',
    );
    report({ done: true, handle });
    report({ phase: 'done' });
  } else if (mode === 'sweep') report({ done: true, result: await store.sweepTemporaries() });
  else if (mode === 'legacy')
    report({
      done: true,
      result: await store.pruneLegacyTemporaries({ legacyOffline: true, force: true }),
    });
  else throw new Error('invalid fixture mode');
} catch (error) {
  report({
    done: true,
    error: error instanceof Error ? error.name : 'unknown',
    reason:
      typeof error === 'object' && error !== null && 'reason' in error ? error.reason : undefined,
  });
} finally {
  process.disconnect?.();
}
