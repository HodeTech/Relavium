import { isAbsolute, resolve } from 'node:path';

import { fsPolicyCanonicalPath } from '../engine/tool-host/fs-policy.js';

/**
 * The ONE directory identity of a workflow run (MVP-11 unit 7, round 2): what a run records as `runs.project_root` and what every reader
 * that asks "was this run started HERE?" compares it with. The Home lists, opens, answers and starts again only the runs of the directory
 * it was opened in, so this is an authority rule, not a label.
 *
 * - **Recorded canonical.** A run records {@link projectRootOf} its working directory: the same pin a filesystem policy takes as its
 *   workspace (`fsPolicyWorkspace`, the value a chat records as its `working_dir`). `.`, `work/`, a symlink and a case variant of one
 *   directory are one root, and a relative spelling is never written.
 * - **Compared exactly.** {@link isProjectRootHere} is the only match: an absolute recorded root equal, as text, to an absolute directory
 *   of the reader. The reader's directory is itself canonical (the Home passes its policy's workspace), so the text is the identity.
 * - **Fail closed.** A stored root that is not an absolute path (`.`, `work`, the empty text, none) was written before roots were canonical
 *   and names no directory: it is UNRECORDED to every reader ({@link recordedProjectRoot}), never "here". A row recorded under another
 *   absolute spelling of a directory (a trailing slash, a symlink, a case variant) is "elsewhere" to that directory's Home.
 *
 * The working directory itself stays as the person spelled it (`GlobalOptions.cwd`, made absolute): the filesystem floor keeps that
 * lexical spelling ([ADR-0105](../../../../docs/decisions/0105-filesystem-roots-are-invocation-grants-not-project-authority.md)), so only the
 * identity is canonical, never the path a tool is jailed to.
 */

/**
 * The project root a run started in `cwd` records: the canonical spelling of the directory (`fsPolicyCanonicalPath`, the pin
 * `fsPolicyWorkspace` returns). A directory that cannot be pinned (gone, not a directory, unreadable) gives the resolved absolute path:
 * never a relative spelling, and a tool of such a run refuses every access anyway (its policy cannot pin the workspace either).
 */
export function projectRootOf(cwd: string): string {
  try {
    return fsPolicyCanonicalPath(cwd);
  } catch {
    return resolve(cwd);
  }
}

/**
 * A stored `project_root` when it names a directory: a non-empty absolute path. Anything else (`.`, `work`, `''`, `null`, absent) is
 * `undefined`: unrecorded, which is never "here".
 */
export function recordedProjectRoot(stored: string | null | undefined): string | undefined {
  // `isAbsolute('')` is false: the empty text is unrecorded with the relative spellings.
  return typeof stored === 'string' && isAbsolute(stored) ? stored : undefined;
}

/**
 * Whether a run whose stored root is `stored` was started in `here` (the reader's directory, canonical): an absolute stored root, and
 * `here` the same text (so absolute too). A relative or empty value on EITHER side is never a match, so a Home handed a relative directory
 * lists nothing as its own, not even the runs recorded with that very text.
 */
export function isProjectRootHere(
  stored: string | null | undefined,
  here: string | undefined,
): boolean {
  const recorded = recordedProjectRoot(stored);
  return recorded !== undefined && recorded === here;
}
