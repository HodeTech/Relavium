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
  /** Positive initialization ACK; the parent must not hold the write lock during child startup. */
  readonly opened: Promise<void>;
  /** Positive first-write handshake. Early exit rejects rather than impersonating readiness. */
  readonly ready: Promise<void>;
  /** Resolves only on actual native close, including after a spawn error or stop request. */
  readonly done: Promise<{ code: number; stderr: string; spawnError: Error | undefined }>;
  readonly start: () => void;
  readonly stop: () => void;
  readonly isClosed: () => boolean;
}

/** Spawn once and retain its actual close even if setup, the test body or readiness fails. */
function runChild(args: readonly string[]): SpawnedChild {
  const child = spawn(process.execPath, [CHILD_SCRIPT, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let closed = false;
  let spawnError: Error | undefined;
  let signalOpened: () => void = () => {};
  let signalReady: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    signalOpened = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (stdout.split('\n').includes('OPENED')) signalOpened();
    if (stdout.split('\n').includes('READY')) signalReady();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const done = new Promise<{ code: number; stderr: string; spawnError: Error | undefined }>(
    (resolve) => {
      child.on('error', (err) => {
        spawnError ??= err;
      });
      child.stdin.on('error', (err: Error) => {
        spawnError ??= err;
      });
      child.on('close', (code) => {
        closed = true;
        resolve({ code: code ?? -1, stderr, spawnError });
      });
    },
  );
  const prematureClose = done.then((result) => {
    throw new Error(
      `Concurrent writer closed before its handshake (exit ${result.code}). ${result.stderr}`,
      {
        cause: result.spawnError,
      },
    );
  });
  const observedOpened = Promise.race([opened, prematureClose]);
  const observedReady = Promise.race([ready, prematureClose]);
  // Both phases are observed from creation, even if the other phase fails first.
  void observedOpened.catch(() => undefined);
  void observedReady.catch(() => undefined);
  return {
    opened: observedOpened,
    ready: observedReady,
    done,
    start: () => {
      child.stdin.end('START\n');
    },
    stop: () => {
      if (!closed) child.kill();
    },
    isClosed: () => closed,
  };
}

/** Abort abandons only the wait; the caller still owes each child's actual close in finally. */
async function untilCaseAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = (): void => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- preserve the test context's original abort reason
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([stopped, work]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
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

interface CrossProcessPorts {
  readonly firstMode?: 'fail-before-ready';
  readonly onChild?: (child: SpawnedChild) => void;
  readonly onDirectory?: (directory: string) => void;
  readonly onOpened?: () => void;
}

function startCrossProcessCase(signal: AbortSignal, ports: CrossProcessPorts = {}): Promise<void> {
  rawCase = Promise.resolve().then(() => crossProcessCase(signal, ports));
  return rawCase;
}

async function crossProcessCase(signal: AbortSignal, ports: CrossProcessPorts): Promise<void> {
  signal.throwIfAborted();
  const dir = mkdtempSync(join(tmpdir(), 'relavium-concurrency-2p-'));
  const dbPath = join(dir, 'history.db');
  const children: SpawnedChild[] = [];
  const nativeCloses: Array<() => void> = [];
  const phases: Array<{ readonly phase: string; readonly milliseconds: number }> = [];
  const began = performance.now();
  const phase = (name: string): void => {
    phases.push({ phase: name, milliseconds: Math.round(performance.now() - began) });
  };
  let holder: DbClient | undefined;
  let primary: { readonly cause: unknown } | undefined;
  const cleanupFailures: unknown[] = [];
  const releaseLock = (): void => {
    if (holder?.sqlite.inTransaction) holder.sqlite.exec('COMMIT');
  };
  phase('case-enter');
  try {
    ports.onDirectory?.(dir);
    // Retain one parent connection through migration, contention and verification. Closing/reopening
    // the last connection adds an unrelated WAL checkpoint/recovery cycle to a writer contention case.
    holder = createClient(dbPath, (close) => nativeCloses.push(close));
    runMigrations(holder.db);
    phase('migrations-done');
    signal.throwIfAborted();
    const PER_CHILD = 40;
    for (const prefix of ['a', 'b']) {
      const child = runChild([
        DB_DIST_URL.href,
        dbPath,
        prefix,
        String(PER_CHILD),
        prefix === 'a' ? (ports.firstMode ?? 'write') : 'write',
      ]);
      children.push(child);
      ports.onChild?.(child);
    }
    // Import/PRAGMA initialization must not compete with the write lock whose release waits for them.
    // OPENED is separate from READY: each child still enters its first upsert only after START.
    await untilCaseAbort(Promise.all(children.map((child) => child.opened)), signal);
    phase('children-opened');
    ports.onOpened?.();
    signal.throwIfAborted();
    holder.sqlite.exec('BEGIN IMMEDIATE');
    phase('lock-held');
    for (const child of children) child.start();
    await untilCaseAbort(Promise.all(children.map((child) => child.ready)), signal);
    phase('children-ready');
    // Retain the existing overlap margin and the actual 5-second native busy handler. The deterministic
    // write-policy clause guards remain in db's provider-store/retry tests; this is a native smoke.
    await untilCaseAbort(
      new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      }),
      signal,
    );
    releaseLock();
    phase('lock-released');
    const results = await untilCaseAbort(Promise.all(children.map((child) => child.done)), signal);
    phase('children-closed');
    signal.throwIfAborted();
    for (const result of results) {
      expect(result.spawnError).toBeUndefined();
      expect(result.code).toBe(0);
      expect(result.stderr).not.toMatch(/SQLITE|Error/i);
    }
    const providers = createProviderStore(holder.db, { uuid: () => randomUUID(), now: () => 0 });
    const names = providers.list().map((provider) => provider.name);
    expect(names).toHaveLength(2 * PER_CHILD);
    for (let i = 0; i < PER_CHILD; i += 1) {
      expect(names).toContain(`a-${i}`);
      expect(names).toContain(`b-${i}`);
    }
    phase('assertions-done');
  } catch (cause) {
    primary = { cause };
  } finally {
    // Release the lock before asking children to stop, then join actual close before any SQLite close
    // or removal. A test timeout, early-exit handshake failure and kill request are never close ACKs.
    try {
      releaseLock();
    } catch (cause) {
      cleanupFailures.push(cause);
    }
    if (primary !== undefined || signal.aborted) {
      for (const child of children) {
        try {
          child.stop();
        } catch (cause) {
          cleanupFailures.push(cause);
        }
      }
    }
    await Promise.all(children.map((child) => child.done));
    phase('raw-children-joined');
    for (const close of nativeCloses) {
      try {
        close();
      } catch (cause) {
        cleanupFailures.push(cause);
      }
    }
    phase('native-close-attempts-done');
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      phase('directory-removed');
    } catch (cause) {
      cleanupFailures.push(cause);
    }
    if (primary !== undefined || cleanupFailures.length > 0 || signal.aborted)
      console.error(
        'CONCURRENCY_CHILD_PHASES ' +
          JSON.stringify({
            phases,
            childrenClosed: children.filter((child) => child.isClosed()).length,
            cleanupFailures: cleanupFailures.length,
          }),
      );
  }
  if (primary !== undefined) {
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [primary.cause, ...cleanupFailures],
        'Cross-process fixture failed and cleanup also failed.',
        { cause: primary.cause },
      );
    throw primary.cause;
  }
  if (cleanupFailures.length > 0)
    throw new AggregateError(cleanupFailures, 'Cross-process fixture cleanup failed.');
}

describe('concurrency e2e (2.5.I S3) — a run and a chat share one history.db', () => {
  it('an already-aborted fixture wait still observes the raw child-phase rejection', async () => {
    const controller = new AbortController();
    const reason = new Error('synthetic case already stopped');
    controller.abort(reason);
    await expect(
      untilCaseAbort(Promise.reject(new Error('synthetic child-phase fault')), controller.signal),
    ).rejects.toBe(reason);
    // A throw before installing the race would leave the already-created work unobserved.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('coexistence: a real run and a real chat session write the same file concurrently — both land', ({
    signal,
  }) => startCoexistenceCase(signal));

  // Fixture custody only: production opener/CommandLifetime partial-close evidence lives in
  // commands/partial-db-acquisition.test.ts and commands/surface-db-acquisition.test.ts.
  it('fixture cleanup: setup refusal closes its native connection and removes its directory', async ({
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
      expect(clients[0]?.sqlite.open, 'CONCURRENCY_FIXTURE_SETUP_NATIVE_CLOSE').toBe(false);
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

  it('fixture cleanup: close failure retains its setup fault and actual native close outcome', async ({
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
    ({ signal }) => startCrossProcessCase(signal),
  );

  it.skipIf(!existsSync(DB_DIST_PATH))(
    'a child exiting before READY fails and both actual child closes precede directory removal',
    async ({ signal }) => {
      const children: SpawnedChild[] = [];
      let directory: string | undefined;
      await expect(
        startCrossProcessCase(signal, {
          firstMode: 'fail-before-ready',
          onChild: (child) => children.push(child),
          onDirectory: (path) => {
            directory = path;
          },
        }),
      ).rejects.toThrow('Concurrent writer closed before its handshake');
      expect(children).toHaveLength(2);
      expect(children.every((child) => child.isClosed())).toBe(true);
      expect(directory !== undefined && existsSync(directory)).toBe(false);
    },
  );

  it.skipIf(!existsSync(DB_DIST_PATH))(
    'case abort after child initialization joins both native closes before releasing fixture custody',
    async () => {
      const controller = new AbortController();
      const reason = new Error('synthetic cross-process abort');
      const children: SpawnedChild[] = [];
      let directory: string | undefined;
      await expect(
        startCrossProcessCase(controller.signal, {
          onChild: (child) => children.push(child),
          onDirectory: (path) => {
            directory = path;
          },
          onOpened: () => {
            expect(children).toHaveLength(2);
            expect(children.every((child) => !child.isClosed())).toBe(true);
            expect(directory !== undefined && existsSync(directory)).toBe(true);
            controller.abort(reason);
          },
        }),
      ).rejects.toBe(reason);
      expect(children.every((child) => child.isClosed())).toBe(true);
      expect(directory !== undefined && existsSync(directory)).toBe(false);
    },
  );
});
