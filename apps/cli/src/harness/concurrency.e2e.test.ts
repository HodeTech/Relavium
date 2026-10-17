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
  type DbClient,
} from '@relavium/db';
import { RunEventSchema, type AgentSessionRecord, type SessionMessage } from '@relavium/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { runCommand } from '../commands/run.js';
import { buildEngine } from '../engine/build-engine.js';
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
  totalConservativeMicrocents: 0,
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
    child.on('error', (err) => {
      signalReady(); // a spawn failure (ENOENT/EAGAIN) must ALSO release the ready-wait, else `await child.ready` hangs
      reject(err);
    });
    child.on('close', (code) => {
      signalReady(); // a child that died before printing READY must not hang the parent's ready-wait
      resolve({ code: code ?? -1, stderr });
    });
  });
  return { ready, done };
}

interface CoexistencePorts {
  readonly migrate?: typeof runMigrations;
  readonly build?: typeof buildEngine;
  readonly onClient?: (client: DbClient) => void;
  readonly onDirectory?: (directory: string) => void;
  readonly onResult?: (code: number, stdout: string, stderr: string) => void;
}

/** Keep the raw case, not Vitest's timeout wrapper, owed until its actual cleanup completes. */
let rawCase: Promise<void> | undefined;
afterEach(async () => {
  await rawCase?.catch(() => undefined); // The original test already observes its failure.
  rawCase = undefined;
});
function startCoexistenceCase(signal: AbortSignal, ports: CoexistencePorts = {}): Promise<void> {
  rawCase = Promise.resolve().then(() => coexistenceCase(signal, ports));
  return rawCase;
}

async function coexistenceCase(signal: AbortSignal, ports: CoexistencePorts): Promise<void> {
  signal.throwIfAborted();
  const dir = mkdtempSync(join(tmpdir(), 'relavium-concurrency-'));
  const dbPath = join(dir, 'history.db');
  const nativeCloses: Array<() => void> = [];
  const phases: Array<{ readonly phase: string; readonly milliseconds: number }> = [];
  const began = performance.now();
  const phase = (name: string): void => {
    if (phases.length < 24)
      phases.push({ phase: name, milliseconds: Math.round(performance.now() - began) });
  };
  let runWork: ReturnType<typeof runCommand> | undefined;
  let chatWork: Promise<void> | undefined;
  let cancelRun = (): void => {};
  let primary: { readonly cause: unknown } | undefined;
  const cleanupFailures: unknown[] = [];
  phase('case-enter');
  try {
    ports.onDirectory?.(dir);
    phase('run-open-enter');
    const runClient = createClient(dbPath, (close) => nativeCloses.push(close));
    ports.onClient?.(runClient);
    phase('run-open-done');
    phase('migrations-enter');
    (ports.migrate ?? runMigrations)(runClient.db);
    phase('migrations-done');
    signal.throwIfAborted();
    phase('chat-open-enter');
    const chatClient = createClient(dbPath, (close) => nativeCloses.push(close));
    ports.onClient?.(chatClient);
    phase('chat-open-done');
    const TURNS = 12;
    const sessions = createSessionStore(chatClient.db);
    const sessionId = 'sess-coexist';
    sessions.createSession(session(sessionId));

    // A separate connection writes the transcript, yielding between actual writes.
    chatWork = (async () => {
      for (let seq = 0; seq < TURNS; seq += 1) {
        signal.throwIfAborted();
        sessions.appendMessage(message(sessionId, seq));
        sessions.updateSession(session(sessionId, seq + 1));
        await Promise.resolve();
      }
      phase('chat-writes-done');
    })();
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
      terminalOutboxPath: join(dir, 'terminal-outbox.ndjson'),
      // This fixture closes the native connection only after both raw writers settle.
      close: () => {},
    });
    const runIo = captureIo();
    phase('run-command-enter');
    runWork = runCommand(
      { workflow: join(FIXTURES_DIR, 'sequential.relavium.yaml'), input: [], allowMcpStdio: [] },
      {
        io: runIo.io,
        global: globalOptions(),
        openRunStore,
        buildEngine: async (options) => {
          phase('build-enter');
          const engine = await (ports.build ?? buildEngine)(options);
          phase('build-done');
          return engine;
        },
        subscribeSignals: (onSignal) => {
          let requested = false;
          const stop = (): void => {
            if (requested) return;
            requested = true;
            phase('case-stop-request');
            onSignal(2); // The shipping WorkflowLifetime cooperative stop, not a forced close.
          };
          cancelRun = stop;
          signal.addEventListener('abort', stop, { once: true });
          if (signal.aborted) stop();
          return () => {
            signal.removeEventListener('abort', stop);
            cancelRun = () => {};
          };
        },
      },
    ).then((code) => {
      phase('run-command-done');
      ports.onResult?.(code, runIo.out(), runIo.err());
      return code;
    });
    const [runCode] = await Promise.all([runWork, chatWork]);
    phase('both-writers-done');
    signal.throwIfAborted();
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
    phase('assertions-done');
  } catch (cause) {
    primary = { cause };
  } finally {
    if (primary !== undefined || signal.aborted) {
      try {
        cancelRun();
      } catch (cause) {
        cleanupFailures.push(cause);
      }
    }
    // Promise.all's first rejection, context abort and the test timeout are not writer joins.
    const settled = await Promise.allSettled([runWork, chatWork]);
    for (const result of settled)
      if (result.status === 'rejected' && result.reason !== primary?.cause)
        cleanupFailures.push(result.reason);
    phase('raw-writers-joined');
    for (const close of nativeCloses) {
      phase('native-close-enter');
      try {
        close();
        phase('native-close-done');
      } catch (cause) {
        cleanupFailures.push(cause);
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      phase('directory-removed');
    } catch (cause) {
      cleanupFailures.push(cause);
    }
    if (primary !== undefined || cleanupFailures.length > 0 || signal.aborted)
      console.error(
        'CONCURRENCY_FIXTURE_PHASES ' +
          JSON.stringify({ phases, cleanupFailures: cleanupFailures.length }),
      );
  }
  if (primary !== undefined) {
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [primary.cause, ...cleanupFailures],
        'Concurrency fixture failed and cleanup also failed.',
        { cause: primary.cause },
      );
    throw primary.cause;
  }
  if (cleanupFailures.length > 0)
    throw new AggregateError(cleanupFailures, 'Concurrency fixture cleanup failed.');
}

describe('concurrency e2e (2.5.I S3) — a run and a chat share one history.db', () => {
  it('coexistence: a real run and a real chat session write the same file concurrently — both land', ({
    signal,
  }) => startCoexistenceCase(signal));

  it('setup refusal closes the original native connection and removes its directory', async ({
    signal,
  }) => {
    const failure = new Error('synthetic migration setup refusal');
    const clients: DbClient[] = [];
    let directory: string | undefined;
    try {
      await expect(
        startCoexistenceCase(signal, {
          onClient: (client) => clients.push(client),
          onDirectory: (path) => {
            directory = path;
          },
          migrate: () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(clients).toHaveLength(1);
      expect(clients[0]?.sqlite.open, 'CONCURRENCY_SETUP_NATIVE_CLOSE').toBe(false);
      expect(directory).toBeDefined();
      expect(directory !== undefined && existsSync(directory)).toBe(false);
    } finally {
      // Separate administrative recovery keeps a removal-control failure from leaking its real handle.
      for (const client of clients) if (client.sqlite.open) client.sqlite.close();
      if (directory !== undefined)
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('case abort seals a held real build and joins writers before native cleanup', async () => {
    const controller = new AbortController();
    const reason = new Error('synthetic case abort');
    const clients: DbClient[] = [];
    let directory: string | undefined;
    let signalEntered = (): void => {};
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let result:
      | { readonly code: number; readonly stdout: string; readonly stderr: string }
      | undefined;
    let settled = false;
    const work = startCoexistenceCase(controller.signal, {
      onClient: (client) => clients.push(client),
      onDirectory: (path) => {
        directory = path;
      },
      build: async (options) => {
        signalEntered();
        await held;
        return buildEngine(options);
      },
      onResult: (code, stdout, stderr) => {
        result = { code, stdout, stderr };
      },
    });
    // Observe the raw rejection immediately; it remains owed while the build is held.
    const observed = work.then(
      () => {
        settled = true;
        return undefined;
      },
      (cause: unknown) => {
        settled = true;
        return cause;
      },
    );
    try {
      await Promise.race([
        entered,
        observed.then((cause) => {
          throw new Error('Synthetic build was not entered.', { cause });
        }),
      ]);
      controller.abort(reason);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(clients).toHaveLength(2);
      expect(clients.every((client) => client.sqlite.open)).toBe(true);
      expect(directory !== undefined && existsSync(directory)).toBe(true);
      release();
      expect(await observed).toBe(reason);
      expect(result, 'CONCURRENCY_ABORT_PREVENTS_RUN_ENTRY').toEqual({
        code: 1,
        stdout: '',
        stderr: '',
      });
      expect(clients.every((client) => !client.sqlite.open)).toBe(true);
      expect(directory !== undefined && existsSync(directory)).toBe(false);
    } finally {
      controller.abort(reason);
      release();
      await observed;
    }
  });

  it('cleanup failure retains the original setup fault and actual native close outcome', async ({
    signal,
  }) => {
    const primary = new Error('synthetic setup fault');
    const secondary = new Error('synthetic close fault after native release');
    const clients: DbClient[] = [];
    let directory: string | undefined;
    try {
      const failure = await startCoexistenceCase(signal, {
        onDirectory: (path) => {
          directory = path;
        },
        onClient: (client) => {
          clients.push(client);
          const close = client.sqlite.close.bind(client.sqlite);
          client.sqlite.close = () => {
            close();
            throw secondary;
          };
        },
        migrate: () => {
          throw primary;
        },
      }).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error('Expected both fixture failures.');
      expect(failure.cause).toBe(primary);
      expect(failure.errors).toEqual([primary, secondary]);
      expect(clients).toHaveLength(1);
      expect(clients[0]?.sqlite.open).toBe(false);
      expect(directory !== undefined && existsSync(directory)).toBe(false);
    } finally {
      for (const client of clients) if (client.sqlite.open) client.sqlite.close();
      if (directory !== undefined)
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
