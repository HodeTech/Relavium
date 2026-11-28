/**
 * The wait clock is display state that no snapshot carries and no guard reads
 * ([ADR-0147](../../../../../docs/decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md) §2), and a pending sheet
 * no longer repaints at the frame rate. Three claims, each with the evidence the ADR asks for:
 *
 * 1. **The store's tick is gated.** A running turn repaints on every tick (its spinner animates); a turn blocked on the person (an approval,
 *    the agent's question, the continue checkpoint) repaints on none, unless something changed. The confirmation of a wider grant, which
 *    lapses with time, is the one thing a card shows that the tick still refreshes.
 * 2. **The acknowledgement survives a thousand ticks.** The card's state is the same object across them, the host's re-acknowledgement of the
 *    same frame does not restart the dwell, and a `Ctrl+Y` right after the last tick counts. The mutation that gives a tick a new state (the
 *    elapsed text in a snapshot) fails it.
 * 3. **Shifting the display clock changes no guard outcome.** The clock is derived from the wall clock (`Date.now`); the guards of the three
 *    sheets that wear it (the approval's dwell, the question's settle, the checkpoint's dwell) run on the monotonic clock (`performance.now`)
 *    from their own origins. A wall clock stepped an hour either way moves the clock's text and nothing else. (The question's settle read the
 *    wall clock until unit 8's fix wave, S-5: stepped back, it refused every choosing key for as long as it was stepped.)
 *
 * The clocks are faked (`Date` and `performance` only): `vi.advanceTimersByTime` moves both, `vi.setSystemTime` steps only the wall clock.
 */
import type {
  AskUserRequest,
  SessionStreamHandleEvent,
  ToolApprovalRequest,
  ToolPreview,
} from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatStore, type ChatStoreController } from './chat-store.js';
import { editedFilePreview } from './fixtures/edit-diff.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { QUESTION_SETTLE_MS } from './question-card-model.js';
import { APPROVAL_SETTLE_MS, toolReviewPage, type ApprovalGuard } from './tool-review-model.js';
import { waitClockText } from './sheet-frame.js';
import { waitClockFor } from './wait-clock.js';

const START = Date.parse('2026-11-27T09:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

const started: SessionStreamHandleEvent = {
  type: 'session:started',
  sessionId: 'sess-1',
  sequenceNumber: 0,
  timestamp: '2026-11-27T09:00:00.000Z',
  agentRef: 'relavium-chat',
  model: 'claude-sonnet-4-6',
  context: { workingDir: '/w', fsScopeTier: 'sandboxed' },
};
const turnStarted: SessionStreamHandleEvent = {
  type: 'session:turn_started',
  sessionId: 'sess-1',
  sequenceNumber: 1,
  timestamp: '2026-11-27T09:00:01.000Z',
};
const token: SessionStreamHandleEvent = {
  type: 'agent:token',
  sessionId: 'sess-1',
  sequenceNumber: 2,
  timestamp: '2026-11-27T09:00:02.000Z',
  nodeId: 'relavium-chat',
  token: 'more',
  model: 'claude-sonnet-4-6',
};
const REQUEST: ToolApprovalRequest = {
  toolId: 'edit_file',
  action: 'fs_write',
  preview: { path: 'src/app.ts' },
  unredactedPreview: { path: 'src/app.ts' },
};
const PREVIEW: ToolPreview = editedFilePreview(8, { 4: 'four' });
const QUESTION: AskUserRequest = {
  questions: [
    {
      header: 'Pick',
      question: 'Which file?',
      multiSelect: false,
      options: [
        { label: 'a.ts', description: 'first' },
        { label: 'b.ts', description: 'second' },
      ],
    },
  ],
};

/** A store whose turn is running, with a count of its repaints (every listener call is one flush). */
function runningStore(guard?: ApprovalGuard): {
  readonly store: ChatStoreController;
  readonly flushes: () => number;
} {
  const store = createChatStore(
    false,
    undefined,
    INLINE_TRANSCRIPT_BOUND,
    guard === undefined ? undefined : { approvalGuard: guard },
  );
  store.apply(started);
  store.apply(turnStarted);
  expect(store.getSnapshot().state.status).toBe('running');
  let count = 0;
  store.subscribe(() => {
    count += 1;
  });
  return { store, flushes: () => count };
}

const ticks = (store: ChatStoreController, n: number, msEach = 0): void => {
  for (let i = 0; i < n; i += 1) {
    if (msEach > 0) vi.advanceTimersByTime(msEach);
    store.tick();
  }
};

const CARDS: readonly {
  readonly name: string;
  readonly open: (store: ChatStoreController) => void;
}[] = [
  {
    name: 'an approval',
    open: (store) => {
      void store
        .requestApproval(REQUEST, true, undefined, { callId: 'c1', preview: PREVIEW })
        .catch(() => undefined);
    },
  },
  {
    name: 'the agent’s question',
    open: (store) => {
      void store.requestQuestion(QUESTION).catch(() => undefined);
    },
  },
  {
    name: 'the continue checkpoint',
    open: (store) => {
      void store.requestCheckpoint({ rounds: 12, interval: 8 }).catch(() => undefined);
    },
  },
];

describe('the store’s tick is gated while a sheet waits for the person (ADR-0147 §2)', () => {
  it('a running turn with no card repaints on every tick: its spinner animates', () => {
    const { store, flushes } = runningStore();
    ticks(store, 25);
    expect(flushes()).toBe(25);
  });

  it.each(CARDS)('with $name open, a thousand ticks repaint nothing', ({ open }) => {
    const { store, flushes } = runningStore();
    open(store);
    const before = flushes();
    const snapshot = store.getSnapshot();
    ticks(store, 1000, 80);
    expect(flushes(), 'no flush while the turn is blocked on the person').toBe(before);
    expect(store.getSnapshot(), 'the snapshot is the very same object').toBe(snapshot);
  });

  it('something that changed under a waiting card is still drawn, once, on the next tick', () => {
    const { store, flushes } = runningStore();
    CARDS[0]?.open(store);
    const before = flushes();
    store.apply(token); // a coalesced event: it marks the store dirty
    ticks(store, 10);
    expect(flushes()).toBe(before + 1);
  });

  it('the confirmation of a wider grant lapses with time, so the tick redraws it until the frame no longer asks', () => {
    const { store, flushes } = runningStore({
      settleMs: 0,
      quietMs: 0,
      typeaheadMs: 0,
      lockoutMs: 0,
      confirmAlways: true,
    });
    CARDS[0]?.open(store);
    store.bindReviewVisibility(() => true);
    const review = store.getSnapshot().review;
    if (review === undefined) throw new Error('no card');
    store.acknowledgeReviewFrame(review, toolReviewPage(review, 80, 24));
    store.handleReviewInput('g', { ctrl: true }); // the first step of the session-wide grant: it asks
    expect(store.getSnapshot().alwaysConfirm, 'the card asks the confirmation').toBe(true);
    const asked = flushes();
    ticks(store, 10, 80);
    expect(flushes(), 'the tick keeps the lapsing question current').toBe(asked + 10);
    vi.advanceTimersByTime(5_000); // the question's window has passed
    store.tick();
    expect(store.getSnapshot().alwaysConfirm, 'the lapsed question is gone from the frame').toBe(
      false,
    );
    const lapsed = flushes();
    ticks(store, 100, 80);
    expect(flushes(), 'and the card waits quietly again').toBe(lapsed);
  });

  it('the repaints come back the moment the card is answered and the turn runs on', () => {
    const { store, flushes } = runningStore();
    CARDS[0]?.open(store);
    store.answerApproval({ outcome: 'reject' });
    const before = flushes();
    ticks(store, 10);
    expect(flushes()).toBe(before + 10);
  });
});

/**
 * A store wired as the host wires it: the card is visible exactly while its current state has been shown, and the host acknowledges the
 * frame again on every commit (`ToolReviewHost`'s layout effect runs on each render, the clock's re-render included).
 */
function cardRig() {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND); // the real guard
  let shown: unknown;
  store.bindReviewVisibility(() => shown !== undefined && store.getSnapshot().review === shown);
  const answers: unknown[] = [];
  void store
    .requestApproval(REQUEST, true, undefined, { callId: 'c1', preview: PREVIEW })
    .then((answer) => answers.push(answer));
  /** One commit of the host: the current state is measured, flushed and acknowledged. */
  const commit = (): void => {
    const review = store.getSnapshot().review;
    if (review === undefined) return;
    shown = review;
    store.acknowledgeReviewFrame(review, toolReviewPage(review, 80, 24));
  };
  return { store, answers, commit };
}

describe('a thousand ticks leave the acknowledgement valid and the dwell untouched (ADR-0147 §2)', () => {
  it('the card’s state is one object across them, and a Ctrl+Y right after the last one counts', async () => {
    const { store, answers, commit } = cardRig();
    commit(); // the first acknowledged frame: the dwell counts from here
    const review = store.getSnapshot().review;
    for (let i = 0; i < 1000; i += 1) {
      vi.advanceTimersByTime(1000); // the clock's second
      store.tick(); // the store's frame loop goes on running
      commit(); // the clock's re-render: the host commits the same frame again
    }
    expect(store.getSnapshot().review, 'no tick made a new card state').toBe(review);
    // One millisecond after the last tick: far inside a dwell that a tick would have restarted, far outside the one that ran from the
    // first acknowledged frame.
    vi.advanceTimersByTime(1);
    expect(1).toBeLessThan(APPROVAL_SETTLE_MS);
    expect(store.handleReviewInput('y', { ctrl: true })).toBe('handled');
    await Promise.resolve();
    expect(answers).toEqual([{ outcome: 'approve', scope: 'once' }]);
  });
});

describe('shifting the display clock changes no guard outcome (ADR-0147 §2, MVP-11 §5.5 rule 15)', () => {
  /** What a `Ctrl+Y` pressed `afterMs` after the first acknowledged frame does, with the wall clock stepped by `shiftMs` in between. */
  async function outcome(
    afterMs: number,
    shiftMs: number,
  ): Promise<{
    readonly answered: boolean;
    readonly clockBefore: string;
    readonly clockAfter: string;
  }> {
    const { store, answers, commit } = cardRig();
    commit();
    const since = store.getSnapshot().state.approvalSinceMs;
    const clockBefore = waitClockFor(since, 'ticking', Date.now());
    vi.advanceTimersByTime(afterMs);
    vi.setSystemTime(Date.now() + shiftMs); // the wall clock only: NTP, a hand-set clock, a suspended laptop
    commit();
    const clockAfter = waitClockFor(since, 'ticking', Date.now());
    store.handleReviewInput('y', { ctrl: true });
    await Promise.resolve();
    return { answered: answers.length > 0, clockBefore, clockAfter };
  }

  it.each([
    ['an hour forward', 3_600_000],
    ['an hour back', -3_600_000],
    ['a day forward', 86_400_000],
  ])(
    '%s: a press inside the dwell is still refused, and one after it still counts',
    async (_label, shift) => {
      const early = APPROVAL_SETTLE_MS - 100;
      const late = APPROVAL_SETTLE_MS + 100;
      const unshifted = [await outcome(early, 0), await outcome(late, 0)];
      const shifted = [await outcome(early, shift), await outcome(late, shift)];
      expect(unshifted.map((o) => o.answered)).toEqual([false, true]);
      expect(
        shifted.map((o) => o.answered),
        'the same outcomes with the wall clock stepped',
      ).toEqual([false, true]);
      // The display did move: the clock read the stepped wall clock (a clock stepped back below the origin reads no wait), the guard did not.
      expect(shifted[1]?.clockAfter).toBe(waitClockText(late + shift));
      expect(unshifted[1]?.clockAfter).toBe(waitClockText(late));
    },
  );

  /**
   * The other two sheets that wear the clock (unit 8 fix wave, S-5/M-14): the question's settle and the checkpoint's dwell. What a choosing
   * key (the question's `1`) or a `Ctrl+Y` (the checkpoint's continue) pressed `afterMs` after the sheet was on screen does, the wall clock
   * stepped by `shiftMs` in between.
   */
  async function sheetOutcome(
    kind: 'question' | 'checkpoint',
    afterMs: number,
    shiftMs: number,
  ): Promise<boolean> {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND); // the real guard
    const answers: unknown[] = [];
    if (kind === 'question') {
      void store.requestQuestion(QUESTION).then((answer) => answers.push(answer));
      store.bindQuestionVisibility(() => true);
    } else {
      void store
        .requestCheckpoint({ rounds: 12, interval: 8 })
        .then((answer) => answers.push(answer));
      store.bindCheckpointVisibility(() => true);
      const frame = store.getSnapshot().checkpointFrame;
      if (frame === undefined) throw new Error('no checkpoint frame');
      store.acknowledgeCheckpointFrame(frame);
    }
    vi.advanceTimersByTime(afterMs);
    vi.setSystemTime(Date.now() + shiftMs);
    if (kind === 'question') store.handleReviewInput('1', {});
    else store.handleReviewInput('y', { ctrl: true });
    await Promise.resolve();
    return answers.length > 0;
  }

  it.each([
    ['question', 'an hour forward', 3_600_000],
    ['question', 'an hour back', -3_600_000],
    ['question', 'a day forward', 86_400_000],
    ['checkpoint', 'an hour forward', 3_600_000],
    ['checkpoint', 'an hour back', -3_600_000],
  ] as const)(
    'the %s, the wall clock %s: a key inside its settle is still refused, and one after it still counts',
    async (kind, _label, shift) => {
      const settle = kind === 'question' ? QUESTION_SETTLE_MS : APPROVAL_SETTLE_MS;
      const unshifted = [
        await sheetOutcome(kind, settle - 100, 0),
        await sheetOutcome(kind, settle + 100, 0),
      ];
      const shifted = [
        await sheetOutcome(kind, settle - 100, shift),
        await sheetOutcome(kind, settle + 100, shift),
      ];
      expect(unshifted).toEqual([false, true]);
      expect(shifted, 'the same outcomes with the wall clock stepped').toEqual([false, true]);
    },
  );

  it('the clock’s own text follows the wall clock and is quantised to what it shows', () => {
    const since = Date.now();
    expect(waitClockFor(since, 'ticking', since + 41_000)).toBe('waiting 0:41');
    expect(waitClockFor(since, 'ticking', since + 67 * 60_000)).toBe('waiting 1h 07m');
    expect(waitClockFor(undefined, 'ticking', since), 'no card: no clock').toBe('');
    expect(
      waitClockFor(since, 'static', since + 3_600_000),
      'inline: the origin, not a count',
    ).toMatch(/^waiting since \d\d:\d\d$/u);
    // The inline form reads the day against the host's `now`, not the process clock (S-3): seen the same day it is the time alone, seen two
    // days later it names the day.
    const earlier = since - 3 * 86_400_000;
    expect(waitClockFor(earlier, 'static', earlier + 60_000)).toMatch(/^waiting since \d\d:\d\d$/u);
    expect(waitClockFor(earlier, 'static', earlier + 2 * 86_400_000)).toMatch(
      /^waiting since [A-Z][a-z]{2} \d{1,2} \d\d:\d\d$/u,
    );
  });
});
