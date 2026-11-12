import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  ToolDispatchError,
  ToolPreparationError,
  type FsPrepareWriteRequest,
  type FsPreparedWrite,
  type ToolHostCallOptions,
  ToolUnavailableError,
  type DirEntry,
  type DirListing,
  type FileRead,
  type FileWritten,
  type FsCapability,
  type FsListOpts,
  type FsReadOpts,
  type FsScopeTier,
} from '@relavium/core';
import { deepestExistingReal, type AbortSignalLike } from '@relavium/shared';

import {
  createNativeProcessController,
  type NativeProcessController,
} from '../../process/native-process-owner.js';
import { compileIgnore, parseIgnoreLines } from '../../render/tui/gitignore.js';
import {
  captureNativeRuntimeWriteFloor,
  loadNativeMetadataWriteAdapter,
} from './fs-native-metadata.js';
import { captureRequiredCreationMask } from './fs-creation-mask.js';
import { runNativeStage } from './fs-native-write.js';
import {
  captureFsStageInventory,
  FsStageInventoryError,
  normalizeNodeFsIdentity,
  type FsStageInventory,
} from './fs-stage-inventory.js';

import {
  HostCapabilityError,
  HostDeniedError,
  throwIfAborted as throwIfAbortedShared,
} from './errors.js';
import {
  assertFsPolicyPath,
  composeFsPathPolicyScratch,
  createFsPathPolicy,
  fsPolicyFloorPaths,
  fsPolicyScopeRoots,
  fsPolicyWorkspace,
  FsPolicyError,
  isWithinFsRoot,
  type FsPathPolicy,
  type HostScratchRoot,
} from './fs-policy.js';

/**
 * The Node host **mechanism** half of the `ToolHost.fs` capability arm (2.5.A, [ADR-0055](../../../../../docs/decisions/0055-cli-host-capability-seam-tool-environment-factory.md);
 * the engine owns the policy, the host owns the side effect — [ADR-0037](../../../../../docs/decisions/0037-engine-tool-execution-boundary.md)).
 * It backs `read_file` / `write_file` / `list_directory` with a `realpath` + `commonpath` **jail** mirroring
 * the `save_to` write port (`@relavium/db` `media-write.ts`, security-review.md §Media byte delivery): every
 * resolved path is verified to sit under an allowed scope root **after** symlinks are resolved, so neither a
 * `..` traversal nor a symlinked component can escape the tier.
 *
 * Scope tiers ([built-in-tools.md](../../../../../docs/reference/shared-core/built-in-tools.md) §Filesystem
 * permission tiers): `sandboxed` ⇒ the workspace dir (+ an optional host-issued scratch root), `project` ⇒ the workspace plus
 * invocation-granted extra roots selected by config, `full` ⇒ unjailed (the power-user opt-in). A relative tool path resolves
 * against the workspace dir.
 *
 * **Read-only by profile (2.5.A).** `relavium chat`'s default profile constructs this with `readOnly: true`,
 * so `write_file` fail-closes with a `ToolUnavailableError` (→ the actionable `tool_unavailable` code, EA1).
 * Interactive chat uses the full-capability profile behind ADR-0057's mode-aware approval floor; the
 * read-only profile remains an independent host restriction. The workflow-run profile wires it read-write (the workflow-author trust
 * model already governs that path). Reads/writes are bounded (`maxReadBytes`, `maxGlobMatches`) so a single
 * tool call can never stream an unbounded amount into engine memory.
 *
 * Errors name a **reason only** — never the resolved path, the scope root, or the bytes (security-review.md
 * rule 6 / the I3 boundary). A raw Node `fs` error (whose `.message`/`.path` carries the absolute path) is
 * caught at the boundary and re-wrapped, so the capability honours its own contract regardless of caller.
 */

type FsReadRange = NonNullable<FsReadOpts['range']>;
type FsFindOpts = Parameters<NonNullable<FsCapability['findFiles']>>[1];
type FsFindResult = Awaited<ReturnType<NonNullable<FsCapability['findFiles']>>>;
type FsSearchOpts = Parameters<NonNullable<FsCapability['searchFiles']>>[1];
type FsSearchResult = Awaited<ReturnType<NonNullable<FsCapability['searchFiles']>>>;
type FsScanLimit = NonNullable<FsFindResult['stats']['limit']>;

const evidenceAccess = new WeakMap<
  FsCapability,
  (scope: object, path: string, digest: string, start: number, end: number) => boolean
>();
/** Host-only eligibility check; callers supply a freshly verified full-source digest and canonical path. */
export function hasObservedRead(
  capability: FsCapability,
  scope: object,
  path: string,
  digest: string,
  start: number,
  end: number,
): boolean {
  return evidenceAccess.get(capability)?.(scope, path, digest, start, end) ?? false;
}
interface ReadEvidence {
  readonly path: string;
  readonly digest: string;
  readonly start: number;
  readonly end: number;
}

/** Default read ceiling — a single `read_file` never pulls more than this into engine memory (DoS guard). */
const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;
/** Default cap on the files a single glob `read_file` / recursive listing may surface (walk-bound). */
const DEFAULT_MAX_GLOB_MATCHES = 200;
/** Hard cap on entries a single directory listing returns (a huge dir never floods the result). */
const MAX_LIST_ENTRIES = 1000;

export interface NodeFsCapabilityConfig {
  /** The active filesystem scope tier — `sandboxed` (default) / `project` / `full` (built-in-tools.md). */
  readonly tier: FsScopeTier;
  /** The session/run working directory (absolute) — the jail anchor and the base for a relative tool path. */
  readonly workspaceDir: string;
  /** Explicit host-owned operator home for the cross-process staging inventory. */
  readonly operatorHomeDir?: string;
  readonly nativeProcesses?: NativeProcessController;
  /** Host-issued exact private scratch descriptor; a plain tmp path cannot bypass a floor. */
  readonly scratch?: HostScratchRoot;
  /** Pre-admitted invocation policy; absent builds a trusted-host policy once at construction. */
  readonly pathPolicy?: FsPathPolicy;
  /** Trusted-host project roots (absolute); an owned `pathPolicy` takes precedence over these strings. */
  readonly extraRoots?: readonly string[];
  /** `true` ⇒ `write_file` fail-closes as `tool_unavailable` (the 2.5.A chat read-only profile). */
  readonly readOnly: boolean;
  /** Read ceiling in bytes (default {@link DEFAULT_MAX_READ_BYTES}). */
  readonly maxReadBytes?: number;
  /** Max files a single glob read / recursive listing may surface (default {@link DEFAULT_MAX_GLOB_MATCHES}). */
  readonly maxGlobMatches?: number;
}

/**
 * An operational filesystem failure (not-found, a directory read as a file, binary/oversize, an empty glob)
 * naming a **reason only** — never a path / the bytes. Maps to `tool_failed` (the shared {@link HostCapabilityError}).
 */
export class FsCapabilityError extends HostCapabilityError {}

/** Internal discovery ceiling: unlike an I/O failure, return a visibly byte-limited partial scan. */
class FsReadBudgetError extends HostCapabilityError {}

/**
 * A **deterministic scope/security denial** — a path escapes the tier, a UNC path, or a refusal to write through
 * a symlink — mapping to the **fatal**, non-retryable `tool_denied` (the shared {@link HostDeniedError}): a
 * denied path just re-denies, so it must NOT burn the node-retry budget (error-handling.md §tool-dispatch codes).
 *
 * Recoverability (Step 14): fatal by default (`recoverable=false`, inherited). ONE throw opts in — the pure
 * **scope-tier escape** ("the path escapes the allowed filesystem scope") passes `recoverable: true`, so on the
 * `recoverToolFailures` surface (chat / Home / one-shot `agent run`) it is fed back as a correctable tool result
 * and the model can adapt to an in-bounds path (conversational recovery). The **confidentiality** refusal (a
 * secret/credential store read), the protected
 * -path write, and the symlink/hard-link refusals stay fatal — feeding those back would leak a probe oracle or
 * risk nothing useful.
 */
export class FsScopeDeniedError extends HostDeniedError {
  constructor(message: string, opts?: { recoverable?: boolean }) {
    super(message, opts?.recoverable ?? false);
  }
}

/**
 * Build a node-backed {@link FsCapability} jailed to `config`'s scope tier. The returned object is the value a
 * host wires onto `ToolHost.fs`; it holds no ambient state beyond the immutable config.
 */
export function createNodeFsCapability(input: NodeFsCapabilityConfig): FsCapability {
  const snapshot = Object.freeze({
    ...input,
    extraRoots: Object.freeze([...(input.extraRoots ?? [])]),
  });
  let config: NodeFsCapabilityConfig | undefined;
  let admissionError: FsPolicyError | undefined;
  try {
    const pathPolicy =
      snapshot.pathPolicy === undefined
        ? createFsPathPolicy(snapshot)
        : composeFsPathPolicyScratch(snapshot.pathPolicy, snapshot.scratch);
    fsPolicyScopeRoots(pathPolicy, snapshot.workspaceDir, snapshot.tier);
    config = Object.freeze({ ...snapshot, pathPolicy });
  } catch (error) {
    admissionError = error instanceof FsPolicyError ? error : new FsPolicyError();
  }
  // Construction captures identity now. A failed admission stays failed; it is never re-authorized later.
  const owned = (): NodeFsCapabilityConfig => {
    if (config === undefined) throw admissionError ?? new FsPolicyError();
    return config;
  };
  const maxReadBytes = Math.min(
    snapshot.maxReadBytes ?? DEFAULT_MAX_READ_BYTES,
    DEFAULT_MAX_READ_BYTES,
  );
  const maxGlobMatches = snapshot.maxGlobMatches ?? DEFAULT_MAX_GLOB_MATCHES;
  const pending = new WeakMap<object, ReadEvidence>();
  const scopes = new WeakMap<object, ReadEvidence[]>();
  const staged = new WeakMap<object, ReadEvidence[]>();
  const inventory = async (signal?: AbortSignalLike): Promise<FsStageInventory> => {
    const home = owned().operatorHomeDir;
    if (home === undefined) throw new FsStageInventoryError();
    return captureFsStageInventory(home, signal);
  };
  const capability: FsCapability = {
    readFile: (path, opts, signal) =>
      guarded(async () => {
        const stage = await inventory(signal);
        const result = await readOne(
          owned(),
          maxReadBytes,
          maxGlobMatches,
          path,
          opts,
          signal,
          stage,
        );
        if (result.value.range !== undefined) Object.freeze(result.value.range);
        Object.freeze(result.value);
        if (result.evidence !== undefined) pending.set(result.value, result.evidence);
        return result.value;
      }),
    acknowledgeReadResult: (scope, raw) => {
      if (typeof raw !== 'object' || raw === null) return;
      const evidence = pending.get(raw);
      if (evidence === undefined) return;
      pending.delete(raw);
      const entries = staged.get(scope) ?? [];
      entries.push(evidence);
      if (entries.length > 256) entries.shift();
      staged.set(scope, entries);
    },
    promoteReadScope: (scope) => {
      const entries = [...(scopes.get(scope) ?? []), ...(staged.get(scope) ?? [])].slice(-256);
      scopes.set(scope, entries);
      staged.delete(scope);
    },
    releaseReadScope: (scope) => {
      scopes.delete(scope);
      staged.delete(scope);
    },
    findFiles: (path, opts, signal) =>
      guarded(async () =>
        discover(owned(), path, opts, undefined, signal, await inventory(signal)),
      ),
    searchFiles: (path, opts, signal) =>
      guarded(async () =>
        discover(owned(), path, undefined, opts, signal, await inventory(signal)),
      ),
    prepareWrite: (request, signal) =>
      guarded(async () =>
        prepareWrite(owned(), capability, maxReadBytes, request, signal, await inventory(signal)),
      ),
    writeFile: (path, data, opts, signal) =>
      guarded(async () => {
        const prepared = await prepareWrite(
          owned(),
          capability,
          maxReadBytes,
          { kind: 'write', path, content: data, ...opts },
          signal,
          await inventory(signal),
        );
        try {
          return await prepared.execute(signal);
        } finally {
          await prepared.release();
        }
      }),
    listDirectory: (path, opts, signal) =>
      guarded(async () =>
        listOne(owned(), maxGlobMatches, path, opts, signal, await inventory(signal)),
      ),
  };
  evidenceAccess.set(capability, (scope, path, digest, start, end) => {
    if (start < 0 || end < start) return false;
    const intervals = (scopes.get(scope) ?? [])
      .filter((e) => e.path === path && e.digest === digest)
      .sort((a, b) => a.start - b.start);
    let covered = start;
    for (const interval of intervals) {
      if (interval.start > covered) break;
      covered = Math.max(covered, interval.end);
      if (covered >= end) return true;
    }
    return false;
  });
  return capability;
}

/**
 * Run a capability operation, re-wrapping a raw Node `fs` error (whose message/path would leak an absolute
 * path) into a reason-only {@link FsCapabilityError}. A `ToolUnavailableError` (the read-only `write_file`
 * fail-close, surfacing as `tool_unavailable`) and an already-reason-only `FsCapabilityError` pass through.
 */
async function guarded<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    // A typed engine error (ToolUnavailableError = read-only fail-close → tool_unavailable; FsScopeDeniedError
    // = a scope denial → tool_denied) and an already-reason-only FsCapabilityError pass through verbatim. Any
    // RAW Node fs error (whose message/path leaks the absolute path) is replaced with a reason-only one (I3).
    if (
      error instanceof ToolDispatchError ||
      error instanceof HostCapabilityError ||
      error instanceof ToolPreparationError
    ) {
      throw error;
    }
    throw new FsCapabilityError('the filesystem operation failed');
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * read_file
 * ------------------------------------------------------------------------------------------------ */

/**
 * Whether `real` sits inside **pnpm's virtual store** — a `node_modules/.pnpm/…` adjacency. pnpm is the one
 * package manager that hard-links package files from a content-addressable store, and those hard links live ONLY
 * under `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/…` (a top-level `node_modules/<pkg>` is a symlink INTO
 * `.pnpm`, which the jail's realpath resolves to this same store path before the check). npm/yarn-classic copy
 * files (`nlink == 1`) and never need this; macOS/APFS pnpm clones (`nlink == 1`) so the guard is a no-op there.
 *
 * SECURITY (narrowed after the ADR-0057 review): the hard-link aliasing read guard is disabled ONLY for this
 * specific store layout — NOT for any `node_modules` segment (an earlier, too-broad form let an attacker-named
 * `node_modules/<anything>` hard link exfiltrate). The residual is deliberate and bounded: reaching under
 * `node_modules/.pnpm/` to plant a cross-boundary hard link requires a COMPROMISED DEPENDENCY in the tree (a
 * malicious postinstall, or a hard-link path-traversal in the extractor — the node-tar CVE class), at which point
 * the same actor already has local RCE; a benign git clone / normal tarball cannot carry such a link. We accept
 * this to keep dependency-source reads working (a core coding-agent flow) rather than blocking every pnpm read on
 * Linux; the sensitive-read floor still refuses a NAMED secret store even under the store. Tracked for the
 * ADR-0057 security-review record in docs/roadmap/deferred-tasks.md.
 */
function isPnpmStorePath(absolutePath: string): boolean {
  const folded = absolutePath.split(sep).map(foldPathComponent);
  // Match the REAL virtual-store layout ONLY: `…/node_modules/.pnpm/<name>@<version>/node_modules/<name>/…`.
  // Requiring the `<name>@<version>` segment (it always contains `@`) followed by a nested `node_modules`
  // rejects a hard link planted DIRECTLY under `.pnpm/` (e.g. `.pnpm/evil`, or `.pnpm/x/y`), which the looser
  // two-segment adjacency check exempted — the store's package files never live outside that nested shape.
  for (let i = 0; i + 3 < folded.length; i += 1) {
    if (
      folded[i] === 'node_modules' &&
      folded[i + 1] === '.pnpm' &&
      (folded[i + 2]?.includes('@') ?? false) &&
      folded[i + 3] === 'node_modules'
    ) {
      return true;
    }
  }
  return false;
}

/** Whether the hard-link aliasing read guard applies to `real`: ON for the jailed tiers, OFF for the unjailed
 * `full` tier and for pnpm's virtual store ({@link isPnpmStorePath}). */
function rejectAliasedRead(config: NodeFsCapabilityConfig, real: string): boolean {
  return config.tier !== 'full' && !isPnpmStorePath(real);
}

async function readOne(
  config: NodeFsCapabilityConfig,
  maxReadBytes: number,
  maxGlobMatches: number,
  path: string,
  opts: FsReadOpts,
  signal: AbortSignalLike | undefined,
  stage: FsStageInventory,
): Promise<{ value: FileRead; evidence?: ReadEvidence }> {
  throwIfAborted(signal);
  if (opts.glob === true) {
    if (opts.range !== undefined)
      throw new FsCapabilityError('read_file: range cannot be combined with glob');
    return { value: await readGlob(config, maxReadBytes, maxGlobMatches, path, signal, stage) };
  }
  assertNotSensitiveReadPath(resolve(config.workspaceDir, path), config.pathPolicy);
  const inScope = buildScopeChecker(config);
  const real = await jailExisting(config, inScope, path);
  // The confidentiality floor: refuse to read a secret/credential store (.ssh, .relavium, .git/config, the
  // credential dotfiles) in EVERY mode and tier — checked on the realpath'd target so a symlink/alias into one
  // is caught. Reads flow into the model's context (then to the provider), so this mirrors, on the read side,
  // the protected-paths WRITE floor's mode/tier independence (ADR-0057).
  assertNotSensitiveReadPath(lexicalTarget(config, path), config.pathPolicy);
  assertNotSensitiveReadPath(real, config.pathPolicy);
  const result = await readJailedFile(
    real,
    maxReadBytes,
    rejectAliasedRead(config, real),
    opts.range,
    signal,
    undefined,
    stage,
  );
  if (result.kind === 'directory') {
    throw new FsCapabilityError('read_file: the path is a directory, not a file');
  }
  if (result.kind === 'special') {
    throw new FsCapabilityError('read_file: the path is not a regular file');
  }
  if (result.kind === 'aliased') {
    throw new FsScopeDeniedError(
      'read_file: refusing to read a hard-linked file — its content may be shared with a file outside the sandbox (only pnpm virtual-store links under node_modules/.pnpm are exempt)',
    );
  }
  if (result.kind === 'binary') {
    // The durable-media-handle path (ADR-0031) needs a wired media store; the 2.5.A fs arm has none, so a
    // binary/media file fail-closes (never inline base64) rather than corrupting the text channel.
    throw new FsCapabilityError(
      'read_file: binary/media files are not supported in this session — read a text file',
    );
  }
  if (result.kind === 'oversize') {
    throw new FsCapabilityError(`read_file: the file exceeds the ${maxReadBytes}-byte read limit`);
  }
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.bytes);
  } catch {
    throw new FsCapabilityError('read_file: invalid UTF-8 or byte range boundary');
  }
  if (result.bytes.includes(0))
    throw new FsCapabilityError('read_file: binary files are not supported');
  const value: FileRead = {
    content,
    mimeType: mimeForPath(real),
    sizeBytes: result.size,
    lastModified: new Date(result.mtimeMs).toISOString(),
    ...(result.range === undefined ? {} : { range: result.range }),
  };
  return {
    value,
    ...(result.digest === undefined
      ? {}
      : {
          evidence: {
            path: real,
            digest: result.digest,
            start: result.range?.startByte ?? 0,
            end: result.range?.endByte ?? result.size,
          },
        }),
  };
}

/** Expand `pattern` over the jailed tree (bounded), reading each text match into one concatenated view. */
async function readGlob(
  config: NodeFsCapabilityConfig,
  maxReadBytes: number,
  maxGlobMatches: number,
  pattern: string,
  signal: AbortSignalLike | undefined,
  stage: FsStageInventory,
): Promise<FileRead> {
  const matches = await collectGlobFiles(config, maxGlobMatches, pattern, signal, stage);
  if (matches.length === 0) {
    throw new FsCapabilityError('read_file: the glob matched no files');
  }
  const parts: string[] = [];
  let totalBytes = 0;
  let sourceBytes = 0;
  let latest = 0;
  for (const m of matches) {
    throwIfAborted(signal);
    // ONE read fd per match (probe + size + content from the single open) — so a swap after the walk's realpath
    // can neither redirect the read nor make the size charged diverge from the bytes read. The bounded prefix
    // probe may skip a binary match without a full read. Full-source validation reads (including late binary
    // failures) consume the aggregate budget independently of returned text bytes. The fd's own size is
    // admitted BEFORE the full read; prefix-only probes remain bounded by match count × BINARY_PROBE_BYTES.
    const result = await readJailedFile(
      m.real,
      maxReadBytes - sourceBytes,
      rejectAliasedRead(config, m.real),
      undefined,
      signal,
      undefined,
      stage,
    );
    if (result.kind === 'binary') {
      sourceBytes += result.fullReadBytes;
      continue;
    }
    // Skip a match that consumed no full-source read. collectGlobFiles
    // already filters to regular, in-scope, non-sensitive files — but it does NOT check nlink, so the
    // hard-link (`aliased`) skip is enforced HERE by readJailedFile's per-fd guard (the primary aliasing
    // filter for a glob read); `directory`/`special` are the belt-and-suspenders for a post-walk swap.
    if (result.kind === 'directory' || result.kind === 'special' || result.kind === 'aliased')
      continue;
    if (result.kind === 'oversize') {
      throw new FsCapabilityError(
        `read_file: the glob result exceeds the ${maxReadBytes}-byte read limit`,
      );
    }
    sourceBytes += result.size;
    totalBytes += result.size;
    latest = Math.max(latest, result.mtimeMs);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.bytes);
    } catch {
      continue;
    }
    parts.push(`===== ${m.rel} =====\n${text}`);
  }
  if (parts.length === 0) {
    throw new FsCapabilityError('read_file: the glob matched only binary/media files');
  }
  return {
    content: parts.join('\n\n'),
    mimeType: 'text/plain; charset=utf-8',
    sizeBytes: totalBytes,
    lastModified: new Date(latest).toISOString(),
  };
}

/** Prefix length for binary detection — a NUL byte in the first 8 KiB marks a non-text file (the git convention). */
const BINARY_PROBE_BYTES = 8192;

/** The outcome of a single jailed read: a directory, a non-regular/aliased/binary/oversize fail-class, or text + stat. */
export type JailedRead =
  | { kind: 'directory' }
  | { kind: 'special' }
  | { kind: 'aliased' }
  | { kind: 'binary'; fullReadBytes: number }
  | { kind: 'oversize'; size: number }
  | {
      kind: 'file';
      bytes: Buffer;
      size: number;
      mtimeMs: number;
      range?: {
        unit: 'lines' | 'bytes';
        start: number;
        end: number;
        startByte: number;
        endByte: number;
        omittedBytes: number;
      };
      digest?: string;
    };

/**
 * Read an already-jailed canonical path through a **single read fd** — the stat, the bounded binary probe, and
 * the content all come from the one open handle, so a path swapped AFTER the jail's `realpath` can neither make
 * the checked size diverge from the bytes read nor be reached through a probe→read reopen window. `O_NOFOLLOW`
 * fails the open closed if the final component was swapped to a symlink between the resolve and the open: `real`
 * is already canonical, so its final component is NEVER legitimately a symlink (the callers resolved any
 * in-scope symlink to its target first), and `O_NOFOLLOW` therefore rejects ONLY a swap — never a valid target.
 * It is a no-op on Windows (the same residual the append/temp write paths document; Node exposes no `openat` to
 * also pin the PARENT directory). `O_NONBLOCK` opens a FIFO/device WITHOUT blocking — a reader-less FIFO would
 * otherwise hang the open indefinitely (and `fs.open` takes no `AbortSignal`, so the dispatch could not even be
 * cancelled) — and the fstat below then fails any non-regular file closed. `sizeLimit` bounds the read so an
 * over-budget file is never loaded just to be rejected.
 *
 * HARD-LINK ALIASING (`rejectAliased`): `realpath()` resolves symlinks but NOT hard links, so a regular file
 * INSIDE the jail can be a second name for an inode whose OTHER name is OUTSIDE the jail (an SSH key) — the
 * "realpath ∈ scope ⇒ content ∈ scope" invariant the jail relies on does not hold for a hard link, and neither
 * `O_NOFOLLOW` (guards only a symlinked final component) nor the scope check (sees only the in-scope name) catches
 * it. `st.nlink > 1` on the OPENED fd is the race-free signal (same inode the bytes come from); a hard-linked
 * regular file is refused (`kind: 'aliased'`) exactly like a symlink. Gated on `isFile()` (a directory
 * legitimately has `nlink > 1`). `rejectAliased` is `false` only for the unjailed `full` tier — where a benign
 * in-scope hard link (e.g. a pnpm content-store link under `node_modules`) is read normally; the jailed tiers
 * refuse it, trading that read for the aliasing-exfiltration guarantee.
 *
 * Text reads validate UTF-8 without replacement decoding and refuse NUL bytes. A bounded byte seek in a
 * larger file inspects the binary prefix and requested slice/boundaries only; it makes no claim about the
 * unscanned bytes and establishes no full-source edit evidence.
 *
 * Exported for direct security testing of the post-jail fd guard (the no-follow / single-fd / no-hard-link
 * properties), which a black-box `readFile` test cannot reach because the jail already resolves any symlink to
 * its canonical target.
 */
export async function readJailedFile(
  real: string,
  sizeLimit: number,
  rejectAliased = true,
  range?: FsReadRange,
  signal?: AbortSignalLike,
  budget?: { remaining: number },
  stage?: FsStageInventory,
): Promise<JailedRead> {
  throwIfAborted(signal);
  // Windows ignores O_NOFOLLOW. Refuse an already-planted final link explicitly there;
  // this is a stable-path guard, not a promise to close same-user syscall races.
  if (process.platform === 'win32') {
    const entry = await lstat(real);
    if (entry.isSymbolicLink())
      throw new FsScopeDeniedError('read_file: refusing to read through a symlink');
    if (entry.isDirectory()) return { kind: 'directory' };
  }
  const handle = await open(
    real,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    const code = errnoCode(error);
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new FsScopeDeniedError('read_file: refusing to read through a symlink');
    }
    if (code === 'EISDIR') {
      // Some platforms reject `open(dir, O_RDONLY)` outright (Linux/macOS allow it; we detect the dir from the
      // fd's fstat below). Normalize to the same directory outcome so the caller sees one behavior everywhere.
      throw new FsCapabilityError('read_file: the path is a directory, not a file');
    }
    throw error;
  });
  try {
    stage?.assertIdentity(await handle.stat({ bigint: true }));
    const readChunk = async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ): Promise<number> => {
      throwIfAborted(signal);
      const admitted = budget === undefined ? length : Math.min(length, budget.remaining);
      if (admitted <= 0) throw new FsReadBudgetError('search_files: source byte budget reached');
      const { bytesRead } = await handle.read(buffer, offset, admitted, position);
      if (budget !== undefined) budget.remaining -= bytesRead;
      return bytesRead;
    };
    throwIfAborted(signal);
    const st = await handle.stat();
    if (st.isDirectory()) return { kind: 'directory' };
    // Only a REGULAR file is readable. A FIFO / socket / device fails closed here — and because the open used
    // O_NONBLOCK, a reader-less FIFO returned the fd immediately rather than blocking the dispatch. The fstat is
    // authoritative on the OPENED inode, so this guard needs no pre-open path-stat (which would reintroduce the
    // read TOCTOU the single-fd design closes).
    if (!st.isFile()) return { kind: 'special' };
    // Hard-link aliasing guard (see the doc block): a regular file with more than one link may share its inode
    // with a name outside the jail, so a jailed tier refuses it here — race-free on the OPENED fd, before any
    // byte is read. `full` (unjailed) passes `rejectAliased: false` so a benign in-scope hard link still reads.
    if (rejectAliased && st.nlink > 1) return { kind: 'aliased' };
    const probe = Buffer.allocUnsafe(Math.min(BINARY_PROBE_BYTES, st.size));
    const probed = probe.length > 0 ? await readChunk(probe, 0, probe.length, 0) : 0;
    if (probe.subarray(0, probed).includes(0)) return { kind: 'binary', fullReadBytes: 0 };
    if (
      range !== undefined &&
      (!Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < (range.unit === 'lines' ? 1 : 0) ||
        range.end < range.start ||
        (range.unit === 'bytes' && range.end > st.size))
    ) {
      throw new FsCapabilityError('read_file: invalid or out-of-file range');
    }
    const seek = range?.unit === 'bytes' && st.size > sizeLimit;
    if (st.size > sizeLimit && !seek) return { kind: 'oversize', size: st.size };
    const startByte = seek ? range.start : 0;
    const length = seek ? range.end - range.start : st.size;
    if (length > sizeLimit) return { kind: 'oversize', size: length };
    const content = Buffer.alloc(length);
    // Whole-file reads reuse the binary prefix, so every source byte is read and charged once.
    let offset = seek ? 0 : probe.copy(content, 0, 0, probed);
    while (offset < length) {
      const bytesRead = await readChunk(
        content,
        offset,
        Math.min(length - offset, 64 * 1024),
        startByte + offset,
      );
      if (bytesRead === 0) throw new FsCapabilityError('read_file: file changed during read');
      offset += bytesRead;
    }
    const after = await handle.stat();
    throwIfAborted(signal);
    if (
      st.size !== after.size ||
      st.mtimeMs !== after.mtimeMs ||
      st.ctimeMs !== after.ctimeMs ||
      st.ino !== after.ino
    )
      throw new FsCapabilityError('read_file: file changed during read');
    let from = startByte;
    let to = startByte + length;
    if (range?.unit === 'bytes') {
      from = range.start;
      to = range.end;
    }
    if (range?.unit === 'lines') {
      let line = 1;
      let lineStart = 0;
      let foundStart = false;
      let foundEnd = false;
      if (content.length > 0 && range.start === 1) {
        from = 0;
        foundStart = true;
      }
      for (let i = 0; i < content.length; i++) {
        if (content[i] !== 10) continue;
        if (line === range.end) {
          to = i + 1;
          foundEnd = true;
          break;
        }
        if (i + 1 < content.length) {
          line++;
          lineStart = i + 1;
          if (line === range.start) {
            from = lineStart;
            foundStart = true;
          }
        }
      }
      if (!foundEnd && line === range.end && content.length > 0) {
        to = content.length;
        foundEnd = true;
      }
      if (!foundStart || !foundEnd)
        throw new FsCapabilityError('read_file: invalid or out-of-file range');
    }
    if (!seek && range?.unit === 'bytes') {
      for (const boundary of [from, to])
        if (boundary < content.length && ((content[boundary] ?? 0) & 0xc0) === 0x80)
          throw new FsCapabilityError('read_file: byte range cuts a UTF-8 sequence');
    }
    if (!seek) {
      try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
      } catch {
        return { kind: 'binary', fullReadBytes: st.size };
      }
      if (content.includes(0)) return { kind: 'binary', fullReadBytes: st.size };
    } else {
      for (const boundary of [from, to]) {
        if (boundary < st.size) {
          const boundaryProbe = Buffer.alloc(1);
          const bytesRead = await readChunk(boundaryProbe, 0, 1, boundary);
          if (bytesRead !== 1 || ((boundaryProbe[0] ?? 0) & 0xc0) === 0x80)
            throw new FsCapabilityError('read_file: byte range cuts a UTF-8 sequence');
        }
      }
    }
    const bytes = seek ? content : content.subarray(from, to);
    const digest = seek ? undefined : createHash('sha256').update(content).digest('hex');
    return {
      kind: 'file',
      bytes,
      size: st.size,
      mtimeMs: st.mtimeMs,
      ...(range === undefined
        ? {}
        : {
            range: { ...range, startByte: from, endByte: to, omittedBytes: st.size - (to - from) },
          }),
      ...(digest === undefined ? {} : { digest }),
    };
  } finally {
    await handle.close();
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * write_file
 * ------------------------------------------------------------------------------------------------ */

/**
 * Protected paths NO mode (auto included) may write — even where the fs jail would allow them
 * ([ADR-0057](../../../../../docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md)). `.git/`,
 * `.relavium/`, and `.ssh/` are matched by a path SEGMENT (so a `.gitignore` / `.relaviumrc` FILE is not
 * protected — only the directories; a whole `.ssh/` is protected because *nothing* good comes of an agent
 * writing into it — `authorized_keys`, `config`'s `ProxyCommand`, `id_*`, `rc` are all persistence/RCE
 * vectors); the auto-sourced startup / config files below — every one of which executes code on the next
 * shell, X login, or `git` invocation (`.gitconfig`'s `core.hooksPath` / `[alias] x = !cmd` ⇒ RCE) — are
 * matched by BASENAME. This is the secure FLOOR, not an exhaustive catalogue: it deliberately does NOT cover
 * directory-pattern sources (fish `conf.d/*.fish`), OS launch agents (`~/Library/LaunchAgents/*.plist`), or
 * editor auto-run config — those are out of the basename model's reach and rely on the fs jail + approval.
 *
 * {@link foldPathComponent} normalizes each compared name the way a real filesystem folds a component: it
 * takes the part before the first `:` (Win32 NTFS `name::$DATA` / `name:stream` addresses the SAME default
 * stream as `name`, so `.gitconfig::$DATA` must fold to `.gitconfig`), lowercases (a case-insensitive FS / a
 * `.GIT` variant must not slip through), AND strips trailing dots/spaces — Win32 silently drops those at open
 * time, so `write_file('.bashrc.')` / `'.git '` would otherwise land on the REAL protected target while the
 * unfolded name missed the set. Folding always (not only on win32) over-denies a genuinely-distinct `.git.` or
 * a POSIX `a:b` on a case-sensitive FS, which is the safe direction. The canonical target re-check in {@link prepareWrite}
 * additionally canonicalizes a Win32 8.3 short-name alias (`GITCON~1` → `.gitconfig`) of an EXISTING target.
 */
/** Permanently reserved for host-owned ADR-0125 staging, including before any stage exists. */
export const FS_STAGE_DIRECTORY = '.relavium-fs-stage-v1';
/** A reserved stage component is never model filesystem authority. */
export function isFsStagePath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => {
    const folded = foldPathComponent(part);
    return folded === FS_STAGE_DIRECTORY || folded.startsWith(`${FS_STAGE_DIRECTORY}.`);
  });
}
const PROTECTED_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  '.relavium',
  '.ssh',
  FS_STAGE_DIRECTORY,
]);
const PROTECTED_RC_BASENAMES: ReadonlySet<string> = new Set([
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.bash_aliases', // sourced by the default Debian/Ubuntu .bashrc
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
  '.zlogout',
  '.cshrc',
  '.tcshrc',
  '.kshrc',
  '.login',
  '.xprofile', // X11 login scripts — executed at graphical login
  '.xinitrc',
  '.xsession',
  '.gitconfig', // user-global git config — core.hooksPath / `[alias] x = !cmd` ⇒ RCE on the next git command
  'config.fish', // fish — ~/.config/fish/config.fish
  'profile.ps1',
  'microsoft.powershell_profile.ps1', // PowerShell profiles
]);

/** Fold a path component the way a filesystem does for matching: take the pre-`:` part (NTFS `name::$DATA`
 * addresses `name`), lowercase (case-insensitive FS), and strip trailing dots/spaces (Win32 drops those at open
 * time) — so `.BASHRC` / `.bashrc.` / `.git ` / `.gitconfig::$DATA` all fold to the bare protected name. */
function foldPathComponent(name: string): string {
  const beforeStream = name.split(':', 1)[0] ?? name; // NTFS Alternate-Data-Stream / drive qualifier
  const lowered = beforeStream.toLowerCase();
  // Strip trailing dots/spaces (Win32 drops them at open time) via a linear scan — NOT a `/[. ]+$/` regex, whose
  // `+$` backtracks (flagged by the static analyzer) and would break this file's no-backtracking-RegExp posture.
  let end = lowered.length;
  while (end > 0 && (lowered[end - 1] === '.' || lowered[end - 1] === ' ')) end -= 1;
  return lowered.slice(0, end);
}

/**
 * Whether an absolute path is protected — a `.git`/`.relavium`/`.ssh` directory segment, or a startup/config
 * basename. The pure predicate behind {@link assertNotProtectedPath}; exported so a caller (the ADR-0057 chat
 * `auto`-mode approval, which falls back to an explicit prompt on a protected target) can classify a target
 * WITHOUT triggering the throw — the two share exactly one protected-paths definition.
 */
export function isProtectedPath(absoluteTarget: string): boolean {
  for (const segment of absoluteTarget.split(/[\\/]/)) {
    if (PROTECTED_DIR_SEGMENTS.has(foldPathComponent(segment))) return true;
  }
  const base = absoluteTarget.split(/[\\/]/).at(-1) ?? '';
  return PROTECTED_RC_BASENAMES.has(foldPathComponent(base)) || isSensitiveReadPath(absoluteTarget);
}

/** Deny a write to a protected path (a `.git`/`.relavium`/`.ssh` directory, or a startup/config file). FATAL. */
export function isProtectedPolicyPath(absoluteTarget: string, policy?: FsPathPolicy): boolean {
  return (
    policy === undefined ? [absoluteTarget] : fsPolicyFloorPaths(policy, absoluteTarget)
  ).some(isProtectedPath);
}

function assertNotProtectedPath(absoluteTarget: string, policy?: FsPathPolicy): void {
  if (isProtectedPolicyPath(absoluteTarget, policy)) {
    throw new FsScopeDeniedError(
      'write_file: refusing to write a protected directory, credential store or shell startup file',
    );
  }
}

/**
 * Directory segments whose contents are refused to READ in every mode/tier — a whole `.ssh/` (private keys,
 * `authorized_keys`, `known_hosts`) and `.relavium/` (this CLI's local config/secrets dir). Narrower than the
 * write floor's {@link PROTECTED_DIR_SEGMENTS} (which also blocks whole `.git/` for WRITE-side hook RCE, a
 * concern that does not apply to a read) — reads leak CONFIDENTIALITY, so the read floor targets the
 * secret/credential stores specifically.
 *
 * Only a host-issued, identity-checked scratch descriptor may exempt its exact ancestor `.relavium`.
 * Ordinary invocation roots never override this floor (ADR-0105).
 */
const SENSITIVE_READ_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  '.ssh',
  '.relavium',
  FS_STAGE_DIRECTORY,
  '.aws',
  '.kube',
  '.azure',
  '.terraform.d',
  'gcloud', // Unix XDG and Windows APPDATA stores include token databases and credential-bearing configurations.
  'legacy_credentials',
  // `.env` as a DIRECTORY (some tooling stores per-environment secrets as `.env/production`, etc.) — the basename
  // check below only catches a `.env` FILE, so anything NESTED under a `.env/` dir needs the segment guard too.
  // Over-denying a rare `.env` virtualenv read is the safe direction for a confidentiality floor.
  '.env',
]);
/** Credential/secret dotfiles refused to READ by basename (git creds, npm/pypi/pg/netrc tokens). */
const SENSITIVE_READ_BASENAMES: ReadonlySet<string> = new Set([
  '.gitconfig', // user-global git config — `[credential]`, insteadOf URLs with embedded tokens
  '.git-credentials', // git `store` helper — verbatim `https://user:TOKEN@host` lines (the plaintext token store)
  '.netrc',
  '.npmrc', // `_authToken`
  '.pypirc',
  '.pgpass',
  '.envrc', // direnv — an in-repo shell file that routinely holds `export AWS_SECRET_ACCESS_KEY=…` (NOT a `.env*`)
  '.dockercfg', // legacy Docker registry auth (pre-`config.json`) — plaintext base64 `auth` credentials
  'application_default_credentials.json',
  'credentials.tfrc.json',
  '.terraformrc', // Unix CLI config supports token-bearing credentials blocks.
  'terraform.rc', // Windows CLI config in APPDATA supports the same credentials blocks.
]);

/**
 * Whether an absolute path is a secret/credential store that must never be read into the model's context (and
 * thence to the provider): under a `.ssh`/`.relavium`/`.aws` segment, a `.env` / `.env.*` dotenv file, a
 * `.docker/config.json` (registry auth), a repo-local `.git/config` or `config.worktree` (remote-URL credentials), or a
 * credential dotfile. The read-side confidentiality analogue of {@link isProtectedPath}; exported for direct
 * testing. Folds each component like the write floor (NTFS ADS / case / trailing dot-space). This floor is the
 * one control the CLI `@`-mention read (2.5.D / [ADR-0061](../../../../../docs/decisions/0061-cli-input-layer-file-injection-and-shell-escape.md))
 * shares with `read_file`; the `.env`/`.aws`/`.docker` members were added there and strengthen `read_file` on
 * every surface.
 */
export function isSensitiveReadPath(absoluteTarget: string): boolean {
  if (isFsStagePath(absoluteTarget)) return true;
  const folded = absoluteTarget.split(/[\\/]/).map(foldPathComponent);
  for (const segment of folded) {
    if (SENSITIVE_READ_DIR_SEGMENTS.has(segment)) return true;
  }
  const base = folded.at(-1) ?? '';
  // dotenv secret files — `.env`, `.env.local`, `.env.production`, … (foldPathComponent strips a trailing dot, so
  // `.env.` folds to `.env`). The single most common in-repo secret store.
  if (base === '.env' || base.startsWith('.env.')) return true;
  // Docker registry auth (`~/.docker/config.json` or a project `.docker/config.json`) — base64-embedded creds.
  if (base === 'config.json' && folded.includes('.docker')) return true;
  // Git `config` and `config.worktree` can embed remote-URL credentials: catch either under a `.git` dir
  // (repo / submodule / linked worktree) or a bare-repo dir. Over-denying a stray `x.git/config.worktree`
  // that isn't a repo is the safe direction for a read floor.
  if (
    (base === 'config' || base === 'config.worktree') &&
    folded.some((segment) => segment === '.git' || segment.endsWith('.git'))
  ) {
    return true;
  }
  // git's XDG credential store `$XDG_CONFIG_HOME/git/credentials` — same plaintext `user:TOKEN@host` lines as
  // `.git-credentials`, but the basename is a bare `credentials` under a `git` dir (no leading dot).
  if (base === 'credentials' && folded.includes('git')) return true;
  return SENSITIVE_READ_BASENAMES.has(base);
}

/** Discovery prunes refused scratch descendants; explicit accesses still throw. Root identity is admitted separately. */
function isSensitivePolicyReadPath(path: string, policy: FsPathPolicy | undefined): boolean {
  try {
    return (policy === undefined ? [path] : fsPolicyFloorPaths(policy, path)).some(
      isSensitiveReadPath,
    );
  } catch (error) {
    if (error instanceof FsPolicyError) return true;
    throw error;
  }
}

/** Deny a read of a secret/credential store (`.ssh`/`.relavium`, a git `config`, a credential dotfile). FATAL. */
function assertNotSensitiveReadPath(absoluteTarget: string, policy?: FsPathPolicy): void {
  if (
    (policy === undefined ? [absoluteTarget] : fsPolicyFloorPaths(policy, absoluteTarget)).some(
      isSensitiveReadPath,
    )
  ) {
    throw new FsScopeDeniedError(
      'refusing to read a credential/secret store (.ssh / .relavium / .aws / .env or .env.* / .docker config / a git config or credential dotfile) — ask the user to share any needed content instead',
    );
  }
}

interface PreparedSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly digest: string;
  readonly text: string;
}

async function snapshotPrepared(
  target: string,
  maxBytes: number,
  signal: AbortSignalLike | undefined,
  stage: FsStageInventory,
): Promise<PreparedSnapshot | null> {
  await assertNotSymlink(target);
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if (errnoCode(error) === 'ENOENT') return undefined;
    if (errnoCode(error) === 'ELOOP' || errnoCode(error) === 'ENOTDIR')
      throw new FsScopeDeniedError('refusing a symlink or unsafe target');
    throw error;
  });
  if (handle === undefined) return null;
  try {
    const info = await handle.stat({ bigint: true });
    stage.assertIdentity(info);
    if (info.isDirectory()) throw new FsCapabilityError('the target is a directory');
    if (!info.isFile() || info.nlink !== 1n)
      throw new FsScopeDeniedError('refusing a non-regular or hard-linked file');
    if (info.size > BigInt(maxBytes)) throw new ToolPreparationError('diff_limit');
    const bytes = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < bytes.length) {
      throwIfAborted(signal);
      const result = await handle.read(
        bytes,
        offset,
        Math.min(65536, bytes.length - offset),
        offset,
      );
      if (result.bytesRead === 0) throw new ToolPreparationError('stale_file');
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      info.dev !== after.dev ||
      info.ino !== after.ino ||
      info.size !== after.size ||
      info.mtimeNs !== after.mtimeNs ||
      info.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n
    )
      throw new ToolPreparationError('stale_file');
    if (bytes.includes(0)) throw new ToolPreparationError('unsupported_text');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new ToolPreparationError('unsupported_text');
    }
    return {
      dev: info.dev,
      ino: info.ino,
      mode: info.mode,
      uid: info.uid,
      gid: info.gid,
      size: info.size,
      mtimeNs: info.mtimeNs,
      ctimeNs: info.ctimeNs,
      digest: createHash('sha256').update(bytes).digest('hex'),
      text,
    };
  } finally {
    await handle.close();
  }
}
function equalSnapshot(a: PreparedSnapshot | null, b: PreparedSnapshot | null): boolean {
  return a === null
    ? b === null
    : b !== null &&
        a.dev === b.dev &&
        a.ino === b.ino &&
        a.mode === b.mode &&
        a.uid === b.uid &&
        a.gid === b.gid &&
        a.size === b.size &&
        a.mtimeNs === b.mtimeNs &&
        a.ctimeNs === b.ctimeNs &&
        a.digest === b.digest;
}

async function prepareWrite(
  config: NodeFsCapabilityConfig,
  capability: FsCapability,
  maxBytes: number,
  request: FsPrepareWriteRequest,
  signal: AbortSignalLike | undefined,
  stage: FsStageInventory,
): Promise<FsPreparedWrite> {
  if (config.readOnly)
    throw new ToolUnavailableError('write_file', 'fs (read-only in this session)');
  throwIfAborted(signal);
  if (request.path.length > 4096 || Buffer.byteLength(request.path, 'utf8') > 4096)
    throw new FsCapabilityError('write_file: the target path is too long');
  if (Buffer.from(request.path, 'utf8').toString('utf8') !== request.path)
    throw new ToolPreparationError('unsupported_text');
  const nativeFloor = await captureNativeRuntimeWriteFloor();
  const lexical = lexicalTarget(config, request.path);
  nativeFloor.assertPath(lexical);
  assertNotProtectedPath(lexical, config.pathPolicy);
  assertNotSensitiveReadPath(lexical, config.pathPolicy);
  const inScope = buildScopeChecker(config);
  const parent = dirname(lexical);
  const deepest = await deepestExistingReal(parent, {
    realpath,
    lstat,
    dirname,
    isMissing: (error) => errnoCode(error) === 'ENOENT',
  });
  nativeFloor.assertPath(deepest);
  assertInScope(inScope, deepest);
  assertFsPolicyPath(config.pathPolicy, lexical, deepest);
  assertNotProtectedPath(deepest, config.pathPolicy);
  const ancestor = await stat(deepest, { bigint: true });
  const parentReal = await realpath(parent).catch((error: unknown) => {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw error;
  });
  if (parentReal === undefined && (request.kind === 'edit' || request.createDirs !== true))
    throw new FsCapabilityError(
      'write_file: the target directory does not exist (set createDirs to create it)',
    );
  const target = parentReal === undefined ? undefined : join(parentReal, basename(lexical));
  let canonicalTarget: string | undefined;
  if (target !== undefined) {
    nativeFloor.assertPath(target);
    assertInScope(inScope, parentReal!);
    assertFsPolicyPath(config.pathPolicy, lexical, target);
    assertNotProtectedPath(target, config.pathPolicy);
    assertNotSensitiveReadPath(target, config.pathPolicy);
    canonicalTarget = await realpath(target).catch((error: unknown) => {
      if (errnoCode(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (canonicalTarget !== undefined) {
      nativeFloor.assertPath(canonicalTarget);
      assertNotProtectedPath(canonicalTarget, config.pathPolicy);
      assertNotSensitiveReadPath(canonicalTarget, config.pathPolicy);
      stage.assertIdentity(await stat(canonicalTarget, { bigint: true }));
    }
  }
  const proposedText = request.kind === 'write' ? request.content : request.newString;
  if (Buffer.byteLength(proposedText, 'utf8') > maxBytes)
    throw new ToolPreparationError('diff_limit');
  if (Buffer.from(proposedText, 'utf8').toString('utf8') !== proposedText)
    throw new ToolPreparationError('unsupported_text');
  if (config.operatorHomeDir === undefined)
    throw new HostDeniedError('filesystem metadata protection is unavailable');
  const native = await loadNativeMetadataWriteAdapter();
  const before =
    target === undefined ? null : await snapshotPrepared(target, maxBytes, signal, stage);
  let after: string;
  if (request.kind === 'edit') {
    if (before === null || target === undefined || request.readScope === undefined)
      throw new ToolPreparationError('read_required');
    if (request.oldString.length === 0) throw new ToolPreparationError('match_not_found');
    if (
      Buffer.from(request.oldString, 'utf8').toString('utf8') !== request.oldString ||
      Buffer.from(request.newString, 'utf8').toString('utf8') !== request.newString
    )
      throw new ToolPreparationError('unsupported_text');
    const positions: number[] = [];
    let from = 0;
    while (true) {
      const found = before.text.indexOf(request.oldString, from);
      if (found < 0) break;
      positions.push(found);
      if (positions.length > 100_000) throw new ToolPreparationError('diff_limit');
      if (positions.length % 1024 === 0) {
        throwIfAborted(signal);
        await new Promise<void>((resolveYield) => setImmediate(resolveYield));
        throwIfAborted(signal);
      }
      from = found + request.oldString.length;
    }
    if (positions.length === 0) throw new ToolPreparationError('match_not_found');
    if (positions.length > 1 && request.replaceAll !== true)
      throw new ToolPreparationError('match_not_unique');
    let previousEnd = 0;
    let byteCursor = 0;
    let checked = 0;
    for (const position of positions) {
      if (++checked % 1024 === 0) {
        throwIfAborted(signal);
        await new Promise<void>((resolveYield) => setImmediate(resolveYield));
        throwIfAborted(signal);
      }
      byteCursor += Buffer.byteLength(before.text.slice(previousEnd, position), 'utf8');
      const start = byteCursor;
      const end = start + Buffer.byteLength(request.oldString, 'utf8');
      if (
        !hasObservedRead(
          capability,
          request.readScope,
          canonicalTarget ?? target,
          before.digest,
          start,
          end,
        )
      )
        throw new ToolPreparationError('unobserved_match');
      byteCursor = end;
      previousEnd = position + request.oldString.length;
    }
    const finalBytes =
      Number(before.size) +
      positions.length *
        (Buffer.byteLength(request.newString, 'utf8') -
          Buffer.byteLength(request.oldString, 'utf8'));
    if (finalBytes > maxBytes) throw new ToolPreparationError('diff_limit');
    after = before.text.split(request.oldString).join(request.newString);
  } else after = request.append === true ? (before?.text ?? '') + request.content : request.content;
  if (Buffer.byteLength(after, 'utf8') > maxBytes) throw new ToolPreparationError('diff_limit');
  if (after.includes('\0') || Buffer.from(after, 'utf8').toString('utf8') !== after)
    throw new ToolPreparationError('unsupported_text');
  const processes = config.nativeProcesses ?? createNativeProcessController();
  const creationMask = async (maskSignal?: AbortSignalLike): Promise<number | undefined> => {
    const required = native.requiresCreationMaskProbe();
    if (typeof required !== 'boolean' || (required && process.platform !== 'darwin'))
      throw new HostDeniedError('filesystem creation policy unavailable');
    return captureRequiredCreationMask(processes, required, maskSignal);
  };
  const initialMask = await creationMask(signal);
  let nativePrepared: unknown;
  let preparationOwned = false;
  try {
    const nativeTarget = target ?? join(deepest, `.relavium-fs-stage-v1.prepare.${randomUUID()}`);
    nativePrepared =
      before === null
        ? await native.prepareNewMetadata(nativeTarget, initialMask)
        : await native.prepareExistingMetadata(
            nativeTarget,
            request.kind === 'write' && request.append === true,
            initialMask,
          );
    preparationOwned = true;
    if (before !== null) {
      const identity = await native.existingMetadataIdentity(nativePrepared);
      const observedIdentity = normalizeNodeFsIdentity(before);
      if (
        typeof identity !== 'object' ||
        identity === null ||
        !('dev' in identity) ||
        !('ino' in identity) ||
        identity.dev !== observedIdentity.dev.toString() ||
        identity.ino !== observedIdentity.ino.toString()
      ) {
        throw new ToolPreparationError('stale_file');
      }
    }
  } catch (error) {
    if (preparationOwned) {
      try {
        if (before === null) await native.releaseNewMetadata(nativePrepared);
        else await native.releaseExistingMetadata(nativePrepared);
      } catch {
        throw new HostDeniedError('filesystem metadata cleanup failed');
      }
    }
    if (error instanceof ToolPreparationError) throw error;
    throw new HostDeniedError('filesystem metadata preparation refused');
  }
  let used = false;
  let pending: Promise<FileWritten> | undefined;
  let released = false;
  const run = async (executeSignal?: AbortSignalLike): Promise<FileWritten> => {
    throwIfAborted(executeSignal);
    if (config.operatorHomeDir === undefined) throw new FsStageInventoryError();
    const executionStage = await captureFsStageInventory(config.operatorHomeDir, executeSignal);
    const executionNativeFloor = await captureNativeRuntimeWriteFloor();
    executionNativeFloor.assertPath(lexical);
    const freshDeepest = await deepestExistingReal(parent, {
      realpath,
      lstat,
      dirname,
      isMissing: (error) => errnoCode(error) === 'ENOENT',
    });
    executionNativeFloor.assertPath(freshDeepest);
    const freshAncestor = await stat(freshDeepest, { bigint: true });
    if (
      freshDeepest !== deepest ||
      ancestor.dev !== freshAncestor.dev ||
      ancestor.ino !== freshAncestor.ino
    )
      throw new ToolPreparationError('stale_file');
    const freshParent = await realpath(parent).catch((error: unknown) => {
      if (errnoCode(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (freshParent !== parentReal) throw new ToolPreparationError('stale_file');
    if (
      target !== undefined &&
      !equalSnapshot(
        before,
        await snapshotPrepared(target, maxBytes, executeSignal, executionStage),
      )
    )
      throw new ToolPreparationError('stale_file');
    if (target === undefined) {
      const missing: string[] = [];
      let cursor = parent;
      while (true) {
        try {
          await lstat(cursor);
          break;
        } catch (error) {
          if (errnoCode(error) !== 'ENOENT') throw error;
          missing.push(cursor);
          const next = dirname(cursor);
          if (next === cursor) throw new HostDeniedError('filesystem creation policy unavailable');
          cursor = next;
        }
      }
      for (const directory of missing.reverse()) {
        throwIfAborted(executeSignal);
        const mask = await creationMask(executeSignal);
        try {
          await native.recheckNewMetadata(nativePrepared, mask);
        } catch {
          throw new HostDeniedError('filesystem creation policy unavailable');
        }
        executionNativeFloor.assertPath(directory);
        assertNotProtectedPath(directory, config.pathPolicy);
        assertFsPolicyPath(config.pathPolicy, lexical, directory);
        try {
          await mkdir(directory, { mode: 0o700 });
        } catch (error) {
          if (errnoCode(error) !== 'EEXIST') throw error;
        }
        const actual = await realpath(directory);
        executionNativeFloor.assertPath(actual);
        assertInScope(inScope, actual);
        assertNotProtectedPath(actual, config.pathPolicy);
        assertFsPolicyPath(config.pathPolicy, lexical, actual);
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new ToolPreparationError('stale_file');
        try {
          await native.recheckNewMetadata(nativePrepared, mask);
        } catch {
          throw new HostDeniedError('filesystem creation policy unavailable');
        }
      }
    }
    const jailed = await jailWriteTarget(config, inScope, request.path, false);
    const finalTarget = jailed.finalTarget;
    executionNativeFloor.assertPath(finalTarget);
    assertNotProtectedPath(finalTarget, config.pathPolicy);
    assertNotSensitiveReadPath(finalTarget, config.pathPolicy);
    await assertNotSymlink(finalTarget);
    if (target !== undefined && finalTarget !== target)
      throw new ToolPreparationError('stale_file');
    if (
      !equalSnapshot(
        before,
        await snapshotPrepared(finalTarget, maxBytes, executeSignal, executionStage),
      )
    )
      throw new ToolPreparationError('stale_file');
    throwIfAborted(executeSignal);
    if (target === undefined) {
      const mask = await creationMask(executeSignal);
      try {
        await native.recheckNewMetadata(nativePrepared, mask);
        await native.releaseNewMetadata(nativePrepared);
        nativePrepared = await native.prepareNewMetadata(finalTarget, mask);
      } catch {
        throw new HostDeniedError('filesystem creation policy unavailable');
      }
    }
    await runNativeStage({
      adapter: native,
      prepared: nativePrepared,
      before: before === null ? null : Buffer.from(before.text, 'utf8'),
      after: Buffer.from(after, 'utf8'),
      home: config.operatorHomeDir,
      nonce: randomUUID().replaceAll('-', ''),
      creationMask: async () => creationMask(executeSignal),
      ...(executeSignal === undefined ? {} : { signal: executeSignal }),
    });
    return {
      path: relWorkspace(config, finalTarget),
      bytesWritten:
        request.kind === 'write'
          ? Buffer.byteLength(request.content, 'utf8')
          : Buffer.byteLength(after, 'utf8'),
    };
  };
  return Object.freeze({
    path: relWorkspace(config, target ?? lexical),
    before: before?.text ?? null,
    after,
    execute: (executeSignal?: AbortSignalLike, options?: ToolHostCallOptions) => {
      if (used || released)
        return Promise.reject(new FsCapabilityError('prepared write is no longer available'));
      used = true;
      const producer = (): Promise<FileWritten> => guarded(() => run(executeSignal));
      pending = options?.retainWork === undefined ? producer() : options.retainWork(producer);
      return pending;
    },
    release: async () => {
      released = true;
      await pending?.catch(() => undefined);
      try {
        if (before === null) await native.releaseNewMetadata(nativePrepared);
        else await native.releaseExistingMetadata(nativePrepared);
      } catch {
        throw new HostDeniedError('filesystem metadata cleanup failed');
      }
    },
  });
}

/* ------------------------------------------------------------------------------------------------ *
 * list_directory
 * ------------------------------------------------------------------------------------------------ */

async function listOne(
  config: NodeFsCapabilityConfig,
  maxEntries: number,
  path: string,
  opts: FsListOpts,
  signal: AbortSignalLike | undefined,
  stage: FsStageInventory,
): Promise<DirListing> {
  throwIfAborted(signal);
  assertNotSensitiveReadPath(resolve(config.workspaceDir, path), config.pathPolicy);
  const inScope = buildScopeChecker(config);
  const realRoot = await jailExisting(config, inScope, path);
  // Refuse to enumerate a credential/secret store (recon of key/secret filenames) — the read-side confidentiality
  // floor, applied to the requested root and to each nested entry the recursive walk reaches below.
  assertNotSensitiveReadPath(lexicalTarget(config, path), config.pathPolicy);
  assertNotSensitiveReadPath(realRoot, config.pathPolicy);
  const rootInfo = await stat(realRoot);
  stage.assertIdentity(await stat(realRoot, { bigint: true }));
  if (!rootInfo.isDirectory()) {
    throw new FsCapabilityError('list_directory: the path is not a directory');
  }
  const matcher = opts.glob === undefined ? undefined : compileGlob(opts.glob);
  const cap = Math.min(maxEntries, MAX_LIST_ENTRIES);
  const entries: DirEntry[] = [];
  let truncated = false;
  const complete = await walk(
    realRoot,
    opts.recursive === true,
    signal,
    inScope,
    config.pathPolicy,
    async (real, rel, dirent) => {
      if (matcher !== undefined && !matcher(rel)) return true;
      // Sensitive-read floor on the RESOLVED target (mirrors collectGlobFiles): `walk` realpaths the parent DIR
      // but not the entry, so a bare lexical check would let a symlink named innocuously slip a nested
      // .ssh/.relavium/credential store into the listing. Fall back to the lexical path when realpath fails (a
      // broken/vanished link) so a sensitively-NAMED entry is still filtered. The DISPLAYED name (`rel`) is unchanged.
      const realResolved = await realpath(real).catch(() => undefined);
      if (
        isSensitivePolicyReadPath(real, config.pathPolicy) ||
        isSensitivePolicyReadPath(realResolved ?? real, config.pathPolicy)
      )
        return true;
      const info = await lstat(real).catch(() => undefined);
      if (info === undefined) return true; // a vanished/inaccessible entry is skipped, never fatal
      stage.assertIdentity(await lstat(real, { bigint: true }));
      if (realResolved !== undefined)
        stage.assertIdentity(await stat(realResolved, { bigint: true }));
      if (entries.length >= cap) {
        truncated = true;
        return false;
      }
      entries.push({
        name: rel,
        type: dirent.isDirectory() ? 'directory' : 'file',
        sizeBytes: info.size,
        lastModified: info.mtime.toISOString(),
      });
      return true;
    },
  );
  return {
    entries,
    ...(truncated || !complete ? { truncated: true, entryLimit: cap, omittedEntries: null } : {}),
    ...(!complete ? { incomplete: true } : {}),
  };
}

// Independent traversal and result ceilings. No directory is materialized in full.
const SCAN_ENTRIES = 10000;
const SCAN_DIRS = 1000;
const SCAN_DEPTH = 32;
const SCAN_IGNORE_ANCESTORS = 32;
const SCAN_FILES = 1000;
const SCAN_BYTES = 16 * 1024 * 1024;
const SCAN_FILE_BYTES = 1024 * 1024;
const SCAN_MATCHES = 200;
const SCAN_WORK = 16 * 1024 * 1024;
const IGNORE_BYTES = 64 * 1024;
const IGNORE_RULES = 256;
const LINE_BYTES = 2048;
const IGNORE_FILES = ['.gitignore', '.relaviumignore'] as const;

/** Presence is enough: nested rules are unsupported, so never read their contents or follow a link. */
async function hasIgnoreFile(dir: string, signal: AbortSignalLike | undefined): Promise<boolean> {
  for (const name of IGNORE_FILES) {
    throwIfAborted(signal);
    try {
      await lstat(join(dir, name));
      return true;
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function discover(
  config: NodeFsCapabilityConfig,
  path: string,
  find: FsFindOpts,
  search: undefined,
  signal: AbortSignalLike | undefined,
  stage: FsStageInventory,
): Promise<FsFindResult>;
async function discover(
  config: NodeFsCapabilityConfig,
  path: string,
  find: undefined,
  search: FsSearchOpts,
  signal: AbortSignalLike | undefined,
  stage: FsStageInventory,
): Promise<FsSearchResult>;
async function discover(
  config: NodeFsCapabilityConfig,
  path: string,
  find: FsFindOpts | undefined,
  search: FsSearchOpts | undefined,
  signal: AbortSignalLike | undefined,
  stage: FsStageInventory,
): Promise<FsFindResult | FsSearchResult> {
  throwIfAborted(signal);
  const glob = find?.glob ?? search?.glob;
  const fits = (value: string, limit: number): boolean =>
    value.length > 0 && value.length <= limit && Buffer.byteLength(value, 'utf8') <= limit;
  if (!fits(path, 4096)) throw new FsCapabilityError('discovery: invalid path');
  if (glob !== undefined && !fits(glob, 4096))
    throw new FsCapabilityError('discovery: invalid glob');
  if (search !== undefined && !fits(search.pattern, 1024))
    throw new FsCapabilityError('search_files: invalid pattern');
  const inScope = buildScopeChecker(config);
  assertNotSensitiveReadPath(lexicalTarget(config, path), config.pathPolicy);
  const root = await jailExisting(config, inScope, path);
  assertNotSensitiveReadPath(root, config.pathPolicy);
  stage.assertIdentity(await stat(root, { bigint: true }));
  if (!(await stat(root)).isDirectory())
    throw new FsCapabilityError('discovery: the path is not a directory');
  const stats: {
    entriesVisited: number;
    filesScanned: number;
    bytesScanned: number;
    skippedBinary: number;
    skippedOversize: number;
    unreadable: number;
    incomplete: boolean;
    limit?: FsScanLimit;
  } = {
    entriesVisited: 0,
    filesScanned: 0,
    bytesScanned: 0,
    skippedBinary: 0,
    skippedOversize: 0,
    unreadable: 0,
    incomplete: false,
  };
  const stop = (limit: FsScanLimit): void => {
    stats.incomplete = true;
    stats.limit ??= limit;
  };
  const sourceBudget = { remaining: SCAN_BYTES };
  const bodies: string[] = [];
  let ignoreWork = 0;
  const workspaceRoot = fsPolicyWorkspace(config.pathPolicy ?? createFsPathPolicy(config));
  for (const name of IGNORE_FILES) {
    const target = join(workspaceRoot, name);
    let present = false;
    try {
      await lstat(target);
      present = true;
      const real = await realpath(target);
      if (!inScope(real) || isSensitivePolicyReadPath(real, config.pathPolicy)) {
        stop('ignore');
        break;
      }
      const read = await readJailedFile(
        real,
        IGNORE_BYTES,
        rejectAliasedRead(config, real),
        undefined,
        signal,
        undefined,
        stage,
      );
      if (read.kind !== 'file') {
        stop('ignore');
        break;
      }
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes);
      const lines = parseIgnoreLines(text);
      if (
        lines.length > IGNORE_RULES ||
        text
          .split('\n')
          .some(
            (line) =>
              /[ \t]+\r?$/.test(line) &&
              line.trim().length > 0 &&
              !line.trimStart().startsWith('#'),
          ) ||
        lines.some((line) => line.includes('[') || line.includes(']') || line.includes('\\'))
      ) {
        stop('ignore');
        break;
      }
      bodies.push(text);
      ignoreWork += lines.reduce((sum, line) => sum + line.length + 1, 0);
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof FsStageInventoryError) throw error;
      if (present || errnoCode(error) !== 'ENOENT') {
        stats.unreadable++;
        stop('ignore');
        break;
      }
    }
  }
  const checkNestedIgnore = async (dir: string): Promise<boolean> => {
    if (relative(workspaceRoot, dir) === '') return false;
    try {
      const present = await hasIgnoreFile(dir, signal);
      throwIfAborted(signal);
      if (!present) return false;
    } catch {
      throwIfAborted(signal);
      stats.unreadable++;
    }
    stop('ignore');
    return true;
  };
  // A scoped walk never visits its parents. Inspect only admitted ancestors, with a separate finite
  // ceiling, so unsupported inherited rules cannot be mistaken for a complete scan. The workspace
  // root is the supported ignore boundary; a selected extra root never grants its own parents.
  if (relative(workspaceRoot, root) !== '') {
    let ancestor = dirname(root);
    let inspected = 0;
    while (
      !stats.incomplete &&
      relative(workspaceRoot, ancestor) !== '' &&
      inScope(ancestor) &&
      !isSensitivePolicyReadPath(ancestor, config.pathPolicy)
    ) {
      throwIfAborted(signal);
      if (++inspected > SCAN_IGNORE_ANCESTORS) {
        stop('depth');
        break;
      }
      const admitted = await resolveInScope(ancestor, inScope);
      if (admitted === undefined) {
        stats.unreadable++;
        stop('ignore');
        break;
      }
      if (isSensitivePolicyReadPath(admitted, config.pathPolicy)) break;
      if (await checkNestedIgnore(admitted)) break;
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  const ignored = compileIgnore(...bodies);
  const matchesGlob = glob === undefined ? () => true : compileGlob(glob);
  const files: { path: string; sizeBytes: number; lastModified: string; mtimeMs: number }[] = [];
  const matches: { path: string; line: number; content: string; omittedBytes: number }[] = [];
  const stack = [{ dir: root, depth: 0 }];
  let directories = 0;
  let work = 0;
  while (stack.length > 0 && !stats.incomplete) {
    throwIfAborted(signal);
    const next = stack.pop();
    if (next === undefined) break;
    if (++directories > SCAN_DIRS) {
      stop('directories');
      break;
    }
    const resolved = await resolveInScope(next.dir, inScope);
    if (resolved === undefined || isSensitivePolicyReadPath(resolved, config.pathPolicy)) {
      stats.unreadable++;
      stats.incomplete = true;
      break;
    }
    if (await checkNestedIgnore(resolved)) break;
    const atWorkspaceRoot = relative(workspaceRoot, resolved) === '';
    let dir;
    try {
      dir = await opendir(resolved);
    } catch {
      stats.unreadable++;
      stats.incomplete = true;
      break;
    }
    try {
      for await (const entry of dir) {
        throwIfAborted(signal);
        if (++stats.entriesVisited > SCAN_ENTRIES) {
          stop('entries');
          break;
        }
        if (!atWorkspaceRoot && (entry.name === '.gitignore' || entry.name === '.relaviumignore')) {
          stop('ignore');
          break;
        }
        const candidate = join(resolved, entry.name);
        const rel = posixRel(root, candidate);
        const workspaceRel = posixRel(workspaceRoot, candidate);
        // Ignore and glob matching are independent. Charge each pattern against its candidate,
        // including retry work in the two-pointer matchers, without multiplying the two sets.
        // `**` can retry whole path segments; bound those retries by the number of
        // segments as well as the segment-level character comparisons.
        const segmentFactor = Math.max(rel.split('/').length, workspaceRel.split('/').length);
        work +=
          segmentFactor *
          ((workspaceRel.length + 1) * ignoreWork + (rel.length + 1) * (glob?.length ?? 0));
        if (work > SCAN_WORK) {
          stop('work');
          break;
        }
        if (
          isSensitivePolicyReadPath(candidate, config.pathPolicy) ||
          ignored.ignores(workspaceRel, entry.isDirectory())
        )
          continue;
        stage.assertIdentity(await lstat(candidate, { bigint: true }));
        if (entry.isDirectory()) {
          if (next.depth >= SCAN_DEPTH) {
            stop('depth');
            break;
          }
          stack.push({ dir: candidate, depth: next.depth + 1 });
          continue;
        }
        if (!matchesGlob(rel)) continue;
        const real = await realpath(candidate).catch(() => undefined);
        if (real === undefined) {
          stats.unreadable++;
          stats.incomplete = true;
          break;
        }
        if (!inScope(real) || isSensitivePolicyReadPath(real, config.pathPolicy)) continue;
        assertFsPolicyPath(config.pathPolicy, candidate, real);
        stage.assertIdentity(await stat(real, { bigint: true }));
        const info = await stat(real).catch(() => undefined);
        if (info === undefined) {
          stats.unreadable++;
          stats.incomplete = true;
          break;
        }
        if (!info.isFile()) continue;
        if (stats.filesScanned >= SCAN_FILES) {
          stop('files');
          break;
        }
        stats.filesScanned++;
        const display = relWorkspace(config, candidate);
        if (find !== undefined) {
          // Open even find results so hard links cannot disclose aliases across the jail.
          let checked: JailedRead;
          try {
            checked = await readJailedFile(
              real,
              0,
              rejectAliasedRead(config, real),
              undefined,
              signal,
              undefined,
              stage,
            );
          } catch (error) {
            throwIfAborted(signal);
            if (error instanceof FsStageInventoryError) throw error;
            stats.unreadable++;
            stats.incomplete = true;
            break;
          }
          if (
            checked.kind === 'aliased' ||
            checked.kind === 'special' ||
            checked.kind === 'directory'
          )
            continue;
          files.push({
            path: display,
            sizeBytes: info.size,
            lastModified: info.mtime.toISOString(),
            mtimeMs: info.mtimeMs,
          });
          if (files.length >= SCAN_MATCHES) {
            stop('matches');
            break;
          }
          continue;
        }
        if (search === undefined) continue;
        if (info.size > SCAN_FILE_BYTES) {
          stats.skippedOversize++;
          continue;
        }
        if (stats.bytesScanned + info.size > SCAN_BYTES) {
          stop('bytes');
          break;
        }
        let result: JailedRead;
        try {
          result = await readJailedFile(
            real,
            SCAN_FILE_BYTES,
            rejectAliasedRead(config, real),
            undefined,
            signal,
            sourceBudget,
            stage,
          );
        } catch (error) {
          throwIfAborted(signal);
          if (error instanceof FsStageInventoryError) throw error;
          if (error instanceof FsReadBudgetError) {
            stop('bytes');
            break;
          }
          stats.unreadable++;
          stats.incomplete = true;
          break;
        } finally {
          // Failed decoding and skipped binary candidates have already consumed real I/O too.
          stats.bytesScanned = SCAN_BYTES - sourceBudget.remaining;
        }
        if (result.kind === 'binary') {
          stats.skippedBinary++;
          continue;
        }
        if (result.kind === 'oversize') stats.skippedOversize++;
        if (result.kind !== 'file') continue;
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.bytes);
        } catch {
          stats.skippedBinary++;
          continue;
        }
        if (result.bytes.includes(0)) {
          stats.skippedBinary++;
          continue;
        }
        const needle =
          search.caseSensitive === false ? foldPattern(search.pattern) : search.pattern;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          // Charge the worst-case literal comparisons across all indexOf retries, plus folding.
          // Each retry resumes at least one folded UTF-16 unit later, so their searched spans do
          // not cause an uncharged quadratic rescan; the needle multiplier bounds comparisons.
          work += (line.length * 3 + 1) * (needle.length + 1);
          if (work > SCAN_WORK) {
            stop('work');
            break;
          }
          const at = await findLiteral(
            line,
            needle,
            search.caseSensitive === false,
            search.wholeWord === true,
            signal,
          );
          if (at < 0) continue;
          const bytes = Buffer.from(line);
          let excerptStart = Math.max(
            0,
            Buffer.byteLength(line.slice(0, at)) - Math.floor(LINE_BYTES / 2),
          );
          while (excerptStart < bytes.length && ((bytes[excerptStart] ?? 0) & 0xc0) === 0x80)
            excerptStart++;
          let excerpt = bytes.subarray(excerptStart, excerptStart + LINE_BYTES);
          while (excerpt.length > 0 && (excerpt[excerpt.length - 1] ?? 0) >= 128) {
            try {
              new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(excerpt);
              break;
            } catch {
              excerpt = excerpt.subarray(0, -1);
            }
          }
          matches.push({
            path: display,
            line: i + 1,
            content: excerpt.toString('utf8'),
            omittedBytes: bytes.length - excerpt.length,
          });
          if (matches.length >= SCAN_MATCHES) {
            stop('matches');
            break;
          }
        }
        if (stats.incomplete) break;
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
  }
  throwIfAborted(signal);
  if (find !== undefined) {
    files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      files: files.map((file) => ({
        path: file.path,
        sizeBytes: file.sizeBytes,
        lastModified: file.lastModified,
      })),
      stats,
    };
  }
  return { matches, stats };
}
// Fold one original code point at a time so expansion positions retain an exact source span.
// The pattern uses the same folding rule; neither offset nor word classification uses folded text.
function foldPattern(text: string): string {
  return Array.from(text, (part) => part.toLowerCase()).join('');
}
async function findLiteral(
  line: string,
  needle: string,
  insensitive: boolean,
  wholeWord: boolean,
  signal: AbortSignalLike | undefined,
): Promise<number> {
  let haystack = line;
  const starts: number[] = [];
  const ends: number[] = [];
  if (insensitive) {
    const chunks: string[] = [];
    let source = 0;
    let foldedCount = 0;
    for (const part of line) {
      if (++foldedCount % 16384 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        throwIfAborted(signal);
      }
      const folded = part.toLowerCase();
      chunks.push(folded);
      for (let i = 0; i < folded.length; i++) {
        starts.push(source);
        ends.push(source + part.length);
      }
      source += part.length;
    }
    haystack = chunks.join('');
  }
  let from = 0;
  let attempts = 0;
  while (from <= haystack.length) {
    if (++attempts % 16384 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      throwIfAborted(signal);
    }
    const at = haystack.indexOf(needle, from);
    if (at < 0) return -1;
    const start = insensitive ? starts[at] : at;
    const end = insensitive ? ends[at + needle.length - 1] : at + needle.length;
    if (
      start !== undefined &&
      end !== undefined &&
      (!wholeWord || (!wordBefore(line, start) && !wordAfter(line, end)))
    )
      return start;
    from = at + 1;
  }
  return -1;
}
function wordBefore(value: string, at: number): boolean {
  if (at <= 0) return false;
  const last = value.charCodeAt(at - 1);
  const start = last >= 0xdc00 && last <= 0xdfff && at >= 2 ? at - 2 : at - 1;
  const code = value.codePointAt(start);
  return code !== undefined && /[\p{L}\p{N}_]/u.test(String.fromCodePoint(code));
}
function wordAfter(value: string, at: number): boolean {
  const next = value.codePointAt(at);
  return next !== undefined && /[\p{L}\p{N}_]/u.test(String.fromCodePoint(next));
}

/* ------------------------------------------------------------------------------------------------ *
 * The scope jail (mirrors @relavium/db media-write.ts, generalized to multiple roots + read targets).
 * ------------------------------------------------------------------------------------------------ */

/** A precomputed in-scope predicate over a real (symlink-resolved) absolute path. `full` ⇒ always true. */
type ScopeChecker = (real: string) => boolean;

/** Precompute the tier's realpath'd scope roots ONCE, returning a sync membership predicate. */
function buildScopeChecker(config: NodeFsCapabilityConfig): ScopeChecker {
  const roots = fsPolicyScopeRoots(config.pathPolicy, config.workspaceDir, config.tier);
  if (config.tier === 'full') return () => true;
  // Native relative membership handles Windows drive/directory case returned differently
  // by synchronous policy admission and asynchronous realpath, without admitting siblings.
  return (real) => roots.some((root) => isWithinFsRoot(root, real));
}

/** Resolve a tool path to its real (symlink-resolved) absolute path and verify it is in-jail. Must exist. */
async function jailExisting(
  config: NodeFsCapabilityConfig,
  inScope: ScopeChecker,
  path: string,
): Promise<string> {
  const lexical = lexicalTarget(config, path);
  const real = await realpath(lexical).catch(() => {
    throw new FsCapabilityError('the path does not exist or is not accessible');
  });
  assertInScope(inScope, real);
  assertFsPolicyPath(config.pathPolicy, lexical, real);
  return real;
}

/** Resolve a write target: jail the deepest existing ancestor BEFORE any mkdir, then re-check post-mkdir. */
async function jailWriteTarget(
  config: NodeFsCapabilityConfig,
  inScope: ScopeChecker,
  path: string,
  createDirs: boolean,
): Promise<{ realDir: string; finalTarget: string }> {
  const lexical = lexicalTarget(config, path);
  const targetDir = dirname(lexical);
  // Verify the deepest EXISTING ancestor is in-scope AND not protected before creating anything, so a
  // symlinked/aliased ancestor pointing outside the scope — OR resolving INTO a protected dir (a Win32 8.3
  // short name like `GIT~1` → `.git`, which the lexical pre-check misses) — is caught before `mkdir` creates
  // even an empty subdir there. This closes the createDirs side-effect the realpath'd finalTarget check alone
  // would only catch AFTER the mkdir.
  const deepestReal = await deepestExistingReal(targetDir, {
    realpath,
    lstat,
    dirname,
    isMissing: (error) => errnoCode(error) === 'ENOENT',
  });
  assertInScope(inScope, deepestReal);
  assertFsPolicyPath(config.pathPolicy, lexical, deepestReal);
  assertNotProtectedPath(deepestReal, config.pathPolicy);
  if (createDirs) await mkdir(targetDir, { recursive: true, mode: 0o700 });
  // The parent must now exist (created above, or pre-existing) — re-resolve + re-check (tightens the window).
  const realDir = await realpath(targetDir).catch(() => {
    throw new FsCapabilityError(
      'write_file: the target directory does not exist (set createDirs to create it)',
    );
  });
  assertInScope(inScope, realDir);
  assertFsPolicyPath(config.pathPolicy, lexical, join(realDir, basename(lexical)));
  return { realDir, finalTarget: join(realDir, basename(lexical)) };
}

/** Throw a scope denial if `real` is not in scope (the authoritative post-realpath jail). RECOVERABLE on the chat
 *  surface (Step 14) — the pure scope-tier escape is refused before any side effect, so the model may adapt to an
 *  in-bounds path; the floor still denies every attempt. (The confidentiality / symlink / protected-path denials
 *  keep the default fatal, so this is the ONLY fs denial fed back.) */
function assertInScope(inScope: ScopeChecker, real: string): void {
  if (!inScope(real)) {
    throw new FsScopeDeniedError('the path escapes the allowed filesystem scope', {
      recoverable: true,
    });
  }
}

/** Resolve a tool path lexically against the workspace, rejecting an empty/UNC path up front. */
function lexicalTarget(config: NodeFsCapabilityConfig, path: string): string {
  if (path === '') {
    throw new FsCapabilityError('the path is empty');
  }
  if (path.startsWith('\\\\') || (process.platform === 'win32' && /^[\\/]{2}/.test(path))) {
    throw new FsScopeDeniedError('a UNC path is not allowed'); // `\\server\share`
  }
  // An absolute tool path is allowed (it is jail-checked after realpath); a relative one anchors at the
  // workspace. `resolve` normalizes any `..`; the post-realpath `assertInScope` is the authoritative jail.
  return isAbsolute(path) ? resolve(path) : resolve(config.workspaceDir, path);
}

/** Refuse to write through an existing symlink at the final path; a missing path (ENOENT) is fine. */
async function assertNotSymlink(target: string): Promise<void> {
  const info = await lstat(target).catch((error: unknown) => {
    if (errnoCode(error) === 'ENOENT') return undefined; // not present yet — the common case
    // Self-defending: re-wrap any other raw fs error (its message/path would leak) rather than rethrow it.
    throw new FsCapabilityError('write_file: the final path could not be inspected');
  });
  if (info?.isSymbolicLink() === true) {
    throw new FsScopeDeniedError('write_file: refusing to write through a symlink');
  }
}

/** A permitted file's workspace-relative path, or its canonical absolute path across Windows drives. */
function relWorkspace(config: NodeFsCapabilityConfig, real: string): string {
  const rel = relative(fsPolicyWorkspace(config.pathPolicy), real);
  return isAbsolute(rel) ? real : rel || '.';
}

/* ------------------------------------------------------------------------------------------------ *
 * Bounded directory walk + glob collection. Never follows a symlinked directory (no escape, no loop).
 * ------------------------------------------------------------------------------------------------ */

/**
 * Walk `root` (optionally recursive), invoking `visit(real, rel, dirent)`; `visit` returns false to stop. Each
 * queued directory is re-resolved (`realpath`) + scope-checked **immediately before** its `readdir` — reducing the
 * queue-to-read replacement window under owner-controlled storage: a directory atomically swapped for an out-of-jail
 * symlink in that window is dropped, and the read targets the freshly-resolved canonical path, not the stale one.
 * `root` is already a canonical in-scope path (the caller realpath'd it). A symlinked subdir is never followed
 * (`dirent.isDirectory()` is false for one), so the recursion stays inside the jail with no symlink loop.
 */
async function walk(
  root: string,
  recursive: boolean,
  signal: AbortSignalLike | undefined,
  inScope: ScopeChecker,
  policy: FsPathPolicy | undefined,
  visit: (real: string, rel: string, dirent: Dirent) => Promise<boolean>,
): Promise<boolean> {
  const stack = [{ path: root, depth: 0 }];
  let visited = 0;
  let directories = 0;
  while (stack.length > 0) {
    throwIfAborted(signal);
    const queued = stack.pop();
    if (queued === undefined) break;
    if (++directories > SCAN_DIRS) return false;
    const dir = await resolveInScope(queued.path, inScope);
    if (dir === undefined) return false;
    if (isSensitivePolicyReadPath(queued.path, policy) || isSensitivePolicyReadPath(dir, policy))
      continue;
    const handle = await opendir(dir).catch(() => undefined);
    if (handle === undefined) return false;
    try {
      for await (const dirent of handle) {
        throwIfAborted(signal);
        if (++visited > SCAN_ENTRIES) return false;
        const real = join(dir, dirent.name);
        if (!(await visit(real, posixRel(root, real), dirent))) return false;
        if (recursive && dirent.isDirectory() && !isSensitivePolicyReadPath(real, policy)) {
          if (queued.depth >= SCAN_DEPTH) return false;
          stack.push({ path: real, depth: queued.depth + 1 });
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return true;
}

/** Resolve `dir` through `realpath` and return it only if still in scope (else `undefined`) — the walk's jail guard. */
async function resolveInScope(dir: string, inScope: ScopeChecker): Promise<string | undefined> {
  const real = await realpath(dir).catch(() => undefined);
  return real !== undefined && inScope(real) ? real : undefined;
}

/** Collect the files under the workspace matching `pattern` (bounded), each jail-checked, for a glob read. */
async function collectGlobFiles(
  config: NodeFsCapabilityConfig,
  maxMatches: number,
  pattern: string,
  signal: AbortSignalLike | undefined,
  stage: FsStageInventory,
): Promise<{ real: string; rel: string; size: number; mtimeMs: number }[]> {
  // Refuse the original UNC spelling before portable glob separators erase its provenance.
  lexicalTarget(config, pattern);
  const inScope = buildScopeChecker(config);
  const portablePattern = process.platform === 'win32' ? pattern.replaceAll('\\', '/') : pattern;
  const meta = portablePattern.search(/[*?]/);
  const slash = portablePattern.lastIndexOf('/', meta < 0 ? portablePattern.length : meta);
  // Keep the trailing separator: C:/ must not become the drive-relative C: spelling.
  const prefix = slash < 0 ? '.' : portablePattern.slice(0, slash + 1);
  assertNotSensitiveReadPath(lexicalTarget(config, prefix), config.pathPolicy);
  const base = await jailExisting(config, inScope, prefix);
  assertNotSensitiveReadPath(base, config.pathPolicy);
  stage.assertIdentity(await stat(base, { bigint: true }));
  const matcher = compileGlob(slash < 0 ? portablePattern : portablePattern.slice(slash + 1));
  const out: { real: string; rel: string; size: number; mtimeMs: number }[] = [];
  let matchCap = false;
  const complete = await walk(
    base,
    true,
    signal,
    inScope,
    config.pathPolicy,
    async (real, rel, dirent) => {
      if (dirent.isDirectory() || !matcher(rel)) return true;
      // Defense in depth: a matched FILE is realpath-jailed (a symlinked file could still point outside scope).
      const realResolved = await realpath(real).catch(() => undefined);
      if (realResolved === undefined || !inScope(realResolved)) return true; // skip, never read out of scope
      // Never surface a credential/secret store through a glob (the sensitive-read floor); the per-fd hard-link
      // guard in readJailedFile then still refuses an aliased match the readGlob loop reaches.
      if (
        isSensitivePolicyReadPath(real, config.pathPolicy) ||
        isSensitivePolicyReadPath(realResolved, config.pathPolicy)
      )
        return true;
      assertFsPolicyPath(config.pathPolicy, real, realResolved);
      // stat the RESOLVED target (not the walk path) so an in-scope symlink TO a regular file still reads — a
      // bare `lstat(real)` on a symlink reports `isFile() === false` and would wrongly drop a legitimate match.
      const info = await stat(realResolved).catch(() => undefined);
      if (info === undefined || !info.isFile()) return true;
      stage.assertIdentity(await stat(realResolved, { bigint: true }));
      if (out.length >= maxMatches) {
        matchCap = true;
        return false;
      }
      out.push({
        real: realResolved,
        rel: relWorkspace(config, realResolved),
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
      return true;
    },
  );
  if (matchCap)
    throw new FsCapabilityError(
      `read_file: glob exceeds the ${maxMatches}-file limit; narrow the glob`,
    );
  if (!complete) throw new FsCapabilityError('read_file: glob traversal was incomplete');
  return out;
}

/* ------------------------------------------------------------------------------------------------ *
 * A linear, ReDoS-safe glob matcher (segment-aware: `*`/`?` within a segment, `**` across segments).
 * Mirrors the engine's no-RegExp posture (registry.ts `globMatch`) — never compiles a backtracking RegExp.
 * ------------------------------------------------------------------------------------------------ */

/** Compile a glob pattern to a predicate over a POSIX-separated relative path. */
function compileGlob(pattern: string): (path: string) => boolean {
  const pat = pattern.split('/');
  return (path: string) => matchSegments(pat, path.split('/'));
}

/** Match a pattern segment-list against a path segment-list; `**` matches zero or more whole segments. */
function matchSegments(pat: readonly string[], str: readonly string[]): boolean {
  let p = 0;
  let s = 0;
  let starP = -1; // pattern index just past the last `**`
  let starS = 0; // str index to resume from when extending the last `**`
  while (s < str.length) {
    const seg = pat[p];
    if (seg === '**') {
      starP = ++p; // `**` matches zero segments first; remember where to extend it
      starS = s;
    } else if (seg !== undefined && matchSegment(seg, str[s] ?? '')) {
      p++;
      s++;
    } else if (starP >= 0) {
      p = starP; // mismatch — let the last `**` swallow one more segment
      s = ++starS;
    } else {
      return false;
    }
  }
  while (pat[p] === '**') p++; // trailing `**` segments match the empty remainder
  return p === pat.length;
}

/** Match a single glob segment (`*` = any run sans `/`, `?` = one char sans `/`) against a path segment. */
function matchSegment(glob: string, value: string): boolean {
  let g = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    const gc = glob[g];
    if (gc === '?' || (gc !== undefined && gc !== '*' && gc === value[v])) {
      g++;
      v++;
    } else if (gc === '*') {
      star = ++g;
      mark = v;
    } else if (star >= 0) {
      g = star;
      v = ++mark;
    } else {
      return false;
    }
  }
  while (glob[g] === '*') g++;
  return g === glob.length;
}

/* ------------------------------------------------------------------------------------------------ *
 * Small helpers.
 * ------------------------------------------------------------------------------------------------ */

/** The forward-slash relative path of `real` under `root` (the model-facing, OS-agnostic entry name). */
function posixRel(root: string, real: string): string {
  return relative(root, real).split(sep).join('/');
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain; charset=utf-8',
  '.ts': 'text/x-typescript',
  '.tsx': 'text/x-typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.sh': 'application/x-sh',
};

/** Infer a text mime type from the file extension; the default is plain UTF-8 text. */
function mimeForPath(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot < 0 ? '' : path.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'text/plain; charset=utf-8';
}

/** A Node `errno` code (`ENOENT`, …) off an unknown thrown value, or `undefined`. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Cooperative cancellation — throw a reason-only error before a (potentially slow) filesystem step. */
function throwIfAborted(signal: AbortSignalLike | undefined): void {
  throwIfAbortedShared(signal, 'the filesystem operation was aborted');
}
