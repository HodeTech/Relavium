import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkflowDefinition } from '@relavium/core';
import {
  createClient,
  createProviderStore,
  createRunHistoryStore,
  createSessionStore,
  runMigrations,
} from '@relavium/db';
import { RunEventSchema, type AgentSessionRecord, type SessionMessage } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { runCommand } from '../commands/run.js';
import type { OpenedHistory } from '../history/open.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';

/**
 * 2.5.I S3 — concurrency e2e: a `relavium chat` and a `relavium run` share one `history.db`
 * ([ADR-0064](../../../../docs/decisions/0064-live-model-catalog.md) §5). Two scenarios, per the close-plan D3:
 *
 * 1. **Two-connection coexistence** (in-process): the REAL `runCommand` (its own connection) writes run
 *    events while a REAL `SessionStore` (a second connection — the chat process's handle) writes a transcript,
 *    interleaved. Proves the run and chat write paths coexist on one file with no interference and consistent
 *    reads. A single Node process (synchronous better-sqlite3) can't truly overlap two transactions, so this
 *    proves coexistence, not lock contention —
 * 2. **Two-process cross-process safety** (real child processes): the genuine two-OS-process WAL path a
 *    single synchronous process cannot reach (separate SQLite instances + real OS file locks). Two children
 *    race a burst of provider `upsert`s (the BEGIN IMMEDIATE + `withBusyRetry` write path) while the parent
 *    HOLDS the write lock and releases it only after a **READY handshake** — each child signals just before
 *    its first write — so a real cross-process busy-wait happens every run (deterministic, not overlap-luck).
 *    Both children must then land every write with no escaped `SQLITE_BUSY`. This is a cross-process
 *    *safety/coexistence* smoke — the
 *    precise clause-guards for the Step-4 fix are the DETERMINISTIC white-box tests in `@relavium/db`:
 *    `provider-store.test.ts` (spies `db.transaction(..., { behavior: 'immediate' })`) and `retry.test.ts`
 *    (a held-lock released mid-backoff exercising `withBusyRetry` + the fail-loud budget). It needs the built
 *    `@relavium/db` (the child can't use vitest's source resolution); it is visibly SKIPPED — never silently
 *    passed — if the dist is absent (a `pnpm turbo run build` produces it; CI builds upstream packages first).
 */

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
// The child receives the built db as a file:// URL (its `import()` needs a URL — a bare Windows path like
// `C:\…` is not a valid import specifier); the path form is only for the existence gate.
const DB_DIST_URL = new URL('../../../../packages/db/dist/index.js', import.meta.url);
const DB_DIST_PATH = fileURLToPath(DB_DIST_URL);
const CHILD_SCRIPT = fileURLToPath(new URL('./fixtures/concurrent-writer.mjs', import.meta.url));
const ISO = '2026-07-07T00:00:00.000Z';

function globalOptions(): GlobalOptions {
  return {
    json: true,
    color: false,
    cwd: FIXTURES_DIR,
    configPath: undefined,
    verbosity: 'normal',
  };
}

const session = (id: string, totalOutputTokens = 0): AgentSessionRecord => ({
  id,
  agentSlug: 'chatter',
  context: { workingDir: '/workspace', fsScopeTier: 'sandboxed' },
  status: 'active',
  totalInputTokens: 0,
  totalOutputTokens,
  totalCostMicrocents: 0,
  createdAt: ISO,
  updatedAt: ISO,
});

const message = (sessionId: string, seq: number): SessionMessage => ({
  id: `${sessionId}-m${seq}`,
  sessionId,
  sequenceNumber: seq,
  role: seq % 2 === 0 ? 'user' : 'assistant',
  content: [{ type: 'text', text: `turn ${seq}` }],
  timestamp: ISO,
});

interface SpawnedChild {
  /** Resolves when the child prints `READY` (about to write) OR exits — so the parent never hangs on a dead child. */
  readonly ready: Promise<void>;
  /** Resolves with the child's exit code + captured stderr once it closes. */
  readonly done: Promise<{ code: number; stderr: string }>;
}

/** Spawn a child; expose a `ready` handshake (printed just before its first write) + its final exit/stderr. */
function runChild(args: readonly string[]): SpawnedChild {
  const child = spawn(process.execPath, [CHILD_SCRIPT, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let signalReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (stdout.includes('READY')) signalReady();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const done = new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      signalReady(); // a child that died before printing READY must not hang the parent's ready-wait
      resolve({ code: code ?? -1, stderr });
    });
  });
  return { ready, done };
}

describe('concurrency e2e (2.5.I S3) — a run and a chat share one history.db', () => {
  it('coexistence: a real run and a real chat session write the same file concurrently — both land', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relavium-concurrency-'));
    const dbPath = join(dir, 'history.db');
    const runClient = createClient(dbPath);
    runMigrations(runClient.db);
    const chatClient = createClient(dbPath); // a SEPARATE connection — the chat process's handle
    const TURNS = 12;
    try {
      const sessions = createSessionStore(chatClient.db);
      const sessionId = 'sess-coexist';
      sessions.createSession(session(sessionId));

      // The chat side: append a transcript, yielding between turns so the run interleaves at await points.
      const chatWrites = (async () => {
        for (let seq = 0; seq < TURNS; seq += 1) {
          sessions.appendMessage(message(sessionId, seq));
          sessions.updateSession(session(sessionId, seq + 1));
          await Promise.resolve();
        }
      })();

      // The run side: the REAL `runCommand` persisting to its OWN connection on the same file.
      const openRunStore = (workflow: WorkflowDefinition): OpenedHistory => ({
        store: createRunHistoryStore(runClient.db, {
          uuid: () => randomUUID(),
          now: () => Date.now(),
          workflow: {
            slug: workflow.workflow.id,
            name: workflow.workflow.name ?? workflow.workflow.id,
            definitionJson: JSON.stringify(workflow),
          },
        }),
        db: runClient.db,
        close: () => {},
      });
      const runIo = captureIo();
      const runPromise = runCommand(
        { workflow: join(FIXTURES_DIR, 'sequential.relavium.yaml'), input: [] },
        { io: runIo.io, global: globalOptions(), openRunStore },
      );

      const [runCode] = await Promise.all([runPromise, chatWrites]);

      // The run completed cleanly and its events persisted (stdout-pure --json contract).
      expect(runCode).toBe(0);
      expect(runIo.err()).toBe('');
      const runEvents = runIo
        .out()
        .trimEnd()
        .split('\n')
        .map((line) => RunEventSchema.parse(JSON.parse(line)));
      expect(runEvents[0]?.type).toBe('run:started');
      expect(runEvents.at(-1)?.type).toBe('run:completed');

      // The chat transcript persisted intact + the loadFull snapshot is consistent with the session totals.
      const full = sessions.loadFull(sessionId);
      expect(full?.messages.map((m) => m.sequenceNumber)).toEqual(
        Array.from({ length: TURNS }, (_, i) => i),
      );
      expect(full?.session.totalOutputTokens).toBe(TURNS);
    } finally {
      try {
        runClient.sqlite.close();
      } finally {
        try {
          chatClient.sqlite.close();
        } finally {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
    }
  });

  it.skipIf(!existsSync(DB_DIST_PATH))(
    'cross-process safety: two child processes contend on one file (parent holds the lock) — all writes land',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'relavium-concurrency-2p-'));
      const dbPath = join(dir, 'history.db');
      // The parent migrates ONCE so the children never race the migrator — they only write.
      const setup = createClient(dbPath);
      runMigrations(setup.db);
      setup.sqlite.close();
      const PER_CHILD = 40;
      // A third connection that HOLDS the single WAL write lock while the children start, so their first
      // upsert genuinely busy-waits cross-process. `inTransaction` is the truth of whether the lock is held —
      // it double-guards release and never COMMITs when no transaction is open.
      const holder = createClient(dbPath);
      const releaseLock = (): void => {
        if (holder.sqlite.inTransaction) holder.sqlite.exec('COMMIT');
      };
      try {
        holder.sqlite.exec('BEGIN IMMEDIATE'); // acquire the write lock; the children block on it
        const childA = runChild([DB_DIST_URL.href, dbPath, 'a', String(PER_CHILD)]);
        const childB = runChild([DB_DIST_URL.href, dbPath, 'b', String(PER_CHILD)]);

        // Deterministic handshake: both children print READY the instant before their first write, so once
        // both signal they are (about to be) busy-waiting on the held lock. A small margin then covers the
        // microgap between the signal and the child's BEGIN IMMEDIATE, so releasing here guarantees a real
        // cross-process busy-wait every run — independent of Node/import startup speed (which can exceed a
        // fixed timer). The `close`-resolves-`ready` fallback means a dead child can never hang this wait.
        await Promise.all([childA.ready, childB.ready]);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
        releaseLock();
        const [a, b] = await Promise.all([childA.done, childB.done]);

        // Both children exited cleanly. A real failure prints the error to stderr + exits 1; a benign Node
        // warning line (deprecation, experimental flag) is tolerated — assert the exit code and the ABSENCE
        // of a SQLite/Error line, not exact-empty stderr (which a CI runner's warnings could break).
        expect(a.code).toBe(0);
        expect(a.stderr).not.toMatch(/SQLITE|Error/i);
        expect(b.code).toBe(0);
        expect(b.stderr).not.toMatch(/SQLITE|Error/i);

        // Every write of BOTH children landed: 2 × PER_CHILD distinct providers, none lost or corrupted.
        const verify = createClient(dbPath);
        try {
          const providers = createProviderStore(verify.db, {
            uuid: () => randomUUID(),
            now: () => 0,
          });
          const names = providers.list().map((p) => p.name);
          expect(names).toHaveLength(2 * PER_CHILD);
          for (let i = 0; i < PER_CHILD; i += 1) {
            expect(names).toContain(`a-${i}`);
            expect(names).toContain(`b-${i}`);
          }
        } finally {
          verify.sqlite.close();
        }
      } finally {
        // Nested so a failure in one cleanup step never skips the rest (release → close → remove temp dir).
        try {
          releaseLock();
        } finally {
          try {
            holder.sqlite.close();
          } finally {
            rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          }
        }
      }
    },
  );
});
