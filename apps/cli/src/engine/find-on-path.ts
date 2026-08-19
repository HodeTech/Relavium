import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
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
export async function findOnPath(command: string): Promise<string | undefined> {
  const pathVar = process.env['PATH'] ?? process.env['Path'] ?? '';
  const dirs = pathVar.split(delimiter).filter((dir) => dir !== '');
  for (const dir of dirs) {
    for (const ext of candidateExtensions(command)) {
      const candidate = join(dir, command + ext);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here / not executable — keep searching
      }
    }
  }
  return undefined;
}

/**
 * The suffixes to try for `command` on this platform.
 *
 * On POSIX, exactly one: none. On Windows, each `PATHEXT` — plus the BARE name FIRST when the command
 * already carries a recognized extension, because otherwise every candidate would be `node.exe.EXE` and the
 * real binary would never be found.
 */
function candidateExtensions(command: string): readonly string[] {
  if (process.platform !== 'win32') return [''];
  const pathExts = (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter((ext) => ext !== '');
  const upper = command.toUpperCase();
  const hasExt = pathExts.some((ext) => upper.endsWith(ext.toUpperCase()));
  return hasExt ? ['', ...pathExts] : pathExts;
}
