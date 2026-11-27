/**
 * The Home's gate card as a sheet (MVP-11 unit 8, ADR-0147 §1 and §2), opened the way a person opens it (`↓` onto the Attention row, `Enter`):
 *
 * - **The wait clock's origin** is when the run parked (`parkedSince`, the run row's `updated_at`), else the moment the card opened: a display
 *   value on the screen record, never in the card's snapshot, read by no guard.
 * - **The frame**: the rule says `Waiting for you`, and the guarded keys say `(wait)` from the card's appearance until its lockout opens.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { HostedLaunch, RunHostSnapshot } from '../../home/run-host.js';
import { settleFrames, withoutStyles } from './harness-util.js';
import { RootApp } from './home-app.js';
import type { ParkedRunRow } from './home-attention.js';
import {
  createHomeController,
  type HomeController,
  type HomeControllerState,
  type HomeGateCardsPort,
} from './home-controller.js';
import { waitSinceText } from './sheet-frame.js';

afterEach(cleanup);

const RUN = 'run-0001';
const DOWN = '\x1b[B';
const ENTER = '\r';
const PARKED_SINCE = '2026-11-27T08:00:00.000Z';
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const ROW: ParkedRunRow = { runId: RUN, kind: 'approval', gates: 1 };
const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 1, sessions: 0, runs: 0 },
  isEmpty: true,
};
const run = (parkedSince: string | undefined): RunGates => ({
  runId: RUN,
  workflowId: 'wf',
  gates: [
    {
      runId: RUN,
      gateId: 'g1',
      nodeId: 'review-step',
      gateType: 'approval',
      message: 'Ship the release?',
      accepts: ['approved', 'rejected'],
    },
  ],
  budgetGates: [],
  ...(parkedSince === undefined ? {} : { parkedSince }),
  degraded: false,
});

async function eventually(predicate: () => boolean, what: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) throw new Error(`${what} was not reached`);
    },
    { timeout: 5_000, interval: 5 },
  );
}

/** The Home with one parked run of this directory, its card opened with `↓` and `Enter`. */
async function opened(parkedSince: string | undefined) {
  const resume = vi.fn(
    (): Promise<HostedLaunch> => Promise.resolve({ kind: 'settled', message: 'nothing to resume' }),
  );
  const gateCards: HomeGateCardsPort = {
    list: () => [ROW],
    read: (runId) => (runId === RUN ? run(parkedSince) : undefined),
    resume,
  };
  const real = createHomeController({
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => EMPTY },
    hostedRuns: { snapshot: () => IDLE, cancel: () => false, close: () => Promise.resolve() },
    gateCards,
    schedule: () => () => {},
    onExit: vi.fn(),
    onError: vi.fn(),
  });
  let homeVisible: ((state: HomeControllerState) => boolean) | undefined;
  const controller: HomeController = {
    ...real,
    bindHomeFrame: (visible) => {
      homeVisible = visible;
      real.bindHomeFrame(visible);
    },
  };
  const harness = render(
    <RootApp
      controller={controller}
      nowMs={() => 0}
      color={false}
      getSize={() => ({ cols: 80, rows: 24 })}
      subscribeResize={() => () => {}}
    />,
  );
  const frame = (): string => withoutStyles(harness.lastFrame() ?? '');
  await settleFrames();
  harness.stdin.write(DOWN);
  await eventually(() => controller.getSnapshot().stripFocus?.id !== undefined, 'the row focus');
  await eventually(
    () => frame().includes('Enter open') && homeVisible?.(controller.getSnapshot()) === true,
    'the focused row on screen',
  );
  const before = Date.now();
  harness.stdin.write(ENTER);
  await eventually(() => controller.getSnapshot().screen?.kind === 'gate-card', 'the card');
  const after = Date.now();
  await eventually(() => frame().includes('Waiting for you'), 'the card’s frame');
  return { controller, frame, before, after };
}

describe('the gate card’s wait clock starts when the run parked', () => {
  it('parkedSince is the origin: the screen record carries it, the card’s snapshot does not', async () => {
    const m = await opened(PARKED_SINCE);
    const screen = m.controller.getSnapshot().screen;
    if (screen?.kind !== 'gate-card') throw new Error('no card');
    expect(screen.waitingSinceMs).toBe(Date.parse(PARKED_SINCE));
    expect(Object.keys(screen.card.getSnapshot())).not.toContain('waitingSinceMs');
    // Inline the clock is the static origin, in the rule.
    // (the text the card draws names the day once the run parked before today, so the expectation is the formatter's own text for that origin)
    expect(m.frame()).toMatch(
      new RegExp(
        `^== Waiting for you =+ ${waitSinceText(Date.parse(PARKED_SINCE)).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} ==$`,
        'mu',
      ),
    );
  });

  it('with no parkedSince it is the moment the card opened', async () => {
    const m = await opened(undefined);
    const screen = m.controller.getSnapshot().screen;
    if (screen?.kind !== 'gate-card') throw new Error('no card');
    expect(screen.waitingSinceMs).toBeGreaterThanOrEqual(m.before);
    expect(screen.waitingSinceMs).toBeLessThanOrEqual(m.after);
  });

  it('a parkedSince that is not a time is the moment the card opened, never NaN', async () => {
    const m = await opened('not a time');
    const screen = m.controller.getSnapshot().screen;
    if (screen?.kind !== 'gate-card') throw new Error('no card');
    expect(Number.isFinite(screen.waitingSinceMs)).toBe(true);
    expect(screen.waitingSinceMs).toBeGreaterThanOrEqual(m.before);
  });
});

describe('the gate card says (wait) from its appearance', () => {
  it('Approve and Reject wait, and the rule says Waiting for you', async () => {
    const m = await opened(PARKED_SINCE);
    expect(m.frame()).toContain(
      '[Ctrl+Y] Approve (wait) · [Ctrl+N] Reject (wait) · Esc leaves it pending',
    );
    // The product's lockout opens two seconds after the card appeared: the legend flips once then.
    await eventually(
      () => m.frame().includes('[Ctrl+Y] Approve · [Ctrl+N] Reject · Esc leaves it pending'),
      'the legend flipped',
    );
  });
});
