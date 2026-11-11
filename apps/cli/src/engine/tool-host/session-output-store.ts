/** Private, ephemeral session-instance output storage (ADR-0105/0120).
 * Path checks protect owner-controlled storage and cooperating processes; Node does not provide
 * a descriptor-relative jail against hostile same-user parent replacement. Windows inherits the
 * owner-controlled profile/ACL assumption; POSIX modes are checked explicitly.
 */
import { randomUUID } from 'node:crypto';
import { constants, lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { mkdir, open, opendir, rename, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type {
  FileRead,
  FsReadOpts,
  SpilledResult,
  ToolOutputStore,
  ToolResultLimits,
} from '@relavium/core';
import type { AbortSignalLike } from '@relavium/shared';
import { z } from 'zod';

import { HostCapabilityError } from './errors.js';
import { issueHostScratchRoot, type HostScratchRoot } from './fs-policy.js';

export const SESSION_OUTPUT_LIMITS = Object.freeze({
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  files: 64,
});
const CHUNK_BYTES = 64 * 1024;
const SWEEP_ENTRIES = 128;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const DIRECTORY = new RegExp(`^output-v1\\.([1-9][0-9]{0,9})\\.(${UUID})$`);
const OUTPUT_FILE = new RegExp(`^${UUID}\\.(?:txt|tmp)$`);
const REFERENCE = new RegExp(`^output://(${UUID})/(${UUID})$`);
const MARKER = '.owner.json';
const ownerSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive().max(2147483647),
    instance: z.string().uuid(),
    dev: z.string().regex(/^-?[0-9]{1,20}$/),
    ino: z.string().regex(/^-?[0-9]{1,20}$/),
  })
  .strict();
type Owner = z.infer<typeof ownerSchema>;
type Identity = Pick<BigIntStats, 'dev' | 'ino'>;
type OwnerState = 'live' | 'dead' | 'unknown';
type StoreReason =
  | 'closed'
  | 'quota'
  | 'invalid_ref'
  | 'unsafe_path'
  | 'invalid_range'
  | 'invalid_text'
  | 'io'
  | 'cleanup'
  | 'aborted';

/** All diagnostics are fixed labels: never content, paths, references, or native error causes. */
export class SessionOutputStoreError extends HostCapabilityError {
  readonly reason: StoreReason;
  readonly cleanupUncertain: boolean;
  constructor(
    reason: StoreReason,
    /** An initializer or spill could not prove complete rollback; no native cause/path is retained. */
    cleanupUncertain = false,
  ) {
    super(`session output store: ${reason}`);
    this.reason = reason;
    this.cleanupUncertain = cleanupUncertain;
  }
}
export interface SessionOutputSweepResult {
  readonly removed: number;
  readonly retained: number;
  readonly incomplete: boolean;
}
export interface SessionOutputStore extends ToolOutputStore {
  readonly scratch: HostScratchRoot;
  readonly startupSweep: SessionOutputSweepResult;
  read(ref: string, opts: FsReadOpts, signal?: AbortSignalLike): Promise<FileRead>;
  seal(): void;
  close(): Promise<void>;
}
export interface SessionOutputStoreOptions {
  readonly homeDir: string;
  /** Host-only test controls; limits can only narrow the shipping ceilings. */
  readonly limits?: {
    readonly fileBytes?: number;
    readonly totalBytes?: number;
    readonly files?: number;
  };
  readonly testHooks?: {
    readonly ownerState?: (pid: number) => OwnerState;
    /** Runs after exclusive marker open/fstat, before writing any ownership metadata. */
    readonly afterMarkerOpen?: () => Promise<void>;
    readonly beforeWriteChunk?: () => Promise<void>;
    readonly beforeReadChunk?: () => Promise<void>;
    readonly beforeCleanup?: () => Promise<void>;
  };
}

function code(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}
function same(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function fail(reason: StoreReason): never {
  throw new SessionOutputStoreError(reason);
}
function abort(signal: AbortSignalLike | undefined): void {
  if (signal?.aborted === true) {
    if ('reason' in signal) throw signal.reason;
    fail('aborted');
  }
}
function privateInfo(info: BigIntStats): void {
  if (
    process.platform !== 'win32' &&
    ((info.mode & 0o077n) !== 0n ||
      (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())))
  )
    fail('unsafe_path');
}
function directory(path: string, expected?: Identity): BigIntStats {
  const info = lstatSync(path, { bigint: true });
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    realpathSync.native(path) !== path ||
    (expected !== undefined && !same(info, expected))
  )
    fail('unsafe_path');
  privateInfo(info);
  return info;
}
function regular(info: BigIntStats, expected?: Identity): void {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1n ||
    (expected !== undefined && !same(info, expected))
  )
    fail('unsafe_path');
  privateInfo(info);
}
function file(path: string, expected?: Identity): BigIntStats {
  const info = lstatSync(path, { bigint: true });
  regular(info, expected);
  return info;
}
function normalize(error: unknown, reason: StoreReason = 'io'): SessionOutputStoreError {
  return error instanceof SessionOutputStoreError ? error : new SessionOutputStoreError(reason);
}
function ownerState(pid: number): OwnerState {
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    return code(error) === 'ESRCH' ? 'dead' : 'unknown';
  }
}
async function names(path: string, max: number): Promise<{ names: string[]; incomplete: boolean }> {
  const result: string[] = [];
  const entries = await opendir(path);
  // The async iterator closes itself on completion, throw, and a bounded early return.
  for await (const entry of entries) {
    if (result.length >= max) return { names: result, incomplete: true };
    result.push(entry.name);
  }
  return { names: result, incomplete: false };
}

interface Roots {
  readonly anchor: string;
  readonly anchorInfo: Identity;
  readonly parent: string;
  readonly parentInfo: Identity;
}
function validateRoots(roots: Roots): void {
  directory(roots.anchor, roots.anchorInfo);
  directory(roots.parent, roots.parentInfo);
}
async function roots(homeDir: string): Promise<Roots> {
  const home = realpathSync.native(resolve(homeDir));
  const anchor = join(home, '.relavium');
  const parent = join(anchor, 'session-outputs-v1');
  // Only these exact children are provisioned; a linked or permissive existing anchor refuses.
  try {
    await mkdir(anchor, { mode: 0o700 });
  } catch (error) {
    if (code(error) !== 'EEXIST') throw error;
  }
  const anchorInfo = directory(anchor);
  try {
    await mkdir(parent, { mode: 0o700 });
  } catch (error) {
    if (code(error) !== 'EEXIST') throw error;
  }
  const result = { anchor, anchorInfo, parent, parentInfo: directory(parent) };
  validateRoots(result);
  return result;
}
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK;
const WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0) |
  constants.O_NONBLOCK;

/** Ownership is pinned both before and after opening, without using a native error's path/cause. */
async function readOwned(
  path: string,
  expected: Identity,
  maxBytes: number,
  validate: () => void,
  signal?: AbortSignalLike,
  hook?: () => Promise<void>,
): Promise<{ bytes: Buffer; info: BigIntStats }> {
  abort(signal);
  validate();
  file(path, expected);
  const handle = await open(path, READ_FLAGS);
  try {
    const info = await handle.stat({ bigint: true });
    regular(info, expected);
    if (info.size < 0n || info.size > BigInt(maxBytes)) fail('quota');
    validate();
    file(path, info);
    const bytes = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < bytes.length) {
      abort(signal);
      await hook?.();
      abort(signal);
      validate();
      file(path, info);
      const result = await handle.read(
        bytes,
        offset,
        Math.min(CHUNK_BYTES, bytes.length - offset),
        offset,
      );
      if (result.bytesRead === 0) fail('io');
      offset += result.bytesRead;
    }
    abort(signal);
    validate();
    file(path, info);
    const after = await handle.stat({ bigint: true });
    regular(after, info);
    if (
      after.size !== info.size ||
      after.mtimeNs !== info.mtimeNs ||
      after.ctimeNs !== info.ctimeNs
    )
      fail('unsafe_path');
    return { bytes, info };
  } finally {
    await handle.close();
  }
}
async function readOwner(path: string, info: Identity, validate: () => void): Promise<Owner> {
  const data = await readOwned(path, info, 1024, validate);
  const parsed: unknown = JSON.parse(data.bytes.toString('utf8'));
  const owner = ownerSchema.safeParse(parsed);
  if (!owner.success) fail('unsafe_path');
  return owner.data;
}

/** Flat, finite sweep. Every live PID (including a reused PID), uncertain owner, unmarked tree,
 * malformed entry, linked inode, or changed root is retained. No age-only deletion authority.
 */
async function sweep(
  roots: Roots,
  probe: (pid: number) => OwnerState,
): Promise<SessionOutputSweepResult> {
  validateRoots(roots);
  const entries = await names(roots.parent, SWEEP_ENTRIES);
  let removed = 0;
  let retained = 0;
  for (const name of entries.names) {
    const match = DIRECTORY.exec(name);
    if (match?.[1] === undefined || match[2] === undefined) {
      retained++;
      continue;
    }
    const root = join(roots.parent, name);
    try {
      validateRoots(roots);
      const rootInfo = directory(root);
      const validate = (): void => {
        validateRoots(roots);
        directory(root, rootInfo);
      };
      const markerInfo = file(join(root, MARKER));
      const owner = await readOwner(join(root, MARKER), markerInfo, validate);
      if (
        owner.pid !== Number(match[1]) ||
        owner.instance !== match[2] ||
        owner.dev !== rootInfo.dev.toString() ||
        owner.ino !== rootInfo.ino.toString() ||
        probe(owner.pid) !== 'dead'
      ) {
        retained++;
        continue;
      }
      const children = await names(root, SESSION_OUTPUT_LIMITS.files * 2 + 1);
      if (
        children.incomplete ||
        children.names.some((child) => child !== MARKER && !OUTPUT_FILE.test(child))
      ) {
        retained++;
        continue;
      }
      const pins = children.names.map((child) => ({ name: child, info: file(join(root, child)) }));
      validate();
      file(join(root, MARKER), markerInfo);
      // Recheck liveness immediately before destructive work. Missing files from a peer sweep are
      // already reclaimed; every remaining inode still needs current, exact ownership.
      if (probe(owner.pid) !== 'dead') {
        retained++;
        continue;
      }
      for (const pin of pins.filter((pin) => pin.name !== MARKER)) {
        validate();
        file(join(root, MARKER), markerInfo);
        try {
          file(join(root, pin.name), pin.info);
          await unlink(join(root, pin.name));
        } catch (error) {
          if (code(error) !== 'ENOENT') throw error;
        }
      }
      validate();
      file(join(root, MARKER), markerInfo);
      await unlink(join(root, MARKER));
      validate();
      await rmdir(root);
      removed++;
    } catch {
      // Revoked global roots cannot be represented as successful startup maintenance.
      validateRoots(roots);
      retained++;
    }
  }
  validateRoots(roots);
  return Object.freeze({ removed, retained, incomplete: entries.incomplete });
}

function slice(bytes: Buffer, opts: FsReadOpts): Pick<FileRead, 'content' | 'range'> {
  if (opts.glob === true) fail('invalid_range');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('invalid_text');
  }
  if (bytes.includes(0)) fail('invalid_text');
  const range = opts.range;
  if (range === undefined) return { content: bytes.toString('utf8') };
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) fail('invalid_range');
  let startByte: number;
  let endByte: number;
  if (range.unit === 'bytes') {
    if (range.start < 0 || range.end < range.start || range.end > bytes.length)
      fail('invalid_range');
    startByte = range.start;
    endByte = range.end;
  } else if (range.unit === 'lines') {
    if (bytes.length === 0 || range.start < 1 || range.end < range.start) fail('invalid_range');
    let line = 1;
    let start: number | undefined = range.start === 1 ? 0 : undefined;
    let end: number | undefined;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 10) continue;
      if (line === range.end) end = i + 1;
      if (i + 1 < bytes.length) {
        line++;
        if (line === range.start) start = i + 1;
      }
    }
    if (start === undefined || range.end > line) fail('invalid_range');
    startByte = start;
    endByte = end ?? bytes.length;
  } else fail('invalid_range');
  // Empty ranges at the middle of a code point are also refused.
  for (const boundary of [startByte, endByte])
    if (boundary < bytes.length && ((bytes[boundary] ?? 0) & 0xc0) === 0x80) fail('invalid_range');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(startByte, endByte),
    );
  } catch {
    fail('invalid_text');
  }
  return {
    content,
    range: { ...range, startByte, endByte, omittedBytes: bytes.length - (endByte - startByte) },
  };
}

/** A failed constructor owns only the pinned instance directory and its exclusive marker.
 * Unknown entries or aliases retain the entire subtree; the shared anchor/parent are never removed.
 */
async function rollbackInitialization(
  global: Roots,
  root: string,
  rootInfo: Identity | undefined,
  markerInfo: Identity | undefined,
): Promise<boolean> {
  try {
    if (rootInfo === undefined) return false;
    const validate = (): void => {
      validateRoots(global);
      directory(root, rootInfo);
    };
    validate();
    const children = await names(root, 1);
    validate();
    if (children.incomplete || children.names.some((name) => name !== MARKER)) return false;
    if (children.names.length !== 0) {
      if (markerInfo === undefined) return false;
      file(join(root, MARKER), markerInfo);
      validate();
      file(join(root, MARKER), markerInfo);
      await unlink(join(root, MARKER));
    }
    validate();
    await rmdir(root);
    return true;
  } catch {
    return false;
  }
}

/** Rejects with SessionOutputStoreError; cancellation preserves the caller's exact abort reason. */
export async function createSessionOutputStore(
  options: SessionOutputStoreOptions,
): Promise<SessionOutputStore> {
  try {
    return await createStore(options);
  } catch (error) {
    throw normalize(error);
  }
}
async function createStore(options: SessionOutputStoreOptions): Promise<SessionOutputStore> {
  const limits = { ...SESSION_OUTPUT_LIMITS, ...options.limits };
  for (const key of ['fileBytes', 'totalBytes', 'files'] as const)
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] <= 0 ||
      limits[key] > SESSION_OUTPUT_LIMITS[key]
    )
      fail('quota');
  const global = await roots(options.homeDir);
  const startupSweep = await sweep(global, options.testHooks?.ownerState ?? ownerState);
  const instance = randomUUID();
  const root = join(global.parent, `output-v1.${process.pid}.${instance}`);
  let rootInfo: BigIntStats | undefined;
  let markerInfo: BigIntStats | undefined;
  let marker: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  let scratch: HostScratchRoot;
  const markerPath = join(root, MARKER);
  const validate = (): void => {
    if (rootInfo === undefined) fail('unsafe_path');
    validateRoots(global);
    directory(root, rootInfo);
  };
  try {
    validateRoots(global);
    await mkdir(root, { mode: 0o700 });
    created = true;
    rootInfo = directory(root);
    const owner: Owner = {
      version: 1,
      pid: process.pid,
      instance,
      dev: rootInfo.dev.toString(),
      ino: rootInfo.ino.toString(),
    };
    validate();
    marker = await open(markerPath, WRITE_FLAGS, 0o600);
    // Capture deletion authority before any fallible metadata write, sync, or descriptor issuance.
    markerInfo = await marker.stat({ bigint: true });
    regular(markerInfo);
    validate();
    file(markerPath, markerInfo);
    await options.testHooks?.afterMarkerOpen?.();
    validate();
    file(markerPath, markerInfo);
    await marker.writeFile(JSON.stringify(owner));
    await marker.sync();
    await marker.close();
    marker = undefined;
    validate();
    file(markerPath, markerInfo);
    scratch = issueHostScratchRoot({ homeDir: resolve(global.anchor, '..'), rootDir: root });
  } catch (error) {
    const primary = normalize(error);
    let closeUncertain = false;
    if (marker !== undefined) {
      try {
        await marker.close();
      } catch {
        closeUncertain = true;
      }
    }
    const removed = !created || (await rollbackInitialization(global, root, rootInfo, markerInfo));
    throw new SessionOutputStoreError(
      primary.reason,
      primary.cleanupUncertain || closeUncertain || !removed,
    );
  }
  const validateOwned = (): void => {
    if (markerInfo === undefined) fail('unsafe_path');
    validate();
    file(markerPath, markerInfo);
  };
  const owned = new Map<string, { readonly name: string; readonly info: BigIntStats }>();
  const pending = new Set<Promise<unknown>>();
  let sealed = false;
  let totalBytes = 0;
  let fileCount = 0;
  let closePromise: Promise<void> | undefined;
  let cleanupFailed = false;
  function track<T>(factory: () => Promise<T>): Promise<T> {
    if (sealed) return Promise.reject(new SessionOutputStoreError('closed'));
    // Both factories are async and retain their raw native producer through final cleanup.
    const work = factory();
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }
  async function remove(name: string, info: Identity): Promise<void> {
    validateOwned();
    file(join(root, name), info);
    await unlink(join(root, name));
    owned.delete(name);
  }
  async function write(text: string, signal?: AbortSignalLike): Promise<SpilledResult> {
    abort(signal);
    const length = Buffer.byteLength(text, 'utf8');
    if (
      length > limits.fileBytes ||
      totalBytes + length > limits.totalBytes ||
      fileCount >= limits.files
    )
      fail('quota');
    totalBytes += length;
    fileCount++;
    const id = randomUUID();
    const tempName = `${id}.tmp`;
    const finalName = `${id}.txt`;
    let currentName = tempName;
    let identity: BigIntStats | undefined;
    let tempCreated = false;
    let published = false;
    try {
      validateOwned();
      const handle = await open(join(root, tempName), WRITE_FLAGS, 0o600);
      tempCreated = true;
      try {
        identity = await handle.stat({ bigint: true });
        regular(identity);
        owned.set(tempName, { name: tempName, info: identity });
        const bytes = Buffer.from(text, 'utf8');
        let offset = 0;
        while (offset < bytes.length) {
          abort(signal);
          await options.testHooks?.beforeWriteChunk?.();
          abort(signal);
          validateOwned();
          file(join(root, tempName), identity);
          const result = await handle.write(
            bytes,
            offset,
            Math.min(CHUNK_BYTES, bytes.length - offset),
            offset,
          );
          if (result.bytesWritten === 0) fail('io');
          offset += result.bytesWritten;
        }
        await handle.sync();
        abort(signal);
        validateOwned();
        file(join(root, tempName), identity);
        const finalInfo = await handle.stat({ bigint: true });
        regular(finalInfo, identity);
        if (finalInfo.size !== BigInt(length)) fail('io');
        identity = finalInfo;
      } finally {
        await handle.close();
      }
      abort(signal);
      validateOwned();
      file(join(root, tempName), identity);
      // The random exclusive temp owns this fresh final name; never overwrite a planted final.
      try {
        lstatSync(join(root, finalName));
        fail('unsafe_path');
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
      }
      await rename(join(root, tempName), join(root, finalName));
      currentName = finalName;
      owned.delete(tempName);
      owned.set(finalName, { name: finalName, info: identity });
      abort(signal);
      validateOwned();
      file(join(root, finalName), identity);
      published = true;
      return { ref: `output://${instance}/${id}`, byteLength: length };
    } catch (error) {
      abort(signal);
      const primary = normalize(error);
      throw tempCreated && identity === undefined
        ? new SessionOutputStoreError(primary.reason, true)
        : primary;
    } finally {
      if (!published) {
        if (tempCreated && identity === undefined) {
          // Exclusive creation succeeded, but no inode pin was captured. Never guess deletion authority
          // or reuse its reservations; quarantine this instance and report uncertainty on close.
          cleanupFailed = true;
          sealed = true;
        } else {
          totalBytes -= length;
          fileCount--;
        }
        if (identity !== undefined)
          try {
            await remove(currentName, identity);
          } catch {
            cleanupFailed = true;
            sealed = true;
          }
      }
    }
  }
  async function read(ref: string, opts: FsReadOpts, signal?: AbortSignalLike): Promise<FileRead> {
    try {
      abort(signal);
      const parsed = REFERENCE.exec(ref);
      if (parsed?.[1] !== instance || parsed[2] === undefined) fail('invalid_ref');
      const name = `${parsed[2]}.txt`;
      const entry = owned.get(name);
      if (entry === undefined) fail('invalid_ref');
      const result = await readOwned(
        join(root, name),
        entry.info,
        limits.fileBytes,
        validateOwned,
        signal,
        options.testHooks?.beforeReadChunk,
      );
      abort(signal);
      return {
        ...slice(result.bytes, opts),
        mimeType: 'text/plain',
        sizeBytes: Number(result.info.size),
        lastModified: new Date(Number(result.info.mtimeMs)).toISOString(),
      };
    } catch (error) {
      abort(signal);
      throw normalize(error);
    }
  }
  function seal(): void {
    sealed = true;
  }
  async function cleanup(): Promise<void> {
    await Promise.allSettled([...pending]);
    try {
      await options.testHooks?.beforeCleanup?.();
      validateOwned();
      const children = await names(root, limits.files * 2 + 1);
      if (children.incomplete || children.names.some((name) => name !== MARKER && !owned.has(name)))
        fail('cleanup');
      // Validate every entry before deleting any, so a planted link retains the complete subtree.
      for (const entry of owned.values()) file(join(root, entry.name), entry.info);
      for (const entry of [...owned.values()]) await remove(entry.name, entry.info);
      validateOwned();
      await unlink(markerPath);
      validate();
      await rmdir(root);
      if (cleanupFailed) fail('cleanup');
    } catch {
      fail('cleanup');
    }
  }
  return Object.freeze({
    scratch,
    startupSweep,
    spill: (text: string, _limits: ToolResultLimits, signal?: AbortSignalLike) =>
      track(() => write(text, signal)),
    read: (ref: string, opts: FsReadOpts, signal?: AbortSignalLike) =>
      track(() => read(ref, opts, signal)),
    seal,
    close: (): Promise<void> => {
      seal();
      closePromise ??= cleanup();
      return closePromise;
    },
  });
}
