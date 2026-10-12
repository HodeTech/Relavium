import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { agentSessions } from './schema.js';
import { createSessionStore } from './session-store.js';
import { createSessionUsageStore } from './session-usage-store.js';

const dist = new URL('../dist/index.js', import.meta.url);
// The isolated causal runner supplies only this test's physical sibling source entry.
// Normal package CI still requires and exercises the actual built DB entry.
const sourceEntry = new URL('./index.ts', import.meta.url);
const requestedEntry = process.env['RELAVIUM_USAGE_TEST_SOURCE_ENTRY'];
if (requestedEntry !== undefined && requestedEntry !== sourceEntry.href)
  throw new Error('Usage test source entry must be the exact sibling source index.');
const entry = requestedEntry === undefined ? dist : sourceEntry;
const worker = fileURLToPath(new URL('./fixtures/session-usage-worker.mjs', import.meta.url));

interface Worker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; error: string }>;
}

type ReadinessDeadline = (callback: () => void, delay: number) => () => void;

const armReadinessDeadline: ReadinessDeadline = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

function startWorker(
  path: string,
  mode: string,
  armDeadline: ReadinessDeadline = armReadinessDeadline,
): Worker {
  if (!existsSync(fileURLToPath(entry)))
    throw new Error('Build @relavium/db before its native session-usage tests.');
  const child = spawn(process.execPath, [worker, entry.href, path, mode], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const started = performance.now();
  const record = (value: object): void => {
    const destination = process.env['RELAVIUM_USAGE_NATIVE_EVENTS'];
    if (destination !== undefined)
      appendFileSync(
        destination,
        `${JSON.stringify({ callerPid: process.pid, pid: child.pid, mode, elapsedMs: Math.round(performance.now() - started), ...value })}\n`,
      );
  };
  record({ stage: 'spawn' });
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let output = '';
  let error = '';
  let state: 'waiting' | 'ready' | 'failed' = 'waiting';
  let cancelDeadline: (() => void) | undefined;
  const disarm = (): void => {
    const cancel = cancelDeadline;
    cancelDeadline = undefined;
    cancel?.();
  };
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    output += text;
    if (mode === 'readiness-timeout-control' && output === 'WAITING\n')
      record({ stage: 'not-ready', kind: 'WAITING' });
    if (state === 'waiting' && (output.includes('CUT\n') || output.includes('LOCKED\n'))) {
      state = 'ready';
      disarm();
      record({ stage: 'barrier', kind: output.includes('CUT\n') ? 'CUT' : 'LOCKED' });
      resolveReady();
    }
  });
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    error += text;
  });
  cancelDeadline = armDeadline(() => {
    // Clearing a timer does not make an already-queued callback authoritative again.
    if (state !== 'waiting') return;
    state = 'failed';
    disarm();
    record({ stage: 'readiness-timeout' });
    rejectReady(new Error('session usage worker readiness deadline'));
    child.kill('SIGKILL');
  }, 5_000);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error: string }>(
    (resolve) => {
      child.once('error', (fault) => {
        state = 'failed';
        disarm();
        rejectReady(fault);
      });
      child.once('close', (code, signal) => {
        record({ stage: 'close', code, signal });
        disarm();
        if (state === 'waiting') {
          state = 'failed';
          rejectReady(new Error(`session usage worker closed before readiness: ${error}`));
        }
        resolve({ code, signal, error });
      });
    },
  );
  return { child, ready, closed };
}

function seed(client: DbClient): void {
  runMigrations(client.db, { dbPath: client.path });
  createSessionUsageStore(client.db).createFreshSession({
    id: 's1',
    agentSlug: 'chatter',
    context: { workingDir: '/work', fsScopeTier: 'sandboxed' },
    createdAt: '2026-10-10T00:00:00.000Z',
  });
}

// Match the isolated acceptance runner's case budget for seed, child, reopen and cleanup.
// The five-second startup deadline ends at the barrier; each test owns post-barrier lifetime.
describe('native session usage transaction crash and contention', () => {
  it('disarms readiness at LOCKED and ignores an obsolete callback before RELEASE', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relavium-session-usage-readiness-'));
    const client = createClient(join(root, 'history.db'));
    let run: Worker | undefined;
    let expire: (() => void) | undefined;
    const cancel = vi.fn();
    try {
      seed(client);
      run = startWorker(client.path, 'lock-release', (callback, delay) => {
        expect(delay).toBe(5_000);
        expire = callback;
        return cancel;
      });
      await run.ready;
      expect(cancel).toHaveBeenCalledTimes(1);
      if (expire === undefined) throw new Error('missing readiness callback');
      expire();
      expect(run.child.killed).toBe(false);
      expect(run.child.signalCode).toBeNull();
      run.child.stdin.end('RELEASE\n');
      const result = await run.closed;
      expect(result, result.error).toMatchObject({ code: 0, signal: null });
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      run?.child.kill('SIGKILL');
      await run?.closed;
      client.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects and joins a killed native child when readiness never arrives', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relavium-session-usage-no-readiness-'));
    const client = createClient(join(root, 'history.db'));
    let run: Worker | undefined;
    let expire: (() => void) | undefined;
    const cancel = vi.fn();
    try {
      seed(client);
      run = startWorker(client.path, 'readiness-timeout-control', (callback) => {
        expire = callback;
        return cancel;
      });
      const refusal = expect(run.ready).rejects.toThrow('session usage worker readiness deadline');
      let output = '';
      run.child.stdout.on('data', (text: string) => {
        output += text;
        if (output.includes('WAITING\n')) {
          if (expire === undefined) throw new Error('missing readiness callback');
          expire();
        }
      });
      await refusal;
      const result = await run.closed;
      expect(result, result.error).toMatchObject({ code: null, signal: 'SIGKILL' });
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      run?.child.kill('SIGKILL');
      await run?.closed;
      client.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it.each(['pending-before-ack', 'pending-after-ack', 'pending-after-commit'])(
    'pending marker survives only outer commit at native process cut %s',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'relavium-pending-crash-'));
      const path = join(root, 'history.db');
      const client = createClient(path);
      let run: Worker | undefined;
      try {
        seed(client);
        run = startWorker(path, mode);
        await run.ready;
        run.child.kill('SIGKILL');
        const result = await run.closed;
        expect(result.signal, result.error).toBe('SIGKILL');
        const reopened = createClient(path);
        try {
          const committed = mode === 'pending-after-commit';
          const snapshot = createSessionUsageStore(reopened.db).loadCoverage('s1');
          expect(snapshot?.coverage).toEqual({
            unverified: false,
            pendingInvocations: committed ? 1 : 0,
            unknownCalls: 0,
          });
          expect(createSessionStore(reopened.db).loadSession('s1')?.totalCostMicrocents).toBe(0);
          expect(
            reopened.sqlite.prepare('SELECT count(*) AS n FROM session_usage_invocations').get(),
          ).toEqual({ n: committed ? 1 : 0 });
          // A reopened store cannot recover the dead process's opaque receipt authority.
          const next = createSessionUsageStore(reopened.db).beginInvocation({
            sessionId: 's1',
            model: 'm',
            producerId: 'child',
            dispatchId: 'd',
            round: 0,
            chainAttempt: 1,
          });
          expect(next.invocation.ordinal).toBe(committed ? 2 : 1);
        } finally {
          reopened.sqlite.close();
        }
      } finally {
        run?.child.kill('SIGKILL');
        await run?.closed;
        client.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.each(['before-ack', 'after-ack', 'after-commit'])(
    'survives process death %s without laundering old writes',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'relavium-session-usage-crash-'));
      const path = join(root, 'history.db');
      const client = createClient(path);
      let run: Worker | undefined;
      try {
        seed(client);
        client.db.run(
          sql`UPDATE agent_sessions SET total_cost_microcents = total_cost_microcents + 0 WHERE id = 's1'`,
        );
        run = startWorker(path, mode);
        await run.ready;
        run.child.kill('SIGKILL');
        const result = await run.closed;
        expect(result.signal, result.error).toBe('SIGKILL');
        const reopened = createClient(path);
        try {
          const row = reopened.db
            .select()
            .from(agentSessions)
            .where(eq(agentSessions.id, 's1'))
            .get();
          expect(createSessionUsageStore(reopened.db).loadCoverage('s1')?.coverage.unverified).toBe(
            true,
          );
          const committed = mode === 'after-commit';
          expect(row?.usageUnverified).toBe(committed);
          expect(row?.usageMutationRevision).toBe(committed ? 4 : 2);
          expect(row?.usageAckRevision).toBe(committed ? 4 : 1);
          expect(createSessionStore(reopened.db).loadMessages('s1')).toHaveLength(
            committed ? 1 : 0,
          );
          expect(row?.title).toBe(committed ? 'new-writer' : null);
        } finally {
          reopened.sqlite.close();
        }
      } finally {
        run?.child.kill('SIGKILL');
        await run?.closed;
        client.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.each(['lock-release', 'lock-hold'])(
    'retries the whole outer transaction under %s',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'relavium-session-usage-lock-'));
      const client = createClient(join(root, 'history.db'));
      let run: Worker | undefined;
      try {
        seed(client);
        client.sqlite.pragma('busy_timeout = 10');
        const store = createSessionStore(client.db);
        const session = store.loadSession('s1');
        if (session === undefined) throw new Error('missing fixture session');
        run = startWorker(client.path, mode);
        await run.ready;
        const originalTransaction = client.db.transaction.bind(client.db);
        const transaction = vi.spyOn(client.db, 'transaction');
        try {
          if (mode === 'lock-release') {
            const child = run.child;
            transaction.mockImplementationOnce((body, config) => {
              try {
                return originalTransaction(body, config);
              } catch (error) {
                // The old writer cannot release before this genuine failed outer BEGIN.
                expect(error).toHaveProperty('code', 'SQLITE_BUSY');
                child.stdin.end('RELEASE\n');
                throw error;
              }
            });
            store.updateSession({ ...session, title: 'new-writer' });
            expect(transaction.mock.calls.length).toBeGreaterThan(1);
            expect(transaction.mock.calls.length).toBeLessThanOrEqual(5);
            const result = await run.closed;
            expect(result.code, result.error).toBe(0);
            const row = client.db
              .select()
              .from(agentSessions)
              .where(eq(agentSessions.id, 's1'))
              .get();
            expect(row?.usageUnverified).toBe(true);
            expect(row?.usageMutationRevision).toBe(3);
            expect(row?.usageAckRevision).toBe(3);
            expect(row?.title).toBe('new-writer');
          } else {
            expect(() => store.updateSession({ ...session, title: 'must not land' })).toThrow();
            expect(transaction).toHaveBeenCalledTimes(5);
            run.child.kill('SIGKILL');
            await run.closed;
            const row = client.db
              .select()
              .from(agentSessions)
              .where(eq(agentSessions.id, 's1'))
              .get();
            expect(row?.title).toBeNull();
            expect(row?.usageMutationRevision).toBe(1);
            expect(row?.usageAckRevision).toBe(1);
            expect(row?.usageUnverified).toBe(false);
          }
          for (const call of transaction.mock.calls)
            expect(call[1]).toEqual({ behavior: 'immediate' });
        } finally {
          transaction.mockRestore();
        }
      } finally {
        run?.child.kill('SIGKILL');
        await run?.closed;
        client.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
