import { createSessionStore, type Db, type SessionStore } from '@relavium/db';

import { openLocalDb } from '../db/open.js';
import { CliError } from '../process/errors.js';

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
 * Production (`commands/chat.ts`, `chat-list`, …) wires this; the unit tests drive a `createSessionStore`
 * over an in-memory db directly, so they never touch the user's home.
 *
 * A db-open fault (cannot create / open / migrate the file) is an INVOCATION fault (exit 2), surfaced before
 * any session work — mirroring {@link openHistoryReader} so every session command (`chat`, `chat-list`, and
 * the upcoming resume/export) reports an unreadable `history.db` as a clean exit 2, not an opaque exit 1.
 */
export function openSessionStore(homeDir: string): OpenedSessionStore {
  let opened: { db: Db; close: () => void };
  try {
    opened = openLocalDb(homeDir);
  } catch (err) {
    throw new CliError(
      'invalid_invocation',
      `could not open the session history database: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return { store: createSessionStore(opened.db), db: opened.db, close: opened.close };
}
