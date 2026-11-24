import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  COMMAND_LINE_ENTRY_ISSUE,
  COMMAND_LINE_ENTRY_MESSAGE,
  GlobalConfigSchema,
  ProjectConfigSchema,
} from '@relavium/shared';
import type { GlobalConfig, ProjectConfig } from '@relavium/shared';
import { parse as parseToml } from 'smol-toml';
import type { ZodError, ZodIssue, ZodType } from 'zod';

import { ConfigError, OperatorConfigError } from './errors.js';
import { findProjectConfigDir, globalConfigDir } from './paths.js';
import { resolveConfig, type ResolvedConfig } from './resolve.js';
import { assertProjectArtifactPath } from './project-directory.js';

/** Pre-parse source cap (ADR-0048 hardened loader) — a committed config file is small. */
const MAX_CONFIG_BYTES = 256 * 1024;

/**
 * How one layer is read. A PROJECT layer is admitted against the operator home (it must not read global state through a child alias),
 * so that arm carries the home as a REQUIRED field: the type refuses a project-layer read that names no home, rather than a default
 * to the process's real home that a test or an embedding host would silently inherit. An operator-owned file needs no home.
 */
export type LoadConfigFileOptions =
  | { readonly selfHealMode?: boolean; readonly projectLayer?: false }
  | { readonly selfHealMode?: boolean; readonly projectLayer: true; readonly home: string };

/**
 * Read + parse + validate a single TOML config layer against `schema`. An **absent** file
 * returns `undefined` (a missing layer is normal, not an error). Every failure — unreadable,
 * over-size, malformed TOML, or schema-invalid — becomes a typed, file-attributed
 * `ConfigError` (exit 2) whose detail is a TOML position or a Zod field path, never the file's
 * contents (config files hold no secrets — config-spec.md).
 */
export function loadConfigFile<T>(
  filePath: string,
  schema: ZodType<T>,
  opts?: LoadConfigFileOptions,
): T | undefined {
  // Automatic project layers must not read global state through child aliases.
  // Explicit operator config reads retain their selected-file contract.
  if (opts?.projectLayer === true) assertProjectArtifactPath(filePath, opts.home);
  const text = readConfigText(filePath, opts?.selfHealMode === true);
  if (text === undefined) return undefined; // an absent layer is not an error

  let data: unknown;
  try {
    data = parseToml(text);
  } catch (err) {
    throw new ConfigError(filePath, `is not valid TOML${tomlPosition(err)}.`, { cause: err });
  }

  const projectSetting = opts?.projectLayer === true ? projectOperatorPreference(data) : undefined;
  if (projectSetting !== undefined) {
    throw new OperatorConfigError(projectSetting, true);
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    const setting = operatorIssue(result.error);
    if (setting !== undefined) throw new OperatorConfigError(setting, false);
    throw new ConfigError(filePath, `is invalid — ${formatZodError(result.error)}.`, {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * The text of one config layer, or `undefined` when there is no file. The path is STATTED FIRST (following a link, as the layers are read),
 * and anything that is not a regular file is refused without ever being opened: a project-layer link to a device (a tape, a serial line)
 * must not be opened at all, whatever the flags. A regular file is then opened ONCE, and every later question (is it still the file that was
 * statted, how big, which mode) and the read itself are asked of the DESCRIPTOR, never of the path again: a `stat` then a `readFileSync` by
 * path left a window in which a same-directory owner could rename a FIFO over the file (the read then blocks with no deadline) or a larger
 * file (the size cap was checked on the old one). `O_NONBLOCK` keeps the open itself from waiting on a FIFO swapped in after the `stat`, and
 * `O_NOCTTY` from making a terminal the process's controlling one; the descriptor's own `fstat` must then name the SAME file (device and
 * inode) as the `stat`, so a file swapped in between is refused unread, as is anything that is no regular file.
 *
 * **A link is FOLLOWED, on purpose.** There is no `O_NOFOLLOW`: the operator's global config (and `--config`) may be a link into a
 * dotfiles repository, and a project layer may be a link to a file the project owns; reads through intentional links remain
 * supported ([ADR-0063](../../../../docs/decisions/0063-cli-config-write-contract.md), amended 2026-10-16). What keeps a project
 * layer out of global state is the canonical-path rule at the top of {@link loadConfigFile}, not a refusal of every link. The one
 * place a link must NOT be followed is the `0600` self-heal, which {@link reassertOwnerOnly} settles from the descriptor.
 *
 * Every failure keeps its fixed sentence; none carries the path (the caller's {@link ConfigError} names the file).
 */
function readConfigText(filePath: string, selfHeal: boolean): string | undefined {
  let admitted: BigIntStats;
  try {
    admitted = statSync(filePath, { bigint: true });
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined; // an absent layer is not an error
    throw new ConfigError(filePath, 'could not be read.', { cause: err });
  }
  if (!admitted.isFile()) {
    throw new ConfigError(filePath, 'is not a regular file.');
  }
  let fd: number;
  try {
    fd = openSync(
      filePath,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0),
    );
  } catch (err) {
    throw new ConfigError(filePath, 'could not be read.', { cause: err });
  }
  try {
    let stats: BigIntStats;
    try {
      stats = fstatSync(fd, { bigint: true });
    } catch (err) {
      throw new ConfigError(filePath, 'could not be read.', { cause: err });
    }
    // Exact bigint identities (a Windows file ID exceeds a Number's precision). A path that is no longer the statted file was swapped
    // in the window between the `stat` and the open: nothing of it is read.
    if (!stats.isFile() || stats.dev !== admitted.dev || stats.ino !== admitted.ino) {
      throw new ConfigError(filePath, 'could not be read.');
    }
    if (selfHeal) {
      reassertOwnerOnly(filePath, fd, stats);
    }
    // Enforce the size cap BEFORE reading into memory (ADR-0048 hardened loader) — an oversize
    // file is rejected without ever being loaded. The read below is bounded too: a file that grew after the `fstat` is refused as
    // one that was over the cap.
    if (stats.size > BigInt(MAX_CONFIG_BYTES)) {
      throw new ConfigError(filePath, `exceeds the ${MAX_CONFIG_BYTES}-byte config size limit.`);
    }
    return readWithinCap(fd, filePath);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A read-only descriptor that fails to close has nothing left to lose.
    }
  }
}

/** The descriptor's bytes as UTF-8, read in bounded chunks; refuses (the size-limit sentence) once more than the cap are there. */
function readWithinCap(fd: number, filePath: string): string {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_CONFIG_BYTES + 1 - total));
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_CONFIG_BYTES) {
        throw new ConfigError(filePath, `exceeds the ${MAX_CONFIG_BYTES}-byte config size limit.`);
      }
      chunks.push(buffer.subarray(0, count));
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(filePath, 'could not be read.', { cause: err });
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export interface LoadConfigOptions {
  /** Where to discover the project from (the resolved `--cwd`). */
  readonly cwd: string;
  /** `--config` — overrides the global config file path; project layers still apply. */
  readonly configPath?: string | undefined;
  /** Injected home directory (defaults to the OS home; set in tests). */
  readonly home?: string | undefined;
}

export interface LoadedConfig {
  /** Model provenance from these same validated layers; fallback selection must not reopen them. */
  readonly hasRepositoryChatModel: boolean;
  readonly config: ResolvedConfig;
  /** Validated operator-owned state, before project/workspace resolution. */
  readonly globalConfig: GlobalConfig | undefined;
  /** Lexically pinned selected global file for this invocation. */
  readonly globalConfigPath: string;
  /** The discovered project `.relavium/` directory, or `undefined` when outside a project. */
  readonly projectConfigDir: string | undefined;
  /** The resolved home directory — the root of `~/.relavium/` (where `history.db` lives, 2.H/ADR-0050). */
  readonly homeDir: string;
}

/**
 * The `~/.relavium` root — WITHOUT parsing any config (ADR-0071 §4, folded from the step-7 Sonnet review).
 *
 * `loadResolvedConfig` returns this same value, but only after a project-dir walk and up to three TOML reads. The
 * boot-time catalog seed needs the home dir and nothing else, and it runs on EVERY invocation — including bare
 * Home and `--help`. Doing the full resolve there taxed the hottest path with work it throws away. One source of
 * truth for "what is home", read the cheap way when that is all a caller needs.
 */
export function resolveHomeDir(options: Pick<LoadConfigOptions, 'home'>): string {
  return options.home ?? homedir();
}

/**
 * Discover and merge every config layer for the given cwd: the global `~/.relavium/config.toml`
 * (or `--config`), then the project `workspace.toml` + `project.toml` if a `.relavium/` is found
 * by walking up from cwd. Returns the resolved config and the discovered project dir.
 */
export function loadResolvedConfig(options: LoadConfigOptions): LoadedConfig {
  const home = resolveHomeDir(options);
  const globalFile = resolve(options.configPath ?? join(globalConfigDir(home), 'config.toml'));
  // #33's `0600` self-heal applies to the CANONICAL global config and nothing else (#W15-13). It used to run
  // on every layer, including `workspace.toml` / `project.toml` — which `config-spec.md` describes as
  // committed and shared, so merely READING a project's config rewrote a file's mode in the user's repo and
  // showed up as an unexplained `git diff`. `--config` is excluded for the same reason: it names an arbitrary
  // path the user chose, and mutating permissions on it is a surprise, not a guarantee. Skipping the heal is
  // never a regression — the file's mode is simply left as it was.
  const global = loadConfigFile<GlobalConfig>(globalFile, GlobalConfigSchema, {
    selfHealMode: options.configPath === undefined,
  });

  const projectConfigDir = findProjectConfigDir(options.cwd, home);
  let workspace: ProjectConfig | undefined;
  let project: ProjectConfig | undefined;
  if (projectConfigDir !== undefined) {
    workspace = loadConfigFile<ProjectConfig>(
      join(projectConfigDir, 'workspace.toml'),
      ProjectConfigSchema,
      { projectLayer: true, home },
    );
    project = loadConfigFile<ProjectConfig>(
      join(projectConfigDir, 'project.toml'),
      ProjectConfigSchema,
      { projectLayer: true, home },
    );
  }

  return {
    hasRepositoryChatModel:
      project?.chat?.default_model !== undefined || workspace?.chat?.default_model !== undefined,
    config: resolveConfig({ global, workspace, project }),
    globalConfig: global,
    globalConfigPath: globalFile,
    projectConfigDir,
    homeDir: home,
  };
}

type OperatorSetting = 'standard_env_key_consent' | 'keychain_unavailable_acknowledged';

function projectOperatorPreference(data: unknown): OperatorSetting | undefined {
  if (typeof data !== 'object' || data === null || !('preferences' in data)) return undefined;
  const preferences: unknown = data.preferences;
  if (typeof preferences !== 'object' || preferences === null) return undefined;
  if (Object.hasOwn(preferences, 'standard_env_key_consent')) return 'standard_env_key_consent';
  if (Object.hasOwn(preferences, 'keychain_unavailable_acknowledged'))
    return 'keychain_unavailable_acknowledged';
  return undefined;
}

/** Inspect only schema-owned path segments; authored unknown keys are never promoted to diagnostics. */
function operatorIssue(error: ZodError): OperatorSetting | undefined {
  for (const issue of error.issues) {
    if (issue.path[0] !== 'preferences') continue;
    if (issue.path[1] === 'standard_env_key_consent') return 'standard_env_key_consent';
    if (issue.path[1] === 'keychain_unavailable_acknowledged')
      return 'keychain_unavailable_acknowledged';
  }
  return undefined;
}

/**
 * Best-effort `0600` self-heal for the CANONICAL global config (#33) — the read-side twin of
 * `config/write.ts`'s write-time mode and of `db/open.ts`'s db self-heal (ADR-0050). Only the caller that
 * passes `selfHealMode` reaches it; see the call site for why the project layers and `--config` do not.
 *
 * Deliberately **never throws**: unlike `history.db`, a config file holds no secrets (config-spec.md — secret
 * VALUES live in the keychain and are referenced by name), so this is defence in depth, not the guarantee. A
 * read-only file, a foreign owner, or Windows — where POSIX mode bits do not apply and `chmod` is a documented
 * no-op — must not turn a perfectly readable config into a startup failure.
 *
 * Skips the `chmod` entirely when the mode is already right, so the common path adds no syscall at all.
 */
function reassertOwnerOnly(filePath: string, fd: number, stats: BigIntStats): void {
  // The permission bits of `st_mode` — masking is the only way to read them.
  if ((stats.mode & 0o777n) === 0o600n) {
    return;
  }
  // The descriptor was opened THROUGH a link if the path is one, and `fchmod` would change the mode of whatever the link points AT,
  // which may be a file outside `~/.relavium` that this heal has no business touching (#W15-13). `lstat` is the only way to ask about
  // the path's own entry: it must be a regular file and the very file the descriptor holds (same device and inode), or it is left
  // alone. A symlinked config is left alone; that is the same "leave it as it was" outcome as any other failure on this best-effort
  // path. The mode is then set on the DESCRIPTOR, so a path swapped after the `lstat` is not chmod'ed either.
  try {
    const entry = lstatSync(filePath, { bigint: true });
    if (!entry.isFile() || entry.dev !== stats.dev || entry.ino !== stats.ino) {
      return;
    }
    fchmodSync(fd, 0o600);
  } catch {
    // Best-effort by design — see the doc comment. A config layer is readable either way.
  }
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code: unknown = err.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** A safe ` (line L, column C)` suffix from a TOML error — never the error's source snippet. */
function tomlPosition(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const line = 'line' in err && typeof err.line === 'number' ? err.line : undefined;
    const column = 'column' in err && typeof err.column === 'number' ? err.column : undefined;
    if (line !== undefined && column !== undefined) {
      return ` (line ${line}, column ${column})`;
    }
  }
  return '';
}

/**
 * First Zod issue as a field-attributed, **value-free** message (path + a code-derived reason).
 * Exported so the config WRITER ([write.ts](./write.ts)) reuses the SAME value-free formatting — a
 * schema-validation failure on the write path must never echo a received value either (ADR-0063).
 */
export function formatZodError(error: ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return 'failed schema validation';
  }
  const path = issue.path.join('.');
  const reason = safeIssueReason(issue);
  return path.length > 0 ? `${path}: ${reason}` : reason;
}

/**
 * A safe, value-free reason derived from the issue's CODE and schema-side data (the expected
 * type, the allowed enum options, the unknown key names) — **never** `issue.message`, which
 * embeds the received value for several Zod codes (e.g. `invalid_enum_value` →
 * "received 'x'"), and never `issue.received`. Config files hold no secrets (config-spec.md),
 * but the loader is the enforcement point and must not rely on that policy holding.
 */
function safeIssueReason(issue: ZodIssue): string {
  switch (issue.code) {
    case 'unrecognized_keys':
      return `unknown key(s): ${issue.keys.join(', ')}`;
    case 'invalid_type':
      return `expected ${issue.expected}`;
    case 'invalid_enum_value':
      return `must be one of: ${issue.options.map(String).join(', ')}`;
    case 'too_small':
      return issue.type === 'number'
        ? `must be ${issue.inclusive ? '>=' : '>'} ${String(issue.minimum)}`
        : 'value is too small';
    case 'too_big':
      return issue.type === 'number'
        ? `must be ${issue.inclusive ? '<=' : '<'} ${String(issue.maximum)}`
        : 'value is too large';
    case 'invalid_string':
      return 'value is not a valid string';
    case 'custom':
      // Only an issue that a shared schema marks as value-free may speak: today, an allowlist entry that is not a
      // command line (an open quote, no token, an empty program). Any other custom issue stays generic.
      return issue.params?.['relavium'] === COMMAND_LINE_ENTRY_ISSUE
        ? COMMAND_LINE_ENTRY_MESSAGE
        : 'value is invalid';
    default:
      return 'value is invalid';
  }
}
