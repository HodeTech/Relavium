import { randomUUID } from 'node:crypto';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { FilesystemMediaStore } from './media-store.js';
import { MediaTemporaryMaintenanceError } from './media-store-temporaries.js';

// Several native process starts and explicit IPC barriers belong to one case. Their joined
// lifecycle needs a case budget separate from Vitest's five-second single-operation default.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

interface Worker {
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  wait: (stage: string) => Promise<Record<string, unknown>>;
  release: () => void;
  stop: () => Promise<void>;
}
let base: string;
let root: string;
const workers: Worker[] = [];
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'relavium-temp-protocol-'));
  root = join(base, 'cas');
  mkdirSync(root);
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});
function worker(mode: string, stage?: string): Worker {
  const child = fork(
    fileURLToPath(new URL('./fixtures/media-temporary-worker.ts', import.meta.url)),
    [root, mode, ...(stage === undefined ? [] : [stage])],
    {
      execArgv: [
        '--experimental-strip-types',
        '--import',
        new URL('./fixtures/media-temporary-register.ts', import.meta.url).href,
      ],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let diagnostic = '';
  const phases: Array<{ phase: string; milliseconds: number }> = [];
  const started = performance.now();
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let faulted = false;
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-4000);
  });
  const messages: Array<Record<string, unknown>> = [];
  const pending = new Set<() => void>();
  child.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null) {
      const value = Object.fromEntries(Object.entries(message));
      messages.push(value);
      if (
        typeof value['phase'] === 'string' &&
        [
          'loader-entry',
          'worker-entry',
          'store-imported',
          'producer-open',
          'writing',
          'done',
        ].includes(value['phase']) &&
        phases.length < 32
      )
        phases.push({ phase: value['phase'], milliseconds: performance.now() - started });
      for (const notify of pending) notify();
    }
  });
  let ended = false;
  const closed = new Promise<void>((resolve) => {
    child.on('error', (error) => {
      diagnostic = error.message;
      faulted = true;
      for (const notify of pending) notify();
    });
    child.once('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.once('close', () => {
      ended = true;
      for (const notify of pending) notify();
      resolve();
    });
  });
  const result: Worker = {
    child,
    closed,
    wait: (stage) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(check);
          reject(
            new Error(
              `native fixture did not reach ${stage}: ${JSON.stringify({ phases, exitCode, exitSignal, closed: ended, faulted })}: ${diagnostic}`,
            ),
          );
        }, 5000);
        const check = (): void => {
          const match = messages.find((message) =>
            stage === 'done' ? message['done'] === true : message['stage'] === stage,
          );
          if (match !== undefined) {
            clearTimeout(timer);
            pending.delete(check);
            resolve(match);
          } else if (
            ended ||
            faulted ||
            messages.some((message) => message['error'] !== undefined)
          ) {
            clearTimeout(timer);
            pending.delete(check);
            reject(new Error(`native fixture exited before ${stage}: ${diagnostic}`));
          }
        };
        pending.add(check);
        check();
      }),
    release: () => {
      if (child.connected) child.send('release');
    },
    stop: async () => {
      if (!ended) child.kill('SIGKILL');
      await closed;
    },
  };
  workers.push(result);
  return result;
}
function age(path: string, milliseconds = 25 * 60 * 60 * 1000): void {
  const when = new Date(Date.now() - milliseconds);
  utimesSync(path, when, when);
}
async function deadProducer(): Promise<{ path: string; pid: number }> {
  const producer = worker('producer');
  await producer.wait('writing');
  const name = readdirSync(root).find((name) => name.startsWith('media-v1.'));
  if (name === undefined || producer.child.pid === undefined)
    throw new Error('producer did not create temp');
  const path = join(root, name);
  age(path);
  await producer.stop();
  return { path, pid: producer.child.pid };
}

/** Production writer/reader vectors use real temp files and replace only native identity observations. */
async function exactIdentityClaims(): Promise<void> {
  const nativeStat = fs.lstatSync;
  const nativeUnlink = fs.promises.unlink;
  let inode = 0n;
  let interrupted = true;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('fixture absent owner'), { code: 'ESRCH' });
  });
  const unlink = vi.spyOn(fs.promises, 'unlink').mockImplementation(async (path) => {
    if (interrupted && basename(String(path)) === 'blob')
      throw Object.assign(new Error('fixture interrupted claim'), { code: 'EIO' });
    await nativeUnlink(path);
  });
  const snapshot = (...args: Parameters<typeof nativeStat>): ReturnType<typeof nativeStat> => {
    const info = nativeStat(...args);
    const name = basename(String(args[0]));
    if (info !== undefined && (name.startsWith('media-v1.') || name === 'blob'))
      Object.defineProperty(info, 'ino', {
        value: typeof info.ino === 'bigint' ? inode : Number(inode),
      });
    return info;
  };
  Object.defineProperty(fs, 'lstatSync', { value: snapshot });
  syncBuiltinESMExports();
  const makeClaim = async (
    label: string,
    value: bigint,
  ): Promise<{ dir: string; blob: string }> => {
    inode = value;
    interrupted = true;
    const vectorRoot = join(base, label);
    mkdirSync(vectorRoot);
    const source = join(vectorRoot, `media-v1.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(source, new Uint8Array([5, 6]));
    age(source);
    expect(await new FilesystemMediaStore(vectorRoot).sweepTemporaries()).toMatchObject({
      removed: 0,
      retained: 1,
      reasons: { io: 1 },
    });
    const name = readdirSync(vectorRoot).find((entry) => entry.startsWith('media-claim-v2.'));
    if (name === undefined) throw new Error('production writer did not leave an exact claim');
    interrupted = false;
    return { dir: join(vectorRoot, name), blob: join(vectorRoot, name, 'blob') };
  };
  try {
    // Both native values collapse to the same Number. The writer and reader must retain exact bits.
    const first = 1n << 53n;
    const collision = await makeClaim('collision', first);
    inode = first + 1n;
    expect(Number(first)).toBe(Number(inode));
    expect(
      {
        result: await new FilesystemMediaStore(join(base, 'collision')).sweepTemporaries(),
        exists: existsSync(collision.blob),
      },
      'MEDIA_TEMP_NATIVE_IDENTITY_PRECISION',
    ).toEqual({
      result: { removed: 0, retained: 1, reasons: { identity_changed: 1 } },
      exists: true,
    });
    for (const [index, value] of [
      BigInt(Number.MAX_SAFE_INTEGER),
      first,
      first + 1n,
      11193352636847878000n,
      (1n << 64n) - 1n,
      // Node's signed bigint stats: a 64-bit file ID with its top bit set reads negative (NI).
      -1n,
      -(1n << 63n),
    ].entries()) {
      const label = `exact-${index}`;
      const claim = await makeClaim(label, value);
      expect(
        await new FilesystemMediaStore(join(base, label)).sweepTemporaries(),
        'MEDIA_TEMP_NATIVE_IDENTITY_RECOVERY',
      ).toEqual({ removed: 1, retained: 0, reasons: {} });
      expect(existsSync(claim.dir)).toBe(false);
    }
    for (const [index, token] of ['00', '0z', 'z'.repeat(14), (1n << 64n).toString(36)].entries()) {
      const label = `malformed-${index}`;
      const claim = await makeClaim(label, 123n);
      const fields = basename(claim.dir).split('.');
      fields[4] = token;
      const altered = join(base, label, fields.join('.'));
      renameSync(claim.dir, altered);
      expect(await new FilesystemMediaStore(join(base, label)).sweepTemporaries()).toEqual({
        removed: 0,
        retained: 1,
        reasons: { malformed: 1 },
      });
      expect(existsSync(join(altered, 'blob'))).toBe(true);
    }
    for (const value of [123n, first]) {
      const label = `legacy-${value}`;
      const claim = await makeClaim(label, value);
      const legacy = join(
        base,
        label,
        basename(claim.dir).replace('media-claim-v2.', 'media-claim-v1.'),
      );
      renameSync(claim.dir, legacy);
      const safe = value === 123n;
      expect(await new FilesystemMediaStore(join(base, label)).sweepTemporaries()).toEqual(
        safe
          ? { removed: 1, retained: 0, reasons: {} }
          : { removed: 0, retained: 1, reasons: { malformed: 1 } },
      );
      expect(existsSync(join(legacy, 'blob'))).toBe(!safe);
    }
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: nativeStat });
    unlink.mockRestore();
    kill.mockRestore();
    syncBuiltinESMExports();
  }
}

it('uses exclusive private owner records and only absent old producers are removed', async () => {
  const producer = worker('producer');
  await producer.wait('writing');
  const name = readdirSync(root).find((name) => name.startsWith('media-v1.'));
  if (name === undefined) throw new Error('missing temp');
  const path = join(root, name);
  age(path);
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  const live = await new FilesystemMediaStore(root).sweepTemporaries();
  expect(live, 'MEDIA_TEMP_OWNER_ABSENCE').toEqual({
    removed: 0,
    retained: 1,
    reasons: { owner_live: 1 },
  });
  producer.release();
  const published = await producer.wait('done');
  expect(published['handle']).toMatch(/^media:\/\/sha256-/);
  await producer.closed;
  // An error is a diagnostic, including on a real already-started fixture. It must
  // neither suppress owned cancellation nor acknowledge the stderr/IPC close.
  const faultedProducer = worker('producer');
  await faultedProducer.wait('writing');
  const kill = vi.spyOn(faultedProducer.child, 'kill');
  let actualClose = false;
  const actualClosed = new Promise<void>((resolve) =>
    faultedProducer.child.once('close', () => {
      actualClose = true;
      resolve();
    }),
  );
  try {
    faultedProducer.child.emit('error', new Error('synthetic already-started fixture error'));
    const stopped = faultedProducer.stop();
    expect(kill, 'MEDIA_FIXTURE_ERROR_IS_NOT_CLOSE').toHaveBeenCalledExactlyOnceWith('SIGKILL');
    await stopped;
    expect(actualClose, 'MEDIA_FIXTURE_ERROR_IS_NOT_CLOSE').toBe(true);
  } finally {
    if (!actualClose) faultedProducer.child.kill('SIGKILL');
    await actualClosed;
    kill.mockRestore();
  }
  // The interrupted writer is a separate old-producer vector below.
  for (const name of readdirSync(root).filter((entry) => entry.startsWith('media-v1.')))
    rmSync(join(root, name));
  const second = await deadProducer();
  const result = await new FilesystemMediaStore(root).sweepTemporaries();
  expect(result).toEqual({ removed: 1, retained: 0, reasons: {} });
  expect(readdirSync(root)).not.toContain(basename(second.path));
});

it('retains young, future, reused PID, permission-denied, unknown and malformed owners with fixed counts', async () => {
  const dead = await deadProducer();
  const original = statSync(dead.path);
  const now = Date.now();
  utimesSync(dead.path, new Date(now), new Date(now));
  expect(
    await new FilesystemMediaStore(root).sweepTemporaries({ now }),
    'MEDIA_TEMP_MINIMUM_AGE',
  ).toMatchObject({
    reasons: { too_young: 1 },
  });
  utimesSync(dead.path, new Date(now + 60000), new Date(now + 60000));
  expect(
    await new FilesystemMediaStore(root).sweepTemporaries({ now }),
    'MEDIA_TEMP_FUTURE_TIMESTAMP',
  ).toMatchObject({
    reasons: { future_timestamp: 1 },
  });
  utimesSync(dead.path, original.atime, original.mtime);
  for (const state of ['live', 'EPERM', 'EIO']) {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (state === 'live') return true;
      throw Object.assign(new Error('private owner diagnostic'), { code: state });
    });
    const result = await new FilesystemMediaStore(root).sweepTemporaries();
    expect(result, 'MEDIA_TEMP_OWNER_UNCERTAINTY').toMatchObject({
      removed: 0,
      retained: 1,
      reasons: { [state === 'live' ? 'owner_live' : 'owner_unknown']: 1 },
    });
    kill.mockRestore();
  }
  writeFileSync(join(root, 'media-v1.bad-owner.tmp'), 'private body');
  const result = await new FilesystemMediaStore(root).sweepTemporaries();
  expect(result).toEqual({ removed: 1, retained: 1, reasons: { malformed: 1 } });
  expect(JSON.stringify(result)).not.toContain('private');
});

it('two real sweepers atomically claim one old producer without double deletion or overwrite', async () => {
  await deadProducer();
  const first = worker('sweep', 'preclaim');
  const second = worker('sweep', 'preclaim');
  await Promise.all([first.wait('preclaim'), second.wait('preclaim')]);
  expect(readdirSync(root).filter((name) => name.startsWith('media-claim-'))).toHaveLength(2);
  first.release();
  second.release();
  const results = await Promise.all([first.wait('done'), second.wait('done')]);
  await Promise.all([first.closed, second.closed]);
  const removed = results
    .map((value) => value['result'])
    .reduce<number>(
      (sum, value) =>
        sum +
        (typeof value === 'object' &&
        value !== null &&
        'removed' in value &&
        typeof value.removed === 'number'
          ? value.removed
          : 0),
      0,
    );
  expect({ removed, remaining: readdirSync(root) }, 'MEDIA_TEMP_ATOMIC_CLAIM').toEqual({
    removed: 1,
    remaining: [],
  });
});

it.each(['preclaim', 'moved', 'postunlink'])(
  'recovers a killed claimant at the native %s barrier',
  async (stage) => {
    await deadProducer();
    const claimant = worker('sweep', stage);
    await claimant.wait(stage);
    const before = await new FilesystemMediaStore(root).sweepTemporaries();
    expect(before.reasons['claimant_live'], 'MEDIA_TEMP_LIVE_CLAIMANT').toBe(1);
    await claimant.stop();
    const result = await new FilesystemMediaStore(root).sweepTemporaries();
    expect(
      { result, remaining: readdirSync(root) },
      'MEDIA_TEMP_DEAD_CLAIM_RECOVERY',
    ).toMatchObject({ result: { retained: 0 }, remaining: [] });
  },
);

it('recovers a second crash after the recovery marker exclusive open', async () => {
  await deadProducer();
  const claimant = worker('sweep', 'moved');
  await claimant.wait('moved');
  await claimant.stop();
  const recovery = worker('sweep', 'recovery');
  await recovery.wait('recovery');
  await recovery.stop();
  const result = await new FilesystemMediaStore(root).sweepTemporaries();
  expect({ result, remaining: readdirSync(root) }, 'MEDIA_TEMP_RECOVERY_CRASH').toEqual({
    result: { removed: 1, retained: 0, reasons: {} },
    remaining: [],
  });
});

it('retains a mismatched claimed file identity and corrupt claim children', async () => {
  await deadProducer();
  const claimant = worker('sweep', 'moved');
  await claimant.wait('moved');
  await claimant.stop();
  const name = readdirSync(root).find((name) => name.startsWith('media-claim-'));
  if (name === undefined) throw new Error('missing claim');
  const dir = join(root, name);
  const blob = join(dir, 'blob');
  // Preserve the original inode elsewhere so the replacement cannot reuse it.
  linkSync(blob, join(base, 'original'));
  rmSync(blob);
  writeFileSync(blob, new Uint8Array([5, 6]));
  age(blob);
  const result = await new FilesystemMediaStore(root).sweepTemporaries();
  expect(result, 'MEDIA_TEMP_CLAIM_IDENTITY').toEqual({
    removed: 0,
    retained: 1,
    reasons: { identity_changed: 1 },
  });
  writeFileSync(join(dir, 'unrecognized'), 'keep');
  expect(await new FilesystemMediaStore(root).sweepTemporaries()).toMatchObject({
    reasons: { malformed: 1 },
  });
  await exactIdentityClaims();
});

it('requires BOTH runtime flags and deletes only the two exact offline legacy grammars', async () => {
  const rootOld = `stream.${randomUUID()}.tmp`;
  const shardOld = `${'a'.repeat(62)}.${randomUUID()}.tmp`;
  mkdirSync(join(root, 'ab'));
  writeFileSync(join(root, rootOld), 'old');
  writeFileSync(join(root, 'ab', shardOld), 'old');
  for (const name of ['stray.tmp', 'stream.not-a-uuid.tmp', '.save.00000000.tmp'])
    writeFileSync(join(root, name), 'keep');
  const store = new FilesystemMediaStore(root);
  for (const options of [
    {},
    { legacyOffline: true },
    { force: true },
    { legacyOffline: 'true', force: true },
  ]) {
    // Reflect.apply supplies hostile runtime data without casting it into the trusted signature.
    await expect(
      Reflect.apply(store.pruneLegacyTemporaries.bind(store), undefined, [options]),
    ).rejects.toMatchObject({ reason: 'flags_required' });
  }
  expect(await store.sweepTemporaries()).toMatchObject({
    removed: 0,
    reasons: { legacy_offline_required: 2 },
  });
  expect(await store.pruneLegacyTemporaries({ legacyOffline: true, force: true })).toEqual({
    removed: 2,
    retained: 0,
    reasons: {},
  });
  expect(readdirSync(root).sort()).toEqual(
    ['.save.00000000.tmp', 'ab', 'stray.tmp', 'stream.not-a-uuid.tmp'].sort(),
  );
});

it('legacy preflight refuses a live producer before deleting any legacy file', async () => {
  writeFileSync(join(root, `stream.${randomUUID()}.tmp`), 'old');
  const producer = worker('producer');
  await producer.wait('writing');
  const result = await Promise.allSettled([
    new FilesystemMediaStore(root).pruneLegacyTemporaries({ legacyOffline: true, force: true }),
  ]);
  expect(result, 'MEDIA_TEMP_LEGACY_LIVE_GUARD').toMatchObject([
    { status: 'rejected', reason: { reason: 'producer_active' } },
  ]);
  expect(readdirSync(root).filter((name) => name.startsWith('stream.'))).toHaveLength(1);
});

it('maintenance marker blocks a concurrent new producer and is held through deletion', async () => {
  writeFileSync(join(root, `stream.${randomUUID()}.tmp`), 'old');
  const maintainer = worker('legacy', 'maintenance');
  await maintainer.wait('maintenance');
  await expect(
    new FilesystemMediaStore(root).put(new Uint8Array([1, 2]), 'audio/L16'),
  ).rejects.toBeInstanceOf(MediaTemporaryMaintenanceError);
  maintainer.release();
  expect(await maintainer.wait('done'), 'MEDIA_TEMP_MAINTENANCE_HANDSHAKE').toMatchObject({
    done: true,
    result: { removed: 1 },
  });
  await maintainer.closed;
  expect(readdirSync(root)).toEqual([]);
});

it('producer post-open recheck refuses a maintainer admitted after its first check', async () => {
  const producer = worker('producer', 'producer-open');
  await producer.wait('producer-open');
  const maintainer = worker('legacy', 'maintenance');
  await maintainer.wait('maintenance');
  producer.release();
  expect(await producer.wait('done'), 'MEDIA_TEMP_PRODUCER_RECHECK').toMatchObject({
    done: true,
    error: 'MediaTemporaryMaintenanceError',
  });
  await producer.closed;
  maintainer.release();
  expect(await maintainer.wait('done')).toMatchObject({ done: true, result: { removed: 0 } });
  await maintainer.closed;
  expect(readdirSync(root)).toEqual([]);
});

it('never provisions an absent root or follows legacy symlink/hardlink candidates', async () => {
  const absent = join(base, 'absent');
  const store = new FilesystemMediaStore(absent);
  expect(await store.sweepTemporaries()).toEqual({ removed: 0, retained: 0, reasons: {} });
  expect(await store.pruneLegacyTemporaries({ legacyOffline: true, force: true })).toEqual({
    removed: 0,
    retained: 0,
    reasons: {},
  });
  expect(readdirSync(base)).toEqual(['cas']);
  const victim = join(base, 'victim');
  writeFileSync(victim, 'keep');
  const candidate = join(root, `stream.${randomUUID()}.tmp`);
  symlinkSync(victim, candidate);
  await expect(
    new FilesystemMediaStore(root).pruneLegacyTemporaries({ legacyOffline: true, force: true }),
  ).rejects.toMatchObject({ reason: 'unsafe_path' });
  rmSync(candidate);
  linkSync(victim, candidate);
  await expect(
    new FilesystemMediaStore(root).pruneLegacyTemporaries({ legacyOffline: true, force: true }),
  ).rejects.toMatchObject({ reason: 'unsafe_path' });
  expect(statSync(victim).size).toBe(4);
});

it('revalidates the exact original identity after initial claim rename', async () => {
  await deadProducer();
  const claimant = worker('sweep', 'moved');
  await claimant.wait('moved');
  const name = readdirSync(root).find((entry) => entry.startsWith('media-claim-'));
  if (name === undefined) throw new Error('missing claimed directory');
  const blob = join(root, name, 'blob');
  linkSync(blob, join(base, 'original-claimed'));
  rmSync(blob);
  writeFileSync(blob, new Uint8Array([7, 8]));
  claimant.release();
  const result = await claimant.wait('done');
  await claimant.closed;
  expect(
    { result, exists: existsSync(blob), size: existsSync(blob) ? statSync(blob).size : undefined },
    'MEDIA_TEMP_INITIAL_CLAIM_IDENTITY',
  ).toMatchObject({
    result: { result: { retained: 1, reasons: { unsafe_entry: 1 } } },
    exists: true,
    size: 2,
  });
});

it('two real recovery sweepers retain competing markers and eventually remove one claim', async () => {
  await deadProducer();
  const claimant = worker('sweep', 'moved');
  await claimant.wait('moved');
  await claimant.stop();
  const first = worker('sweep', 'recovery');
  const second = worker('sweep', 'recovery');
  await Promise.all([first.wait('recovery'), second.wait('recovery')]);
  first.release();
  second.release();
  const results = await Promise.all([first.wait('done'), second.wait('done')]);
  await Promise.all([first.closed, second.closed]);
  let removed = 0;
  for (const result of results) {
    const counts = result['result'];
    if (
      typeof counts !== 'object' ||
      counts === null ||
      !('removed' in counts) ||
      typeof counts.removed !== 'number'
    )
      throw new Error('native recovery failed');
    removed += counts.removed;
  }
  removed += (await new FilesystemMediaStore(root).sweepTemporaries()).removed;
  expect({ removed, remaining: readdirSync(root) }, 'MEDIA_TEMP_RECOVERY_EXCLUSION').toEqual({
    removed: 1,
    remaining: [],
  });
});

it('recovers a killed recovery owner after it unlinked the claimed blob', async () => {
  await deadProducer();
  const claimant = worker('sweep', 'moved');
  await claimant.wait('moved');
  await claimant.stop();
  const recovery = worker('sweep', 'postunlink');
  await recovery.wait('postunlink');
  await recovery.stop();
  const result = await new FilesystemMediaStore(root).sweepTemporaries();
  expect({ result, remaining: readdirSync(root) }, 'MEDIA_TEMP_RECOVERY_POSTUNLINK').toEqual({
    result: { removed: 1, retained: 0, reasons: {} },
    remaining: [],
  });
});

it.each(['directory', 'rmdir'])(
  'counts the final recovery cleanup winner when its peer loses at %s',
  async (losingOperation) => {
    await deadProducer();
    const claimant = worker('sweep', 'moved');
    await claimant.wait('moved');
    await claimant.stop();
    const lastStage = losingOperation === 'directory' ? 'claim-removed' : 'claim-remove';
    const retaining = worker('sweep', `recovery,marker-removed,${lastStage}`);
    await retaining.wait('recovery');
    const deleting = worker(
      'sweep',
      `recovery,postunlink,marker-removed${losingOperation === 'rmdir' ? ',claim-remove' : ''}`,
    );
    await deleting.wait('recovery');

    // The first process observes its live peer and retains, then removes only its own marker.
    retaining.release();
    await retaining.wait('marker-removed');
    deleting.release();
    await deleting.wait('postunlink');
    deleting.release();
    await deleting.wait('marker-removed');

    // Both markers and the blob are gone. The retaining process wins the final native rmdir;
    // the deleting process resumes either before directory validation or after it, at rmdir.
    retaining.release();
    await retaining.wait(lastStage);
    if (losingOperation === 'rmdir') {
      deleting.release();
      await deleting.wait('claim-remove');
    }
    retaining.release();
    const winner = await retaining.wait('done');
    await retaining.closed;
    deleting.release();
    const loser = await deleting.wait('done');
    await deleting.closed;
    expect(
      { winner: winner['result'], loser: loser['result'], remaining: readdirSync(root) },
      'MEDIA_TEMP_RECOVERY_CLEANUP_WINNER',
    ).toEqual({
      winner: { removed: 1, retained: 0, reasons: {} },
      loser: { removed: 0, retained: 1, reasons: { claimant_live: 1 } },
      remaining: [],
    });
  },
);

it.each(['ENOENT', 'EIO'])(
  'classifies recovery directory-listing %s only after its own marker removal',
  async (errorCode) => {
    await deadProducer();
    const claimant = worker('sweep', 'moved');
    await claimant.wait('moved');
    await claimant.stop();
    const nativeReaddir = fs.readdirSync;
    let entered = false;
    const read = (...args: Parameters<typeof nativeReaddir>): ReturnType<typeof nativeReaddir> => {
      const path = String(args[0]);
      if (basename(path).startsWith('media-claim-') && nativeReaddir(path).length === 0) {
        entered = true;
        if (errorCode === 'ENOENT') fs.rmdirSync(path);
        else throw Object.assign(new Error('synthetic cleanup I/O failure'), { code: errorCode });
      }
      return nativeReaddir(...args);
    };
    Object.defineProperty(fs, 'readdirSync', { value: read });
    syncBuiltinESMExports();
    try {
      const result = await new FilesystemMediaStore(root).sweepTemporaries();
      expect(
        { entered, result, remaining: nativeReaddir(root).length },
        'MEDIA_TEMP_RECOVERY_LISTING_DISPOSITION',
      ).toEqual({
        entered: true,
        result: {
          removed: 0,
          retained: 1,
          reasons: errorCode === 'ENOENT' ? { claimant_live: 1 } : { io: 1 },
        },
        remaining: errorCode === 'ENOENT' ? 0 : 1,
      });
    } finally {
      Object.defineProperty(fs, 'readdirSync', { value: nativeReaddir });
      syncBuiltinESMExports();
    }
  },
);

it('refuses invalid injected clocks before deletion or root provisioning', async () => {
  const candidate = await deadProducer();
  const store = new FilesystemMediaStore(root);
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const [result] = await Promise.allSettled([store.sweepTemporaries({ now })]);
    expect(
      { result, size: statSync(candidate.path).size },
      'MEDIA_TEMP_ADMITTED_CLOCK',
    ).toMatchObject({ result: { status: 'rejected', reason: { reason: 'io' } }, size: 2 });
  }
  expect(await store.sweepTemporaries()).toEqual({ removed: 1, retained: 0, reasons: {} });
});

it('retains linked, directory and native FIFO producer entries without traversing them', async () => {
  const abandoned = await deadProducer();
  rmSync(abandoned.path);
  const victim = join(base, 'outside-target');
  writeFileSync(victim, new Uint8Array([9, 10]));
  const candidate = (): string => join(root, `media-v1.${abandoned.pid}.${randomUUID()}.tmp`);
  symlinkSync(victim, candidate());
  linkSync(victim, candidate());
  mkdirSync(candidate());
  let count = 3;
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [candidate()]);
    count++;
  }
  const result = await new FilesystemMediaStore(root).sweepTemporaries();
  expect(result, 'MEDIA_TEMP_UNSAFE_ENTRY').toEqual({
    removed: 0,
    retained: count,
    reasons: { unsafe_entry: count },
  });
  expect(statSync(victim).size).toBe(2);
});

it('legacy preflight refuses uncertain new owners before deleting any old format', async () => {
  await deadProducer();
  const legacy = `stream.${randomUUID()}.tmp`;
  writeFileSync(join(root, legacy), 'old');
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('private permission detail'), { code: 'EPERM' });
  });
  const [result] = await Promise.allSettled([
    new FilesystemMediaStore(root).pruneLegacyTemporaries({ legacyOffline: true, force: true }),
  ]);
  expect(
    { result, remaining: readdirSync(root).includes(legacy) },
    'MEDIA_TEMP_LEGACY_UNCERTAIN_GUARD',
  ).toMatchObject({
    result: { status: 'rejected', reason: { reason: 'owner_unknown' } },
    remaining: true,
  });
});
