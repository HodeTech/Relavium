import { join } from 'node:path';

import { CliError } from '../process/cli-error.js';
import {
  canonicalProjectPath,
  findProjectConfigDir,
  globalConfigDir,
  projectPathIsAllowed,
} from './paths.js';

export const PROJECT_DIRECTORY_REMEDY =
  'Home and ~/.relavium are global state, not a project. Run this command in a project directory; import any existing global workflows or agents there.';

/**
 * Automatic catalog reads/writes must check the actual child target, not only its marker ancestor. `home` is the operator home the rule
 * reads and has no default: a caller that was never handed one would otherwise judge a path by the REAL home of whoever runs it
 * (review H2), so each call site names the home it means (a command resolves the process's own at its boundary).
 */
export function assertProjectArtifactPath(path: string, home: string): void {
  if (
    canonicalProjectPath(path) === undefined ||
    canonicalProjectPath(globalConfigDir(home)) === undefined
  )
    throw new CliError(
      'invalid_invocation',
      'The project artifact target could not be resolved safely. Check directory access and symbolic links, then retry.',
    );
  if (!projectPathIsAllowed(path, home))
    throw new CliError(
      'invalid_invocation',
      'The project artifact resolves into home or global configuration. Use a project-owned path and remove links into global state.',
    );
}

/** One destination rule for init, create/import/export and in-chat project export. `home` has no default, for the reason above. */
export function resolveProjectDirectory(cwd: string, home: string, discovered?: string): string {
  const unavailable = (): never => {
    throw new CliError(
      'invalid_invocation',
      'The project directory could not be resolved safely. Check directory access and symbolic links, then retry.',
    );
  };
  if (
    canonicalProjectPath(home) === undefined ||
    canonicalProjectPath(globalConfigDir(home)) === undefined ||
    canonicalProjectPath(cwd) === undefined
  )
    unavailable();
  if (!projectPathIsAllowed(cwd, home))
    throw new CliError('invalid_invocation', PROJECT_DIRECTORY_REMEDY);
  const target = discovered ?? findProjectConfigDir(cwd, home) ?? join(cwd, '.relavium');
  if (canonicalProjectPath(target) === undefined) unavailable();
  if (!projectPathIsAllowed(target, home))
    throw new CliError('invalid_invocation', PROJECT_DIRECTORY_REMEDY);
  return target;
}
