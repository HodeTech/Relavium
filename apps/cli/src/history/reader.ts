import { createRunHistoryReader, type Db, type RunHistoryReader } from '@relavium/db';

import { openLocalDb } from '../db/open.js';
import { CliError } from '../process/errors.js';

/** An opened workflow-agnostic read seam plus the handle to close its SQLite connection. */
export interface OpenedReader {
  readonly reader: RunHistoryReader;
  readonly close: () => void;
}

/**
 * Open `~/.relavium/history.db` and wrap it in the workflow-agnostic {@link RunHistoryReader} the read commands
 * (`list`/`logs`/`status`/`gate list`, 2.I) consume — distinct from the workflow-scoped `openHistoryStore` the
 * `run`/`gate` write paths use. A pre-run db-open fault (cannot create / open / migrate the file) is an
 * INVOCATION fault (exit 2), surfaced before any read. Tests inject `openDb` to pass an in-memory db.
 */
export function openHistoryReader(
  homeDir: string,
  openDb: (homeDir: string) => { db: Db; close: () => void } = openLocalDb,
): OpenedReader {
  let opened: { db: Db; close: () => void };
  try {
    opened = openDb(homeDir);
  } catch (err) {
    throw new CliError(
      'invalid_invocation',
      `could not open the run history database: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return { reader: createRunHistoryReader(opened.db), close: opened.close };
}
