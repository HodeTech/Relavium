import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createClient, runMigrations } from './client.js';
import { createRunHistoryStore } from './run-history-store.js';

/**
 * ADR-0079 — cross-process run ownership, proven across REAL processes.
 *
 * The ADR's own Consequences say this cannot be shown in one Node process: `better-sqlite3` is synchronous, so
 * two in-process owners are serialized by construction and the state that matters — one process still
 * BELIEVING it owns a run another has taken over — never arises. That belief is the entire reason ADR-0079
 * chose a fencing token over a bare compare-and-swap, so a test that cannot produce it cannot test the
 * decision.
 *
 * Two properties, one per test, and they are different claims:
 *
 * 1. **Mutual exclusion** — a second process cannot acquire a live lease. This is what a CAS would also give.
 * 2. **The fence** — a process that HELD the lease and lost it cannot still write. This is what a CAS would
 *    NOT give, and it is the property that makes a stale owner harmless rather than merely slow.
 *
 * Deterministic by handshake, not by racing spawns: each child reports when it has acquired and then blocks
 * until the parent tells it to write, so the parent controls the interleaving exactly. That is deliberately
 * unlike `migrate-lock.e2e.test.ts`, which documents its own racing-spawn flakiness as the reason its
 * clause-guards are unit tests — here the barrier buys the determinism, so these ARE the clause-guards.
 *
 * Needs the BUILT `@relavium/db` (a child cannot use vitest's source resolution) and is visibly SKIPPED —
 * never silently passed — when the dist is absent, mirroring the migrate-lock precedent.
 */

const DB_DIST_URL = new URL('../dist/index.js', import.meta.url);
const DB_DIST_PATH = fileURLToPath(DB_DIST_URL);
const CHILD_SCRIPT = fileURLToPath(new URL('./fixtures/lease-holder.mjs', import.meta.url));

/** A spawned lease holder, driven line-by-line over its stdio. */
interface Holder {
  /** The next protocol line the child emits. Rejects if the child dies first. */
  readonly next: () => Promise<string>;
  /** Release the write barrier. */
  readonly write: () => void;
  readonly done: Promise<number | null>;
}

function spawnHolder(args: {
  dbPath: string;
  runId: string;
  ownerId: string;
  ttlMs: number;
  seq: number;
}): Holder {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [
      CHILD_SCRIPT,
      DB_DIST_URL.href,
      args.dbPath,
      args.runId,
      args.ownerId,
      String(args.ttlMs),
      String(args.seq),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  // Buffer whole lines: `data` chunks are not line-aligned, and a test that assumed they were would pass or
  // fail on how the OS happened to split the pipe.
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let buffered = '';
  let stderr = '';
  let exited: { code: number | null } | undefined;
  const failWaiters: Array<(reason: Error) => void> = [];
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let index = buffered.indexOf('\n');
    while (index !== -1) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter === undefined) lines.push(line);
      else waiter(line);
      index = buffered.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const done = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      exited = { code };
      // A child that died before answering must fail the waiter, not hang the test until vitest's timeout —
      // the stderr is the diagnosis and a timeout would throw it away.
      for (const fail of failWaiters.splice(0)) {
        fail(new Error(`child exited (${String(code)}) before replying; stderr: ${stderr}`));
      }
      waiters.length = 0;
      resolve(code);
    });
  });
  return {
    next: () =>
      new Promise<string>((resolve, reject) => {
        const buffered_ = lines.shift();
        if (buffered_ !== undefined) {
          resolve(buffered_);
          return;
        }
        if (exited !== undefined) {
          reject(new Error(`child already exited (${String(exited.code)}); stderr: ${stderr}`));
          return;
        }
        waiters.push(resolve);
        failWaiters.push(reject);
      }),
    write: () => child.stdin.write('write\n'),
    done,
  };
}

/** A migrated `history.db` holding one run that has started and not finished. */
async function seedRun(dbPath: string, runId: string): Promise<void> {
  const client = createClient(dbPath);
  try {
    runMigrations(client.db, { dbPath: client.path });
    const store = createRunHistoryStore(client.db, {
      // A REAL uuid: this dep mints the surrogate `workflows.id`, which the run-event schema validates.
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: { slug: 'lease-e2e', name: 'lease-e2e', definitionJson: '{}' },
    });
    // Through the store's own upsert, not a fabricated id: `runs.workflow_id → workflows.id`, so a made-up
    // UUID fails the foreign key. The run row must in turn exist before any lease can reference it
    // (`run_leases.run_id → runs.id`) — which is the whole reason this seed runs before the children.
    const workflowId = await store.resolveWorkflowId('lease-e2e');
    await store.persistEvent({
      type: 'run:started',
      runId,
      sequenceNumber: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      workflowId,
      inputs: {},
      executionMode: 'local',
    });
  } finally {
    client.sqlite.close();
  }
}

describe('ADR-0079 — two processes, one run', () => {
  it.skipIf(!existsSync(DB_DIST_PATH))(
    'a second process cannot acquire a LIVE lease, and the holder still writes',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'relavium-lease-excl-'));
      const dbPath = join(dir, 'history.db');
      const runId = 'run-exclusive';
      try {
        await seedRun(dbPath, runId);
        const owner = spawnHolder({ dbPath, runId, ownerId: 'owner-a', ttlMs: 60_000, seq: 1 });
        expect(await owner.next()).toBe('ACQUIRED 1');

        // A second process, while the first is alive and holding. This is the moment two `relavium` processes
        // would otherwise both start dispatching nodes for one run.
        const intruder = spawnHolder({ dbPath, runId, ownerId: 'owner-b', ttlMs: 60_000, seq: 2 });
        expect(await intruder.next()).toBe('REFUSED');
        expect(await intruder.done).toBe(0);

        // …and the rightful owner is unaffected: it still owns the run and its guarded write lands.
        owner.write();
        expect(await owner.next()).toBe('WROTE');
        expect(await owner.done).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
    30_000,
  );

  it(
    'a FENCED-OUT process cannot write, even though it still believes it owns the run',
    { timeout: 30_000, skip: !existsSync(DB_DIST_PATH) },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'relavium-lease-fence-'));
      const dbPath = join(dir, 'history.db');
      const runId = 'run-fenced';
      try {
        await seedRun(dbPath, runId);
        // A 1ms TTL so the lease is expired the instant the takeover asks — no sleep, no timing assumption.
        const stale = spawnHolder({ dbPath, runId, ownerId: 'owner-a', ttlMs: 1, seq: 1 });
        expect(await stale.next()).toBe('ACQUIRED 1');

        // A second process takes the EXPIRED lease over. The generation moves forward; nothing tells the
        // first process, which is exactly the situation a bare CAS on `last_seq` would leave undefended.
        const taker = spawnHolder({ dbPath, runId, ownerId: 'owner-b', ttlMs: 60_000, seq: 2 });
        expect(await taker.next()).toBe('ACQUIRED 2');

        // Now the stale owner writes, still holding generation 1 and still believing it owns the run. THIS is
        // the property under test: it is refused for the right reason, so it can never become a second
        // side-effect producer that also appends to the log.
        stale.write();
        expect(await stale.next()).toBe('FENCED');
        expect(await stale.done).toBe(0);

        // The new owner writes normally — the fence stopped the loser, not the run.
        taker.write();
        expect(await taker.next()).toBe('WROTE');
        expect(await taker.done).toBe(0);

        // And the durable log carries exactly the winner's event: one `node:started`, from owner-b.
        const client = createClient(dbPath);
        try {
          const store = createRunHistoryStore(client.db, {
            uuid: () => randomUUID(),
            now: () => Date.now(),
            workflow: { slug: 'lease-e2e', name: 'lease-e2e', definitionJson: '{}' },
          });
          const started = store
            .loadRunEvents(runId)
            .filter((event) => event.type === 'node:started');
          expect(started).toHaveLength(1);
          expect(started[0]?.type === 'node:started' && started[0].nodeId).toBe('n-owner-b');
        } finally {
          client.sqlite.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  );
});
