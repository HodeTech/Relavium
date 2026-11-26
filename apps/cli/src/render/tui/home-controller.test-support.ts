/**
 * What the controller's mutation pins share (MVP-11 unit 7, round 2): the Home's snapshot as a scripted read, one session row and one run row,
 * the key objects, and the two ways of letting a promise chain settle. Fixtures only: nothing here asserts, and nothing here is imported by the
 * product.
 */
import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { ChatKey } from './chat-input.js';
import type { ApprovalGuard } from './tool-review-model.js';

/** A guard with no dwell, quiet gap, type-ahead window or lockout: the card answers on the first chord. */
export const GUARD_OFF: ApprovalGuard = { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 };
export const DOWN: ChatKey = { downArrow: true };
export const ENTER: ChatKey = { return: true };
export const ESC: ChatKey = { escape: true };
export const CTRL: ChatKey = { ctrl: true };
/** The run host with nothing launching and nothing active. */
export const IDLE_HOST: RunHostSnapshot = { launching: false, active: undefined, last: undefined };

/** Let the resolved promises of one handler's chain run. */
export const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};

/** Wait (a bounded number of macrotasks) until `predicate` holds. */
export async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !predicate(); turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

export const sessionRow = (sessionId: string): HomeSessionRow => ({
  sessionId,
  title: undefined,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});

export const runRow = (runId: string): HomeRunRow => ({
  runId,
  workflowSlug: 'wf',
  status: 'completed',
  createdAt: '2026-11-23T00:00:00.000Z',
  startedAt: undefined,
  completedAt: undefined,
  totalCostMicrocents: 0,
});

/** A snapshot of an otherwise empty directory, with `over` laid on it. */
export const snapshotOf = (over: Partial<HomeSnapshot>): HomeSnapshot => ({
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: false,
  ...over,
});
