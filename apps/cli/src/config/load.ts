import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { GlobalConfigSchema, ProjectConfigSchema } from '@relavium/shared';
import type { GlobalConfig, ProjectConfig } from '@relavium/shared';
import { parse as parseToml } from 'smol-toml';
import type { ZodError, ZodIssue, ZodType } from 'zod';

import { ConfigError } from './errors.js';
import { findProjectConfigDir, globalConfigDir } from './paths.js';
import { resolveConfig, type ResolvedConfig } from './resolve.js';

/** Pre-parse source cap (ADR-0048 hardened loader) — a committed config file is small. */
const MAX_CONFIG_BYTES = 256 * 1024;

/**
 * Read + parse + validate a single TOML config layer against `schema`. An **absent** file
 * returns `undefined` (a missing layer is normal, not an error). Every failure — unreadable,
 * over-size, malformed TOML, or schema-invalid — becomes a typed, file-attributed
 * `ConfigError` (exit 2) whose detail is a TOML position or a Zod field path, never the file's
 * contents (config files hold no secrets — config-spec.md).
 */
export function loadConfigFile<T>(filePath: string, schema: ZodType<T>): T | undefined {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      return undefined;
    }
    throw new ConfigError(filePath, 'could not be read.', { cause: err });
  }

  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
    throw new ConfigError(filePath, `exceeds the ${MAX_CONFIG_BYTES}-byte config size limit.`);
  }

  let data: unknown;
  try {
    data = parseToml(text);
  } catch (err) {
    throw new ConfigError(filePath, `is not valid TOML${tomlPosition(err)}.`, { cause: err });
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ConfigError(filePath, `is invalid — ${formatZodError(result.error)}.`, {
      cause: result.error,
    });
  }
  return result.data;
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
  readonly config: ResolvedConfig;
  /** The discovered project `.relavium/` directory, or `undefined` when outside a project. */
  readonly projectConfigDir: string | undefined;
}

/**
 * Discover and merge every config layer for the given cwd: the global `~/.relavium/config.toml`
 * (or `--config`), then the project `workspace.toml` + `project.toml` if a `.relavium/` is found
 * by walking up from cwd. Returns the resolved config and the discovered project dir.
 */
export function loadResolvedConfig(options: LoadConfigOptions): LoadedConfig {
  const home = options.home ?? homedir();
  const globalFile = options.configPath ?? join(globalConfigDir(home), 'config.toml');
  const global = loadConfigFile<GlobalConfig>(globalFile, GlobalConfigSchema);

  const projectConfigDir = findProjectConfigDir(options.cwd);
  let workspace: ProjectConfig | undefined;
  let project: ProjectConfig | undefined;
  if (projectConfigDir !== undefined) {
    workspace = loadConfigFile<ProjectConfig>(
      join(projectConfigDir, 'workspace.toml'),
      ProjectConfigSchema,
    );
    project = loadConfigFile<ProjectConfig>(
      join(projectConfigDir, 'project.toml'),
      ProjectConfigSchema,
    );
  }

  return { config: resolveConfig({ global, workspace, project }), projectConfigDir };
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

/** First Zod issue as a field-attributed, **value-free** message (path + a code-derived reason). */
function formatZodError(error: ZodError): string {
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
      return 'value is too small';
    case 'too_big':
      return 'value is too large';
    case 'invalid_string':
      return 'value is not a valid string';
    default:
      return 'value is invalid';
  }
}
