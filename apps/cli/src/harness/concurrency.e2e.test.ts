import { spawn } from 'node:child_process';
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
import { randomUUID } from 'node:crypto';
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
 * 2. **Two-process contention** (real child processes): the genuine cross-process WAL path. Two child
 *    processes race a burst of provider `upsert`s (the BEGIN IMMEDIATE + `withBusyRetry` write path) against
 *    the same file; both must land every write with no escaped `SQLITE_BUSY`. This is the only form that
 *    reproduces the real write-lock contention ADR-0064 §5 names. It needs the built `@relavium/db` (the child
 *    can't use vitest's source resolution); it is visibly SKIPPED — never silently passed — if the dist is
 *    absent (a `pnpm turbo run build` produces it; CI builds upstream packages before this test).
 */

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const DB_DIST = fileURLToPath(new URL('../../../../packages/db/dist/index.js', import.meta.url));
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

/** Spawn a child process; resolve with its exit code + captured stderr (empty on a clean run). */
function runChild(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD_SCRIPT, ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
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
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  it.skipIf(!existsSync(DB_DIST))(
    'contention: two child processes race provider upserts on one file — all writes land, no SQLITE_BUSY escapes',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'relavium-concurrency-2p-'));
      const dbPath = join(dir, 'history.db');
      // The parent migrates ONCE so the children never race the migrator — they only write.
      const setup = createClient(dbPath);
      runMigrations(setup.db);
      setup.sqlite.close();
      const PER_CHILD = 40;
      try {
        const [a, b] = await Promise.all([
          runChild([DB_DIST, dbPath, 'a', String(PER_CHILD)]),
          runChild([DB_DIST, dbPath, 'b', String(PER_CHILD)]),
        ]);
        // Both children exited cleanly (no escaped SQLITE_BUSY / no thrown write) — a failure prints to stderr.
        expect(a.stderr).toBe('');
        expect(a.code).toBe(0);
        expect(b.stderr).toBe('');
        expect(b.code).toBe(0);

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
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
