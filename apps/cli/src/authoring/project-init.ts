import { lstatSync, mkdirSync, rmdirSync, statSync, type BigIntStats } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { canonicalProjectPath } from '../config/paths.js';
import { resolveProjectDirectory } from '../config/project-directory.js';
import { CliError } from '../process/cli-error.js';

const messages = {
  marker_link:
    'The project .relavium marker is a symbolic link. Replace the link with a project directory before running init.',
  marker_invalid:
    'The project .relavium marker is not a directory. Move or rename it before running init.',
  cwd_invalid: 'Project initialization needs an existing, accessible working directory.',
  changed:
    'The project directory changed before initialization. Run init again to review the target.',
  create_failed:
    'Project initialization could not complete. Check directory permissions and retry.',
  cleanup_incomplete:
    'Project initialization could not complete, and cleanup could not be confirmed. Inspect .relavium before retrying.',
} as const;

export class ProjectInitError extends CliError {
  readonly reason: keyof typeof messages;
  constructor(reason: keyof typeof messages, cause?: unknown) {
    super('invalid_invocation', messages[reason], cause === undefined ? undefined : { cause });
    this.name = 'ProjectInitError';
    this.reason = reason;
  }
}

export interface ProjectInitResult {
  readonly status: 'created' | 'already-initialized';
  readonly projectConfigDir: string;
  readonly created: readonly string[];
}
export interface PreparedProjectInit {
  readonly projectConfigDir: string;
  readonly alreadyInitialized: boolean;
  /** The exact directories the confirmation card must name, including the new marker. */
  readonly directories: readonly string[];
  readonly publish: (assertAdmitting?: () => void) => ProjectInitResult;
}

function code(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
function marker(path: string): BigIntStats | undefined {
  let stats: BigIntStats;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch (error) {
    if (code(error) === 'ENOENT') return undefined;
    throw new ProjectInitError('cwd_invalid', error);
  }
  if (stats.isSymbolicLink()) throw new ProjectInitError('marker_link');
  if (!stats.isDirectory()) throw new ProjectInitError('marker_invalid');
  return stats;
}
function inspect(cwd: string, home: string) {
  try {
    if (!statSync(cwd).isDirectory()) throw new ProjectInitError('cwd_invalid');
  } catch (error) {
    if (error instanceof ProjectInitError) throw error;
    throw new ProjectInitError('cwd_invalid', error);
  }
  // Refuse this final component before discovery could follow it or call it initialized.
  marker(join(cwd, '.relavium'));
  const target = resolveProjectDirectory(cwd, home);
  return { target, existing: marker(target) !== undefined };
}
type CreatedDirectory = {
  readonly path: string;
  readonly identity?: { readonly dev: bigint; readonly ino: bigint };
};
function sameDirectory(entry: CreatedDirectory): boolean {
  try {
    const current = lstatSync(entry.path, { bigint: true });
    return (
      entry.identity !== undefined &&
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === entry.identity.dev &&
      current.ino === entry.identity.ino
    );
  } catch {
    return false;
  }
}
function cleanCreated(entries: readonly CreatedDirectory[]): boolean {
  let complete = true;
  for (const entry of [...entries].reverse()) {
    try {
      try {
        lstatSync(entry.path);
      } catch (error) {
        if (code(error) === 'ENOENT') continue;
        throw error;
      }
      if (!sameDirectory(entry)) {
        complete = false;
        continue;
      }
      // Never recursively remove a directory; concurrent content and replacements belong to their author.
      rmdirSync(entry.path);
    } catch (error) {
      if (code(error) !== 'ENOENT') complete = false;
    }
  }
  return complete;
}

/** Read-only preparation, shared by explicit shell init and Home's prewrite confirmation. */
export function prepareProjectInit(cwd: string, home: string = homedir()): PreparedProjectInit {
  const workingDir = resolve(cwd);
  const planned = inspect(workingDir, home);
  const canonicalTarget = canonicalProjectPath(planned.target);
  if (canonicalTarget === undefined) throw new ProjectInitError('cwd_invalid');
  const directories = planned.existing
    ? []
    : [planned.target, join(planned.target, 'workflows'), join(planned.target, 'agents')];
  return {
    projectConfigDir: planned.target,
    alreadyInitialized: planned.existing,
    directories,
    publish: (assertAdmitting = () => {}) => {
      assertAdmitting();
      const current = inspect(workingDir, home);
      if (current.existing)
        return { status: 'already-initialized', projectConfigDir: current.target, created: [] };
      if (
        planned.existing ||
        current.target !== planned.target ||
        canonicalProjectPath(current.target) !== canonicalTarget
      )
        throw new ProjectInitError('changed');
      const created: CreatedDirectory[] = [];
      let refused: { readonly error: unknown } | undefined;
      const admit = (): void => {
        try {
          assertAdmitting();
        } catch (error) {
          refused = { error };
          throw error;
        }
      };
      try {
        for (const path of directories) {
          admit();
          const root = created[0];
          if (root !== undefined && !sameDirectory(root)) throw new ProjectInitError('changed');
          // Recheck the global boundary before every mkdir, including a changed cwd alias.
          if (
            resolveProjectDirectory(workingDir, home) !== planned.target ||
            canonicalProjectPath(planned.target) !== canonicalTarget
          )
            throw new ProjectInitError('changed');
          try {
            mkdirSync(path);
          } catch (error) {
            if (created.length === 0 && code(error) === 'EEXIST') {
              const winner = inspect(workingDir, home);
              if (winner.existing)
                return {
                  status: 'already-initialized',
                  projectConfigDir: winner.target,
                  created: [],
                };
            }
            throw error;
          }
          // Record ownership even if the following identity read fails; cleanup
          // must then report uncertainty rather than forget a successful mkdir.
          created.push({ path });
          const stats = marker(path);
          if (stats === undefined) throw new ProjectInitError('changed');
          created[created.length - 1] = { path, identity: { dev: stats.dev, ino: stats.ino } };
        }
        if (created.some((entry) => !sameDirectory(entry))) throw new ProjectInitError('changed');
        return { status: 'created', projectConfigDir: planned.target, created: directories };
      } catch (error) {
        if (!cleanCreated(created)) throw new ProjectInitError('cleanup_incomplete', error);
        if (refused !== undefined && refused.error === error) throw error;
        if (error instanceof CliError) throw error;
        throw new ProjectInitError('create_failed', error);
      }
    },
  };
}
