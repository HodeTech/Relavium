import { randomUUID } from 'node:crypto';
import {
  existsSync,
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { FilesystemMediaStore } from './media-store.js';
import { MediaStoreFilesystemError } from './media-store-paths.js';
import { isOwnedStorageFailure } from './storage-failure-facts.js';

const hooks = vi.hoisted(() => ({
  afterOpen: vi.fn<(file: FileHandle, path: string) => void>(),
  beforeUnlink: vi.fn<(path: string) => void | Promise<void>>(),
}));
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return {
    ...native,
    open: async (...args: Parameters<typeof native.open>) => {
      const file = await native.open(...args);
      hooks.afterOpen(file, String(args[0]));
      return file;
    },
    unlink: async (...args: Parameters<typeof native.unlink>) => {
      await hooks.beforeUnlink(String(args[0]));
      return native.unlink(...args);
    },
  };
});

type Scope = 'maintenance' | 'recovery';
const scopes: ReadonlyArray<Scope> = ['maintenance', 'recovery'];
const absentPid = 2147483647;
const bytes = new Uint8Array([1, 2]);

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'retains real marker deletion permission failure with private storage origin',
  async () => {
    const store = new FilesystemMediaStore(root);
    hooks.beforeUnlink.mockImplementation((path) => {
      if (marker('maintenance', path)) chmodSync(root, 0o500);
    });
    try {
      const error: unknown = await store
        .pruneLegacyTemporaries({ legacyOffline: true, force: true })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(MediaStoreFilesystemError);
      expect(isOwnedStorageFailure(error), 'DB_ORIGIN_MEDIA_DELETE_BOUNDARY').toBe(true);
      expect(
        readdirSync(root).filter((name) => name.startsWith('media-maintenance-v1.')),
      ).toHaveLength(1);
    } finally {
      chmodSync(root, 0o700);
    }
  },
);
let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-marker-acquisition-')));
  root = join(base, 'cas');
  mkdirSync(root);
  hooks.afterOpen.mockReset();
  hooks.beforeUnlink.mockReset();
  const nativeKill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === absentPid)
      throw Object.assign(new Error('private absent-owner fixture'), { code: 'ESRCH' });
    return nativeKill(pid, signal);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

function marker(scope: Scope, path: string): boolean {
  return basename(path).startsWith(
    scope === 'maintenance' ? 'media-maintenance-v1.' : 'recovery-v1.',
  );
}
function claim(): string {
  const staging = join(root, `claim-fixture-${randomUUID()}`);
  mkdirSync(staging);
  const blob = join(staging, 'blob');
  writeFileSync(blob, bytes);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(blob, old, old);
  const info = statSync(blob, { bigint: true });
  const name = `media-claim-v2.${absentPid}.${randomUUID()}.${info.dev.toString(36)}.${info.ino.toString(36)}.${absentPid}.${randomUUID()}`;
  const directory = join(root, name);
  renameSync(staging, directory);
  return directory;
}
function prepare(scope: Scope): { store: FilesystemMediaStore; directory: string } {
  return {
    store: new FilesystemMediaStore(root),
    directory: scope === 'recovery' ? claim() : root,
  };
}
function run(scope: Scope, store: FilesystemMediaStore): Promise<unknown> {
  return scope === 'maintenance'
    ? store.pruneLegacyTemporaries({ legacyOffline: true, force: true })
    : store.sweepTemporaries();
}
async function refusal(
  scope: Scope,
  pending: Promise<unknown>,
  reason: 'io' | 'unsafe_path',
): Promise<void> {
  const [result] = await Promise.allSettled([pending]);
  expect(result).toMatchObject(
    scope === 'maintenance'
      ? { status: 'rejected', reason: { name: 'MediaStoreFilesystemError', reason } }
      : {
          status: 'fulfilled',
          value: {
            removed: 0,
            retained: 1,
            reasons: { [reason === 'io' ? 'io' : 'unsafe_entry']: 1 },
          },
        },
  );
  expect(JSON.stringify(result)).not.toContain('private');
  if (result?.status === 'rejected') {
    const failure: unknown = result.reason;
    expect(failure).toBeInstanceOf(MediaStoreFilesystemError);
    if (!(failure instanceof MediaStoreFilesystemError))
      throw new Error('unclassified acquisition failure');
    expect(failure.message).not.toContain('private');
    expect(Reflect.get(failure, 'cause')).toBeUndefined();
  }
}
function latch(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {
    throw new Error('fixture latch was not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each(scopes)(
  '%s close failure retires its known marker and permits later publication/prune/recovery',
  async (scope) => {
    const { store, directory } = prepare(scope);
    let closed = 0;
    let markerPath: string | undefined;
    hooks.afterOpen.mockImplementation((file, path) => {
      if (!marker(scope, path)) return;
      markerPath = path;
      const close = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementation(async () => {
        await close();
        expect(file.fd).toBe(-1);
        closed++;
        throw new Error('private close diagnostic');
      });
    });
    await refusal(scope, run(scope, store), 'io');
    expect(
      { closed, present: markerPath !== undefined && existsSync(markerPath) },
      'DB_MARKER_CLOSE_FAILURE_CLEANUP',
    ).toEqual({ closed: 1, present: false });
    expect(readdirSync(directory)).toEqual(scope === 'recovery' ? ['blob'] : []);

    hooks.afterOpen.mockReset();
    const handle = await store.put(bytes, 'audio/L16');
    expect(await store.get(handle)).toEqual(bytes);
    const legacy = join(root, `stream.${randomUUID()}.tmp`);
    writeFileSync(legacy, 'legacy');
    expect(await store.pruneLegacyTemporaries({ legacyOffline: true, force: true })).toEqual({
      removed: 1,
      retained: 0,
      reasons: {},
    });
    if (scope === 'maintenance') claim();
    expect(await store.sweepTemporaries(), 'DB_MARKER_LATER_RECOVERY').toEqual({
      removed: 1,
      retained: 0,
      reasons: {},
    });
  },
);

it('failed recovery acquisition keeps an empty claim for one later counted recovery', async () => {
  const { store, directory } = prepare('recovery');
  rmSync(join(directory, 'blob'));
  let closed = 0;
  let markerPath: string | undefined;
  hooks.afterOpen.mockImplementation((file, path) => {
    if (!marker('recovery', path)) return;
    markerPath = path;
    const close = file.close.bind(file);
    vi.spyOn(file, 'close').mockImplementation(async () => {
      await close();
      expect(file.fd).toBe(-1);
      closed++;
      throw new Error('private close diagnostic');
    });
  });
  await refusal('recovery', run('recovery', store), 'io');
  expect(
    {
      closed,
      claimPresent: existsSync(directory),
      markerPresent: markerPath !== undefined && existsSync(markerPath),
    },
    'DB_RECOVERY_FAILED_ACQUISITION_RETAINS_CLAIM',
  ).toEqual({
    closed: 1,
    claimPresent: true,
    markerPresent: false,
  });
  expect(readdirSync(directory)).toEqual([]);
  hooks.afterOpen.mockReset();
  expect(await store.sweepTemporaries(), 'DB_RECOVERY_LATER_CLAIM_COUNTED_ONCE').toEqual({
    removed: 1,
    retained: 0,
    reasons: {},
  });
  expect(existsSync(directory)).toBe(false);
  expect(await store.sweepTemporaries()).toEqual({ removed: 0, retained: 0, reasons: {} });
});

it.each(scopes)(
  '%s fstat failure joins native close and retains a marker with unknown identity',
  async (scope) => {
    const { store, directory } = prepare(scope);
    let closed = 0;
    let markerPath: string | undefined;
    hooks.afterOpen.mockImplementation((file, path) => {
      if (!marker(scope, path)) return;
      markerPath = path;
      vi.spyOn(file, 'stat').mockRejectedValue(new Error('private fstat diagnostic'));
      const close = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementation(async () => {
        await close();
        expect(file.fd).toBe(-1);
        closed++;
      });
    });
    await refusal(scope, run(scope, store), 'io');
    expect(
      { closed, present: markerPath !== undefined && existsSync(markerPath) },
      'DB_MARKER_UNKNOWN_IDENTITY_RETAINED',
    ).toEqual({ closed: 1, present: true });
    expect(hooks.beforeUnlink).not.toHaveBeenCalled();
    if (scope === 'recovery')
      expect(readFileSync(join(directory, 'blob'))).toEqual(Buffer.from(bytes));
  },
);

it.each(scopes)(
  '%s fstat refusal survives a secondary native close failure without guessing identity',
  async (scope) => {
    const { store } = prepare(scope);
    let closed = 0;
    let markerPath: string | undefined;
    hooks.afterOpen.mockImplementation((file, path) => {
      if (!marker(scope, path)) return;
      markerPath = path;
      vi.spyOn(file, 'stat').mockRejectedValue(new MediaStoreFilesystemError('unsafe_path'));
      const close = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementation(async () => {
        await close();
        expect(file.fd).toBe(-1);
        closed++;
        throw new Error('private secondary close diagnostic');
      });
    });
    await refusal(scope, run(scope, store), 'unsafe_path');
    expect(
      { closed, present: markerPath !== undefined && existsSync(markerPath) },
      'DB_MARKER_FSTAT_FAILURE_PRECEDENCE',
    ).toEqual({ closed: 1, present: true });
    expect(hooks.beforeUnlink).not.toHaveBeenCalled();
  },
);

it.each(scopes)(
  '%s post-close ownership failure retains the replacement and the detached original',
  async (scope) => {
    const { store, directory } = prepare(scope);
    const original = join(base, 'original-marker');
    let markerPath: string | undefined;
    hooks.afterOpen.mockImplementation((file, path) => {
      if (!marker(scope, path)) return;
      markerPath = path;
      const close = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementation(async () => {
        await close();
        renameSync(path, original);
        writeFileSync(path, 'foreign marker');
      });
    });
    await refusal(scope, run(scope, store), 'unsafe_path');
    expect(markerPath).toBeDefined();
    if (markerPath === undefined) throw new Error('fixture did not open marker');
    expect(readFileSync(markerPath, 'utf8'), 'DB_MARKER_REPLACEMENT_RETAINED').toBe(
      'foreign marker',
    );
    expect(existsSync(original)).toBe(true);
    expect(hooks.beforeUnlink).not.toHaveBeenCalled();
    if (scope === 'recovery') expect(existsSync(join(directory, 'blob'))).toBe(true);
  },
);

it.each(scopes)(
  '%s captured extra-link identity never becomes deletion authority after link removal',
  async (scope) => {
    const { store } = prepare(scope);
    const extra = join(base, 'extra-marker-link');
    let markerPath: string | undefined;
    hooks.afterOpen.mockImplementation((file, path) => {
      if (!marker(scope, path)) return;
      markerPath = path;
      linkSync(path, extra);
      const close = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementation(async () => {
        await close();
        rmSync(extra);
        throw new Error('private close diagnostic');
      });
    });
    await refusal(scope, run(scope, store), 'io');
    if (markerPath === undefined) throw new Error('fixture did not open marker');
    expect(statSync(markerPath).nlink).toBe(1);
    expect(existsSync(markerPath), 'DB_MARKER_CAPTURED_ONE_LINK_REQUIRED').toBe(true);
    expect(hooks.beforeUnlink).not.toHaveBeenCalled();
  },
);

it.each(scopes)('%s close failure cannot clean through or renew a revoked root', async (scope) => {
  const { store } = prepare(scope);
  const originalRoot = join(base, 'original-root');
  let originalMarker: string | undefined;
  let replacementMarker: string | undefined;
  hooks.afterOpen.mockImplementation((file, path) => {
    if (!marker(scope, path)) return;
    const close = file.close.bind(file);
    vi.spyOn(file, 'close').mockImplementation(async () => {
      await close();
      const suffix = relative(root, path);
      renameSync(root, originalRoot);
      mkdirSync(root);
      originalMarker = join(originalRoot, suffix);
      replacementMarker = join(root, suffix);
      // Preserve the marker and (for recovery) claim-directory identities while
      // replacing their root. Only the original-root pin distinguishes this case.
      if (scope === 'recovery') renameSync(dirname(originalMarker), dirname(replacementMarker));
      else renameSync(originalMarker, replacementMarker);
      throw new Error('private close diagnostic');
    });
  });
  if (scope === 'maintenance') await refusal(scope, run(scope, store), 'io');
  else await expect(run(scope, store)).rejects.toMatchObject({ reason: 'unsafe_path' });
  expect(existsSync(originalRoot)).toBe(true);
  expect(originalMarker !== undefined && existsSync(originalMarker)).toBe(false);
  if (replacementMarker === undefined) throw new Error('fixture did not replace root');
  expect(existsSync(replacementMarker), 'DB_MARKER_ORIGINAL_ROOT_REQUIRED').toBe(true);
  expect(readFileSync(replacementMarker)).toEqual(Buffer.alloc(0));
  expect(hooks.beforeUnlink).not.toHaveBeenCalled();
  hooks.afterOpen.mockReset();
  await expect(store.put(bytes, 'audio/L16')).rejects.toMatchObject({ reason: 'unsafe_path' });
  await expect(
    store.pruneLegacyTemporaries({ legacyOffline: true, force: true }),
  ).rejects.toMatchObject({ reason: 'unsafe_path' });
  await expect(store.sweepTemporaries()).rejects.toMatchObject({ reason: 'unsafe_path' });
});

it('recovery close failure requires its exact original claim directory before marker cleanup', async () => {
  const { store, directory } = prepare('recovery');
  const original = join(base, 'original-claim');
  let replacementMarker: string | undefined;
  hooks.afterOpen.mockImplementation((file, path) => {
    if (!marker('recovery', path)) return;
    const close = file.close.bind(file);
    vi.spyOn(file, 'close').mockImplementation(async () => {
      await close();
      renameSync(directory, original);
      mkdirSync(directory);
      replacementMarker = join(directory, basename(path));
      // Move the exact original marker into the replacement directory. A marker-only
      // identity check must not acquire authority over this different parent.
      renameSync(join(original, basename(path)), replacementMarker);
      writeFileSync(join(directory, 'blob'), 'foreign claim blob');
      throw new Error('private close diagnostic');
    });
  });
  await refusal('recovery', run('recovery', store), 'io');
  if (replacementMarker === undefined) throw new Error('fixture did not replace claim');
  expect(existsSync(replacementMarker), 'DB_RECOVERY_ORIGINAL_DIRECTORY_REQUIRED').toBe(true);
  expect(readFileSync(replacementMarker)).toEqual(Buffer.alloc(0));
  expect(readFileSync(join(directory, 'blob'), 'utf8')).toBe('foreign claim blob');
  expect(readFileSync(join(original, 'blob'))).toEqual(Buffer.from(bytes));
  expect(readdirSync(original)).toEqual(['blob']);
  expect(hooks.beforeUnlink).not.toHaveBeenCalled();
});

it.each(scopes)(
  '%s secondary cleanup failure preserves the primary scrubbed close failure',
  async (scope) => {
    const { store } = prepare(scope);
    let closed = 0;
    let markerPath: string | undefined;
    hooks.afterOpen.mockImplementation((file, path) => {
      if (!marker(scope, path)) return;
      markerPath = path;
      const close = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementation(async () => {
        await close();
        closed++;
        throw new Error('private primary close diagnostic');
      });
    });
    hooks.beforeUnlink.mockImplementation((path) => {
      if (marker(scope, path)) throw new MediaStoreFilesystemError('unsafe_path');
    });
    await refusal(scope, run(scope, store), 'io');
    expect(
      { closed, present: markerPath !== undefined && existsSync(markerPath) },
      'DB_MARKER_PRIMARY_FAILURE_PRECEDENCE',
    ).toEqual({ closed: 1, present: true });
    expect(hooks.beforeUnlink).toHaveBeenCalledOnce();
  },
);

it.each(scopes)(
  '%s failed acquisition cleans only its own marker while a peer remains active',
  async (scope) => {
    const { store, directory } = prepare(scope);
    const firstEntered = latch();
    const firstRelease = latch();
    const peerEntered = latch();
    const peerRelease = latch();
    let firstMarker: string | undefined;
    let peerMarker: string | undefined;
    let opens = 0;
    hooks.afterOpen.mockImplementation((file, path) => {
      if (!marker(scope, path)) return;
      const first = opens++ === 0;
      if (first) firstMarker = path;
      else peerMarker = path;
      const close = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementation(async () => {
        await close();
        expect(file.fd).toBe(-1);
        if (first) {
          firstEntered.release();
          await firstRelease.promise;
          throw new Error('private first close diagnostic');
        }
        peerEntered.release();
        await peerRelease.promise;
      });
    });
    const pending = run(scope, store);
    const firstResult = Promise.allSettled([pending]);
    let peerResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await firstEntered.promise;
      peerResult = Promise.allSettled([run(scope, new FilesystemMediaStore(root))]);
      await peerEntered.promise;
      expect(readdirSync(directory).filter((name) => marker(scope, name))).toHaveLength(2);
      firstRelease.release();
      await refusal(scope, pending, 'io');
      if (firstMarker === undefined || peerMarker === undefined)
        throw new Error('fixture did not open both markers');
      expect(existsSync(firstMarker)).toBe(false);
      expect(existsSync(peerMarker), 'DB_MARKER_PEER_OWNERSHIP').toBe(true);
      expect(readdirSync(directory).filter((name) => marker(scope, name))).toEqual([
        basename(peerMarker),
      ]);
      if (scope === 'recovery') expect(existsSync(join(directory, 'blob'))).toBe(true);
    } finally {
      firstRelease.release();
      peerRelease.release();
      await firstResult;
      await peerResult;
    }
    if (peerResult === undefined) throw new Error('fixture did not start peer');
    expect(await peerResult).toEqual([
      {
        status: 'fulfilled',
        value: { removed: scope === 'maintenance' ? 0 : 1, retained: 0, reasons: {} },
      },
    ]);
    expect(readdirSync(root)).toEqual([]);
    hooks.afterOpen.mockReset();
    expect(await store.put(bytes, 'audio/L16')).toMatch(/^media:\/\/sha256-/);
  },
);

it.each(['bad-owner', 'future-version', 'future-protocol'])(
  'retains unknown maintenance prefix %s and refuses producer/offline authority',
  async (variant) => {
    const name =
      variant === 'bad-owner'
        ? 'media-maintenance-v1.bad-owner'
        : variant === 'future-version'
          ? `media-maintenance-v2.${process.pid}.00000000-0000-4000-8000-000000000000`
          : 'media-maintenance-future-protocol';
    const unknown = join(root, name);
    const legacy = join(root, `stream.${randomUUID()}.tmp`);
    writeFileSync(unknown, 'unknown protocol');
    writeFileSync(legacy, 'legacy');
    const store = new FilesystemMediaStore(root);
    await expect(store.put(bytes, 'audio/L16')).rejects.toMatchObject({
      reason: 'maintenance_active',
    });
    await expect(
      store.pruneLegacyTemporaries({ legacyOffline: true, force: true }),
    ).rejects.toMatchObject({ reason: 'owner_unknown' });
    expect(await store.sweepTemporaries(), 'DB_UNKNOWN_MAINTENANCE_REMAINS_FAIL_CLOSED').toEqual({
      removed: 0,
      retained: 2,
      reasons: { malformed: 1, legacy_offline_required: 1 },
    });
    expect(readFileSync(unknown, 'utf8')).toBe('unknown protocol');
    expect(readFileSync(legacy, 'utf8')).toBe('legacy');
    expect(readdirSync(root).sort()).toEqual([name, basename(legacy)].sort());
  },
);
