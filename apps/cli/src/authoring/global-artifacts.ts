import { opendirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { globalConfigDir } from '../config/paths.js';

export const GLOBAL_ARTIFACTS_REMEDY =
  'Workflows or agents in ~/.relavium/workflows or ~/.relavium/agents are not project artifacts. Leave the originals in place until reviewed; move them into a project or run `relavium import <path>` from that project directory.';
const MAX_NOTICE_ENTRIES = 256;

/** Local read-only notice; never parse, move, repair or print arbitrary global artifact names. */
export function globalArtifactsNotice(home: string = homedir()): string | undefined {
  for (const kind of ['workflows', 'agents']) {
    try {
      const directory = opendirSync(join(globalConfigDir(home), kind));
      try {
        for (let count = 0; count < MAX_NOTICE_ENTRIES; count++) {
          const entry = directory.readSync();
          if (entry === null) break;
          if ((entry.isFile() || entry.isSymbolicLink()) && /\.ya?ml$/iu.test(entry.name))
            return GLOBAL_ARTIFACTS_REMEDY;
        }
        // Do not turn a health notice into an unbounded scan of a large folder.
        // An incomplete observation is disclosed instead of claiming no artifacts.
        if (directory.readSync() !== null)
          return 'Global artifact inspection was incomplete. ~/.relavium/workflows and ~/.relavium/agents are not project catalogs; review those folders before moving files or running `relavium import <path>` from a project directory.';
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
