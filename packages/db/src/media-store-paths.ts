import { RelaviumError } from '@relavium/shared';

import { lstatSync, mkdirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Reason-only host failure; native errors may contain private absolute filenames. */
export class MediaStoreFilesystemError extends RelaviumError {
  constructor(readonly reason: 'missing' | 'unsafe_path' | 'io') {
    super(
      reason === 'missing'
        ? 'the requested media bytes are unavailable'
        : 'the media filesystem path could not be admitted',
    );
    this.name = 'MediaStoreFilesystemError';
  }
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

interface RootPin {
  readonly canonical: string;
  readonly dev: number;
  readonly ino: number;
  readonly entryDev: number;
  readonly entryIno: number;
  readonly linked: boolean;
}

/**
 * Pin the root on its first admitted operation. Reads/GC do not provision a never-used store.
 * Once pinned, absence/replacement/retargeting revokes it; no later operation silently re-pins.
 * Synchronous admission prevents two first operations from racing two initial root identities.
 * This is an owner-controlled path guard, not a descriptor-relative parent-swap jail (ADR-0105).
 */
export class MediaStorePaths {
  readonly #lexical: string;
  #pin: RootPin | undefined;

  constructor(root: string) {
    this.#lexical = resolve(root);
  }

  root(create: boolean): string | undefined {
    try {
      let entry: Stats;
      try {
        entry = lstatSync(this.#lexical);
      } catch (error) {
        if (!missing(error)) throw error;
        if (this.#pin !== undefined) throw new MediaStoreFilesystemError('unsafe_path');
        if (!create) return undefined;
        mkdirSync(this.#lexical, { recursive: true, mode: 0o700 });
        entry = lstatSync(this.#lexical);
      }
      const canonical = realpathSync(this.#lexical);
      const info = statSync(canonical);
      if (!info.isDirectory()) throw new MediaStoreFilesystemError('unsafe_path');
      const current = {
        canonical,
        dev: info.dev,
        ino: info.ino,
        entryDev: entry.dev,
        entryIno: entry.ino,
        linked: entry.isSymbolicLink(),
      };
      const pin = this.#pin;
      if (
        pin !== undefined &&
        (pin.canonical !== canonical ||
          pin.dev !== info.dev ||
          pin.ino !== info.ino ||
          pin.entryDev !== entry.dev ||
          pin.entryIno !== entry.ino ||
          pin.linked !== entry.isSymbolicLink())
      ) {
        throw new MediaStoreFilesystemError('unsafe_path');
      }
      this.#pin ??= Object.freeze(current);
      return canonical;
    } catch (error) {
      throw this.error(error);
    }
  }

  shard(digest: string, create: boolean): string | undefined {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new MediaStoreFilesystemError('unsafe_path');
    const root = this.root(create);
    if (root === undefined) return undefined;
    const dir = join(root, digest.slice(0, 2));
    try {
      let info: Stats;
      try {
        info = lstatSync(dir);
      } catch (error) {
        if (!missing(error)) throw error;
        if (!create) return undefined;
        try {
          mkdirSync(dir, { mode: 0o700 });
        } catch (error) {
          // A cooperating writer may have created the same shard; it still must pass all checks below.
          if (
            !(
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'EEXIST'
            )
          )
            throw error;
        }
        info = lstatSync(dir);
      }
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        realpathSync(dir) !== dir ||
        !within(root, dir)
      ) {
        throw new MediaStoreFilesystemError('unsafe_path');
      }
      this.root(false);
      return dir;
    } catch (error) {
      throw this.error(error);
    }
  }

  path(digest: string, create: boolean): string | undefined {
    const dir = this.shard(digest, create);
    return dir === undefined ? undefined : join(dir, digest.slice(2));
  }

  /** Root temp or one canonical shard, with no linked descendants (no pnpm exception for CAS). */
  assertParent(path: string): void {
    const root = this.root(false);
    if (root === undefined || !within(root, path))
      throw new MediaStoreFilesystemError('unsafe_path');
    const parent = dirname(path);
    if (parent === root) return;
    const shard = basename(parent);
    if (
      dirname(parent) !== root ||
      !/^[0-9a-f]{2}$/.test(shard) ||
      this.shard(shard + '0'.repeat(62), false) !== parent
    ) {
      throw new MediaStoreFilesystemError('unsafe_path');
    }
  }

  file(path: string): Stats | undefined {
    const info = this.fileSnapshot(path);
    // fileSnapshot already excludes additional links; ownership also excludes detachment.
    if (info !== undefined && info.nlink === 0) throw new MediaStoreFilesystemError('unsafe_path');
    return info;
  }

  /**
   * A pathname stat may observe a just-detached inode when a concurrent rename wins
   * between the kernel's lookup and attribute read. Accept that zero-link snapshot only
   * for non-owning reads/publication checks; temporary ownership and deletion stay strict.
   */
  fileSnapshot(path: string): Stats | undefined {
    this.assertParent(path);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.nlink !== 0 && info.nlink !== 1))
        throw new MediaStoreFilesystemError('unsafe_path');
      return info;
    } catch (error) {
      if (missing(error)) return undefined;
      throw this.error(error);
    }
  }

  assertOwnedFile(path: string, opened: Stats): void {
    const current = this.file(path);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      current === undefined ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      throw new MediaStoreFilesystemError('unsafe_path');
    }
  }

  /**
   * Read from the opened descriptor, not from a durable association with its pathname.
   * Cooperative atomic publication can replace that name before/after open or detach the fd's
   * inode (nlink=0). Neither permits an additional hard link: the current entry snapshot and
   * fd must remain regular files with at most one link on the same filesystem.
   * The caller must verify the bytes' content hash before delivery. This retains ADR-0105's
   * owner-controlled-parent assumption; it is not a descriptor-relative parent-swap jail.
   * Temporary-file ownership and destructive operations must not use this read-only check.
   */
  assertReadableFile(path: string, opened: Stats): void {
    const current = this.fileSnapshot(path);
    if (
      !opened.isFile() ||
      (opened.nlink !== 0 && opened.nlink !== 1) ||
      current === undefined ||
      current.dev !== opened.dev
    ) {
      throw new MediaStoreFilesystemError('unsafe_path');
    }
  }

  error(error: unknown): MediaStoreFilesystemError {
    return error instanceof MediaStoreFilesystemError
      ? error
      : new MediaStoreFilesystemError(missing(error) ? 'missing' : 'io');
  }
}
