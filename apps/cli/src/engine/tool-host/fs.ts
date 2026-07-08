import { randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  ToolDispatchError,
  ToolUnavailableError,
  type DirEntry,
  type DirListing,
  type FileRead,
  type FileWritten,
  type FsCapability,
  type FsListOpts,
  type FsReadOpts,
  type FsScopeTier,
  type FsWriteOpts,
} from '@relavium/core';
import type { AbortSignalLike } from '@relavium/shared';

import {
  HostCapabilityError,
  HostDeniedError,
  throwIfAborted as throwIfAbortedShared,
} from './errors.js';

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
 * naming a **reason only** — never a path / the bytes. Maps to `tool_failed` (the shared {@link HostCapabilityError}).
 */
export class FsCapabilityError extends HostCapabilityError {}

/**
 * A **deterministic scope/security denial** — a path escapes the tier, a UNC path, or a refusal to write through
 * a symlink — mapping to the **fatal**, non-retryable `tool_denied` (the shared {@link HostDeniedError}): a
 * denied path just re-denies, so it must NOT burn the node-retry budget (error-handling.md §tool-dispatch codes).
 *
 * Recoverability (Step 14): fatal by default (`recoverable=false`, inherited). ONE throw opts in — the pure
 * **scope-tier escape** ("the path escapes the allowed filesystem scope") passes `recoverable: true`, so on the
 * interactive chat surface it is fed back as a correctable tool result and the model can adapt to an in-bounds
 * path (conversational recovery). The **confidentiality** refusal (a secret/credential store read), the protected
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
export function createNodeFsCapability(config: NodeFsCapabilityConfig): FsCapability {
  const maxReadBytes = config.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxGlobMatches = config.maxGlobMatches ?? DEFAULT_MAX_GLOB_MATCHES;
  return {
    readFile: (path, opts, signal) =>
      guarded(() => readOne(config, maxReadBytes, maxGlobMatches, path, opts, signal)),
    writeFile: (path, data, opts, signal) =>
      guarded(() => writeOne(config, path, data, opts, signal)),
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
    if (error instanceof ToolDispatchError || error instanceof HostCapabilityError) {
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
): Promise<FileRead> {
  throwIfAborted(signal);
  if (opts.glob === true) {
    return readGlob(config, maxReadBytes, maxGlobMatches, path, signal);
  }
  const inScope = await buildScopeChecker(config);
  const real = await jailExisting(config, inScope, path);
  // The confidentiality floor: refuse to read a secret/credential store (.ssh, .relavium, .git/config, the
  // credential dotfiles) in EVERY mode and tier — checked on the realpath'd target so a symlink/alias into one
  // is caught. Reads flow into the model's context (then to the provider), so this mirrors, on the read side,
  // the protected-paths WRITE floor's mode/tier independence (ADR-0057).
  assertNotSensitiveReadPath(real);
  const result = await readJailedFile(real, maxReadBytes, rejectAliasedRead(config, real));
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
  return {
    content: result.bytes.toString('utf8'),
    mimeType: mimeForPath(real),
    sizeBytes: result.size,
    lastModified: new Date(result.mtimeMs).toISOString(),
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
    // ONE read fd per match (probe + size + content from the single open) — so a swap after the walk's realpath
    // can neither redirect the read nor make the size charged diverge from the bytes read. The bounded prefix
    // probe skips a binary match WITHOUT charging the budget or loading it; the budget is enforced against the
    // fd's own size BEFORE the full read, so an over-budget text file is never loaded just to be rejected.
    const result = await readJailedFile(
      m.real,
      maxReadBytes - totalBytes,
      rejectAliasedRead(config, m.real),
    );
    // skip a non-text match (dir / special / aliased / binary); never charge the budget. collectGlobFiles
    // already filters to regular, in-scope, non-sensitive files — but it does NOT check nlink, so the
    // hard-link (`aliased`) skip is enforced HERE by readJailedFile's per-fd guard (the primary aliasing
    // filter for a glob read); `directory`/`special` are the belt-and-suspenders for a post-walk swap.
    if (
      result.kind === 'directory' ||
      result.kind === 'special' ||
      result.kind === 'aliased' ||
      result.kind === 'binary'
    )
      continue;
    if (result.kind === 'oversize') {
      throw new FsCapabilityError(
        `read_file: the glob result exceeds the ${maxReadBytes}-byte read limit`,
      );
    }
    totalBytes += result.size;
    latest = Math.max(latest, result.mtimeMs);
    parts.push(`===== ${m.rel} =====\n${result.bytes.toString('utf8')}`);
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
  | { kind: 'binary' }
  | { kind: 'oversize'; size: number }
  | { kind: 'file'; bytes: Buffer; size: number; mtimeMs: number };

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
 * CAVEAT (binary heuristic): a NUL-free file in a legacy single-byte encoding (Latin-1 / CP1252 / MacRoman)
 * passes as "text" and is decoded as UTF-8, yielding U+FFFD replacements for its high bytes — an accepted v1
 * limitation (the durable-media-handle path that would carry such files faithfully is the deferred follow-up).
 *
 * Exported for direct security testing of the post-jail fd guard (the no-follow / single-fd / no-hard-link
 * properties), which a black-box `readFile` test cannot reach because the jail already resolves any symlink to
 * its canonical target.
 */
export async function readJailedFile(
  real: string,
  sizeLimit: number,
  rejectAliased = true,
): Promise<JailedRead> {
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
    const probeLen = Math.min(BINARY_PROBE_BYTES, st.size);
    if (probeLen > 0) {
      const probe = Buffer.allocUnsafe(probeLen);
      const { bytesRead } = await handle.read(probe, 0, probeLen, 0);
      if (probe.subarray(0, bytesRead).includes(0)) return { kind: 'binary' };
    }
    if (st.size > sizeLimit) return { kind: 'oversize', size: st.size };
    // Read from explicit position 0 (not the handle's running offset, which the probe advanced) into a sized
    // buffer — avoids `FileHandle.readFile()` position ambiguity and keeps content pinned to the fstat'd inode.
    const content = Buffer.allocUnsafe(st.size);
    const { bytesRead } = await handle.read(content, 0, st.size, 0);
    return {
      kind: 'file',
      bytes: content.subarray(0, bytesRead),
      size: st.size,
      mtimeMs: st.mtimeMs,
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
 * a POSIX `a:b` on a case-sensitive FS, which is the safe direction. The realpath re-check in {@link writeOne}
 * additionally canonicalizes a Win32 8.3 short-name alias (`GITCON~1` → `.gitconfig`) of an EXISTING target.
 */
const PROTECTED_DIR_SEGMENTS: ReadonlySet<string> = new Set(['.git', '.relavium', '.ssh']);
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
  for (const segment of absoluteTarget.split(sep)) {
    if (PROTECTED_DIR_SEGMENTS.has(foldPathComponent(segment))) return true;
  }
  return PROTECTED_RC_BASENAMES.has(foldPathComponent(basename(absoluteTarget)));
}

/** Deny a write to a protected path (a `.git`/`.relavium`/`.ssh` directory, or a startup/config file). FATAL. */
function assertNotProtectedPath(absoluteTarget: string): void {
  if (!isProtectedPath(absoluteTarget)) return;
  // Re-derive which class matched for a precise (still reason-only) message.
  for (const segment of absoluteTarget.split(sep)) {
    if (PROTECTED_DIR_SEGMENTS.has(foldPathComponent(segment))) {
      throw new FsScopeDeniedError(
        'write_file: refusing to write inside a protected directory (.git / .relavium / .ssh)',
      );
    }
  }
  throw new FsScopeDeniedError('write_file: refusing to write a shell startup file');
}

/**
 * Directory segments whose contents are refused to READ in every mode/tier — a whole `.ssh/` (private keys,
 * `authorized_keys`, `known_hosts`) and `.relavium/` (this CLI's local config/secrets dir). Narrower than the
 * write floor's {@link PROTECTED_DIR_SEGMENTS} (which also blocks whole `.git/` for WRITE-side hook RCE, a
 * concern that does not apply to a read) — reads leak CONFIDENTIALITY, so the read floor targets the
 * secret/credential stores specifically.
 *
 * NOTE (latent): `.relavium` also names this CLI's sanctioned scratch root `~/.relavium/tmp/` (the `tmpDir`
 * sandboxed root). Both this read floor AND the write {@link PROTECTED_DIR_SEGMENTS} would refuse that root — but
 * no call site wires `tmpDir` today, so the collision is inert. Resolve it (home-anchored match, or exclude the
 * wired tmp root) BEFORE any caller passes `tmpDir`. Tracked in docs/roadmap/deferred-tasks.md.
 */
const SENSITIVE_READ_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  '.ssh',
  '.relavium',
  '.aws',
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
]);

/**
 * Whether an absolute path is a secret/credential store that must never be read into the model's context (and
 * thence to the provider): under a `.ssh`/`.relavium`/`.aws` segment, a `.env` / `.env.*` dotenv file, a
 * `.docker/config.json` (registry auth), a repo-local `.git/config` (embeds remote-URL credentials), or a
 * credential dotfile. The read-side confidentiality analogue of {@link isProtectedPath}; exported for direct
 * testing. Folds each component like the write floor (NTFS ADS / case / trailing dot-space). This floor is the
 * one control the CLI `@`-mention read (2.5.D / [ADR-0061](../../../../../docs/decisions/0061-cli-input-layer-file-injection-and-shell-escape.md))
 * shares with `read_file`; the `.env`/`.aws`/`.docker` members were added there and strengthen `read_file` on
 * every surface.
 */
export function isSensitiveReadPath(absoluteTarget: string): boolean {
  const folded = absoluteTarget.split(sep).map(foldPathComponent);
  for (const segment of folded) {
    if (SENSITIVE_READ_DIR_SEGMENTS.has(segment)) return true;
  }
  const base = foldPathComponent(basename(absoluteTarget));
  // dotenv secret files — `.env`, `.env.local`, `.env.production`, … (foldPathComponent strips a trailing dot, so
  // `.env.` folds to `.env`). The single most common in-repo secret store.
  if (base === '.env' || base.startsWith('.env.')) return true;
  // Docker registry auth (`~/.docker/config.json` or a project `.docker/config.json`) — base64-embedded creds.
  if (base === 'config.json' && folded.includes('.docker')) return true;
  // A git `config` embeds remote-URL credentials: catch it under a `.git` dir (repo / submodule `.git/modules/*`
  // / worktree) AND under a bare-repo dir (`myrepo.git/config`) — any segment ENDING in `.git` with a `config`
  // basename. Over-denying a stray `x.git/config` that isn't a repo is the safe direction for a read floor.
  if (
    base === 'config' &&
    folded.some((segment) => segment === '.git' || segment.endsWith('.git'))
  ) {
    return true;
  }
  // git's XDG credential store `$XDG_CONFIG_HOME/git/credentials` — same plaintext `user:TOKEN@host` lines as
  // `.git-credentials`, but the basename is a bare `credentials` under a `git` dir (no leading dot).
  if (base === 'credentials' && folded.includes('git')) return true;
  return SENSITIVE_READ_BASENAMES.has(base);
}

/** Deny a read of a secret/credential store (`.ssh`/`.relavium`, a git `config`, a credential dotfile). FATAL. */
function assertNotSensitiveReadPath(absoluteTarget: string): void {
  if (isSensitiveReadPath(absoluteTarget)) {
    throw new FsScopeDeniedError(
      'refusing to read a credential/secret store (.ssh / .relavium / .aws / .env or .env.* / .docker config / a git config or credential dotfile) — ask the user to share any needed content instead',
    );
  }
}

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
  // Protected paths are denied in EVERY mode (auto included). Checked on the REQUESTED path before the jail
  // mkdir so a `createDirs` write cannot even create an empty `.git/`, then re-checked on the (realDir-)jailed
  // finalTarget so a parent symlink cannot resolve INTO a protected directory.
  assertNotProtectedPath(resolve(config.workspaceDir, path));
  const inScope = await buildScopeChecker(config);
  const { realDir, finalTarget } = await jailWriteTarget(
    config,
    inScope,
    path,
    opts.createDirs === true,
  );
  await assertNotSymlink(finalTarget); // never write THROUGH an existing symlink at the final component
  assertNotProtectedPath(finalTarget); // re-check the jailed target (parent realpath'd) against the fold
  // Belt-and-suspenders for Win32 final-component name-aliasing: `finalTarget` keeps the LEXICAL basename
  // (jailWriteTarget only realpath's the parent). If the target already EXISTS, its realpath is the canonical
  // long name, so a Win32 8.3 short-name alias (`GITCON~1` → `.gitconfig`) or an NTFS stream path that folds to
  // a non-protected basename is caught HERE. A not-yet-existing target has no alias, so the checks above suffice.
  const canonicalTarget = await realpath(finalTarget).catch(() => undefined);
  if (canonicalTarget !== undefined) assertNotProtectedPath(canonicalTarget);
  throwIfAborted(signal);
  const bytes = Buffer.from(data, 'utf8');
  if (opts.append === true) {
    // Append cannot use the atomic temp+rename (that replaces, never appends). Open with O_NOFOLLOW so the
    // kernel refuses a final-component symlink AT OPEN TIME — closing the TOCTOU window between the
    // `assertNotSymlink` lstat above and the write (a swapped-in symlink can't redirect the append out of
    // scope). A symlink there fails ELOOP/ENOTDIR, which we map to the FATAL `tool_denied` (not the retryable
    // `tool_failed` `guarded` would otherwise assign a raw fs error). NOTE: `O_NOFOLLOW` is `0` on Windows (no
    // kernel enforcement); the `assertNotSymlink` lstat above still covers the non-race case. `O_NONBLOCK` opens
    // a FIFO/device WITHOUT blocking — a reader-less FIFO would otherwise hang the write FOREVER (fs.open takes
    // no AbortSignal, so even the EA7 mid-turn abort could not cancel it), and the fstat below fails it closed.
    // The write arm now also serves the approval-gated `chat-read-write` profile (ADR-0057), not only the
    // author-trusted workflow-run path; the residual Windows-only symlink-swap race is flagged for the mandatory
    // ADR-0057 security review (Step 5) to re-affirm as accepted — the protected-paths floor + fs jail still hold.
    const handle = await open(
      finalTarget,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
    ).catch((error: unknown) => {
      const code = errnoCode(error);
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        throw new FsScopeDeniedError('write_file: refusing to write through a symlink');
      }
      if (code === 'ENXIO' || code === 'EOPNOTSUPP' || code === 'ENODEV') {
        // A non-regular special file that fails the OPEN itself rather than reaching the fstat: O_WRONLY |
        // O_NONBLOCK on a reader-less FIFO returns ENXIO immediately (instead of blocking forever); a socket
        // special file returns ENXIO (Linux) or EOPNOTSUPP (macOS); a device with no driver returns ENODEV. All
        // are targets we refuse anyway — surface the same fatal denial the post-open fstat gives, not a raw
        // (retryable, path-leaking) fs error.
        throw new FsScopeDeniedError(
          'write_file: refusing to append to a non-regular file (a FIFO/device/socket)',
        );
      }
      throw error;
    });
    try {
      // Race-free guards on the OPENED inode (same fd — no TOCTOU vs. a path re-stat): (1) refuse a NON-REGULAR
      // target — a reader-less FIFO/device would hang the write forever (O_NONBLOCK above returned the fd so this
      // fstat can run); (2) refuse a HARD-LINKED regular file (st.nlink > 1) — lstat, realpath, and the
      // protected-path fold all see only this one in-scope, non-symlink name, but the shared inode may ALSO be a
      // name outside the jail or a protected file (~/.ssh/authorized_keys), and O_APPEND would write straight
      // through to it, defeating the protected-paths floor. Both mirror the read-side fd guards (readJailedFile).
      const st = await handle.stat();
      if (!st.isFile()) {
        throw new FsScopeDeniedError(
          'write_file: refusing to append to a non-regular file (a FIFO/device/socket)',
        );
      }
      if (st.nlink > 1) {
        throw new FsScopeDeniedError(
          'write_file: refusing to append to a hard-linked file (its content may be shared with a file outside the sandbox)',
        );
      }
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
    // O_CREAT|O_EXCL|O_WRONLY (the 'wx' flag) plus O_NOFOLLOW — no-follow PARITY with the append path: the open
    // refuses to follow a final-component symlink even though the random temp name already makes a pre-placed
    // symlink there implausible (defense in depth). The residual gap is a PARENT-dir swap between `jailWriteTarget`'s
    // realpath and this write — not closable in Node (no `openat`); the write arm now also serves the
    // approval-gated `chat-read-write` profile (ADR-0057), so that Windows-only residual is flagged for the
    // mandatory ADR-0057 security review (Step 5), with the protected-paths floor + fs jail still in force.
    await writeFile(tmp, bytes, {
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    });
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
  // Refuse to enumerate a credential/secret store (recon of key/secret filenames) — the read-side confidentiality
  // floor, applied to the requested root and to each nested entry the recursive walk reaches below.
  assertNotSensitiveReadPath(realRoot);
  const rootInfo = await stat(realRoot);
  if (!rootInfo.isDirectory()) {
    throw new FsCapabilityError('list_directory: the path is not a directory');
  }
  const matcher = opts.glob === undefined ? undefined : compileGlob(opts.glob);
  const cap = Math.min(maxEntries, MAX_LIST_ENTRIES);
  const entries: DirEntry[] = [];
  await walk(realRoot, opts.recursive === true, signal, inScope, async (real, rel, dirent) => {
    if (entries.length >= cap) return false; // stop the walk once the listing cap is hit
    if (matcher !== undefined && !matcher(rel)) return true;
    // Sensitive-read floor on the RESOLVED target (mirrors collectGlobFiles): `walk` realpaths the parent DIR
    // but not the entry, so a bare lexical check would let a symlink named innocuously slip a nested
    // .ssh/.relavium/credential store into the listing. Fall back to the lexical path when realpath fails (a
    // broken/vanished link) so a sensitively-NAMED entry is still filtered. The DISPLAYED name (`rel`) is unchanged.
    const realResolved = await realpath(real).catch(() => undefined);
    if (isSensitiveReadPath(realResolved ?? real)) return true;
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
  // Verify the deepest EXISTING ancestor is in-scope AND not protected before creating anything, so a
  // symlinked/aliased ancestor pointing outside the scope — OR resolving INTO a protected dir (a Win32 8.3
  // short name like `GIT~1` → `.git`, which the lexical pre-check misses) — is caught before `mkdir` creates
  // even an empty subdir there. This closes the createDirs side-effect the realpath'd finalTarget check alone
  // would only catch AFTER the mkdir.
  const deepestReal = await deepestExistingReal(targetDir);
  assertInScope(inScope, deepestReal);
  assertNotProtectedPath(deepestReal);
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
    throw new FsCapabilityError('write_file: the final path could not be inspected');
  });
  if (info?.isSymbolicLink() === true) {
    throw new FsScopeDeniedError('write_file: refusing to write through a symlink');
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

/**
 * Walk `root` (optionally recursive), invoking `visit(real, rel, dirent)`; `visit` returns false to stop. Each
 * queued directory is re-resolved (`realpath`) + scope-checked **immediately before** its `readdir` — closing the
 * TOCTOU between the time it was queued and the time it is read: a directory atomically swapped for an out-of-jail
 * symlink in that window is dropped, and the read targets the freshly-resolved canonical path, not the stale one.
 * `root` is already a canonical in-scope path (the caller realpath'd it). A symlinked subdir is never followed
 * (`dirent.isDirectory()` is false for one), so the recursion stays inside the jail with no symlink loop.
 */
async function walk(
  root: string,
  recursive: boolean,
  signal: AbortSignalLike | undefined,
  inScope: ScopeChecker,
  visit: (real: string, rel: string, dirent: Dirent) => Promise<boolean>,
): Promise<void> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    throwIfAborted(signal);
    const queued = stack.pop();
    if (queued === undefined) break;
    // Re-resolve + re-scope-check EVERY popped dir (including `root`, already canonical — a no-op resolve) right
    // before its `readdir`, closing the queue→read TOCTOU; a dir swapped out-of-jail in that window drops here.
    const dir = await resolveInScope(queued, inScope);
    if (dir === undefined) continue; // swapped out-of-jail or vanished between queue and read — skip
    const dirents = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
    for (const dirent of dirents) {
      const real = join(dir, dirent.name);
      if (!(await visit(real, posixRel(root, real), dirent))) return;
      if (recursive && dirent.isDirectory()) stack.push(real); // re-resolved + re-checked when it is popped
    }
  }
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
): Promise<{ real: string; rel: string; size: number; mtimeMs: number }[]> {
  const inScope = await buildScopeChecker(config);
  const base = await realpath(config.workspaceDir).catch(() => {
    throw new FsCapabilityError('read_file: the workspace directory is not accessible');
  });
  const matcher = compileGlob(pattern);
  const out: { real: string; rel: string; size: number; mtimeMs: number }[] = [];
  await walk(base, true, signal, inScope, async (real, rel, dirent) => {
    if (out.length >= maxMatches) return false;
    if (dirent.isDirectory() || !matcher(rel)) return true;
    // Defense in depth: a matched FILE is realpath-jailed (a symlinked file could still point outside scope).
    const realResolved = await realpath(real).catch(() => undefined);
    if (realResolved === undefined || !inScope(realResolved)) return true; // skip, never read out of scope
    // Never surface a credential/secret store through a glob (the sensitive-read floor); the per-fd hard-link
    // guard in readJailedFile then still refuses an aliased match the readGlob loop reaches.
    if (isSensitiveReadPath(realResolved)) return true;
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
