/**
 * The stale gate card, proved on the REAL SQLite store (ADR-0079 §4/§5, ADR-0078 §2) — the native twin of
 * `packages/core/src/engine/stale-gate-card.e2e.test.ts`, which can only run on the in-memory reference store
 * because `@relavium/core` has no SQLite dependency.
 *
 * Terminal A runs a two-gate workflow and parks at gate g1 with its card open; the park hands the lease back.
 * Terminal B — a SECOND engine on its OWN connection to the SAME `history.db` file, as a second process would
 * be — decides g1 through the checkpoint resume path, runs on to g2, parks and hands its lease back too. Then
 * A's stale card takes an answer (or Ctrl-C). A re-takes the vacant lease under a fresh fence, so the fence
 * cannot refuse it; only the compare-and-append sees the log moved. The fix reads that refusal as ownership
 * loss: no terminal, no outbox entry, the re-taken lease released, the run left exactly as B decided it.
 *
 * **What is real here.** Three engines built by the CLI's own `buildEngine` over `createCliHost`, each with its
 * own `better-sqlite3` connection, `createRunHistoryStore`, `createRunLeasePort` and file terminal outbox;
 * the real `UNIQUE(run_id, seq)` index, the real in-transaction head guard and fence check, and the real
 * `BEGIN IMMEDIATE` writes. The assertions read the database FILE through a separate observer connection.
 * **What is not.** There is one OS process, so "two processes" means two connections with distinct lease
 * owners; the node executor is the standard one, so no provider is ever called (a stub resolver refuses).
 *
 * **The negative control** re-creates the pre-fix classification at the host's store seam — the typed
 * `AppendConflictError` is lost and a terminal carries no head guard, which is what the engine did before — and
 * shows the same scenario then leaves a `run:failed` refused by the real unique index and held in the outbox,
 * and that the assertions of the real tests reject that outcome. It emulates the old behaviour; it does not
 * run the old engine code.
 *
 * ISOLATION: every file lives in one temporary directory, and `HOME`/`USERPROFILE` point at it for the test.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseWorkflow,
  reconstructCheckpointState,
  type ExecutionHost,
  type RunHandle,
  type WorkflowDefinition,
  type WorkflowEngine,
} from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
  type DbClient,
  type RunHistoryStore,
} from '@relavium/db';
import {
  isAppendConflictError,
  type DurableWriteContext,
  type GateDecision,
  type RunEvent,
} from '@relavium/shared';

import { outcomeToExitCode, type RunOutcome } from '../commands/drive.js';
import { buildEngine } from './build-engine.js';
import { createHistoryCheckpointer } from './checkpointer.js';
import { createCliHost } from './host.js';
import type { ProviderResolver } from './providers.js';
import { EXIT_CODES } from '../process/exit-codes.js';

const WORKFLOW_ID = 'stale-gate-card-native';
const TWO_GATES: WorkflowDefinition = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: ${WORKFLOW_ID}
  nodes:
    - { id: a, type: input }
    - { id: g1, type: human_gate, gate_type: approval }
    - { id: g2, type: human_gate, gate_type: approval }
    - { id: b, type: output }
  edges:
    - { from: a, to: g1 }
    - { from: g1, to: g2 }
    - { from: g2, to: b }
`,
);

const TERMINAL_TYPES: readonly string[] = ['run:completed', 'run:failed', 'run:cancelled'];
const isTerminalType = (type: string): boolean => TERMINAL_TYPES.includes(type);

/** No node in this workflow calls a model, so a provider lookup is a bug in the test, and refuses loudly. */
const NO_PROVIDERS: ProviderResolver = {
  resolveProvider: () => {
    throw new Error('the stale-gate-card workflow has no agent node');
  },
  keyFor: () => {
    throw new Error('the stale-gate-card workflow has no agent node');
  },
};

const approve = (by: string): GateDecision => ({ decision: 'approved', decidedBy: by });

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Poll a condition on a real clock — a real database commits on its own schedule, so no microtask spin. */
async function until(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(5);
  }
  throw new Error(`never became true: ${what}`); // fail fast, never hang
}

// ---------------------------------------------------------------------------------------------------------
// The observer: raw reads of the database FILE through a connection no engine owns.
// ---------------------------------------------------------------------------------------------------------

interface EventRow {
  readonly id: string;
  readonly seq: number;
  readonly event_type: string;
}
function isEventRow(row: unknown): row is EventRow {
  return (
    typeof row === 'object' &&
    row !== null &&
    'id' in row &&
    typeof row.id === 'string' &&
    'seq' in row &&
    typeof row.seq === 'number' &&
    'event_type' in row &&
    typeof row.event_type === 'string'
  );
}
function eventRows(client: DbClient, runId: string): EventRow[] {
  const rows: unknown[] = client.sqlite
    .prepare('SELECT id, seq, event_type FROM run_events WHERE run_id = ? ORDER BY seq')
    .all(runId);
  return rows.map((row) => {
    if (!isEventRow(row)) throw new Error('unexpected run_events row shape');
    return row;
  });
}
function leaseRowCount(client: DbClient, runId: string): number {
  return client.sqlite.prepare('SELECT run_id FROM run_leases WHERE run_id = ?').all(runId).length;
}
function storedStatus(client: DbClient, runId: string): string {
  const row: unknown = client.sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(runId);
  if (
    typeof row !== 'object' ||
    row === null ||
    !('status' in row) ||
    typeof row.status !== 'string'
  )
    throw new Error('the run row has no status');
  return row.status;
}

// ---------------------------------------------------------------------------------------------------------
// One "process": an engine on its own connection to the shared file.
// ---------------------------------------------------------------------------------------------------------

/** One call a process made to its store: what it asked for and what the real database answered. */
interface Attempt {
  readonly type: RunEvent['type'];
  readonly sequenceNumber: number;
  /** The compare-and-append head the call carried (`undefined` ⇒ unguarded). */
  readonly guardedAgainst: number | undefined;
  readonly outcome: 'landed' | 'refused';
  readonly refusal: unknown;
}

type StoreFault = 'none' | 'pre-fix-classification';

interface ProcessOn {
  readonly name: string;
  readonly client: DbClient;
  readonly store: RunHistoryStore;
  readonly host: ExecutionHost;
  readonly engine: WorkflowEngine;
  readonly attempts: Attempt[];
}

interface Rig {
  readonly dir: string;
  readonly dbPath: string;
  readonly clients: DbClient[];
  /** Open a new connection to the shared file; the first one creates and migrates it. */
  readonly connect: () => DbClient;
}

function newRig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'relavium-stale-gate-card-'));
  const dbPath = join(dir, 'history.db');
  const clients: DbClient[] = [];
  let migrated = false;
  return {
    dir,
    dbPath,
    clients,
    connect: () => {
      const client = createClient(dbPath);
      clients.push(client);
      if (!migrated) {
        runMigrations(client.db);
        migrated = true;
      }
      return client;
    },
  };
}

/**
 * Wrap a store so every call is recorded with the real database's answer. With `pre-fix-classification` it
 * also reproduces what the engine saw BEFORE the fix: a terminal carried no head guard, and a refused
 * compare-and-append reached the engine as an untyped store error rather than an `AppendConflictError`.
 */
function recordingStore(
  inner: ExecutionHost['store'],
  attempts: Attempt[],
  fault: StoreFault,
): ExecutionHost['store'] {
  return {
    ...inner,
    persistEvent: async (event: RunEvent, ctx?: DurableWriteContext) => {
      const downgrade = fault === 'pre-fix-classification';
      const context: DurableWriteContext | undefined =
        downgrade && isTerminalType(event.type)
          ? ctx?.fence === undefined
            ? undefined
            : { fence: ctx.fence }
          : ctx;
      try {
        await inner.persistEvent(event, context);
        attempts.push({
          type: event.type,
          sequenceNumber: event.sequenceNumber,
          guardedAgainst: context?.expectedLastSequenceNumber,
          outcome: 'landed',
          refusal: undefined,
        });
      } catch (error) {
        attempts.push({
          type: event.type,
          sequenceNumber: event.sequenceNumber,
          guardedAgainst: context?.expectedLastSequenceNumber,
          outcome: 'refused',
          refusal: error,
        });
        throw downgrade && isAppendConflictError(error) ? new Error(error.message) : error;
      }
    },
  };
}

async function processOn(
  rig: Rig,
  name: string,
  options: { readonly checkpointer: boolean; readonly fault?: StoreFault } = {
    checkpointer: false,
  },
): Promise<ProcessOn> {
  const client = rig.connect();
  const store = createRunHistoryStore(client.db, {
    uuid: randomUUID,
    now: Date.now,
    workflow: {
      slug: WORKFLOW_ID,
      name: WORKFLOW_ID,
      definitionJson: JSON.stringify(TWO_GATES),
    },
  });
  const base = createCliHost(store, {
    ...(options.checkpointer ? { checkpointer: createHistoryCheckpointer(store) } : {}),
    runLeases: createRunLeasePort(store),
    // Its OWN outbox file, like a process's own — inside the test directory, never the operator's home.
    terminalOutboxPath: join(rig.dir, `${name}-outbox.ndjson`),
  });
  const attempts: Attempt[] = [];
  const host: ExecutionHost = {
    ...base,
    store: recordingStore(base.store, attempts, options.fault ?? 'none'),
  };
  const engine = await buildEngine({ host, providers: NO_PROVIDERS });
  return { name, client, store, host, engine, attempts };
}

/** Read a handle's primary stream up to its next `run:paused`, keeping the reader intact for `depart()`. */
async function readToPause(handle: RunHandle): Promise<Extract<RunEvent, { type: 'run:paused' }>> {
  const iterator = handle.events[Symbol.asyncIterator]();
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) throw new Error('the run ended before it paused');
    if (next.value.type === 'run:paused') return next.value;
  }
}

// ---------------------------------------------------------------------------------------------------------
// The scene: A parked on g1 with its card open; B has decided g1, run to g2 and left.
// ---------------------------------------------------------------------------------------------------------

async function staleCardScene(rig: Rig, fault: StoreFault) {
  const a = await processOn(rig, 'terminal-a', { checkpointer: false, fault });
  const observer = rig.connect();
  const observerStore = createRunHistoryStore(observer.db, {
    uuid: randomUUID,
    now: Date.now,
    workflow: { slug: WORKFLOW_ID, name: WORKFLOW_ID, definitionJson: JSON.stringify(TWO_GATES) },
  });
  const observerLeases = createRunLeasePort(observerStore);

  const handleA = a.engine.start({ workflow: TWO_GATES, inputs: {} });
  const runId = handleA.runId;
  const eventsA: RunEvent[] = [];
  const atFirstGate = deferred<string>();
  // A keeps draining on a background promise, as the CLI's card does, so its execution stays alive and parked.
  const drainedA = (async () => {
    try {
      for await (const event of handleA.events) {
        eventsA.push(event);
        if (event.type === 'run:paused') atFirstGate.resolve(event.gateIds[0] ?? '');
      }
    } catch (error) {
      atFirstGate.reject(error);
      throw error;
    }
  })();
  const firstGate = await atFirstGate.promise;
  // §4: A's park handed the claim back — the row is gone, so another process may take the run.
  await until(async () => (await observerLeases.read(runId)) === undefined, 'A released its lease');
  const beforeB = eventRows(observer, runId);

  // Terminal B: `relavium gate <run> g1 approve` — a resume from the checkpoint, on its own connection.
  const b = await processOn(rig, 'terminal-b', { checkpointer: true });
  const handleB = await b.engine.resumeFromCheckpoint({
    runId,
    workflow: TWO_GATES,
    inputs: {},
    gateId: firstGate,
    decision: approve('terminal-b'),
  });
  const secondPause = await readToPause(handleB);
  expect((await handleB.depart()).kind).toBe('detached'); // B exits at g2, as `relavium gate` does
  await until(async () => (await observerLeases.read(runId)) === undefined, 'B released its lease');
  b.client.sqlite.close(); // B's process is gone: nothing of it may touch the file again

  const afterB = eventRows(observer, runId);
  const usedByB = new Set(afterB.slice(beforeB.length).map((row) => row.seq));
  expect(usedByB.size).toBeGreaterThan(0);
  expect(afterB.slice(0, beforeB.length)).toEqual(beforeB);
  return {
    rig,
    a,
    observer,
    observerStore,
    handleA,
    eventsA,
    drainedA,
    runId,
    firstGate,
    secondGate: secondPause.gateIds[0] ?? '',
    afterB,
    usedByB,
    /** How many calls A had made to its store when the stale card was touched. */
    attemptsBeforeStaleCard: a.attempts.length,
  };
}

type Scene = Awaited<ReturnType<typeof staleCardScene>>;

/** What the CLI would report: the outcome its drive loop last saw, mapped through the real exit mapping. */
function exitCodeOf(scene: Scene): number {
  let outcome: RunOutcome | undefined;
  for (const event of scene.eventsA) {
    if (event.type === 'run:paused') outcome = 'paused';
    else if (event.type === 'run:completed') outcome = 'completed';
    else if (event.type === 'run:failed') outcome = 'failed';
    else if (event.type === 'run:cancelled') outcome = 'cancelled';
  }
  return outcomeToExitCode(outcome, scene.handleA.durability(), scene.handleA.terminalError());
}

/** What every stale-card outcome must leave behind, read from the database file. */
async function expectFencedAndUntouched(scene: Scene): Promise<void> {
  const { a, observer, observerStore, handleA, eventsA, runId, afterB, usedByB, secondGate } =
    scene;

  // A claims no outcome: no terminal reached its stream, and the handle reports the fenced disposition
  // (no terminal + `uncertain`, which the CLI maps to exit 6 — never exit 5).
  expect(eventsA.filter((event) => isTerminalType(event.type))).toEqual([]);
  expect(handleA.durability()).toBe('uncertain');
  expect(handleA.terminalError()).toBeUndefined();
  expect(exitCodeOf(scene)).toBe(EXIT_CODES.runOwnedElsewhere);
  expect(EXIT_CODES.runOwnedElsewhere).toBe(6);

  // A's calls during the stale window: none landed, and none was refused by the UNIQUE index — every refusal
  // was the typed compare-and-append conflict, the signal the engine reads as ownership loss.
  const staleAttempts = a.attempts.slice(scene.attemptsBeforeStaleCard);
  expect(staleAttempts.length).toBeGreaterThan(0);
  expect(staleAttempts.filter((attempt) => attempt.outcome === 'landed')).toEqual([]);
  for (const attempt of staleAttempts) {
    expect(isAppendConflictError(attempt.refusal), `${attempt.type} refusal`).toBe(true);
    expect(attempt.guardedAgainst, `${attempt.type} carried a head guard`).toBeDefined();
  }

  // Nothing of A's landed: the rows are exactly what B left — same ids, same sequences — with no terminal.
  const rows = eventRows(observer, runId);
  expect(rows).toEqual(afterB);
  expect(rows.filter((row) => isTerminalType(row.event_type))).toEqual([]);
  const seqs = rows.map((row) => row.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect([...usedByB].every((seq) => rows.filter((row) => row.seq === seq).length === 1)).toBe(
    true,
  );

  // No outbox entry: the run belongs to another process's log, so there is nothing for a later start to retry.
  expect(await a.host.terminalOutbox.list()).toEqual([]);

  // The re-taken claim was handed back, so the next `relavium gate` is not refused for a lease TTL.
  expect(leaseRowCount(observer, runId)).toBe(0);
  expect(await a.host.runLeases.read(runId)).toBeUndefined();

  // The run's stored status is the one B decided: paused at g2, resumable — not failed.
  expect(storedStatus(observer, runId)).toBe('paused');
  const checkpoint = reconstructCheckpointState(observerStore.loadRunEventLogForReplay(runId));
  expect(checkpoint?.runStatus).toBe('paused');
  expect(checkpoint?.pendingGates.map((gate) => gate.gateId)).toEqual([secondGate]);
  const interrupted = await observerStore.listInterruptedRuns();
  expect(interrupted.find((run) => run.runId === runId)?.resumable).toBe(true);
}

/** The run A gave up stays healthy: a third engine decides g2 and the run completes with one terminal. */
async function expectStillCompletes(scene: Scene): Promise<void> {
  const c = await processOn(scene.rig, 'terminal-c', { checkpointer: true });
  const handleC = await c.engine.resumeFromCheckpoint({
    runId: scene.runId,
    workflow: TWO_GATES,
    inputs: {},
    gateId: scene.secondGate,
    decision: approve('terminal-c'),
  });
  const eventsC: RunEvent[] = [];
  for await (const event of handleC.events) eventsC.push(event);
  expect(eventsC.at(-1)?.type).toBe('run:completed');
  expect(handleC.durability()).toBe('durable');
  const rows = eventRows(scene.observer, scene.runId);
  expect(rows.filter((row) => isTerminalType(row.event_type)).map((row) => row.event_type)).toEqual(
    ['run:completed'],
  );
  const seqs = rows.map((row) => row.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(storedStatus(scene.observer, scene.runId)).toBe('completed');
  expect(await c.host.terminalOutbox.list()).toEqual([]);
  await until(() => leaseRowCount(scene.observer, scene.runId) === 0, 'C released its lease');
}

describe('a stale gate card after another process decided the gate, on the real SQLite store', () => {
  let rig: Rig | undefined;

  beforeEach(() => {
    rig = newRig();
    // The operator's home must never be reachable from here, whatever a dependency resolves from it.
    vi.stubEnv('HOME', rig.dir);
    vi.stubEnv('USERPROFILE', rig.dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (rig === undefined) return;
    for (const client of rig.clients) if (client.sqlite.open) client.sqlite.close();
    rmSync(rig.dir, { recursive: true, force: true });
    rig = undefined;
  });

  const current = (): Rig => {
    if (rig === undefined) throw new Error('the rig is not open');
    return rig;
  };

  it('answering it stops A as fenced: no terminal, no outbox entry, the re-taken lease released', async () => {
    const scene = await staleCardScene(current(), 'none');
    // A's card for g1 is still open and takes an answer. A's resume re-takes the vacant lease under a fresh
    // fence; its guarded append is refused on its stale head — which is ownership loss, not a store fault.
    await scene.a.engine.resume(scene.runId, scene.firstGate, approve('terminal-a'));
    await scene.drainedA;

    // The one thing A tried was the gate decision; it never reached for a terminal.
    const staleAttempts = scene.a.attempts.slice(scene.attemptsBeforeStaleCard);
    expect(staleAttempts.map((attempt) => attempt.type)).toEqual(['human_gate:resumed']);

    await expectFencedAndUntouched(scene);
    await expectStillCompletes(scene);
  }, 30_000);

  it('Ctrl-C at it stops A as fenced too: no `run:cancelled` lands at a sequence B used', async () => {
    // The terminal-first sibling. A cancel at a parked run writes `run:cancelled` before anything else, and a
    // terminal is exempt from the append guard — so the first write under a re-taken claim carries the guard.
    const scene = await staleCardScene(current(), 'none');
    scene.a.engine.cancel(scene.runId);
    await scene.drainedA;

    // The terminal WAS attempted — and refused on the head it carried, by the typed conflict, not by the index.
    const staleAttempts = scene.a.attempts.slice(scene.attemptsBeforeStaleCard);
    expect(staleAttempts.map((attempt) => attempt.type)).toEqual(['run:cancelled']);

    await expectFencedAndUntouched(scene);
    await expectStillCompletes(scene);
  }, 30_000);

  it('negative control: without the typed refusal and the terminal guard, the same scene leaves a refused terminal held in the outbox', async () => {
    // The pre-fix classification, emulated at the store seam: the terminal carries no head guard, and a refused
    // compare-and-append arrives untyped. A reads that as a store fault and fails the run — the bug.
    const scene = await staleCardScene(current(), 'pre-fix-classification');
    await scene.a.engine.resume(scene.runId, scene.firstGate, approve('terminal-a'));
    await scene.drainedA;

    const staleAttempts = scene.a.attempts.slice(scene.attemptsBeforeStaleCard);
    const terminalAttempt = staleAttempts.find((attempt) => isTerminalType(attempt.type));
    expect(terminalAttempt?.type).toBe('run:failed');
    expect(terminalAttempt?.outcome).toBe('refused');
    // The real unique index is what refused it: the bogus terminal wanted a sequence B had already used.
    const refusal = terminalAttempt?.refusal;
    expect(refusal instanceof Error ? refusal.message : 'not an Error').toContain(
      'UNIQUE constraint failed',
    );
    expect(scene.usedByB.has(terminalAttempt?.sequenceNumber ?? -1)).toBe(true);
    // …and it is held for a retry that can never succeed, while A reports a terminal it could not record.
    const held = await scene.a.host.terminalOutbox.list();
    expect(held.map((event) => event.type)).toEqual(['run:failed']);
    expect(scene.handleA.durability()).toBe('uncertain');
    expect(exitCodeOf(scene)).toBe(EXIT_CODES.durabilityUncertain);
    // The database protected itself — B's rows are intact — but the assertions of the real tests see the fault.
    expect(eventRows(scene.observer, scene.runId)).toEqual(scene.afterB);
    // The control must fail on the FIRST thing the real tests assert: A's own stream carried a terminal
    // (`run:failed`), which a fenced run never claims. Any other throw would be a different fault.
    await expect(expectFencedAndUntouched(scene)).rejects.toThrow(
      /type: 'run:failed'[\s\S]*to deeply equal \[\]/,
    );
  }, 30_000);
});
