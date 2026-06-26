import { createSessionStore, type Db, type SessionStore } from '@relavium/db';

import { openLocalDb } from '../db/open.js';

/** An opened session store plus the handle to close its SQLite connection at REPL end. */
export interface OpenedSessionStore {
  readonly store: SessionStore;
  /** The `~/.relavium/history.db` connection the store runs on (ADR-0050) — closed once by {@link close}. */
  readonly db: Db;
  readonly close: () => void;
}

/**
 * Open the durable **session** store for one `relavium chat` REPL (2.M) over `~/.relavium/history.db` —
 * the session counterpart of {@link openHistoryStore} (2.H run history), sharing the **same** db file and
 * the unencrypted-at-rest, `0600`/`0700`-guarded posture ([ADR-0050](../../../../docs/decisions/0050-cli-history-db-at-rest-posture.md);
 * there is no separate `sessions.db`, per [config-spec.md](../../../../docs/reference/contracts/config-spec.md) `[chat]`).
 * Production (`commands/chat.ts`) wires this; the unit tests drive a `createSessionStore` over an in-memory
 * db directly, so they never touch the user's home.
 */
export function openSessionStore(homeDir: string): OpenedSessionStore {
  const { db, close } = openLocalDb(homeDir);
  return { store: createSessionStore(db), db, close };
}
