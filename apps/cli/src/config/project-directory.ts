import { homedir } from 'node:os';
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

/** Automatic catalog reads/writes must check the actual child target, not only its marker ancestor. */
export function assertProjectArtifactPath(path: string, home: string = homedir()): void {
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
      'The project artifact resolves into global configuration. Remove the global catalog link and import into a project-owned catalog.',
    );
}

/** One destination rule for init, create/import/export and in-chat project export. */
export function resolveProjectDirectory(
  cwd: string,
  home: string = homedir(),
  discovered?: string,
): string {
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
