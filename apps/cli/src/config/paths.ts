import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CliError } from '../process/cli-error.js';

/**
 * Filesystem discovery for the two-level config model (config-spec.md). The engine never
 * reads config; this lives in the surface (ADR-0048). Functions take an injected `home`/`cwd`
 * so they are testable against a temp directory.
 */

/** `~/.relavium` — the global config directory. */
export function globalConfigDir(home: string = homedir()): string {
  return join(home, '.relavium');
}

/**
 * Lazily create `~/.relavium/` on first run, owner-only (`0700`). Idempotent.
 *
 * The `0700` is the at-rest control for the unencrypted CLI `history.db` it will hold
 * ([ADR-0050](../../../../docs/decisions/0050-cli-history-db-at-rest-posture.md)). The explicit
 * `chmod` is deliberate: `mkdir`'s mode is umask-masked AND would not re-permission an already-existing
 * directory, so a dir created earlier (e.g. by 2.B) is corrected here. On Windows POSIX mode bits do not
 * apply (`chmod` is effectively a no-op) — protection there falls to the `%USERPROFILE%` NTFS ACL.
 */
export function ensureGlobalConfigDir(home: string = homedir()): string {
  const dir = globalConfigDir(home);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  return dir;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // ENOENT (or any stat failure) → not a directory. Discovery treats absence as "not here".
    return false;
  }
}

/**
 * Walk up from `startCwd` looking for a `.relavium/` directory; the first one found is the
 * project root's config dir. Returns `undefined` if none exists up to the filesystem root.
 */
export function findProjectConfigDir(
  startCwd: string,
  home: string = homedir(),
): string | undefined {
  const allowed = projectBoundary(home);
  if (allowed === undefined)
    throw new CliError(
      'invalid_invocation',
      'The global configuration directory could not be resolved safely. Check directory access and symbolic links before retrying.',
    );
  let current = resolve(startCwd);
  for (;;) {
    // Stop at home, including canonical aliases, and never walk out of global state.
    if (!allowed(current)) return undefined;
    const candidate = join(current, '.relavium');
    if (isDirectory(candidate) && allowed(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/** Resolve existing ancestors with Node's realpath primitive; an unresolved link is never evidence of safety. */
export function canonicalProjectPath(path: string): string | undefined {
  let current = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...suffix.toReversed());
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return undefined;
      try {
        // A dangling link must not be mistaken for an absent component.
        lstatSync(current);
        return undefined;
      } catch (missing) {
        if (errorCode(missing) !== 'ENOENT') return undefined;
      }
      const parent = dirname(current);
      if (parent === current) return undefined;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

function projectBoundary(home: string): ((path: string) => boolean) | undefined {
  const canonicalHome = canonicalProjectPath(home);
  const canonicalGlobal = canonicalProjectPath(globalConfigDir(home));
  if (canonicalHome === undefined || canonicalGlobal === undefined) return undefined;
  return (path) => {
    const canonical = canonicalProjectPath(path);
    if (canonical === undefined || relative(canonicalHome, canonical) === '') return false;
    const fromGlobal = relative(canonicalGlobal, canonical);
    return (
      fromGlobal !== '' &&
      (fromGlobal === '..' || fromGlobal.startsWith(`..${sep}`) || isAbsolute(fromGlobal))
    );
  };
}

/** Shared discovery/authoring exclusion: home and the global subtree are not project destinations. */
export function projectPathIsAllowed(path: string, home: string = homedir()): boolean {
  return projectBoundary(home)?.(path) === true;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
