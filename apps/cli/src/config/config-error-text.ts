import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';

import { sourceLabel } from '../process/source-label.js';
import { ConfigError } from './errors.js';

/** The two roots a config file is named from when a surface that draws into a transcript reports a broken one. */
export interface ConfigErrorRoots {
  /** The directory the command runs in: a config file inside it is named relative to it. */
  readonly cwd: string;
  /** The operator's home: a config file inside it is named from `~`. Defaults to the process's. */
  readonly homeDir?: string | undefined;
}

/** `path` relative to `root`, when it lies inside it; `undefined` for the root itself, a path outside it, and a different drive. */
function insideRoot(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  const outside = rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return outside ? undefined : rel;
}

/**
 * How a transcript names a config file: relative to the project directory when it is inside it, from `~` when it is inside the
 * operator's home, else the relative {@link sourceLabel} (a path up from the project directory, or the bare file name). Never an
 * absolute path: it discloses the operator's directory layout in a transcript that a screen share or a screenshot carries away.
 */
export function configFileLabel(filePath: string, roots: ConfigErrorRoots): string {
  const inProject = insideRoot(roots.cwd, filePath);
  if (inProject !== undefined) return inProject;
  const inHome = insideRoot(roots.homeDir ?? homedir(), filePath);
  return inHome === undefined ? sourceLabel(roots.cwd, filePath) : `~${sep}${inHome}`;
}

/**
 * The same {@link ConfigError} with its message naming the file by {@link configFileLabel} instead of its absolute path (RUNCORE-3),
 * for a surface that draws the message into a transcript, a notice or a report. The shell's own stderr message is another surface and
 * keeps the full path; this never changes the error it was given. An error with no absolute file (a fixed-copy operator error, which
 * carries no path at all) is returned as it is.
 */
export function pathFreeConfigError(error: ConfigError, roots: ConfigErrorRoots): ConfigError {
  const prefix = `${error.filePath}: `;
  if (!isAbsolute(error.filePath) || !error.message.startsWith(prefix)) return error;
  const detail = error.message.slice(prefix.length);
  return new ConfigError(error.filePath, `${configFileLabel(error.filePath, roots)}: ${detail}`, {
    cause: error,
    pathFree: true,
  });
}

/** `fault` as a transcript may draw it: a {@link ConfigError} path-free, anything else as it is. */
export function faultForTranscript(fault: unknown, roots: ConfigErrorRoots): unknown {
  return fault instanceof ConfigError ? pathFreeConfigError(fault, roots) : fault;
}
