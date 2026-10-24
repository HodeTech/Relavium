import { RelaviumError } from '@relavium/shared';

import { randomUUID } from 'node:crypto';
import { constants, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  exactStats,
  MediaStoreFilesystemError,
  MediaStorePaths,
  type ExactStats,
} from './media-store-paths.js';
import { withOwnedFilesystem, withOwnedFilesystemAsync } from './storage-failure-facts.js';

export type MediaTemporaryRetentionReason =
  | 'too_young'
  | 'future_timestamp'
  | 'owner_live'
  | 'owner_unknown'
  | 'claimant_live'
  | 'claimant_unknown'
  | 'malformed'
  | 'unsafe_entry'
  | 'identity_changed'
  | 'legacy_offline_required'
  | 'io';
export interface MediaTemporarySweepResult {
  readonly removed: number;
  readonly retained: number;
  readonly reasons: Readonly<Partial<Record<MediaTemporaryRetentionReason, number>>>;
}
export class MediaTemporaryMaintenanceError extends RelaviumError {
  constructor(
    readonly reason: 'flags_required' | 'producer_active' | 'owner_unknown' | 'maintenance_active',
  ) {
    super('media temporary maintenance could not establish exclusive offline access');
    this.name = 'MediaTemporaryMaintenanceError';
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PID = '[1-9][0-9]{0,9}';
const PRODUCER = new RegExp(`^media-v1\\.(${PID})\\.(${UUID})\\.tmp$`);
const MAINTENANCE = new RegExp(`^media-maintenance-v1\\.(${PID})\\.(${UUID})$`);
const RECOVERY = new RegExp(`^recovery-v1\\.(${PID})\\.(${UUID})$`);
const CLAIM = new RegExp(
  `^media-claim-v[12]\\.(${PID})\\.(${UUID})\\.([0-9a-z]+)\\.([0-9a-z]+)\\.(${PID})\\.(${UUID})$`,
);
const LEGACY_ROOT = new RegExp(`^stream\\.${UUID}\\.tmp$`);
const LEGACY_SHARD = new RegExp(`^[0-9a-f]{62}\\.${UUID}\\.tmp$`);
const MIN_AGE = 24 * 60 * 60 * 1000;
const MIN_NATIVE_IDENTITY = -(1n << 63n);
const MAX_NATIVE_IDENTITY = (1n << 64n) - 1n;
const MAX_NATIVE_TOKEN = MAX_NATIVE_IDENTITY.toString(36);

interface NativeIdentity {
  readonly dev: string;
  readonly ino: string;
}
function nativeIdentityToken(value: bigint): string {
  if (value < MIN_NATIVE_IDENTITY || value > MAX_NATIVE_IDENTITY)
    throw new MediaStoreFilesystemError('unsafe_path');
  // Node fills bigint stats from a signed array, so a 64-bit file ID with its top bit set reads
  // negative; the token is the unsigned value the filesystem reports.
  return BigInt.asUintN(64, value).toString(36);
}
function canonicalNativeToken(field: string): boolean {
  return (
    /^(?:0|[1-9a-z][0-9a-z]{0,12})$/.test(field) &&
    (field.length < MAX_NATIVE_TOKEN.length || field <= MAX_NATIVE_TOKEN)
  );
}
function sameNative(a: NativeIdentity, b: NativeIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

type Liveness = 'absent' | 'live' | 'unknown';
function live(pid: string): Liveness {
  const value = Number(pid);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) return 'unknown';
  try {
    process.kill(value, 0);
    return 'live';
  } catch (error) {
    return code(error) === 'ESRCH' ? 'absent' : 'unknown';
  }
}
function code(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}
function same(a: ExactStats, b: ExactStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function age(info: ExactStats, now: number): MediaTemporaryRetentionReason | undefined {
  if (!Number.isFinite(info.mtimeMs) || info.mtimeMs > now) return 'future_timestamp';
  return now - info.mtimeMs < MIN_AGE ? 'too_young' : undefined;
}
function ownerReason(pid: string, claimant = false): MediaTemporaryRetentionReason | undefined {
  const state = live(pid);
  return state === 'absent'
    ? undefined
    : state === 'live'
      ? claimant
        ? 'claimant_live'
        : 'owner_live'
      : claimant
        ? 'claimant_unknown'
        : 'owner_unknown';
}
class Counts {
  removed = 0;
  retained = 0;
  readonly reasons: Partial<Record<MediaTemporaryRetentionReason, number>> = {};
  retain(reason: MediaTemporaryRetentionReason): void {
    this.retained++;
    this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
  }
  result(): MediaTemporarySweepResult {
    return Object.freeze({
      removed: this.removed,
      retained: this.retained,
      reasons: Object.freeze({ ...this.reasons }),
    });
  }
}

/** Local cooperating processes only; every destructive path retains the pinned root floor. */
export class MediaStoreTemporaries {
  constructor(readonly paths: MediaStorePaths) {}

  producerPath(root: string): string {
    return join(root, `media-v1.${process.pid}.${randomUUID()}.tmp`);
  }

  assertProducerAllowed(): void {
    const root = this.paths.root(false);
    if (root === undefined) return;
    for (const name of this.entries(root)) {
      if (!name.startsWith('media-maintenance-')) continue;
      const match = MAINTENANCE.exec(name);
      if (match?.[1] === undefined) throw new MediaTemporaryMaintenanceError('maintenance_active');
      const info = this.paths.file(join(root, name));
      if (info !== undefined && live(match[1]) !== 'absent')
        throw new MediaTemporaryMaintenanceError('maintenance_active');
    }
  }

  async sweep(options?: { readonly now?: number }): Promise<MediaTemporarySweepResult> {
    const now = options?.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new MediaStoreFilesystemError('io');
    const counts = new Counts();
    const root = this.paths.root(false);
    if (root === undefined) return counts.result();
    for (const name of this.entries(root)) {
      try {
        const producer = PRODUCER.exec(name);
        const claim = CLAIM.exec(name);
        const maintenance = MAINTENANCE.exec(name);
        if (producer?.[1] !== undefined && producer[2] !== undefined) {
          const path = join(root, name);
          const info = this.paths.file(path);
          if (info === undefined) continue;
          const reason = age(info, now) ?? ownerReason(producer[1]);
          if (reason !== undefined) counts.retain(reason);
          else if (await this.claim(root, path, info, producer[1], producer[2])) counts.removed++;
        } else if (claim !== null) {
          const reason = await this.recover(root, name, claim, now);
          if (reason === undefined) counts.removed++;
          else counts.retain(reason);
        } else if (maintenance?.[1] !== undefined) {
          const path = join(root, name);
          const info = this.paths.file(path);
          if (info === undefined) continue;
          const reason = age(info, now) ?? ownerReason(maintenance[1]);
          if (reason !== undefined) counts.retain(reason);
          else {
            await this.removeOwned(path, info);
            counts.removed++;
          }
        } else if (LEGACY_ROOT.test(name)) counts.retain('legacy_offline_required');
        else if (/^media-(?:v|claim-|maintenance-)/.test(name)) counts.retain('malformed');
        else if (/^[0-9a-f]{2}$/.test(name)) {
          const shard = this.paths.shard(name + '0'.repeat(62), false);
          if (shard !== undefined)
            for (const child of this.entries(shard)) {
              if (LEGACY_SHARD.test(child)) counts.retain('legacy_offline_required');
            }
        }
      } catch (error) {
        // Root revocation is never converted into a successful bounded sweep report.
        this.paths.root(false);
        counts.retain(
          error instanceof MediaStoreFilesystemError && error.reason === 'unsafe_path'
            ? 'unsafe_entry'
            : 'io',
        );
      }
    }
    return counts.result();
  }

  async pruneLegacy(options: {
    readonly legacyOffline: true;
    readonly force: true;
  }): Promise<MediaTemporarySweepResult> {
    if (options?.legacyOffline !== true || options.force !== true)
      throw new MediaTemporaryMaintenanceError('flags_required');
    const counts = new Counts();
    const root = this.paths.root(false);
    if (root === undefined) return counts.result();
    const marker = join(root, `media-maintenance-v1.${process.pid}.${randomUUID()}`);
    const identity = await this.createMarker(marker);
    try {
      const candidates: Array<{ path: string; info: ExactStats }> = [];
      // The marker is visible before this scan. New producers recheck after exclusive open;
      // old admitted producers remain visible here until publication/cleanup.
      for (const name of this.entries(root)) {
        const path = join(root, name);
        if (path === marker) continue;
        const producer = PRODUCER.exec(name);
        const maintenance = MAINTENANCE.exec(name);
        if (producer?.[1] !== undefined) {
          const info = this.paths.file(path);
          if (info !== undefined) this.requireAbsent(producer[1]);
        } else if (maintenance?.[1] !== undefined) {
          const info = this.paths.file(path);
          if (info !== undefined && live(maintenance[1]) !== 'absent')
            throw new MediaTemporaryMaintenanceError('maintenance_active');
        } else if (name.startsWith('media-v') || name.startsWith('media-maintenance-')) {
          throw new MediaTemporaryMaintenanceError('owner_unknown');
        } else if (LEGACY_ROOT.test(name)) {
          const info = this.paths.file(path);
          if (info !== undefined) candidates.push({ path, info });
        } else if (/^[0-9a-f]{2}$/.test(name)) {
          const shard = this.paths.shard(name + '0'.repeat(62), false);
          if (shard !== undefined)
            for (const child of this.entries(shard)) {
              if (!LEGACY_SHARD.test(child)) continue;
              const target = join(shard, child);
              const info = this.paths.file(target);
              if (info !== undefined) candidates.push({ path: target, info });
            }
        }
      }
      for (const candidate of candidates) {
        this.paths.assertOwnedFile(marker, identity);
        await this.removeOwned(candidate.path, candidate.info);
        counts.removed++;
      }
      return counts.result();
    } finally {
      await this.removeOwned(marker, identity);
    }
  }

  private requireAbsent(pid: string): void {
    const state = live(pid);
    if (state !== 'absent')
      throw new MediaTemporaryMaintenanceError(
        state === 'live' ? 'producer_active' : 'owner_unknown',
      );
  }
  private entries(path: string): string[] {
    this.paths.root(false);
    try {
      const names = withOwnedFilesystem(() => readdirSync(path));
      this.paths.root(false);
      return names;
    } catch (error) {
      throw this.paths.error(error);
    }
  }
  private async createMarker(path: string): Promise<ExactStats> {
    this.paths.assertParent(path);
    return this.acquireMarker(
      path,
      (identity) => this.paths.assertOwnedFile(path, identity),
      (identity) => this.removeOwned(path, identity),
    );
  }
  /** Keep captured fd identity available when close or the post-close ownership check fails. */
  private async acquireMarker(
    path: string,
    assertOwned: (identity: ExactStats) => void,
    cleanup: (identity: ExactStats) => Promise<void>,
  ): Promise<ExactStats> {
    const file = await withOwnedFilesystemAsync(() =>
      open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      ),
    ).catch((error: unknown) => {
      throw this.paths.error(error);
    });
    let identity: ExactStats | undefined;
    let acquired = false;
    let cleanupError: MediaStoreFilesystemError | undefined;
    try {
      try {
        identity = exactStats(
          await withOwnedFilesystemAsync(() => file.stat({ bigint: true })).catch(
            (error: unknown) => {
              throw this.paths.error(error);
            },
          ),
        );
      } finally {
        try {
          await withOwnedFilesystemAsync(() => file.close());
        } catch (error) {
          cleanupError = this.paths.error(error);
        }
      }
      if (cleanupError !== undefined) throw cleanupError;
      // Only a known regular one-link marker can acquire deletion authority. The caller
      // supplies either the root-file floor or the original claim-directory identity floor.
      if (identity === undefined) throw new MediaStoreFilesystemError('io');
      try {
        assertOwned(identity);
      } catch (error) {
        throw this.paths.error(error);
      }
      acquired = true;
      return identity;
    } finally {
      if (!acquired && identity !== undefined) {
        try {
          await cleanup(identity);
        } catch (error) {
          // A primary acquisition failure is already propagating. Ownership uncertainty or
          // secondary I/O retains the entry; cleanup cannot replace that primary diagnosis.
          cleanupError ??= this.paths.error(error);
        }
      }
    }
  }
  private async removeOwned(path: string, identity: ExactStats): Promise<void> {
    this.paths.assertOwnedFile(path, identity);
    await withOwnedFilesystemAsync(() => unlink(path)).catch((error: unknown) => {
      throw this.paths.error(error);
    });
  }
  private directory(root: string, name: string, identity?: ExactStats): ExactStats {
    this.paths.root(false);
    const path = join(root, name);
    const info = exactStats(withOwnedFilesystem(() => lstatSync(path, { bigint: true })));
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      withOwnedFilesystem(() => realpathSync(path)) !== path ||
      (identity !== undefined && !same(info, identity))
    )
      throw new MediaStoreFilesystemError('unsafe_path');
    this.paths.root(false);
    return info;
  }
  private child(
    root: string,
    name: string,
    identity: ExactStats,
    child: string,
  ): ExactStats | undefined {
    this.directory(root, name, identity);
    try {
      const info = exactStats(
        withOwnedFilesystem(() => lstatSync(join(root, name, child), { bigint: true })),
      );
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new MediaStoreFilesystemError('unsafe_path');
      return info;
    } catch (error) {
      if (code(error) === 'ENOENT') return undefined;
      throw error;
    }
  }
  /** Exact claim identity supplements, rather than replaces, the existing cooperative path floor. */
  private nativeFile(path: string, expected: ExactStats): NativeIdentity {
    const info = withOwnedFilesystem(() => lstatSync(path, { bigint: true }));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1n ||
      info.dev !== expected.dev ||
      info.ino !== expected.ino
    )
      throw new MediaStoreFilesystemError('unsafe_path');
    return { dev: nativeIdentityToken(info.dev), ino: nativeIdentityToken(info.ino) };
  }
  private async claim(
    root: string,
    source: string,
    info: ExactStats,
    pid: string,
    nonce: string,
  ): Promise<boolean> {
    const original = this.nativeFile(source, info);
    const name = `media-claim-v2.${pid}.${nonce}.${original.dev}.${original.ino}.${process.pid}.${randomUUID()}`;
    const dir = join(root, name);
    this.paths.root(false);
    await withOwnedFilesystemAsync(() => mkdir(dir, { mode: 0o700 })); // Exclusive creation.
    const identity = this.directory(root, name);
    try {
      this.paths.assertOwnedFile(source, info);
      if (!sameNative(this.nativeFile(source, info), original))
        throw new MediaStoreFilesystemError('unsafe_path');
      this.directory(root, name, identity);
      await withOwnedFilesystemAsync(() => rename(source, join(dir, 'blob')));
      const moved = this.child(root, name, identity, 'blob');
      if (
        moved === undefined ||
        !same(moved, info) ||
        !sameNative(this.nativeFile(join(dir, 'blob'), moved), original)
      )
        throw new MediaStoreFilesystemError('unsafe_path');
      await withOwnedFilesystemAsync(() => unlink(join(dir, 'blob')));
      return true;
    } catch (error) {
      if (
        code(error) === 'ENOENT' ||
        (error instanceof MediaStoreFilesystemError &&
          error.reason === 'unsafe_path' &&
          this.paths.file(source) === undefined)
      ) {
        // A competing claim won; no absence shortcut may erase a moved or mismatched child.
        if (this.child(root, name, identity, 'blob') === undefined) return false;
      }
      throw error;
    } finally {
      this.directory(root, name, identity);
      if (this.entries(dir).length === 0) await withOwnedFilesystemAsync(() => rmdir(dir));
    }
  }

  private async recover(
    root: string,
    name: string,
    parsed: RegExpExecArray,
    now: number,
  ): Promise<MediaTemporaryRetentionReason | undefined> {
    const producer = parsed[1];
    const device = parsed[3];
    const inode = parsed[4];
    const claimant = parsed[5];
    const exact = name.startsWith('media-claim-v2.');
    if (
      producer === undefined ||
      device === undefined ||
      inode === undefined ||
      claimant === undefined
    )
      return 'malformed';
    for (const field of [device, inode]) {
      if (exact) {
        if (!canonicalNativeToken(field)) return 'malformed';
      } else {
        // Historical v1 encoded Number stats. An unsafe old token cannot establish exact identity.
        const value = Number.parseInt(field, 36);
        if (!Number.isSafeInteger(value) || value < 0 || value.toString(36) !== field)
          return 'malformed';
      }
    }
    const unavailable = ownerReason(claimant, true) ?? ownerReason(producer);
    if (unavailable !== undefined) return unavailable;
    const identity = this.directory(root, name);
    const dir = join(root, name);
    const marker = `recovery-v1.${process.pid}.${randomUUID()}`;
    const markerPath = join(dir, marker);
    // Reserve a distinct marker. Every recovery checks other markers after its own is visible:
    // simultaneous starts may both retain, but cannot both enter the destructive phase.
    const markerInfo = await this.acquireMarker(
      markerPath,
      (opened) => this.assertRecoveryMarker(root, name, identity, marker, opened),
      (opened) => this.removeRecoveryMarker(root, name, identity, marker, opened),
    );
    let outcome: MediaTemporaryRetentionReason | undefined;
    let completed = false;
    let cleanupError: MediaStoreFilesystemError | undefined;
    try {
      outcome = await (async (): Promise<MediaTemporaryRetentionReason | undefined> => {
        this.directory(root, name, identity);
        for (const entry of this.entries(dir)) {
          if (entry === marker || entry === 'blob') continue;
          const recovery = RECOVERY.exec(entry);
          if (recovery?.[1] === undefined) return 'malformed';
          const reason = ownerReason(recovery[1], true);
          if (reason !== undefined) return reason;
          const stale = this.child(root, name, identity, entry);
          if (stale !== undefined) {
            const current = this.child(root, name, identity, entry);
            if (current === undefined) continue;
            if (!same(current, stale)) return 'identity_changed';
            await withOwnedFilesystemAsync(() => unlink(join(dir, entry)));
          }
        }
        const blob = this.child(root, name, identity, 'blob');
        if (blob !== undefined) {
          const original = exact
            ? this.nativeFile(join(dir, 'blob'), blob)
            : { dev: blob.dev.toString(36), ino: blob.ino.toString(36) };
          if (original.dev !== device || original.ino !== inode) return 'identity_changed';
          const reason = age(blob, now);
          if (reason !== undefined) return reason;
          this.directory(root, name, identity);
          const current = this.child(root, name, identity, 'blob');
          if (current === undefined || !same(current, blob)) return 'identity_changed';
          if (exact && !sameNative(this.nativeFile(join(dir, 'blob'), current), original))
            return 'identity_changed';
          await withOwnedFilesystemAsync(() => unlink(join(dir, 'blob')));
        }
        return undefined;
      })();
      completed = true;
    } finally {
      try {
        const removed = await this.cleanupRecovery(root, name, identity, marker, markerInfo);
        // A peer can delete the blob after we retained its live marker. The one actual
        // directory-removal winner accounts for the whole claim, including that schedule.
        if (completed && removed) outcome = undefined;
        else if (completed && outcome === undefined) outcome = 'claimant_live';
      } catch (error) {
        cleanupError = this.paths.error(error);
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
    return outcome;
  }
  private assertRecoveryMarker(
    root: string,
    name: string,
    identity: ExactStats,
    marker: string,
    markerInfo: ExactStats,
  ): void {
    const own = this.child(root, name, identity, marker);
    if (
      !markerInfo.isFile() ||
      markerInfo.nlink !== 1 ||
      own === undefined ||
      !same(own, markerInfo)
    )
      throw new MediaStoreFilesystemError('unsafe_path');
  }
  /** Acquisition failure retires only its marker; normal recovery owns directory removal/counting. */
  private async removeRecoveryMarker(
    root: string,
    name: string,
    identity: ExactStats,
    marker: string,
    markerInfo: ExactStats,
  ): Promise<void> {
    this.assertRecoveryMarker(root, name, identity, marker, markerInfo);
    await withOwnedFilesystemAsync(() => unlink(join(root, name, marker)));
  }
  private async cleanupRecovery(
    root: string,
    name: string,
    identity: ExactStats,
    marker: string,
    markerInfo: ExactStats,
  ): Promise<boolean> {
    await this.removeRecoveryMarker(root, name, identity, marker, markerInfo);
    try {
      this.directory(root, name, identity);
      const dir = join(root, name);
      if (this.entries(dir).length !== 0) return false;
      await withOwnedFilesystemAsync(() => rmdir(dir));
      return true;
    } catch (error) {
      // After our own identity-checked marker removal, a cooperating peer may win
      // directory cleanup. Absence never bypasses the pinned-root or earlier guards.
      this.paths.root(false);
      const missing =
        code(error) === 'ENOENT' ||
        (error instanceof MediaStoreFilesystemError && error.reason === 'missing');
      if (missing || code(error) === 'ENOTEMPTY' || code(error) === 'EEXIST') return false;
      throw this.paths.error(error);
    }
  }
}
