import { randomUUID } from 'node:crypto';
import { constants, lstatSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { mkdir, open, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { MediaStoreFilesystemError, MediaStorePaths } from './media-store-paths.js';

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
  | 'maintenance_active'
  | 'io';
export interface MediaTemporarySweepResult {
  readonly removed: number;
  readonly retained: number;
  readonly reasons: Readonly<Partial<Record<MediaTemporaryRetentionReason, number>>>;
}
export class MediaTemporaryMaintenanceError extends Error {
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
  `^media-claim-v1\\.(${PID})\\.(${UUID})\\.([0-9a-z]+)\\.([0-9a-z]+)\\.(${PID})\\.(${UUID})$`,
);
const LEGACY_ROOT = new RegExp(`^stream\\.${UUID}\\.tmp$`);
const LEGACY_SHARD = new RegExp(`^[0-9a-f]{62}\\.${UUID}\\.tmp$`);
const MIN_AGE = 24 * 60 * 60 * 1000;

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
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function age(info: Stats, now: number): MediaTemporaryRetentionReason | undefined {
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
      const candidates: Array<{ path: string; info: Stats }> = [];
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
      const names = readdirSync(path);
      this.paths.root(false);
      return names;
    } catch (error) {
      throw this.paths.error(error);
    }
  }
  private async createMarker(path: string): Promise<Stats> {
    this.paths.assertParent(path);
    const file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    ).catch((error: unknown) => {
      throw this.paths.error(error);
    });
    const info = await this.closeMarker(file);
    this.paths.assertOwnedFile(path, info);
    return info;
  }
  private async closeMarker(file: FileHandle): Promise<Stats> {
    let info: Stats;
    let cleanupError: MediaStoreFilesystemError | undefined;
    try {
      info = await file.stat().catch((error: unknown) => {
        throw this.paths.error(error);
      });
    } finally {
      try {
        await file.close();
      } catch (error) {
        cleanupError = this.paths.error(error);
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
    return info;
  }
  private async removeOwned(path: string, identity: Stats): Promise<void> {
    this.paths.assertOwnedFile(path, identity);
    await unlink(path).catch((error: unknown) => {
      throw this.paths.error(error);
    });
  }
  private directory(root: string, name: string, identity?: Stats): Stats {
    this.paths.root(false);
    const path = join(root, name);
    const info = lstatSync(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      realpathSync(path) !== path ||
      (identity !== undefined && !same(info, identity))
    )
      throw new MediaStoreFilesystemError('unsafe_path');
    this.paths.root(false);
    return info;
  }
  private child(root: string, name: string, identity: Stats, child: string): Stats | undefined {
    this.directory(root, name, identity);
    try {
      const info = lstatSync(join(root, name, child));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new MediaStoreFilesystemError('unsafe_path');
      return info;
    } catch (error) {
      if (code(error) === 'ENOENT') return undefined;
      throw error;
    }
  }
  private async claim(
    root: string,
    source: string,
    info: Stats,
    pid: string,
    nonce: string,
  ): Promise<boolean> {
    const name = `media-claim-v1.${pid}.${nonce}.${info.dev.toString(36)}.${info.ino.toString(36)}.${process.pid}.${randomUUID()}`;
    const dir = join(root, name);
    this.paths.root(false);
    await mkdir(dir, { mode: 0o700 }); // Exclusive mkdir: never overwrite another claimant's target.
    const identity = this.directory(root, name);
    try {
      this.paths.assertOwnedFile(source, info);
      this.directory(root, name, identity);
      await rename(source, join(dir, 'blob'));
      const moved = this.child(root, name, identity, 'blob');
      if (moved === undefined || !same(moved, info))
        throw new MediaStoreFilesystemError('unsafe_path');
      await unlink(join(dir, 'blob'));
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
      if (this.entries(dir).length === 0) await rmdir(dir);
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
    if (
      producer === undefined ||
      device === undefined ||
      inode === undefined ||
      claimant === undefined
    )
      return 'malformed';
    for (const field of [device, inode]) {
      const value = Number.parseInt(field, 36);
      if (!Number.isSafeInteger(value) || value < 0 || value.toString(36) !== field)
        return 'malformed';
    }
    const unavailable = ownerReason(claimant, true) ?? ownerReason(producer);
    if (unavailable !== undefined) return unavailable;
    const identity = this.directory(root, name);
    const dir = join(root, name);
    const marker = `recovery-v1.${process.pid}.${randomUUID()}`;
    const markerPath = join(dir, marker);
    // Reserve a distinct marker. Every recovery checks other markers after its own is visible:
    // simultaneous starts may both retain, but cannot both enter the destructive phase.
    const file = await open(
      markerPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    const markerInfo = await this.closeMarker(file);
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
            await unlink(join(dir, entry));
          }
        }
        const blob = this.child(root, name, identity, 'blob');
        if (blob !== undefined) {
          if (blob.dev.toString(36) !== device || blob.ino.toString(36) !== inode)
            return 'identity_changed';
          const reason = age(blob, now);
          if (reason !== undefined) return reason;
          this.directory(root, name, identity);
          const current = this.child(root, name, identity, 'blob');
          if (current === undefined || !same(current, blob)) return 'identity_changed';
          await unlink(join(dir, 'blob'));
        }
        return undefined;
      })();
      completed = true;
    } finally {
      try {
        const removed = await this.cleanupRecovery(root, name, identity, marker, markerInfo);
        if (!removed && completed && outcome === undefined) outcome = 'claimant_live';
      } catch (error) {
        cleanupError = this.paths.error(error);
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
    return outcome;
  }
  private async cleanupRecovery(
    root: string,
    name: string,
    identity: Stats,
    marker: string,
    markerInfo: Stats,
  ): Promise<boolean> {
    const own = this.child(root, name, identity, marker);
    if (own === undefined || !same(own, markerInfo))
      throw new MediaStoreFilesystemError('unsafe_path');
    await unlink(join(root, name, marker));
    this.directory(root, name, identity);
    const dir = join(root, name);
    if (this.entries(dir).length !== 0) return false;
    try {
      await rmdir(dir);
      return true;
    } catch (error) {
      if (code(error) === 'ENOTEMPTY' || code(error) === 'EEXIST') return false;
      throw this.paths.error(error);
    }
  }
}
