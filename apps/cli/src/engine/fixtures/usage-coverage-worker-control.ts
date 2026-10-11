import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
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
import { type UsageCoverage } from '@relavium/shared';
import { expect } from 'vitest';
import {
  initialSessionViewState,
  INLINE_TRANSCRIPT_BOUND,
} from '../../render/tui/session-view-model.js';

const workerPath = fileURLToPath(new URL('./usage-coverage-crash-worker.ts', import.meta.url));
const registerPath = fileURLToPath(new URL('./usage-coverage-crash-register.mjs', import.meta.url));
export type Surface = 'run' | 'session';
export type Route = 'primary' | 'failover' | 'summarizer';
export type Cut =
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
export interface Barrier {
  readonly kind: string;
  readonly ownerId: string;
  readonly invocations: number;
}
export interface NativeWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<Barrier>;
  readonly waitFor: (kind: string) => Promise<Barrier>;
  readonly closed: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error: string;
  }>;
}
function recordNative(value: unknown): void {
  const destination = process.env['RELAVIUM_USAGE_NATIVE_EVENTS'];
  if (destination !== undefined) appendFileSync(destination, `${JSON.stringify(value)}\n`);
}
export function startWorker(
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
  const identity = { callerPid: process.pid, pid: child.pid, surface, route, cut, cap };
  recordNative({ ...identity, stage: 'spawn' });
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
        recordNative({ ...identity, stage: 'barrier', ...barrier });
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
        recordNative({ ...identity, stage: 'close', code, signal });
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

export interface Reopened {
  readonly coverage: UsageCoverage;
  readonly actual: number;
  readonly calls: number;
  readonly conservative: number;
  readonly models: readonly { readonly model: string; readonly coverage: UsageCoverage }[];
}
export function reopen(path: string, surface: Surface, ownerId: string): Reopened {
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

export async function atCut(
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
