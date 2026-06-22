import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Filesystem discovery for the two-level config model (config-spec.md). The engine never
 * reads config; this lives in the surface (ADR-0048). Functions take an injected `home`/`cwd`
 * so they are testable against a temp directory.
 */

/** `~/.relavium` — the global config directory. */
export function globalConfigDir(home: string = homedir()): string {
  return join(home, '.relavium');
}

/** Lazily create `~/.relavium/` (and its `tmp/`) on first run. Idempotent. */
export function ensureGlobalConfigDir(home: string = homedir()): string {
  const dir = globalConfigDir(home);
  mkdirSync(join(dir, 'tmp'), { recursive: true });
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
export function findProjectConfigDir(startCwd: string): string | undefined {
  let current = resolve(startCwd);
  for (;;) {
    const candidate = join(current, '.relavium');
    if (isDirectory(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}
