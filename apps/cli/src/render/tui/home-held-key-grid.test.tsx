/**
 * A key held on the Home's pages, through the REAL mounted `RootApp` (MVP-11 unit 7, round 1: SE71 and the gate card's lockout from its
 * appearance). Every key is a byte written to the terminal's input; whether a row or a card was on screen is the host's own evidence (its
 * measured and flushed frames: `homeFrameShown`, the gate card's `shown`), never the test's. The clock and the timers are injected so a grid
 * of held keys runs in moments and reads the same every time: the controller, the gate card's guard and the slide all run on it.
 *
 * - `↓ ⏎` while the pages slide never opens the row the slide arrives at (the `Enter` was pressed before the row was seen), coalesced in one
 *   chunk or a moment apart; inline (no slide) a row seen at rest opens as before.
 * - `⏎` on a seen gate row then `Ctrl+Y` HELD (the first press 5 ms after the `Enter`, its auto-repeat after an initial delay of 0 to 1800 ms
 *   at 30 or 100 ms) never approves the gate, with the slide (`↓ ⏎ Ctrl+Y` together) or without it; a deliberate `Ctrl+Y` two seconds after
 *   the card appeared does.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { HostedLaunch, RunHostSnapshot } from '../../home/run-host.js';
import type { ParkedRunRow } from './home-attention.js';
import { RootApp } from './home-app.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { flush, settleFrames, waitFor } from './harness-util.js';
import { APPROVAL_LOCKOUT_MS } from './tool-review-model.js';

afterEach(cleanup);

const DOWN = '\u001b[B';
const ENTER = '\r';
const CTRL_Y = '\u0019';
const RUN = 'run-0001';
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const STARTED: HostedLaunch = {
  kind: 'started',
  leg: 'resume',
  runId: RUN,
  ended: new Promise(() => undefined),
};
const sessionRow = (n: number): HomeSessionRow => ({
  sessionId: `session-${String(n)}`,
  workingDir: `/work/${String(n)}`,
  title: `Conversation ${String(n)}`,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});
const SESSIONS: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [sessionRow(1), sessionRow(2)],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 2, runs: 0 },
  isEmpty: false,
};
const NOTHING: HomeSnapshot = {
  ...SESSIONS,
  recentSessions: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const PARKED: ParkedRunRow = { runId: RUN, kind: 'approval', gates: 1 };
const APPROVAL_RUN: RunGates = {
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
/** When the person starts, on the injected clock: well after the Home's first frame. */
const START_AT = 10_000;
/** The first press of the held chord comes this long after the `Enter` (a hand going from one key to the next). */
const CHORD_AFTER_ENTER_MS = 5;
/** How long the chord stays down after its first auto-repeat. */
const HOLD_MS = 2_500;
const INITIAL_DELAYS_MS = [0, 250, 400, 450, 500, 600, 660, 1_800] as const;
const REPEAT_INTERVALS_MS = [30, 100] as const;
/** The yields a fired timer is given for the frames it causes (the arrival, and a card the keys that waited for it open) to paint. */
const FRAMES_PER_TIMER = 12;

function mount(options: { readonly slides: boolean; readonly gate?: boolean }) {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const resume = vi.fn(() => Promise.resolve(STARTED));
  const resumeChat = vi.fn(() => new Promise<undefined>(() => {}));
  const controller = createHomeController({
    startChat: () => new Promise<HomeChatSession>(() => {}),
    homeStore: { read: () => (options.gate === true ? NOTHING : SESSIONS) },
    resumeChat,
    hostedRuns: { snapshot: () => IDLE, cancel: () => true, close: () => Promise.resolve() },
    ...(options.gate === true
      ? {
          // The product's own guard numbers: no `guard` is passed.
          gateCards: {
            list: () => [PARKED],
            read: (id: string) => (id === RUN ? APPROVAL_RUN : undefined),
            resume,
          },
        }
      : {}),
    schedule: (run, delayMs) => {
      const timer = { at: now + delayMs, run };
      timers.push(timer);
      return () => {
        const at = timers.indexOf(timer);
        if (at >= 0) timers.splice(at, 1);
      };
    },
    now: () => now,
    slideTransitions: options.slides,
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
  const harness = render(
    <RootApp
      controller={controller}
      nowMs={() => 0}
      color={false}
      alternateScreen
      getSize={() => ({ cols: 80, rows: 24 })}
      subscribeResize={() => () => {}}
    />,
  );
  /**
   * Move the clock to `at`, firing every timer due on the way (the slide's frames, its settle bound) and letting what each one shows paint and be
   * acknowledged at its own instant: the arrival's frame, and what the keys that waited for it open (a terminal paints well inside the
   * milliseconds a held key's next repeat takes).
   */
  const advanceTo = async (at: number): Promise<void> => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (next === undefined || next.at > at) break;
      timers.shift();
      now = Math.max(now, next.at);
      next.run();
      await settleFrames(FRAMES_PER_TIMER);
    }
    now = Math.max(now, at);
  };
  /** One key at `at` on the clock: the bytes reach the host's one reader, which hands them on at once. */
  const keyAt = async (at: number, bytes: string): Promise<void> => {
    await advanceTo(at);
    harness.stdin.write(bytes);
    await flush();
  };
  return { controller, harness, resume, resumeChat, advanceTo, keyAt, now: () => now };
}

describe('`↓ ⏎` while the pages slide opens nothing the person has not seen', () => {
  it.each([
    ['in one chunk', -1],
    ['0 ms apart', 0],
    ['5 ms apart', 5],
    ['15 ms apart', 15],
    ['60 ms apart', 60],
    ['110 ms apart (the last frame before the arrival)', 110],
  ] as const)('%s', async (_name, gap) => {
    const m = mount({ slides: true });
    await settleFrames();
    if (gap < 0) await m.keyAt(START_AT, `${DOWN}${ENTER}`);
    else {
      await m.keyAt(START_AT, DOWN);
      await m.keyAt(START_AT + gap, ENTER);
    }
    await m.advanceTo(START_AT + 1_000);
    await settleFrames();
    expect(m.controller.getSnapshot().stripFocus?.id, 'the slide arrived on the row').toBe(
      'session-1',
    );
    expect(m.resumeChat).not.toHaveBeenCalled();
  });

  it('150 ms apart the slide has arrived and its frame is on screen: the row was seen at rest, and `Enter` opens it', async () => {
    const m = mount({ slides: true });
    await settleFrames();
    await m.keyAt(START_AT, DOWN);
    await m.keyAt(START_AT + 150, ENTER);
    await waitFor(() => m.resumeChat.mock.calls.length > 0);
    expect(m.resumeChat).toHaveBeenCalledWith('session-1');
  });

  it('inline, the row the person has seen at rest opens on `Enter` as before', async () => {
    const m = mount({ slides: false });
    await settleFrames();
    await m.keyAt(START_AT, DOWN);
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('Enter resume'));
    await settleFrames();
    await m.keyAt(START_AT + 300, ENTER);
    await waitFor(() => m.resumeChat.mock.calls.length > 0);
    expect(m.resumeChat).toHaveBeenCalledWith('session-1');
  });
});

/**
 * `⏎` on the gate row, then `Ctrl+Y` pressed {@link CHORD_AFTER_ENTER_MS} later and held: its first auto-repeat after `initial`, then one every
 * `interval`, for {@link HOLD_MS}. With `slides` the `↓` that reaches the row is pressed with them (`↓ ⏎ Ctrl+Y`); without, the row was seen at
 * rest first.
 */
async function heldOnTheGate(slides: boolean, initial: number, interval: number) {
  const m = mount({ slides, gate: true });
  await settleFrames();
  let enterAt = START_AT;
  if (slides) await m.keyAt(START_AT - 5, DOWN);
  else {
    await m.keyAt(START_AT - 1_000, DOWN);
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('Enter open the gate'));
    await settleFrames();
    enterAt = START_AT;
  }
  await m.keyAt(enterAt, ENTER);
  const first = enterAt + CHORD_AFTER_ENTER_MS;
  await m.keyAt(first, CTRL_Y);
  await settleFrames(); // whatever opened is painted and acknowledged from here
  for (let at = first + initial; at <= first + initial + HOLD_MS; at += interval)
    await m.keyAt(at, CTRL_Y);
  await settleFrames();
  return m;
}

describe('a `Ctrl+Y` held from the `Enter` that opened the gate card never approves the gate', () => {
  for (const slides of [false, true])
    for (const initial of INITIAL_DELAYS_MS)
      for (const interval of REPEAT_INTERVALS_MS)
        it(`${slides ? '↓ ⏎ Ctrl+Y while the pages slide' : '⏎ on a seen row'}: initial ${String(initial)} ms, every ${String(interval)} ms`, async () => {
          const m = await heldOnTheGate(slides, initial, interval);
          expect(m.resume).not.toHaveBeenCalled();
        });

  it('a deliberate `Ctrl+Y` two seconds after the card appeared approves it', async () => {
    const m = mount({ slides: false, gate: true });
    await settleFrames();
    await m.keyAt(START_AT - 1_000, DOWN);
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('Enter open the gate'));
    await settleFrames();
    await m.keyAt(START_AT, ENTER);
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('[Ctrl+Y] Approve'));
    await settleFrames();
    await m.keyAt(START_AT + APPROVAL_LOCKOUT_MS, CTRL_Y);
    await waitFor(() => m.resume.mock.calls.length > 0);
    expect(m.resume).toHaveBeenCalledOnce();
  });
});
