/**
 * Where the focus is after a screen opened from a row of the work page closes (MVP-11 unit 7, round 1: OB77). The page it returns to is the
 * work page, and the focus is the ROW it was opened from, by its identity, not the docked prompt: a gate card answered and left with `Esc`, a
 * run's view left with `Esc`. A row that is no longer listed (the gate was answered, so the run is no longer parked) leaves the focus on the row
 * that now stands where it stood (the nearest one), or on the docked prompt when the list is empty. A session row's resume that does not open
 * the conversation (a cancelled restore) leaves the focus on the session. Through the real controller; the run host, the reads and the
 * resume are scripted.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { HostedLaunch, RunHostSnapshot } from '../../home/run-host.js';
import type { ParkedRunRow } from './home-attention.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import type { ApprovalGuard } from './tool-review-model.js';

const OFF: ApprovalGuard = { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 };
const DOWN = { downArrow: true } as const;
const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const CTRL = { ctrl: true } as const;
const RUN = 'run-gate';
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const runRow = (runId: string, status: HomeRunRow['status']): HomeRunRow => ({
  runId,
  workflowSlug: 'wf',
  status,
  createdAt: '2026-11-23T00:00:00.000Z',
  startedAt: undefined,
  completedAt: undefined,
  totalCostMicrocents: 0,
});
const sessionRow = (sessionId: string): HomeSessionRow => ({
  sessionId,
  title: undefined,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});
/** The parked run first (its own row), then a failed run, a session and a recent run. */
const SNAPSHOT: HomeSnapshot = {
  failedRuns: [runRow('run-failed', 'failed')],
  recentSessions: [sessionRow('s1')],
  recentRuns: [runRow('run-live', 'running')],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 2, sessions: 1, runs: 1 },
  isEmpty: false,
};
const PARKED: ParkedRunRow = { runId: RUN, kind: 'approval', gates: 1 };
const GATES: RunGates = {
  runId: RUN,
  workflowId: 'wf',
  gates: [
    {
      runId: RUN,
      gateId: 'g1',
      nodeId: 'review',
      gateType: 'approval',
      message: 'Ship?',
      accepts: ['approved', 'rejected'],
    },
  ],
  budgetGates: [],
  degraded: false,
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};

function rig() {
  let host: RunHostSnapshot = IDLE;
  let parked: readonly ParkedRunRow[] = [PARKED];
  const resume = vi.fn((): Promise<HostedLaunch> => {
    // The answer starts a leg on the run: it is executing, and no longer parked here.
    host = {
      launching: false,
      active: { leg: 'resume', runId: RUN, cancelling: false },
      last: undefined,
    };
    parked = [];
    return Promise.resolve({
      kind: 'started',
      leg: 'resume',
      runId: RUN,
      ended: new Promise(() => undefined),
    });
  });
  const controller = createHomeController({
    startChat: () => new Promise<HomeChatSession>(() => {}),
    homeStore: { read: () => SNAPSHOT },
    resumeChat: () => Promise.resolve(undefined), // the restore was cancelled
    announce: () => {},
    hostedRuns: { snapshot: () => host, cancel: () => true, close: () => Promise.resolve() },
    gateCards: {
      list: () => parked,
      read: (id) => (id === RUN ? GATES : undefined),
      resume,
      guard: OFF,
    },
    schedule: () => () => {},
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
  controller.bindGateCardFrame(() => true);
  return {
    controller,
    resume,
    state: () => controller.getSnapshot(),
    focus: () => controller.getSnapshot().stripFocus?.id,
    press: (key: object): void => controller.handleKey('', key),
    setHost: (next: RunHostSnapshot): void => {
      host = next;
    },
  };
}

describe('a screen opened from a row of the work page gives the focus back to that row when it closes', () => {
  it('a gate card answered and left: the run is no longer parked, so the focus is on the row that now stands where it stood', async () => {
    const r = rig();
    r.press(DOWN);
    expect(r.focus()).toBe(RUN);
    r.press(ENTER);
    expect(r.state().screen?.kind).toBe('gate-card');
    r.controller.handleKey('y', CTRL);
    await settle();
    expect(r.resume).toHaveBeenCalledOnce();
    r.press(ESC);
    expect(r.state().screen).toBeUndefined();
    expect(r.state().homePage).toBe('work');
    expect(r.focus(), 'the nearest row, not the docked prompt').toBe('run-failed');
  });

  it('a gate card left unanswered: the focus is on the gate’s row again', () => {
    const r = rig();
    r.press(DOWN);
    r.press(ENTER);
    expect(r.state().screen?.kind).toBe('gate-card');
    r.press(ESC);
    expect(r.state().screen).toBeUndefined();
    expect(r.focus()).toBe(RUN);
  });

  it('the view of the run this Home hosts, opened from its row and left: the focus is on its row', () => {
    const r = rig();
    r.setHost({
      launching: false,
      active: { leg: 'start', runId: 'run-live', cancelling: false },
      last: undefined,
    });
    r.press(DOWN);
    r.press(DOWN);
    r.press(DOWN);
    r.press(DOWN);
    expect(r.focus()).toBe('run-live');
    r.press(ENTER);
    expect(r.state().screen?.kind).toBe('run-view');
    r.press(ESC);
    expect(r.state().screen).toBeUndefined();
    expect(r.focus()).toBe('run-live');
  });

  it('a session whose restore was cancelled: the focus stays on the session', async () => {
    const r = rig();
    r.press(DOWN);
    r.press(DOWN);
    r.press(DOWN);
    expect(r.focus()).toBe('s1');
    r.press(ENTER);
    await settle();
    await settle();
    expect(r.state().mode).toBe('home');
    expect(r.state().homePage).toBe('work');
    expect(r.focus()).toBe('s1');
  });
});
