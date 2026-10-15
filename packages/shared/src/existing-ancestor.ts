/** Host-injected path inspection; this shared algorithm has no platform imports. */
export interface ExistingAncestorOperations {
  readonly realpath: (path: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<{ isDirectory(): boolean }>;
  readonly dirname: (path: string) => string;
  /** True only for the host's missing-path error, not permission/loop/not-directory failures. */
  readonly isMissing: (error: unknown) => boolean;
}

/** Content-free failure: raw host errors can contain an absolute path or sensitive filename. */
export class ExistingAncestorError extends Error {
  readonly reason: 'unresolvable' | 'not_directory' | 'no_ancestor';

  constructor(reason: ExistingAncestorError['reason']) {
    super('the existing ancestor directory could not be admitted');
    this.name = 'ExistingAncestorError';
    this.reason = reason;
  }
}

/**
 * Resolve the deepest existing directory (ADR-0105). Climb ONLY past a proven missing
 * lexical entry: realpath's ENOENT alone can also mean an existing dangling symlink.
 * The consumer still owns containment, permissions and its read/write floors.
 */
export async function deepestExistingReal(
  startDir: string,
  ops: ExistingAncestorOperations,
): Promise<string> {
  let dir = startDir;
  for (;;) {
    let real: string;
    try {
      real = await ops.realpath(dir);
    } catch (error) {
      if (!ops.isMissing(error)) throw new ExistingAncestorError('unresolvable');
      let absent = false;
      try {
        await ops.lstat(dir);
      } catch (inspectionError) {
        if (!ops.isMissing(inspectionError)) throw new ExistingAncestorError('unresolvable');
        absent = true;
      }
      // An existing entry whose realpath failed (including a dangling link) is not absence.
      if (!absent) throw new ExistingAncestorError('unresolvable');
      const parent = ops.dirname(dir);
      if (parent === dir) throw new ExistingAncestorError('no_ancestor');
      dir = parent;
      continue;
    }
    try {
      if (!(await ops.lstat(real)).isDirectory()) {
        throw new ExistingAncestorError('not_directory');
      }
    } catch (error) {
      if (error instanceof ExistingAncestorError) throw error;
      throw new ExistingAncestorError('unresolvable');
    }
    return real;
  }
}
