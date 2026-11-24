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

/** Local read-only notice; never parse, move, repair or print arbitrary global artifact names. */
export function globalArtifactsNotice(
  home: string = homedir(),
  surface: NoticeSurface = 'shell', // the shell's `relavium list`, or the TUI's `/doctor`
): string | undefined {
  for (const kind of ['workflows', 'agents']) {
    try {
      const directory = opendirSync(join(globalConfigDir(home), kind));
      try {
        for (let count = 0; count < MAX_NOTICE_ENTRIES; count++) {
          const entry = directory.readSync();
          if (entry === null) break;
          if ((entry.isFile() || entry.isSymbolicLink()) && /\.ya?ml$/iu.test(entry.name))
            return surface === 'tui' ? GLOBAL_ARTIFACTS_REMEDY_TUI : GLOBAL_ARTIFACTS_REMEDY;
        }
        // Do not turn a health notice into an unbounded scan of a large folder.
        // An incomplete observation is disclosed instead of claiming no artifacts.
        if (directory.readSync() !== null)
          return surface === 'tui'
            ? 'Global artifact inspection was incomplete. ~/.relavium/workflows and ~/.relavium/agents are not project catalogs; review those folders before moving files or using /import from the Home in a project directory.'
            : 'Global artifact inspection was incomplete. ~/.relavium/workflows and ~/.relavium/agents are not project catalogs; review those folders before moving files or running `relavium import <path>` from a project directory.';
      } finally {
        directory.closeSync();
      }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      )
        continue;
      return 'Global artifact folders could not be inspected. ~/.relavium/workflows and ~/.relavium/agents are not project catalogs; check directory access before moving or importing files into a project.';
    }
  }
  return undefined;
}
