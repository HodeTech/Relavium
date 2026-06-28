import { randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ToolDispatchError, ToolUnavailableError, type FsScopeTier } from '@relavium/core';
import type {
  DirEntry,
  DirListing,
  FileRead,
  FileWritten,
  FsCapability,
  FsListOpts,
  FsReadOpts,
  FsWriteOpts,
} from '@relavium/core';
import type { AbortSignalLike, ErrorCode } from '@relavium/shared';

/**
 * The Node host **mechanism** half of the `ToolHost.fs` capability arm (2.5.A, [ADR-0055](../../../../../docs/decisions/0055-cli-host-capability-seam-tool-environment-factory.md);
 * the engine owns the policy, the host owns the side effect — [ADR-0037](../../../../../docs/decisions/0037-engine-tool-execution-boundary.md)).
 * It backs `read_file` / `write_file` / `list_directory` with a `realpath` + `commonpath` **jail** mirroring
 * the `save_to` write port (`@relavium/db` `media-write.ts`, security-review.md §Media byte delivery): every
 * resolved path is verified to sit under an allowed scope root **after** symlinks are resolved, so neither a
 * `..` traversal nor a symlinked component can escape the tier.
 *
 * Scope tiers ([built-in-tools.md](../../../../../docs/reference/shared-core/built-in-tools.md) §Filesystem
 * permission tiers): `sandboxed` ⇒ the workspace dir (+ an optional tmp root), `project` ⇒ the workspace plus
 * an explicit `extraRoots` allowlist, `full` ⇒ unjailed (the power-user opt-in). A relative tool path resolves
 * against the workspace dir.
 *
 * **Read-only by profile (2.5.A).** `relavium chat`'s default profile constructs this with `readOnly: true`,
 * so `write_file` fail-closes with a `ToolUnavailableError` (→ the actionable `tool_unavailable` code, EA1) —
 * the write capability is **not** wired into a chat session until [ADR-0057](../../../../../docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md)/2.5.E
 * lands the per-tool approval floor. The workflow-run profile wires it read-write (the workflow-author trust
 * model already governs that path). Reads/writes are bounded (`maxReadBytes`, `maxGlobMatches`) so a single
 * tool call can never stream an unbounded amount into engine memory.
 *
 * Errors name a **reason only** — never the resolved path, the scope root, or the bytes (security-review.md
 * rule 6 / the I3 boundary). A raw Node `fs` error (whose `.message`/`.path` carries the absolute path) is
 * caught at the boundary and re-wrapped, so the capability honours its own contract regardless of caller.
 */

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
  /** An optional extra sandboxed root (e.g. `~/.relavium/tmp/`). Absent ⇒ workspace-only under `sandboxed`. */
  readonly tmpDir?: string;
  /** The `project`-tier path allowlist (absolute). Ignored under `sandboxed` / `full`. */
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
 * naming a **reason only** — never a path / the bytes (mirrors `MediaWriteError`). Maps to `tool_failed`.
 */
export class FsCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsCapabilityError';
  }
}

/**
 * A **deterministic scope/security denial** — a path escapes the tier, a UNC path, or a refusal to write
 * through a symlink. It is a {@link ToolDispatchError} (so the registry passes it through, registry.ts) mapping
 * to the **fatal**, non-retryable `tool_denied`: re-issuing the same denied path just re-denies, so it must NOT
 * burn the node-retry budget (error-handling.md §tool-dispatch codes). Mirrors the engine's `ToolPolicyError`
 * shape without needing the dispatched tool id (the host capability is tool-agnostic).
 */
export class FsScopeDeniedError extends ToolDispatchError {
  readonly code = 'tool_denied';
  readonly runErrorCode: ErrorCode = 'tool_denied';
  readonly retryable = false;
  constructor(message: string) {
    super(message, undefined, undefined);
    this.name = 'FsScopeDeniedError';
  }
}

/**
 * Build a node-backed {@link FsCapability} jailed to `config`'s scope tier. The returned object is the value a
 * host wires onto `ToolHost.fs`; it holds no ambient state beyond the immutable config.
 */
export function createNodeFsCapability(config: NodeFsCapabilityConfig): FsCapability {
  const maxReadBytes = config.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxGlobMatches = config.maxGlobMatches ?? DEFAULT_MAX_GLOB_MATCHES;
  return {
    readFile: (path, opts, signal) =>
      guarded(() => readOne(config, maxReadBytes, maxGlobMatches, path, opts, signal)),
    writeFile: (path, data, opts, signal) => guarded(() => writeOne(config, path, data, opts, signal)),
    listDirectory: (path, opts, signal) =>
      guarded(() => listOne(config, maxGlobMatches, path, opts, signal)),
  };
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
    if (error instanceof ToolDispatchError || error instanceof FsCapabilityError) {
      throw error;
    }
    throw new FsCapabilityError('the filesystem operation failed');
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * read_file
 * ------------------------------------------------------------------------------------------------ */

async function readOne(
  config: NodeFsCapabilityConfig,
  maxReadBytes: number,
  maxGlobMatches: number,
  path: string,
  opts: FsReadOpts,
  signal: AbortSignalLike | undefined,
): Promise<FileRead> {
  throwIfAborted(signal);
  if (opts.glob === true) {
    return readGlob(config, maxReadBytes, maxGlobMatches, path, signal);
  }
  const inScope = await buildScopeChecker(config);
  const real = await jailExisting(config, inScope, path);
  const info = await stat(real);
  if (info.isDirectory()) {
    throw new FsCapabilityError('read_file: the path is a directory, not a file');
  }
  return readTextFile(real, info.size, info.mtime, maxReadBytes);
}

/** Read one existing, in-jail, in-budget text file into a {@link FileRead} (binary/media is fail-closed). */
async function readTextFile(
  real: string,
  size: number,
  mtime: Date,
  maxReadBytes: number,
): Promise<FileRead> {
  if (size > maxReadBytes) {
    throw new FsCapabilityError(`read_file: the file exceeds the ${maxReadBytes}-byte read limit`);
  }
  const bytes = await readFile(real);
  if (isBinary(bytes)) {
    // The durable-media-handle path (ADR-0031) needs a wired media store; the 2.5.A fs arm has none, so a
    // binary/media file fail-closes (never inline base64) rather than corrupting the text channel.
    throw new FsCapabilityError(
      'read_file: binary/media files are not supported in this session — read a text file',
    );
  }
  return {
    content: bytes.toString('utf8'),
    mimeType: mimeForPath(real),
    sizeBytes: size,
    lastModified: mtime.toISOString(),
  };
}

/** Expand `pattern` over the jailed tree (bounded), reading each text match into one concatenated view. */
async function readGlob(
  config: NodeFsCapabilityConfig,
  maxReadBytes: number,
  maxGlobMatches: number,
  pattern: string,
  signal: AbortSignalLike | undefined,
): Promise<FileRead> {
  const matches = await collectGlobFiles(config, maxGlobMatches, pattern, signal);
  if (matches.length === 0) {
    throw new FsCapabilityError('read_file: the glob matched no files');
  }
  const parts: string[] = [];
  let totalBytes = 0;
  let latest = 0;
  for (const m of matches) {
    throwIfAborted(signal);
    if (totalBytes + m.size > maxReadBytes) {
      throw new FsCapabilityError(
        `read_file: the glob result exceeds the ${maxReadBytes}-byte read limit`,
      );
    }
    const bytes = await readFile(m.real);
    if (isBinary(bytes)) continue; // a binary match is skipped, not fatal — the text matches still read
    totalBytes += m.size;
    latest = Math.max(latest, m.mtimeMs);
    parts.push(`===== ${m.rel} =====\n${bytes.toString('utf8')}`);
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

/* ------------------------------------------------------------------------------------------------ *
 * write_file
 * ------------------------------------------------------------------------------------------------ */

async function writeOne(
  config: NodeFsCapabilityConfig,
  path: string,
  data: string,
  opts: FsWriteOpts,
  signal: AbortSignalLike | undefined,
): Promise<FileWritten> {
  if (config.readOnly) {
    // The 2.5.A chat profile wires fs READ-only; the write arm fail-closes as `tool_unavailable` (EA1) until
    // ADR-0057/2.5.E lands the per-tool approval floor that makes a write-capable chat host safe.
    throw new ToolUnavailableError('write_file', 'fs (read-only in this session)');
  }
  throwIfAborted(signal);
  const inScope = await buildScopeChecker(config);
  const { realDir, finalTarget } = await jailWriteTarget(config, inScope, path, opts.createDirs === true);
  await assertNotSymlink(finalTarget); // never write THROUGH an existing symlink at the final component
  throwIfAborted(signal);
  const bytes = Buffer.from(data, 'utf8');
  if (opts.append === true) {
    // Append cannot use the atomic temp+rename (that replaces, never appends). Open with O_NOFOLLOW so the
    // kernel refuses a final-component symlink AT OPEN TIME — closing the TOCTOU window between the
    // `assertNotSymlink` lstat above and the write (a swapped-in symlink can't redirect the append out of
    // scope). A symlink there fails ELOOP/ENOTDIR, which we map to the FATAL `tool_denied` (not the retryable
    // `tool_failed` `guarded` would otherwise assign a raw fs error). NOTE: `O_NOFOLLOW` is `0` on Windows (no
    // kernel enforcement); the `assertNotSymlink` lstat above still covers the non-race case, and append is the
    // author-trusted workflow-run path (chat is read-only), so the residual Windows race is accepted for 2.5.A.
    const handle = await open(
      finalTarget,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    ).catch((error: unknown) => {
      const code = errnoCode(error);
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        throw new FsScopeDeniedError('refusing to write through a symlink');
      }
      throw error;
    });
    try {
      await handle.write(bytes);
    } finally {
      await handle.close();
    }
    return { path: relWorkspace(config, finalTarget), bytesWritten: bytes.length };
  }
  // Atomic publish: a unique temp in the same (in-root) dir, then rename — never follows a final-component
  // symlink, and a partial write never lands at the target (mirrors media-write.ts).
  const tmp = join(realDir, `.relavium-write.${randomUUID()}.tmp`);
  let published = false;
  try {
    await writeFile(tmp, bytes, { flag: 'wx' }); // O_CREAT|O_EXCL — refuses to follow/create through a symlink
    await rename(tmp, finalTarget);
    published = true;
  } finally {
    if (!published) await rm(tmp, { force: true }).catch(() => undefined);
  }
  return { path: relWorkspace(config, finalTarget), bytesWritten: bytes.length };
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
): Promise<DirListing> {
  throwIfAborted(signal);
  const inScope = await buildScopeChecker(config);
  const realRoot = await jailExisting(config, inScope, path);
  const rootInfo = await stat(realRoot);
  if (!rootInfo.isDirectory()) {
    throw new FsCapabilityError('list_directory: the path is not a directory');
  }
  const matcher = opts.glob === undefined ? undefined : compileGlob(opts.glob);
  const cap = Math.min(maxEntries, MAX_LIST_ENTRIES);
  const entries: DirEntry[] = [];
  await walk(realRoot, opts.recursive === true, signal, async (real, rel, dirent) => {
    if (entries.length >= cap) return false; // stop the walk once the listing cap is hit
    if (matcher !== undefined && !matcher(rel)) return true;
    const info = await lstat(real).catch(() => undefined);
    if (info === undefined) return true; // a vanished/inaccessible entry is skipped, never fatal
    entries.push({
      name: rel,
      type: dirent.isDirectory() ? 'directory' : 'file',
      sizeBytes: info.size,
      lastModified: info.mtime.toISOString(),
    });
    return true;
  });
  return { entries };
}

/* ------------------------------------------------------------------------------------------------ *
 * The scope jail (mirrors @relavium/db media-write.ts, generalized to multiple roots + read targets).
 * ------------------------------------------------------------------------------------------------ */

/** A precomputed in-scope predicate over a real (symlink-resolved) absolute path. `full` ⇒ always true. */
type ScopeChecker = (real: string) => boolean;

/** Precompute the tier's realpath'd scope roots ONCE, returning a sync membership predicate. */
async function buildScopeChecker(config: NodeFsCapabilityConfig): Promise<ScopeChecker> {
  if (config.tier === 'full') return () => true;
  const roots = await realScopeRoots(config);
  return (real) =>
    roots.some((root) => {
      // Normalize the boundary so a root ending in `sep` (the filesystem root) does not produce a doubled
      // separator a valid child would fail to match (mirrors media-write `assertWithinRoot`).
      const prefix = root.endsWith(sep) ? root : root + sep;
      return real === root || real.startsWith(prefix);
    });
}

/** The realpath'd scope roots for the tier (a non-existent / unresolvable root is dropped, not fatal). */
async function realScopeRoots(config: NodeFsCapabilityConfig): Promise<string[]> {
  const declared =
    config.tier === 'sandboxed'
      ? [config.workspaceDir, ...(config.tmpDir === undefined ? [] : [config.tmpDir])]
      : [config.workspaceDir, ...(config.extraRoots ?? [])]; // project
  const resolved = await Promise.all(declared.map((r) => realpath(r).catch(() => undefined)));
  return resolved.filter((r): r is string => r !== undefined);
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
  // Verify the deepest EXISTING ancestor is in-scope before creating anything, so a symlinked ancestor
  // pointing outside the scope is caught before a single byte or stray dir is written there.
  assertInScope(inScope, await deepestExistingReal(targetDir));
  if (createDirs) await mkdir(targetDir, { recursive: true });
  // The parent must now exist (created above, or pre-existing) — re-resolve + re-check (tightens the window).
  const realDir = await realpath(targetDir).catch(() => {
    throw new FsCapabilityError(
      'write_file: the target directory does not exist (set createDirs to create it)',
    );
  });
  assertInScope(inScope, realDir);
  return { realDir, finalTarget: join(realDir, basename(lexical)) };
}

/** Throw a fatal scope denial if `real` is not in scope (the authoritative post-realpath jail). */
function assertInScope(inScope: ScopeChecker, real: string): void {
  if (!inScope(real)) {
    throw new FsScopeDeniedError('the path escapes the allowed filesystem scope');
  }
}

/** Resolve a tool path lexically against the workspace, rejecting an empty/UNC path up front. */
function lexicalTarget(config: NodeFsCapabilityConfig, path: string): string {
  if (path === '') {
    throw new FsCapabilityError('the path is empty');
  }
  if (path.startsWith('\\\\')) {
    throw new FsScopeDeniedError('a UNC path is not allowed'); // `\\server\share`
  }
  // An absolute tool path is allowed (it is jail-checked after realpath); a relative one anchors at the
  // workspace. `resolve` normalizes any `..`; the post-realpath `assertInScope` is the authoritative jail.
  return isAbsolute(path) ? resolve(path) : resolve(config.workspaceDir, path);
}

/** Resolve the deepest existing ancestor of `startDir` through `realpath` (walking up past missing dirs). */
async function deepestExistingReal(startDir: string): Promise<string> {
  let dir = startDir;
  for (;;) {
    const real = await realpath(dir).catch(() => undefined);
    if (real !== undefined) return real;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new FsCapabilityError('no existing ancestor directory could be resolved');
    }
    dir = parent;
  }
}

/** Refuse to write through an existing symlink at the final path; a missing path (ENOENT) is fine. */
async function assertNotSymlink(target: string): Promise<void> {
  const info = await lstat(target).catch((error: unknown) => {
    if (errnoCode(error) === 'ENOENT') return undefined; // not present yet — the common case
    // Self-defending: re-wrap any other raw fs error (its message/path would leak) rather than rethrow it.
    throw new FsCapabilityError('the final path could not be inspected');
  });
  if (info?.isSymbolicLink() === true) {
    throw new FsScopeDeniedError('refusing to write through a symlink');
  }
}

/** The path of an in-jail file, made workspace-relative for the model-facing result (never an absolute leak). */
function relWorkspace(config: NodeFsCapabilityConfig, real: string): string {
  const rel = relative(config.workspaceDir, real);
  return rel === '' || rel.startsWith('..') ? basename(real) : rel;
}

/* ------------------------------------------------------------------------------------------------ *
 * Bounded directory walk + glob collection. Never follows a symlinked directory (no escape, no loop).
 * ------------------------------------------------------------------------------------------------ */

/** Walk `root` (optionally recursive), invoking `visit(real, rel, dirent)`; `visit` returns false to stop. */
async function walk(
  root: string,
  recursive: boolean,
  signal: AbortSignalLike | undefined,
  visit: (real: string, rel: string, dirent: Dirent) => Promise<boolean>,
): Promise<void> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    throwIfAborted(signal);
    const dir = stack.pop();
    if (dir === undefined) break;
    const dirents = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
    for (const dirent of dirents) {
      const real = join(dir, dirent.name);
      const keepGoing = await visit(real, posixRel(root, real), dirent);
      if (!keepGoing) return;
      // Recurse into REAL directories only — a symlinked dir is never followed (no escape, no symlink loop).
      if (recursive && dirent.isDirectory()) stack.push(real);
    }
  }
}

/** Collect the files under the workspace matching `pattern` (bounded), each jail-checked, for a glob read. */
async function collectGlobFiles(
  config: NodeFsCapabilityConfig,
  maxMatches: number,
  pattern: string,
  signal: AbortSignalLike | undefined,
): Promise<{ real: string; rel: string; size: number; mtimeMs: number }[]> {
  const inScope = await buildScopeChecker(config);
  const base = await realpath(config.workspaceDir).catch(() => {
    throw new FsCapabilityError('read_file: the workspace directory is not accessible');
  });
  const matcher = compileGlob(pattern);
  const out: { real: string; rel: string; size: number; mtimeMs: number }[] = [];
  await walk(base, true, signal, async (real, rel, dirent) => {
    if (out.length >= maxMatches) return false;
    if (dirent.isDirectory() || !matcher(rel)) return true;
    // Defense in depth: a matched FILE is realpath-jailed (a symlinked file could still point outside scope).
    const realResolved = await realpath(real).catch(() => undefined);
    if (realResolved === undefined || !inScope(realResolved)) return true; // skip, never read out of scope
    // stat the RESOLVED target (not the walk path) so an in-scope symlink TO a regular file still reads — a
    // bare `lstat(real)` on a symlink reports `isFile() === false` and would wrongly drop a legitimate match.
    const info = await stat(realResolved).catch(() => undefined);
    if (info === undefined || !info.isFile()) return true;
    out.push({ real: realResolved, rel, size: info.size, mtimeMs: info.mtimeMs });
    return true;
  });
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

/** Heuristic binary detection: a NUL byte in the first 8 KiB marks a non-text file (the git convention). */
function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

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
  if (signal?.aborted === true) {
    throw new FsCapabilityError('the filesystem operation was aborted');
  }
}
