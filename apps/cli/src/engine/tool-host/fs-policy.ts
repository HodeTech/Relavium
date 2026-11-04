import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { FsScopeTier } from '@relavium/core';
import { FS_ROOT_LIMITS } from '@relavium/shared/fs-root-limits';

import { HostDeniedError } from './errors.js';

export class FsPolicyError extends HostDeniedError {
  constructor() {
    super('the filesystem roots or their pinned identities could not be admitted');
  }
}

interface DirectoryPin {
  readonly lexical: string;
  readonly canonical: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly lexicalDev: bigint;
  readonly lexicalIno: bigint;
  readonly linked: boolean;
}

export interface InvocationFsGrants {
  readonly kind: 'invocation-fs-grants';
}
export interface FsPathPolicy {
  readonly kind: 'owned-fs-policy';
}
export interface HostScratchRoot {
  readonly kind: 'host-scratch-root';
}

interface ScratchData {
  readonly anchor: DirectoryPin;
  readonly root: DirectoryPin;
}
interface PolicyData {
  readonly workspace: DirectoryPin;
  readonly extra: readonly DirectoryPin[];
  readonly grants: readonly DirectoryPin[];
  readonly scratch: ScratchData | undefined;
}

const invocations = new WeakMap<InvocationFsGrants, readonly DirectoryPin[]>();
const policies = new WeakMap<FsPathPolicy, PolicyData>();
const scratches = new WeakMap<HostScratchRoot, ScratchData>();

/** Native path membership, including Windows cross-drive refusal and sibling-prefix boundaries. */
export function isWithinFsRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function pinDirectory(path: string): DirectoryPin {
  try {
    const lexical = resolve(path);
    // Match fs/promises.realpath's native canonicalization. The legacy synchronous
    // walker preserves Windows 8.3 spellings, which are not equal to their long names.
    const canonical = realpathSync.native(lexical);
    // Exact native identities: a 64-bit file ID (NTFS, overlayfs xino) exceeds a Number's precision.
    const stat = statSync(canonical, { bigint: true });
    const entry = lstatSync(lexical, { bigint: true });
    if (!stat.isDirectory()) throw new FsPolicyError();
    return Object.freeze({
      lexical,
      canonical,
      dev: stat.dev,
      ino: stat.ino,
      lexicalDev: entry.dev,
      lexicalIno: entry.ino,
      linked: entry.isSymbolicLink(),
    });
  } catch {
    throw new FsPolicyError();
  }
}

function validatePin(pin: DirectoryPin): void {
  const current = pinDirectory(pin.lexical);
  if (
    current.canonical !== pin.canonical ||
    current.dev !== pin.dev ||
    current.ino !== pin.ino ||
    current.lexicalDev !== pin.lexicalDev ||
    current.lexicalIno !== pin.lexicalIno ||
    current.linked !== pin.linked
  ) {
    throw new FsPolicyError();
  }
}

/** Called before dispatcher history/provider/key/MCP composition (ADR-0105). */
export function admitInvocationFsGrants(paths: readonly string[]): InvocationFsGrants {
  if (paths.length > FS_ROOT_LIMITS.count) throw new FsPolicyError();
  const pins = paths.map((path) => {
    if (path.length === 0 || path.length > FS_ROOT_LIMITS.characters || !isAbsolute(path))
      throw new FsPolicyError();
    return pinDirectory(path);
  });
  const descriptor: InvocationFsGrants = Object.freeze({ kind: 'invocation-fs-grants' });
  invocations.set(descriptor, Object.freeze(pins));
  return descriptor;
}

/** Config selects within independently pinned invocation authority; [] and absent are distinct. */
export function selectInvocationFsPolicy(
  invocation: InvocationFsGrants,
  workspace: string,
  selectors: readonly string[] | undefined,
): FsPathPolicy {
  const grants = invocations.get(invocation);
  if (grants === undefined) throw new FsPolicyError();
  grants.forEach(validatePin);
  if (selectors !== undefined && selectors.length > FS_ROOT_LIMITS.count) throw new FsPolicyError();
  const extra =
    selectors === undefined
      ? grants
      : selectors.map((selector) => {
          if (selector.trim() === '' || selector.length > FS_ROOT_LIMITS.characters)
            throw new FsPolicyError();
          const pin = pinDirectory(resolve(workspace, selector));
          if (!grants.some((grant) => isWithinFsRoot(grant.canonical, pin.canonical)))
            throw new FsPolicyError();
          return pin;
        });
  return ownPolicy(workspace, extra, grants, undefined);
}

/** Trusted host construction for non-CLI embeddings/tests. Strings are pinned once, never re-admitted. */
export function createFsPathPolicy(opts: {
  readonly workspaceDir: string;
  readonly extraRoots?: readonly string[];
  readonly scratch?: HostScratchRoot;
}): FsPathPolicy {
  if ((opts.extraRoots?.length ?? 0) > FS_ROOT_LIMITS.count) throw new FsPolicyError();
  const extra = [...(opts.extraRoots ?? [])].map(pinDirectory);
  const scratch = opts.scratch === undefined ? undefined : scratches.get(opts.scratch);
  if (opts.scratch !== undefined && scratch === undefined) throw new FsPolicyError();
  return ownPolicy(opts.workspaceDir, extra, extra, scratch);
}

function ownPolicy(
  workspace: string,
  extra: readonly DirectoryPin[],
  grants: readonly DirectoryPin[],
  scratch: ScratchData | undefined,
): FsPathPolicy {
  const descriptor: FsPathPolicy = Object.freeze({ kind: 'owned-fs-policy' });
  policies.set(
    descriptor,
    Object.freeze({
      workspace: pinDirectory(workspace),
      extra: Object.freeze([...extra]),
      grants: Object.freeze([...grants]),
      scratch,
    }),
  );
  return descriptor;
}

/** Issue the floor prerequisite only. No shipping scratch allocator/lifecycle is introduced here. */
export function issueHostScratchRoot(opts: {
  readonly homeDir: string;
  readonly rootDir: string;
}): HostScratchRoot {
  const anchor = pinDirectory(join(opts.homeDir, '.relavium'));
  const root = pinDirectory(opts.rootDir);
  if (
    root.lexical === anchor.lexical ||
    root.canonical === anchor.canonical ||
    !isWithinFsRoot(anchor.lexical, root.lexical) ||
    !isWithinFsRoot(anchor.canonical, root.canonical) ||
    anchor.linked ||
    root.linked
  ) {
    throw new FsPolicyError();
  }
  assertPrivateDirectory(anchor.lexical);
  inspectScratchDescendants(anchor.lexical, root.lexical, true);
  const descriptor: HostScratchRoot = Object.freeze({ kind: 'host-scratch-root' });
  scratches.set(descriptor, Object.freeze({ anchor, root }));
  return descriptor;
}

function assertPrivateDirectory(path: string): void {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch {
    throw new FsPolicyError();
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new FsPolicyError();
  if (
    process.platform !== 'win32' &&
    ((info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()))
  )
    throw new FsPolicyError();
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function inspectScratchDescendants(root: string, target: string, privateDirectories = false): void {
  if (!isWithinFsRoot(root, target)) throw new FsPolicyError();
  let path = root;
  for (const part of relative(root, target)
    .split(sep)
    .filter((part) => part !== '')) {
    path = join(path, part);
    let info: Stats;
    try {
      info = lstatSync(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw new FsPolicyError();
    }
    if (info.isSymbolicLink()) throw new FsPolicyError();
    if (privateDirectories || info.isDirectory()) assertPrivateDirectory(path);
  }
}

function policyData(policy: FsPathPolicy | undefined): PolicyData {
  const data = policy === undefined ? undefined : policies.get(policy);
  if (data === undefined) throw new FsPolicyError();
  return data;
}

/** Attach host-owned scratch without replacing any previously admitted authority or lexical pin. */
export function composeFsPathPolicyScratch(
  policy: FsPathPolicy,
  scratch: HostScratchRoot | undefined,
): FsPathPolicy {
  const data = policyData(policy);
  if (scratch === undefined) return policy;
  const attached = scratches.get(scratch);
  if (attached === undefined) throw new FsPolicyError();
  if (data.scratch === attached) return policy;
  if (data.scratch !== undefined) throw new FsPolicyError();
  const descriptor: FsPathPolicy = Object.freeze({ kind: 'owned-fs-policy' });
  // Reuse the original workspace, selected roots and invocation grants verbatim.
  // Reconstructing from canonical strings would discard lexical provenance or
  // silently authorize a replacement that appeared after original admission.
  policies.set(descriptor, Object.freeze({ ...data, scratch: attached }));
  return descriptor;
}

/** Validate current root identities before every capability operation; no silent replacement grant. */
export function fsPolicyScopeRoots(
  policy: FsPathPolicy | undefined,
  workspace: string,
  tier: FsScopeTier,
): readonly string[] {
  const data = policyData(policy);
  const bound = resolve(workspace);
  if (bound !== data.workspace.lexical && bound !== data.workspace.canonical)
    throw new FsPolicyError();
  [data.workspace, ...data.grants, ...data.extra].forEach(validatePin);
  if (data.scratch !== undefined) {
    validatePin(data.scratch.anchor);
    validatePin(data.scratch.root);
    assertPrivateDirectory(data.scratch.anchor.lexical);
    inspectScratchDescendants(data.scratch.anchor.lexical, data.scratch.root.lexical, true);
  }
  return [
    data.workspace.canonical,
    ...(tier === 'project' ? data.extra.map((pin) => pin.canonical) : []),
    ...(data.scratch === undefined ? [] : [data.scratch.root.canonical]),
  ];
}

/** A scratch access must be inside the exact issued root in BOTH lexical and canonical views. */
export function assertFsPolicyPath(
  policy: FsPathPolicy | undefined,
  lexical: string,
  canonical: string,
): void {
  const scratch = policyData(policy).scratch;
  if (scratch === undefined) return;
  const lexicalRoot = isWithinFsRoot(scratch.root.lexical, lexical)
    ? scratch.root.lexical
    : scratch.root.canonical;
  const lexicalInside = isWithinFsRoot(lexicalRoot, lexical);
  const canonicalInside = isWithinFsRoot(scratch.root.canonical, canonical);
  if (lexicalInside !== canonicalInside) throw new FsPolicyError();
  if (lexicalInside) inspectScratchDescendants(lexicalRoot, lexical);
}

/** Keep lexical provenance even when a session persists/uses the canonical workspace or grant root. */
export function fsPolicyFloorPaths(
  policy: FsPathPolicy | undefined,
  path: string,
): readonly string[] {
  const data = policyData(policy);
  const views = new Set([path]);
  for (const pin of [data.workspace, ...data.grants, ...data.extra]) {
    if (isWithinFsRoot(pin.canonical, path))
      views.add(join(pin.lexical, relative(pin.canonical, path)));
  }
  return [...views].map((view) => scratchFloorPath(data.scratch, view));
}

/** Exempt only the issued ancestor component; every other credential/protected component remains visible. */
function scratchFloorPath(scratch: ScratchData | undefined, path: string): string {
  if (scratch === undefined) return path;
  for (const [root, anchor] of [
    [scratch.root.lexical, scratch.anchor.lexical],
    [scratch.root.canonical, scratch.anchor.canonical],
  ] as const) {
    if (isWithinFsRoot(root, path)) {
      inspectScratchDescendants(root, path);
      return join(dirname(anchor), '__host_owned_scratch__', relative(anchor, path));
    }
  }
  return path;
}

export function fsPolicyWorkspace(policy: FsPathPolicy | undefined): string {
  return policyData(policy).workspace.canonical;
}
