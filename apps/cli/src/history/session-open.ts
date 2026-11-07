import type { LocalDbNoticeContext } from '../db/checkpoint-notice.js';
import { createSessionStore, type Db, type SessionStore } from '@relavium/db';

import { openLocalDb } from '../db/open.js';
import { storageBoundaryError } from '../process/owned-storage.js';
import { terminalOutboxPath } from './open.js';
import { reconcileInterruptedRuns } from './reconcile.js';

/** An opened session store plus the handle to close its SQLite connection at REPL end. */
export interface OpenedSessionStore {
  readonly store: SessionStore;
  /** The `~/.relavium/history.db` connection the store runs on (ADR-0050) — closed once by {@link close}. */
  readonly db: Db;
  /**
   * Settle the runs a dead process left behind in THIS home (2.6.G liveness): {@link db} with the terminal
   * outbox beside it (ADR-0078 §4), paired here because the drain prunes an outbox entry whose run is not
   * open in the database it reads. Set by {@link openSessionStore}; the Home awaits it before its first read
   * of the runs. A test that injects an in-memory store leaves it unset, so it never reaches the real home's
   * outbox.
   */
  readonly reconcileInterruptedRuns?: () => Promise<void>;
  readonly close: () => void;
}

/**
 * Open the durable **session** store for one `relavium chat` REPL (2.M) over `~/.relavium/history.db` —
 * the session counterpart of {@link openHistoryStore} (2.H run history), sharing the **same** db file and
 * the unencrypted-at-rest, `0600`/`0700`-guarded posture ([ADR-0050](../../../../docs/decisions/0050-cli-history-db-at-rest-posture.md);
 * there is no separate `sessions.db`, per [config-spec.md](../../../../docs/reference/contracts/config-spec.md) `[chat]`).
 * Production (`commands/chat.ts`, `chat-list`, …) wires this; the unit tests drive a `createSessionStore`
 * over an in-memory db directly, so they never touch the user's home.
 *
 * Owned storage-open faults are operational 1. Unknown native/import/wiring faults are
 * infrastructure 9; neither can be diagnosed from arbitrary messages or cause trees.
 */
export function openSessionStore(
  homeDir: string,
  captureClose?: (close: () => void) => void,
  noticeContext?: LocalDbNoticeContext,
): OpenedSessionStore {
  let opened: { db: Db; close: () => void };
  try {
    opened = openLocalDb(homeDir, undefined, captureClose, noticeContext);
  } catch (err) {
    throw storageBoundaryError(err);
  }
  return {
    store: createSessionStore(opened.db),
    db: opened.db,
    reconcileInterruptedRuns: () =>
      reconcileInterruptedRuns(opened.db, terminalOutboxPath(homeDir)),
    close: opened.close,
  };
}
