import { createRunHistoryReader, type Db, type RunHistoryReader } from '@relavium/db';

import { openLocalDb } from '../db/open.js';
import { storageBoundaryError } from '../process/owned-storage.js';

/** An opened workflow-agnostic read seam plus the handle to close its SQLite connection. */
export interface OpenedReader {
  readonly reader: RunHistoryReader;
  readonly close: () => void;
}

/**
 * Open `~/.relavium/history.db` and wrap it in the workflow-agnostic {@link RunHistoryReader} the read commands
 * (`list`/`logs`/`status`/`gate list`, 2.I) consume — distinct from the workflow-scoped `openHistoryStore` the
 * `run`/`gate` write paths use. An owned storage-open fault is operational 1; an unexpected open failure is infrastructure 9.
 * Tests inject `openDb` to pass an in-memory db, without granting arbitrary errors storage origin.
 */
export function openHistoryReader(
  homeDir: string,
  openDb: (homeDir: string) => { db: Db; close: () => void } = openLocalDb,
): OpenedReader {
  let opened: { db: Db; close: () => void };
  try {
    opened = openDb(homeDir);
  } catch (err) {
    throw storageBoundaryError(err);
  }
  return { reader: createRunHistoryReader(opened.db), close: opened.close };
}
