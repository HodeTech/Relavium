import { opendirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { globalConfigDir } from '../config/paths.js';
import type { NoticeSurface } from '../render/notice-surface.js';

export const GLOBAL_ARTIFACTS_REMEDY =
  'Workflows or agents in ~/.relavium/workflows or ~/.relavium/agents are not project artifacts. Leave the originals in place until reviewed; move them into a project or run `relavium import <path>` from that project directory.';
/** The same notice for `/doctor`: the Home's `/import` is the action there, never a shell command (ADR-0146 §6, MVP-11 OD-20). */
export const GLOBAL_ARTIFACTS_REMEDY_TUI =
  'Workflows or agents in ~/.relavium/workflows or ~/.relavium/agents are not project artifacts. Leave the originals in place until reviewed; move them into a project, or open the Home in that project and use /import.';
const MAX_NOTICE_ENTRIES = 256;
/** What the notice says when the folder holds more than it looks at: an observation that is incomplete is disclosed, never read as 'none'. */
const GLOBAL_ARTIFACTS_INCOMPLETE: Readonly<Record<NoticeSurface, string>> = {
  tui: 'Global artifact inspection was incomplete. ~/.relavium/workflows and ~/.relavium/agents are not project catalogs; review those folders before moving files or using /import from the Home in a project directory.',
  shell:
    'Global artifact inspection was incomplete. ~/.relavium/workflows and ~/.relavium/agents are not project catalogs; review those folders before moving files or running `relavium import <path>` from a project directory.',
};
/** The remedy for a workflow or agent file in the global folders, by the surface that reads it. */
const GLOBAL_ARTIFACTS_REMEDIES: Readonly<Record<NoticeSurface, string>> = {
  tui: GLOBAL_ARTIFACTS_REMEDY_TUI,
  shell: GLOBAL_ARTIFACTS_REMEDY,
};
const GLOBAL_ARTIFACTS_UNREADABLE =
  'Global artifact folders could not be inspected. ~/.relavium/workflows and ~/.relavium/agents are not project catalogs; check directory access before moving or importing files into a project.';

/** Whether a directory entry is a workflow or agent file: a regular file or a link with a YAML name. */
function isArtifactFile(entry: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  name: string;
}): boolean {
  return (entry.isFile() || entry.isSymbolicLink()) && /\.ya?ml$/iu.test(entry.name);
}

/** Whether a failure to open a folder only means it is not there (nothing to say), and not that it could not be read. */
function isAbsentFolder(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/** What one folder says, or `undefined` when it holds no artifact and was read to its end. Throws when the folder cannot be opened. */
function noticeOfFolder(path: string, surface: NoticeSurface): string | undefined {
  const directory = opendirSync(path);
  try {
    for (let count = 0; count < MAX_NOTICE_ENTRIES; count++) {
      const entry = directory.readSync();
      if (entry === null) return undefined;
      if (isArtifactFile(entry)) return GLOBAL_ARTIFACTS_REMEDIES[surface];
    }
    // Do not turn a health notice into an unbounded scan of a large folder.
    // An incomplete observation is disclosed instead of claiming no artifacts.
    return directory.readSync() === null ? undefined : GLOBAL_ARTIFACTS_INCOMPLETE[surface];
  } finally {
    directory.closeSync();
  }
}

/** Local read-only notice; never parse, move, repair or print arbitrary global artifact names. */
export function globalArtifactsNotice(
  home: string = homedir(),
  surface: NoticeSurface = 'shell', // the shell's `relavium list`, or the TUI's `/doctor`
): string | undefined {
  for (const kind of ['workflows', 'agents']) {
    try {
      const notice = noticeOfFolder(join(globalConfigDir(home), kind), surface);
      if (notice !== undefined) return notice;
    } catch (error) {
      if (!isAbsentFolder(error)) return GLOBAL_ARTIFACTS_UNREADABLE;
    }
  }
  return undefined;
}
