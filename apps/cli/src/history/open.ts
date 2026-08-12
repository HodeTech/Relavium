import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { WorkflowDefinition } from '@relavium/core';
import { createRunHistoryStore, type Db, type RunHistoryStore } from '@relavium/db';

import { openLocalDb } from '../db/open.js';

/** An opened history store plus the handle to close its SQLite connection at run end. */
export interface OpenedHistory {
  readonly store: RunHistoryStore;
  /**
   * The same `~/.relavium/history.db` connection the store runs on (2.S reuses it for the `model_catalog`
   * reader + the `media_references` retention junction, ADR-0050) — so the catalog/media ports share one
   * connection with run history, closed once by {@link close}.
   */
  readonly db: Db;
  /**
   * Where a terminal the store refused is held (ADR-0078 §4) — `~/.relavium/terminal-outbox.ndjson`, beside
   * `history.db` and deliberately NOT inside it. The store that must hold a refused terminal is the store
   * that just refused it, so the outbox has to be a different file to survive the fault class it exists for.
   */
  readonly terminalOutboxPath: string;
  readonly close: () => void;
}

/**
 * Open the durable run-history store for one CLI run (workstream **2.H**) over `~/.relavium/history.db`
 * (see {@link openLocalDb} for the open/migrate/`0600` posture, ADR-0050). The store records THIS workflow:
 * its frozen snapshot feeds `runs.workflow_definition_snapshot` (the engine's events don't carry the graph).
 * Production (`commands/specs.ts`) wires this; the unit tests and the 2.K harness omit it and keep the
 * in-memory store, so they never touch the user's home. `projectRoot` (the run's cwd) is persisted to
 * `runs.project_root` so a cross-process `relavium gate` resume re-jails `save_to` under the original run's
 * root, not the resumer's cwd.
 */
export function openHistoryStore(
  workflow: WorkflowDefinition,
  homeDir: string,
  projectRoot: string,
): OpenedHistory {
  const { db, close } = openLocalDb(homeDir);
  const store = createRunHistoryStore(db, {
    uuid: () => randomUUID(),
    now: () => Date.now(),
    projectRoot,
    workflow: {
      slug: workflow.workflow.id,
      name: workflow.workflow.name ?? workflow.workflow.id, // `name` is optional in the schema; fall back to the slug
      definitionJson: JSON.stringify(workflow),
    },
  });
  return {
    store,
    db,
    terminalOutboxPath: join(homeDir, '.relavium', 'terminal-outbox.ndjson'),
    close,
  };
}
