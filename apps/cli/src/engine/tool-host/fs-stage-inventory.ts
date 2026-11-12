/** CLI-private reader for candidate ADR-0125 staging ownership records.
 * This reader is not wired and does not enable named staging by itself.
 */
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

import type { AbortSignalLike } from '@relavium/shared';
import { HostDeniedError, throwIfAborted } from './errors.js';

const MAX_RECORDS = 128;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const SCAN_MS = 2000;
const STAGE_PREFIX = '.relavium-fs-stage-v1.';
const recordName = /^([a-f0-9]{32})\.(record|reserved|prepare)$/;
const MAGIC = Buffer.from('RVSTG001');

/** Closed binary protocol: header(24), nonce(32), owner, stage locator, 3 full identities(40 each). */
function parseRecord(bytes: Buffer, nonce: string, uid: bigint | undefined): readonly Identity[] {
  if (
    bytes.length < 176 ||
    !bytes.subarray(0, 8).equals(MAGIC) ||
    bytes[8] !== 1 ||
    bytes.subarray(9, 16).some((value) => value !== 0)
  )
    throw new FsStageInventoryError();
  const pid = bytes.readUInt32LE(16);
  const ownerLength = bytes.readUInt16LE(20);
  const pathLength = bytes.readUInt16LE(22);
  if (
    pid === 0 ||
    pid > 2147483647 ||
    ownerLength === 0 ||
    ownerLength > 184 ||
    pathLength === 0 ||
    pathLength > 4096 ||
    bytes.length !== 176 + ownerLength + pathLength ||
    bytes.subarray(24, 56).toString('ascii') !== nonce
  )
    throw new FsStageInventoryError();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const owner = decoder.decode(bytes.subarray(56, 56 + ownerLength));
  const stage = decoder.decode(bytes.subarray(56 + ownerLength, 56 + ownerLength + pathLength));
  if (
    (uid === undefined
      ? !/^S-1-(?:[0-9]{1,10}-){1,15}[0-9]{1,10}$/.test(owner)
      : owner !== String(uid)) ||
    !isAbsolute(stage) ||
    resolve(stage) !== stage ||
    basename(stage) !== `${STAGE_PREFIX}${pid}.${nonce}`
  )
    throw new FsStageInventoryError();
  const ids: Identity[] = [];
  for (let offset = 56 + ownerLength + pathLength; offset < bytes.length; offset += 40) {
    // Full native identities are retained in the record. Node uses only its independently proven witness.
    ids.push(
      normalizeNodeFsIdentity({
        dev: bytes.readBigUInt64LE(offset + 24),
        ino: bytes.readBigUInt64LE(offset + 32),
      }),
    );
  }
  return ids.slice(1);
}

type Identity = { readonly dev: bigint; readonly ino: bigint };
/** Normalize only the Windows libuv signed-inode representation at the host boundary. */
export function normalizeNodeFsIdentity(
  identity: Identity,
  platform: NodeJS.Platform = process.platform,
): Identity {
  if (platform !== 'win32') return identity;
  if (
    identity.dev < 0n ||
    identity.dev > 0xffff_ffffn ||
    identity.ino < -(1n << 63n) ||
    identity.ino > (1n << 64n) - 1n
  )
    throw new FsStageInventoryError();
  return { dev: identity.dev, ino: BigInt.asUintN(64, identity.ino) };
}
export interface FsStageInventory {
  assertIdentity(identity: Identity): void;
}
export class FsStageInventoryError extends HostDeniedError {
  constructor() {
    super('filesystem staging inventory is unavailable or unsafe');
  }
}
function code(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}
function tick(start: number, signal: AbortSignalLike | undefined): void {
  throwIfAborted(signal, 'filesystem staging inventory scan was aborted');
  if (performance.now() - start > SCAN_MS) throw new FsStageInventoryError();
}
function same(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Capture one bounded inventory per model operation; subsequent identity checks are constant-time. */
export async function captureFsStageInventory(
  operatorHomeDir: string,
  signal?: AbortSignalLike,
): Promise<FsStageInventory> {
  const start = performance.now();
  const identities = new Set<string>();
  const captured = (): FsStageInventory =>
    Object.freeze({
      assertIdentity(identity: Identity): void {
        const normalized = normalizeNodeFsIdentity(identity);
        if (identities.has(`${normalized.dev}:${normalized.ino}`))
          throw new FsStageInventoryError();
      },
    });
  try {
    tick(start, signal);
    if (!isAbsolute(operatorHomeDir)) throw new FsStageInventoryError();
    const requestedHome = resolve(operatorHomeDir);
    tick(start, signal);
    const homeInfo = await stat(requestedHome, { bigint: true });
    if (!homeInfo.isDirectory()) throw new FsStageInventoryError();
    const requestedIndex = join(requestedHome, '.relavium', 'fs-staging-v1');
    let indexInfo;
    try {
      tick(start, signal);
      indexInfo = await lstat(requestedIndex, { bigint: true });
    } catch (error) {
      if (code(error) === 'ENOENT') {
        tick(start, signal);
        const currentHome = await stat(requestedHome, { bigint: true });
        if (!same(homeInfo, currentHome) || !currentHome.isDirectory())
          throw new FsStageInventoryError();
        return captured();
      }
      throw error;
    }
    // Windows follows ADR-0050's explicit operator-home ACL trust boundary. Native
    // placement proves its private ACL; Node mode bits are never ACL evidence.
    const windows = process.platform === 'win32';
    if (!windows && typeof process.geteuid !== 'function') throw new FsStageInventoryError();
    tick(start, signal);
    const home = await realpath(requestedHome);
    const parent = join(home, '.relavium');
    const index = join(parent, 'fs-staging-v1');
    const uid = !windows && process.geteuid ? BigInt(process.geteuid()) : undefined;
    const privatePolicy = (info: { readonly uid: bigint; readonly mode: bigint }): boolean =>
      windows || (info.uid === uid && (info.mode & 0o077n) === 0n);
    tick(start, signal);
    const parentInfo = await lstat(parent, { bigint: true });
    if (
      !parentInfo.isDirectory() ||
      parentInfo.isSymbolicLink() ||
      !privatePolicy(parentInfo) ||
      !indexInfo.isDirectory() ||
      indexInfo.isSymbolicLink() ||
      !privatePolicy(indexInfo) ||
      (await realpath(index)) !== index
    )
      throw new FsStageInventoryError();
    tick(start, signal);
    const directory = await opendir(index);
    const nonces = new Set<string>();
    let count = 0;
    let total = 0;
    for await (const entry of directory) {
      tick(start, signal);
      const match = recordName.exec(entry.name);
      if (
        ++count > MAX_RECORDS * 3 + 1 ||
        !entry.isFile() ||
        (entry.name !== 'inventory.lock' && !match)
      )
        throw new FsStageInventoryError();
      if (match?.[1]) nonces.add(match[1]);
      if (nonces.size > MAX_RECORDS) throw new FsStageInventoryError();
      const path = join(index, entry.name);
      let observed;
      try {
        tick(start, signal);
        observed = await lstat(path, { bigint: true });
      } catch (error) {
        if (
          code(error) === 'ENOENT' &&
          (entry.name.endsWith('.reserved') || entry.name.endsWith('.prepare'))
        )
          continue;
        throw error;
      }
      if (
        !observed.isFile() ||
        observed.isSymbolicLink() ||
        observed.nlink !== 1n ||
        !privatePolicy(observed) ||
        observed.size > BigInt(MAX_RECORD_BYTES)
      )
        throw new FsStageInventoryError();
      const transient = match?.[2] === 'reserved' || match?.[2] === 'prepare';
      let handle;
      try {
        tick(start, signal);
        handle = await open(
          path,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
        );
      } catch (error) {
        if (transient && code(error) === 'ENOENT') continue;
        throw error;
      }
      try {
        tick(start, signal);
        const before = await handle.stat({ bigint: true });
        if (
          !same(observed, before) ||
          !before.isFile() ||
          before.nlink !== 1n ||
          !privatePolicy(before) ||
          (!transient && observed.ctimeNs !== before.ctimeNs)
        )
          throw new FsStageInventoryError();
        if (transient || entry.name === 'inventory.lock') {
          total += Number(before.size);
          if (
            before.size > BigInt(MAX_RECORD_BYTES) ||
            total > MAX_SCAN_BYTES ||
            (match?.[2] !== 'prepare' && before.size !== 0n)
          )
            throw new FsStageInventoryError();
          continue;
        }
        tick(start, signal);
        const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
        tick(start, signal);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        total += bytesRead;
        if (
          bytesRead > MAX_RECORD_BYTES ||
          total > MAX_SCAN_BYTES ||
          BigInt(bytesRead) !== before.size
        )
          throw new FsStageInventoryError();
        tick(start, signal);
        const after = await handle.stat({ bigint: true });
        tick(start, signal);
        const current = await lstat(path, { bigint: true });
        if (
          !same(before, after) ||
          !same(before, current) ||
          after.nlink !== 1n ||
          current.nlink !== 1n ||
          !privatePolicy(current) ||
          before.ctimeNs !== current.ctimeNs ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          throw new FsStageInventoryError();
        if (match?.[2] === 'record' && match[1]) {
          for (const pinned of parseRecord(bytes.subarray(0, bytesRead), match[1], uid))
            identities.add(`${pinned.dev}:${pinned.ino}`);
        }
        // .prepare is a bounded private, uncommitted record. Its producer cannot write payload yet.
      } finally {
        await handle.close();
      }
    }
    tick(start, signal);
    const final = await lstat(index, { bigint: true });
    tick(start, signal);
    const finalParent = await lstat(parent, { bigint: true });
    tick(start, signal);
    const finalHome = await stat(requestedHome, { bigint: true });
    if (
      !same(homeInfo, finalHome) ||
      !finalHome.isDirectory() ||
      (await realpath(requestedHome)) !== home ||
      !same(indexInfo, final) ||
      !final.isDirectory() ||
      !privatePolicy(final) ||
      !same(parentInfo, finalParent) ||
      !finalParent.isDirectory() ||
      !privatePolicy(finalParent)
    )
      throw new FsStageInventoryError();
    return captured();
  } catch (error) {
    throwIfAborted(signal, 'filesystem staging inventory scan was aborted');
    if (error instanceof FsStageInventoryError) throw error;
    throw new FsStageInventoryError();
  }
}
