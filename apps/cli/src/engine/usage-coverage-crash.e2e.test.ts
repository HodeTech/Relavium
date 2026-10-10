import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconstructCheckpointState } from '@relavium/core';
import {
  createClient,
  createRunHistoryReader,
  createSessionStore,
  createSessionUsageStore,
} from '@relavium/db';
import { isUsageCoverageComplete, type UsageCoverage } from '@relavium/shared';
import { describe, expect, it } from 'vitest';
import {
  initialSessionViewState,
  INLINE_TRANSCRIPT_BOUND,
} from '../render/tui/session-view-model.js';

const workerPath = fileURLToPath(
  new URL('./fixtures/usage-coverage-crash-worker.ts', import.meta.url),
);
const registerPath = fileURLToPath(
  new URL('./fixtures/usage-coverage-crash-register.mjs', import.meta.url),
);
type Surface = 'run' | 'session';
type Route = 'primary' | 'failover' | 'summarizer';
type Cut =
  | 'pending'
  | 'invoked'
  | 'settled'
  | 'refuse-pending'
  | 'omit-pending'
  | 'credentials'
  | 'cancel-before-invoke'
  | 'late-receipt'
  | 'late-missing'
  | 'late-partial'
  | 'late-invalid'
  | 'late-rejected'
  | 'lock-release'
  | 'lock-hold';
interface Barrier {
  readonly kind: string;
  readonly ownerId: string;
  readonly invocations: number;
}
interface NativeWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<Barrier>;
  readonly waitFor: (kind: string) => Promise<Barrier>;
  readonly closed: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error: string;
  }>;
}
function startWorker(
  path: string,
  surface: Surface,
  route: Route,
  cut: Cut,
  cap: string,
): NativeWorker {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--import',
      registerPath,
      workerPath,
      path,
      surface,
      route,
      cut,
      cap,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let resolveReady: (barrier: Barrier) => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<Barrier>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const barriers = new Map<string, Barrier>();
  const waiters = new Map<
    string,
    { resolve: (barrier: Barrier) => void; reject: (error: Error) => void }
  >();
  const waitFor = (kind: string): Promise<Barrier> => {
    const found = barriers.get(kind);
    return found === undefined
      ? new Promise((resolve, reject) => {
          waiters.set(kind, { resolve, reject });
        })
      : Promise.resolve(found);
  };
  let output = '',
    error = '',
    announced = false;
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    output += text;
    for (const match of output.matchAll(
      /^(CUT|DONE|ENTERED|INTERRUPTED|LOCK_READY|BUSY) ([\w-]+) (\d+)$/gm,
    )) {
      if (match[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
        const barrier = { kind: match[1], ownerId: match[2], invocations: Number(match[3]) };
        if (barriers.has(barrier.kind)) continue;
        barriers.set(barrier.kind, barrier);
        announced = true;
        resolveReady(barrier);
        waiters.get(barrier.kind)?.resolve(barrier);
        waiters.delete(barrier.kind);
      }
    }
  });
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    error += text;
  });
  // Deadline is a hang guard only; the stdout barrier decides every kill/read ordering.
  const deadline = setTimeout(() => {
    rejectReady(new Error(`usage crash worker deadline: ${error}`));
    child.kill('SIGKILL');
  }, 15_000);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error: string }>(
    (resolve) => {
      child.once('error', rejectReady);
      child.once('close', (code, signal) => {
        clearTimeout(deadline);
        for (const waiter of waiters.values())
          waiter.reject(new Error(`usage worker exited before barrier: ${error}`));
        if (!announced)
          rejectReady(new Error(`usage crash worker exited before barrier: ${error}\n${output}`));
        resolve({ code, signal, error });
      });
    },
  );
  return { child, ready, waitFor, closed };
}

interface Reopened {
  readonly coverage: UsageCoverage;
  readonly actual: number;
  readonly calls: number;
  readonly conservative: number;
  readonly models: readonly { readonly model: string; readonly coverage: UsageCoverage }[];
}
function reopen(path: string, surface: Surface, ownerId: string): Reopened {
  const client = createClient(path);
  try {
    if (surface === 'session') {
      const store = createSessionStore(client.db);
      const before = createSessionUsageStore(client.db).loadCoverage(ownerId);
      if (before === undefined) throw new Error('missing session coverage after crash');
      const breakdown = store.loadSessionCostBreakdown(ownerId);
      const session = store.loadSession(ownerId);
      // Read-only reopen, history and model breakdown cannot acknowledge or clear a dead owner's marker.
      expect(breakdown.coverage).toEqual(before.coverage);
      const view = initialSessionViewState(
        {
          transcript: [],
          cumulativeCostMicrocents: breakdown.totalCostMicrocents,
          usageCoverage: breakdown.coverage,
        },
        INLINE_TRANSCRIPT_BOUND,
      );
      expect(view.usageCoverage).toEqual(before.coverage);
      expect(view.cumulativeCostMicrocents).toBe(breakdown.totalCostMicrocents);
      expect(createSessionUsageStore(client.db).loadCoverage(ownerId)).toEqual(before);
      expect(breakdown.totalCostMicrocents).toBe(session?.totalCostMicrocents);
      expect(breakdown.rows.reduce((sum, row) => sum + row.costMicrocents, 0)).toBe(
        breakdown.totalCostMicrocents,
      );
      const conservative = breakdown.rows.reduce((sum, row) => sum + row.conservativeMicrocents, 0);
      expect(conservative).toBe(session?.totalConservativeMicrocents);
      return {
        conservative,
        coverage: before.coverage,
        models: before.models,
        actual: breakdown.totalCostMicrocents,
        calls: breakdown.rows.reduce((sum, row) => sum + row.callCount, 0),
      };
    }
    const reader = createRunHistoryReader(client.db);
    const events = reader.loadRunEventLogForReplay(ownerId);
    const checkpoint = reconstructCheckpointState(events);
    if (checkpoint?.usageCoverage === undefined)
      throw new Error('missing initialized run coverage');
    const actual = reader.loadRun(ownerId)?.totalCostMicrocents;
    if (actual === undefined) throw new Error('missing run total');
    expect(
      reconstructCheckpointState(reader.loadRunEventLogForReplay(ownerId))?.usageCoverage,
    ).toEqual(checkpoint.usageCoverage);
    const paid = events.filter((event) => event.type === 'cost:attempt_settled');
    expect(paid.reduce((sum, event) => sum + event.costMicrocents, 0)).toBe(actual);
    return {
      conservative: checkpoint.conservativeCostMicrocents,
      coverage: checkpoint.usageCoverage.coverage,
      models: checkpoint.usageCoverage.models,
      actual,
      calls: paid.length,
    };
  } finally {
    client.sqlite.close();
  }
}

async function atCut(
  surface: Surface,
  route: Route,
  cut: Cut,
  cap: string,
  check: (state: Reopened, barrier: Barrier) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-usage-engine-crash-'));
  const path = join(root, 'history.db');
  const worker = startWorker(path, surface, route, cut, cap);
  try {
    const barrier = await worker.ready;
    if (['refuse-pending', 'credentials', 'cancel-before-invoke'].includes(cut)) {
      expect(barrier.kind).toBe('DONE');
      const closed = await worker.closed;
      expect(closed.code, closed.error).toBe(0);
    } else {
      expect(barrier.kind).toBe('CUT');
      worker.child.kill('SIGKILL');
      const closed = await worker.closed;
      expect(closed.signal, closed.error).toBe('SIGKILL');
    }
    const state = reopen(path, surface, barrier.ownerId);
    check(state, barrier);
    // A second fresh connection has the same amounts and qualification; display reads are inert.
    expect(reopen(path, surface, barrier.ownerId)).toEqual(state);
  } finally {
    worker.child.kill('SIGKILL');
    await worker.closed;
    rmSync(root, { recursive: true, force: true });
  }
}

describe('ADR-0104 actual engine and CLI host process crashes', () => {
  for (const cap of ['uncapped', 'capped']) {
    for (const surface of ['run', 'session'] as const) {
      const routes: readonly Route[] =
        surface === 'session' ? ['primary', 'failover', 'summarizer'] : ['primary', 'failover'];
      for (const route of routes)
        for (const cut of ['pending', 'invoked', 'settled'] as const) {
          it(`${surface} ${cap} ${route}: kill after ${cut} before owner acknowledgement`, async () => {
            await atCut(surface, route, cut, cap, (state, barrier) => {
              const earlierPaid = route === 'summarizer' ? 2 : 0;
              const completed = cut === 'settled';
              // Sessions retain their two-attempt primary policy; workflow authored retry bounds it to one.
              const earlierUnknown = route === 'failover' ? (surface === 'session' ? 2 : 1) : 0;
              expect(state.coverage).toEqual({
                unverified: false,
                pendingInvocations: completed ? 0 : 1,
                unknownCalls: earlierUnknown,
              });
              expect(state.actual).toBe(7 * (earlierPaid + Number(completed)));
              expect(state.calls).toBe(earlierPaid + Number(completed));
              expect(barrier.invocations).toBe(
                earlierPaid + earlierUnknown + Number(cut !== 'pending'),
              );
              const model = route === 'failover' ? 'usage-fallback' : 'usage-primary';
              expect(state.models.find((entry) => entry.model === model)?.coverage).toEqual({
                unverified: false,
                pendingInvocations: completed ? 0 : 1,
                unknownCalls: 0,
              });
              expect(isUsageCoverageComplete(state.coverage)).toBe(
                completed && route !== 'failover',
              );
            });
          }, 20_000);
        }
      for (const cut of ['credentials', 'cancel-before-invoke'] as const) {
        it(`${surface} ${cap}: ${cut} after durable pending releases uncertainty without money`, async () => {
          await atCut(surface, 'primary', cut, cap, (state, barrier) => {
            // A model coverage row survives retirement only if pending admission really happened.
            expect(state.models).toEqual([
              {
                model: 'usage-primary',
                coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
              },
            ]);
            expect(barrier.invocations).toBe(0);
            expect(state.actual).toBe(0);
            expect(state.calls).toBe(0);
            expect(state.coverage).toEqual({
              unverified: false,
              pendingInvocations: 0,
              unknownCalls: 0,
            });
          });
        }, 20_000);
      }
      it(`${surface} ${cap}: native pending write refusal proves zero provider invocations`, async () => {
        await atCut(surface, 'primary', 'refuse-pending', cap, (state, barrier) => {
          expect(barrier.invocations).toBe(0);
          expect(state.actual).toBe(0);
          expect(state.calls).toBe(0);
          expect(state.coverage).toEqual({
            unverified: false,
            pendingInvocations: 0,
            unknownCalls: 0,
          });
        });
      }, 20_000);
    }
  }
  for (const cap of ['uncapped', 'capped']) {
    for (const cut of [
      'late-receipt',
      'late-missing',
      'late-partial',
      'late-invalid',
      'late-rejected',
    ] as const) {
      it(`session ${cap} ${cut}: a final raw read settles or retires interrupted uncertainty exactly once`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'relavium-usage-late-receipt-'));
        const path = join(root, 'history.db');
        const worker = startWorker(path, 'session', 'primary', cut, cap);
        try {
          const entered = await worker.ready;
          expect(entered.kind).toBe('ENTERED');
          expect(entered.invocations).toBe(1);
          worker.child.stdin.write('ABORT\n');
          await worker.waitFor('INTERRUPTED');
          const interrupted = reopen(path, 'session', entered.ownerId);
          expect(interrupted.coverage).toEqual({
            unverified: false,
            pendingInvocations: 0,
            unknownCalls: 1,
          });
          expect(interrupted.actual).toBe(0);
          expect(interrupted.calls).toBe(0);
          if (cap === 'capped') expect(interrupted.conservative).toBeGreaterThan(0);
          else expect(interrupted.conservative).toBe(0);
          worker.child.stdin.end('RECEIPT\n');
          await worker.waitFor('DONE');
          const closed = await worker.closed;
          expect(closed.code, closed.error).toBe(0);
          const settled = reopen(path, 'session', entered.ownerId);
          expect(settled.coverage).toEqual({
            unverified: false,
            pendingInvocations: 0,
            unknownCalls: cut === 'late-receipt' ? 0 : 1,
          });
          expect(settled.actual).toBe(cut === 'late-receipt' ? 7 : 0);
          expect(settled.calls).toBe(cut === 'late-receipt' ? 1 : 0);
          expect(settled.conservative).toBe(interrupted.conservative);
          expect(reopen(path, 'session', entered.ownerId)).toEqual(settled);
        } finally {
          worker.child.kill('SIGKILL');
          await worker.closed;
          rmSync(root, { recursive: true, force: true });
        }
      }, 20_000);
    }
  }
  for (const cap of ['uncapped', 'capped'])
    for (const cut of ['lock-release', 'lock-hold'] as const) {
      it(`session ${cap}: pending ${cut} retries native SQLite before permitting egress`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'relavium-usage-lock-'));
        const path = join(root, 'history.db');
        const worker = startWorker(path, 'session', 'primary', cut, cap);
        let locker: ReturnType<typeof createClient> | undefined;
        try {
          const ready = await worker.ready;
          expect(ready.kind).toBe('LOCK_READY');
          locker = createClient(path);
          locker.sqlite.exec('BEGIN IMMEDIATE');
          worker.child.stdin.write('PROCEED\n');
          await worker.waitFor('BUSY');
          if (cut === 'lock-release') locker.sqlite.exec('COMMIT');
          const done = await worker.waitFor('DONE');
          if (cut === 'lock-hold') locker.sqlite.exec('ROLLBACK');
          worker.child.stdin.end();
          const closed = await worker.closed;
          expect(closed.code, closed.error).toBe(0);
          expect(done.invocations).toBe(cut === 'lock-release' ? 1 : 0);
          const state = reopen(path, 'session', ready.ownerId);
          expect(state.actual).toBe(cut === 'lock-release' ? 7 : 0);
          expect(state.calls).toBe(cut === 'lock-release' ? 1 : 0);
          expect(state.coverage).toEqual({
            unverified: false,
            pendingInvocations: 0,
            unknownCalls: 0,
          });
        } finally {
          worker.child.kill('SIGKILL');
          await worker.closed;
          if (locker?.sqlite.inTransaction) locker.sqlite.exec('ROLLBACK');
          locker?.sqlite.close();
          rmSync(root, { recursive: true, force: true });
        }
      }, 20_000);
    }
  it('causal control: bypassing the actual pending append destroys the invoked-crash coverage proof', async () => {
    await atCut('run', 'primary', 'omit-pending', 'uncapped', (state, barrier) => {
      expect(barrier.invocations).toBe(1);
      expect(state.actual).toBe(0);
      // Deliberately lowered host: the positive crash assertion (pending=1) would fail.
      expect(state.coverage.pendingInvocations).toBe(0);
      expect(isUsageCoverageComplete(state.coverage)).toBe(true);
    });
  }, 20_000);
});
