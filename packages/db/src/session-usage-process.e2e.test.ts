import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
const worker = fileURLToPath(new URL('./fixtures/session-usage-worker.mjs', import.meta.url));

interface Worker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; error: string }>;
}

function startWorker(path: string, mode: string): Worker {
  if (!existsSync(fileURLToPath(dist)))
    throw new Error('Build @relavium/db before its native session-usage tests.');
  const child = spawn(process.execPath, [worker, dist.href, path, mode], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let output = '';
  let error = '';
  let announced = false;
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    output += text;
    if (output.includes('CUT\n') || output.includes('LOCKED\n')) {
      announced = true;
      resolveReady();
    }
  });
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    error += text;
  });
  const timeout = setTimeout(() => {
    rejectReady(new Error('session usage worker readiness deadline'));
    child.kill('SIGKILL');
  }, 5_000);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error: string }>(
    (resolve) => {
      child.once('error', (fault) => {
        rejectReady(fault);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        if (!announced)
          rejectReady(new Error(`session usage worker closed before readiness: ${error}`));
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

describe('native session usage transaction crash and contention', () => {
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
  );
});
