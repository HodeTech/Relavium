import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { createClient, runMigrations } from './client.js';
import { createMediaReferenceStore } from './media-reference-store.js';
import { mediaObjects, mediaReferences } from './schema.js';

interface Worker {
  readonly child: ChildProcess;
  readonly joined: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  wait(stage: string): Promise<Record<string, unknown>>;
  release(): void;
  stop(): Promise<void>;
}
function spawnWorker(path: string, mode: string, barrier: string): Worker {
  const child = fork(
    fileURLToPath(new URL('./fixtures/media-metadata-worker.ts', import.meta.url)),
    [path, mode, barrier],
    {
      execArgv: [
        '--experimental-strip-types',
        '--import',
        new URL('./fixtures/media-temporary-register.ts', import.meta.url).href,
      ],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  const messages: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  let ended = false;
  let diagnostic = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-4000);
  });
  child.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null) {
      messages.push(Object.fromEntries(Object.entries(message)));
      for (const notify of listeners) notify();
    }
  });
  const joined = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error) => {
      diagnostic = error.message;
      ended = true;
      for (const notify of listeners) notify();
      resolve({ code: -1, signal: null });
    });
    child.once('exit', (code, signal) => {
      ended = true;
      for (const notify of listeners) notify();
      resolve({ code, signal });
    });
  });
  return {
    child,
    joined,
    wait: (stage) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Metadata fixture did not reach ${stage}: ${diagnostic}`));
        }, 5000);
        const check = (): void => {
          const found = messages.find((message) => message['stage'] === stage);
          if (found === undefined && !ended) return;
          clearTimeout(timer);
          listeners.delete(check);
          if (found === undefined)
            reject(new Error(`Metadata fixture exited before ${stage}: ${diagnostic}`));
          else resolve(found);
        };
        listeners.add(check);
        check();
      }),
    release: () => {
      if (child.connected) child.send('release');
    },
    stop: async () => {
      if (!ended) child.kill('SIGKILL');
      await joined;
    },
  };
}

it('serializes incompatible native writers and rolls back the contender batch after a real busy retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relavium-media-metadata-native-'));
  const path = join(root, 'history.db');
  const barrier = join(root, 'owner-joined');
  const client = createClient(path);
  const workers: Worker[] = [];
  try {
    runMigrations(client.db);
    const owner = spawnWorker(path, 'owner', barrier);
    workers.push(owner);
    await owner.wait('locked');
    const contender = spawnWorker(path, 'contender', barrier);
    workers.push(contender);
    await contender.wait('ready');
    contender.release();
    await contender.wait('native-busy');
    owner.release();
    expect(await owner.wait('done')).toMatchObject({ result: 'committed' });
    expect(await owner.joined).toEqual({ code: 0, signal: null });
    await writeFile(barrier, 'joined');
    expect(
      await contender.wait('done'),
      'FS_CAUSAL_MEDIA_METADATA_NATIVE_SERIALIZATION',
    ).toMatchObject({
      result: 'descriptor_conflict',
      observedBusy: true,
    });
    expect(await contender.joined).toEqual({ code: 0, signal: null });
    expect(client.db.select().from(mediaObjects).all()).toMatchObject([
      {
        handle: `media://sha256-${'a'.repeat(64)}`,
        mimeType: 'audio/L16',
        byteLength: 2,
        createdAt: 1000,
        lastReferencedAt: 1000,
        deletedAt: null,
      },
    ]);
    expect(createMediaReferenceStore(client.db).listObjectHandles()).toEqual([
      `media://sha256-${'a'.repeat(64)}`,
    ]);
    expect(client.db.select().from(mediaReferences).all()).toEqual([]);
  } finally {
    await Promise.all(workers.map((worker) => worker.stop()));
    client.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
