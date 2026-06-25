import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reconstructCheckpointState } from '@relavium/core';
import { createClient, createRunHistoryStore, type RunHistoryStore } from '@relavium/db';
import type { RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCommand } from '../commands/run.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { openHistoryStore } from './open.js';

/**
 * 2.H end-to-end: a real `relavium run` (the production engine + SQLite `RunStore`) persists to a
 * `history.db` under a TEMP home, so the test never touches the user's `~/.relavium/`. The injected
 * `openRunStore` redirects the store's home to the temp dir (it ignores the runCommand-derived homeDir),
 * which is the seam tests use to avoid the real home. Asserts the durable rows, the ADR-0050 `0600`/`0700`
 * at-rest permissions, and that the persisted events reconstruct a checkpoint in a fresh connection
 * (the cross-process resume substrate 2.G consumes).
 */

const FIXTURES = fileURLToPath(new URL('../harness/fixtures/', import.meta.url));

function globalOptions(): GlobalOptions {
  return { json: true, color: false, cwd: FIXTURES, configPath: undefined, verbosity: 'normal' };
}

/** Re-open the temp history.db read-only-ish for assertions (a fresh connection — the run's was closed). */
function reopen(home: string): { store: RunHistoryStore; close: () => void } {
  const client = createClient(join(home, '.relavium', 'history.db'));
  const store = createRunHistoryStore(client.db, {
    uuid: () => randomUUID(),
    now: () => Date.now(),
    workflow: { slug: 'reader', name: 'reader', definitionJson: '{}' },
  });
  return { store, close: () => client.sqlite.close() };
}

describe('2.H durable run history — real run → history.db (temp home)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'relavium-2h-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('persists a completed run (migrate-on-first-use) with owner-only perms', async () => {
    const { io } = captureIo();
    const code = await runCommand(
      { workflow: join(FIXTURES, 'sequential.relavium.yaml'), input: ['n=3'] },
      {
        io,
        global: globalOptions(),
        openRunStore: (wf, _homeDir, projectRoot) => openHistoryStore(wf, home, projectRoot),
      },
    );
    expect(code).toBe(EXIT_CODES.success);

    const dbPath = join(home, '.relavium', 'history.db');
    expect(existsSync(dbPath)).toBe(true);
    if (process.platform !== 'win32') {
      // ADR-0050: history.db is unencrypted, guarded by 0600 (file) / 0700 (dir) OS permissions.
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, '.relavium')).mode & 0o777).toBe(0o700);
    }

    const { store, close } = reopen(home);
    try {
      const runs = store.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('completed');
      const events = store.loadRunEvents(runs[0]?.id ?? '');
      expect(events[0]?.type).toBe('run:started');
      expect(events.at(-1)?.type).toBe('run:completed');
      expect(events.map((e) => e.sequenceNumber)).toEqual(events.map((_, i) => i)); // gap-free
    } finally {
      close();
    }
  });

  it('persists a gate-paused run sufficient to reconstruct a checkpoint in a fresh connection (2.G substrate)', async () => {
    const { io } = captureIo();
    const code = await runCommand(
      { workflow: join(FIXTURES, 'human-gate.relavium.yaml'), input: [] },
      {
        io,
        global: globalOptions(),
        openRunStore: (wf, _homeDir, projectRoot) => openHistoryStore(wf, home, projectRoot),
      },
    );
    expect(code).toBe(EXIT_CODES.gatePaused);

    const { store, close } = reopen(home);
    try {
      const run = store.listRuns()[0];
      expect(run?.status).toBe('paused');
      const interrupted = await store.listInterruptedRuns();
      expect(interrupted.find((r) => r.runId === run?.id)?.resumable).toBe(true);

      const events: RunEvent[] = store.loadRunEvents(run?.id ?? '');
      expect(events.some((e) => e.type === 'human_gate:paused')).toBe(true);
      // The durable log is sufficient for a fresh process to rebuild run state (the 2.G resume path).
      expect(() => reconstructCheckpointState(events)).not.toThrow();
      expect(reconstructCheckpointState(events)).toBeDefined();
    } finally {
      close();
    }
  });
});
