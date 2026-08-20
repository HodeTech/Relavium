import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/**
 * Walk the ambient `PATH` for an executable named `command`, returning the first hit or `undefined`.
 *
 * **The AMBIENT `PATH`, deliberately** — never a caller-declared one. Both consumers depend on that for the
 * same reason from two directions: `run_command` resolves an engine-allowlisted name to a real binary
 * independent of any `declaredEnv`, and
 * [ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §3 resolves an MCP stdio
 * `command` BEFORE the consent gate so the digest names a file rather than a word, and spawns that same path
 * so the child's environment cannot select a different binary. A declared `PATH` is refused outright by
 * §4's denylist, so there is no second candidate to consider.
 *
 * Extracted from `run_command`'s host when the consent gate became a second caller. It is one walk with one
 * `PATHEXT` subtlety, and two copies of it would drift on the first Windows bug either of them found.
 */
export async function findOnPath(
  command: string,
  /**
   * The platform and `PATHEXT`, injected so the Windows branch is testable on any OS. Every CI leg that
   * runs the unit suite is Linux, so a `process.platform` read made `candidateExtensions` unreachable from
   * a test — the one piece of this function with a subtlety worth pinning.
   */
  env: PathLookupEnv = defaultLookupEnv(),
): Promise<string | undefined> {
  const dirs = env.path.split(delimiter).filter((dir) => dir !== '');
  const extensions = candidateExtensions(command, env);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      try {
        // **A regular FILE**, not merely something with the execute bit: a directory carries the traversal
        // bit on POSIX, so `access(X_OK)` alone answered "found" for one — and on Windows `X_OK` is a
        // documented no-op, so it answered "found" for anything that exists. `execve` would fail cleanly on
        // a directory, but this result now also backs a consent fingerprint, where "found" must mean a file.
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here / not executable — keep searching
      }
    }
  }
  return undefined;
}

/** The two ambient values the lookup reads — injected so both branches are testable. */
export interface PathLookupEnv {
  readonly path: string;
  readonly platform: string;
  readonly pathExt: string;
}

function defaultLookupEnv(): PathLookupEnv {
  return {
    path: process.env['PATH'] ?? process.env['Path'] ?? '',
    platform: process.platform,
    pathExt: process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM',
  };
}

/**
 * The suffixes to try for `command` on this platform.
 *
 * On POSIX, exactly one: none. On Windows, each `PATHEXT` — plus the BARE name FIRST when the command
 * already carries a recognized extension, because otherwise every candidate would be `node.exe.EXE` and the
 * real binary would never be found.
 */
export function candidateExtensions(command: string, env: PathLookupEnv): readonly string[] {
  if (env.platform !== 'win32') return [''];
  const pathExts = env.pathExt.split(';').filter((ext) => ext !== '');
  const upper = command.toUpperCase();
  const hasExt = pathExts.some((ext) => upper.endsWith(ext.toUpperCase()));
  return hasExt ? ['', ...pathExts] : pathExts;
}
