/**
 * The continue-checkpoint card in the chat store (ADR-0136 §2 and §4, ADR-0115 §1). The pure key table is in
 * `checkpoint-card.test.ts`; this pins what the store does with it: the card publishes and settles the engine's hook, a stop is an
 * ANSWER that is never delayed, `Ctrl+Y` spends and so clears the approval guards, an abort or a seal is a cancellation and never
 * an answer, and the person's wait is not the turn's work.
 *
 * The clock is the monotonic one (`performance.now()`), as in the approval guard tests, so each case reads like its timeline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatStore, type ChatStoreController } from './chat-store.js';
import { errorRecoveryHint, formatTurnSummary } from './chat-projection.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import {
  APPROVAL_LOCKOUT_MS,
  APPROVAL_QUIET_MS,
  APPROVAL_SETTLE_MS,
  APPROVAL_TYPEAHEAD_MS,
} from './tool-review-model.js';

const START = Date.parse('2026-11-19T10:00:00.000Z');
let origin = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  vi.setSystemTime(START);
  origin = performance.now();
});
afterEach(() => {
  vi.useRealTimers();
});
const at = (ms: number): void => {
  const delta = origin + ms - performance.now();
  if (delta < -1e-6) throw new Error(`the clock cannot run backwards (${delta} ms)`);
  vi.advanceTimersByTime(Math.max(0, delta));
};

const CTRL = { ctrl: true } as const;
const INFO = { rounds: 32, interval: 32 };

interface Rig {
  readonly store: ChatStoreController;
  /** What the engine's hook settled as, or `undefined` while it is still pending. */
  readonly answer: () => unknown;
  /** The hook's rejection, if it rejected. */
  readonly rejected: () => unknown;
  /** Open a card, and (unless `shown` is false) acknowledge its frame the way the host does after a flush. */
  readonly open: (options?: { shown?: boolean; signal?: AbortSignal }) => void;
  readonly show: () => void;
  readonly key: (
    input: string,
    key?: Parameters<ChatStoreController['handleReviewInput']>[1],
  ) => ReturnType<ChatStoreController['handleReviewInput']>;
  readonly visible: (value: boolean) => void;
}

function rig(): Rig {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  let answer: unknown;
  let rejected: unknown;
  let visible = true;
  store.bindCheckpointVisibility(() => visible);
  const show = (): void => {
    const frame = store.getSnapshot().checkpointFrame;
    if (frame !== undefined) store.acknowledgeCheckpointFrame(frame);
  };
  return {
    store,
    answer: () => answer,
    rejected: () => rejected,
    open: (options = {}) => {
      void store.requestCheckpoint(INFO, options.signal).then(
        (value) => {
          answer = value;
        },
        (reason: unknown) => {
          rejected = reason;
        },
      );
      if (options.shown !== false) show();
    },
    show,
    key: (input, key = {}) => store.handleReviewInput(input, key),
    visible: (value) => {
      visible = value;
    },
  };
}

/** Let the hook's promise callbacks run. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const TURN_STARTED_AT = (msAgo: number) =>
  ({
    type: 'session:turn_started',
    sessionId: 's',
    sequenceNumber: 1,
    timestamp: new Date(Date.now() - msAgo).toISOString(),
  }) as const;

const TURN_LIMIT_ENDED = {
  type: 'session:turn_completed',
  sessionId: 's',
  sequenceNumber: 2,
  timestamp: '2026-11-19T11:00:00.000Z',
  stopReason: 'error',
  tokensUsed: { input: 1, output: 1 },
  error: { code: 'turn_limit', message: 'stopped', retryable: false },
} as const;

describe('the card opens and says what it was told', () => {
  it('publishes the rounds, the interval and the turn time so far, and holds the hook open', async () => {
    const r = rig();
    r.store.apply(TURN_STARTED_AT(12_000));
    r.open();
    const card = r.store.getSnapshot().checkpoint;
    expect(card?.rounds).toBe(32);
    expect(card?.interval).toBe(32);
    expect(card?.elapsedMs, '12 s of turn so far, exactly').toBe(12_000);
    expect(r.store.getSnapshot().checkpointFrame).toBeDefined();
    await settle();
    expect(r.answer(), 'nothing settles it but the person').toBeUndefined();
  });

  it('the person’s own wait is not the turn’s work: a second checkpoint after a five-minute wait counts only the working time', async () => {
    const r = rig();
    r.store.apply(TURN_STARTED_AT(12_000));
    r.open(); // 12 s of work so far
    at(5 * 60_000);
    r.key('y', CTRL); // five minutes later the person says continue
    await settle();
    expect(r.answer()).toBe('continue');
    at(5 * 60_000 + 3_000); // three more seconds of work
    r.open();
    expect(r.store.getSnapshot().checkpoint?.elapsedMs, '12 s + 3 s of work, not 5 min 15 s').toBe(
      15_000,
    );
  });

  it('there is no timeout: no timer is armed, and ten minutes of fake time later the hook is still pending', async () => {
    vi.useRealTimers();
    vi.useFakeTimers(); // everything faked this time, timers included
    const r = rig();
    r.open();
    expect(vi.getTimerCount(), 'opening the card arms no timer').toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    await settle();
    expect(r.answer()).toBeUndefined();
    expect(r.rejected()).toBeUndefined();
    expect(r.store.getSnapshot().checkpoint).toBeDefined();
  });

  it('refuses a second checkpoint and any other overlay while one is open: one card at a time, in BOTH directions', async () => {
    const r = rig();
    r.open();
    await expect(r.store.requestCheckpoint(INFO)).rejects.toMatchObject({ name: 'AbortError' });
    // The reverse: an approval or a question asked while a checkpoint is open is refused, so it can never be an unreachable card.
    await expect(
      r.store.requestApproval(
        { toolId: 'write_file', action: 'fs_write', preview: {}, unredactedPreview: {} },
        false,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      r.store.requestQuestion({
        questions: [
          {
            header: 'Pick',
            question: 'Which?',
            multiSelect: false,
            options: [
              { label: 'a', description: 'first' },
              { label: 'b', description: 'second' },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(r.store.getSnapshot().approval).toBeUndefined();
    expect(r.store.getSnapshot().question).toBeUndefined();
    // And the other way round: a checkpoint under an approval or a question.
    const other = rig();
    void other.store.requestApproval(
      { toolId: 'write_file', action: 'fs_write', preview: {}, unredactedPreview: {} },
      false,
    );
    await expect(other.store.requestCheckpoint(INFO)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('a stop is remembered for the turn’s summary, a continue is not (ADR-0136 §2)', () => {
  const lastSummary = (r: Rig) => {
    const entry = r.store.getSnapshot().state.transcript.at(-1);
    return entry?.role === 'assistant' ? entry.summary : undefined;
  };

  it('after a "stop" the turn’s turn_limit summary says the person stopped, and the next turn does not inherit it', async () => {
    const r = rig();
    r.store.apply(TURN_STARTED_AT(1_000));
    r.open();
    r.key('n', CTRL);
    await settle();
    r.store.apply(TURN_LIMIT_ENDED);
    expect(lastSummary(r)?.stoppedAtCheckpoint).toBe(32);
    expect(formatTurnSummary(lastSummary(r)!)).toContain(
      'stopped at a checkpoint after 32 tool rounds',
    );
    expect(
      errorRecoveryHint('turn_limit', undefined, lastSummary(r)),
      'the hint says who stopped it',
    ).toContain('You stopped the turn at a checkpoint');
    // A later turn that ends at the hard stop is a plain limit again.
    r.store.apply({ ...TURN_STARTED_AT(1_000), sequenceNumber: 3 });
    r.store.apply({ ...TURN_LIMIT_ENDED, sequenceNumber: 4 });
    expect(lastSummary(r)?.stoppedAtCheckpoint).toBeUndefined();
    expect(formatTurnSummary(lastSummary(r)!)).toContain('error: turn_limit');
  });

  it('a "continue" leaves no mark: a turn that later ends at the hard stop is a plain limit', async () => {
    const r = rig();
    r.store.apply(TURN_STARTED_AT(1_000));
    r.open();
    at(APPROVAL_SETTLE_MS + 1);
    r.key('y', CTRL);
    await settle();
    expect(r.answer()).toBe('continue');
    r.store.apply(TURN_LIMIT_ENDED);
    expect(lastSummary(r)?.stoppedAtCheckpoint).toBeUndefined();
    expect(formatTurnSummary(lastSummary(r)!)).toContain('error: turn_limit');
  });

  it('a mark is only worn by a turn_limit: a stop followed by some other ending says nothing about a checkpoint', async () => {
    const r = rig();
    r.store.apply(TURN_STARTED_AT(1_000));
    r.open();
    r.key('n', CTRL);
    await settle();
    r.store.apply({
      ...TURN_LIMIT_ENDED,
      error: { code: 'provider_unavailable', message: 'down', retryable: true },
    });
    expect(lastSummary(r)?.stoppedAtCheckpoint).toBeUndefined();
  });
});

describe('a stop is an answer, never delayed (ADR-0136 §2, ADR-0115 §1)', () => {
  it.each([
    ['Ctrl+N', 'n', CTRL, 'handled'],
    ['Esc', '', { escape: true }, 'handled'],
    ['Ctrl+C', 'c', CTRL, 'stop-answered'],
  ] as const)(
    '%s resolves the hook with "stop" the moment it is pressed, on a card nobody has seen',
    async (_name, input, key, result) => {
      const r = rig();
      r.open({ shown: false }); // not acknowledged, not visible: a stop never waits for either
      r.visible(false);
      expect(r.key(input, key)).toBe(result);
      await settle();
      expect(r.answer()).toBe('stop');
      expect(r.store.getSnapshot().checkpoint, 'the card is gone').toBeUndefined();
    },
  );

  it('a stop is not an abort: the surface is told to abort nothing', () => {
    const r = rig();
    r.open();
    expect(r.key('c', CTRL)).not.toBe('abort');
    const r2 = rig();
    r2.open();
    expect(r2.key('', { escape: true })).not.toBe('abort');
  });
});

describe('Ctrl+Y spends, so it clears the approval guards (ADR-0136 §4)', () => {
  it('continues once the frame has been acknowledged for the dwell and nothing else is going on', async () => {
    const r = rig();
    r.open();
    at(APPROVAL_SETTLE_MS + 1);
    expect(r.key('y', CTRL)).toBe('handled');
    await settle();
    expect(r.answer()).toBe('continue');
    expect(r.store.getSnapshot().checkpoint).toBeUndefined();
  });

  it('is refused inside the dwell, and counts once the dwell has run', async () => {
    const r = rig();
    r.open();
    at(APPROVAL_SETTLE_MS - 1);
    r.key('y', CTRL);
    await settle();
    expect(
      r.answer(),
      'the key arrived before the card had been on screen long enough',
    ).toBeUndefined();
    expect(
      r.store.getSnapshot().checkpoint,
      'the card stays open: a refusal answers nothing',
    ).toBeDefined();
    at(APPROVAL_SETTLE_MS + APPROVAL_QUIET_MS + 1);
    r.key('y', CTRL);
    await settle();
    expect(r.answer()).toBe('continue');
  });

  it('is refused while the frame has not been acknowledged, however long ago the card opened', async () => {
    const r = rig();
    r.open({ shown: false });
    at(60_000);
    r.key('y', CTRL);
    await settle();
    expect(r.answer(), 'an unseen card cannot be continued').toBeUndefined();
    r.show();
    at(60_000 + APPROVAL_SETTLE_MS + 1);
    r.key('y', CTRL);
    await settle();
    expect(r.answer()).toBe('continue');
  });

  it('is refused while the card is not visible right now (custody lost), even after an acknowledgement', async () => {
    const r = rig();
    r.open();
    r.visible(false);
    at(APPROVAL_SETTLE_MS + 1);
    r.key('y', CTRL);
    await settle();
    expect(r.answer()).toBeUndefined();
    r.visible(true);
    at(APPROVAL_SETTLE_MS + APPROVAL_QUIET_MS + 2);
    r.key('y', CTRL);
    await settle();
    expect(r.answer()).toBe('continue');
  });

  it('is refused for typeahead: a foreign key just before it is evidence the person was typing, not answering', async () => {
    const r = rig();
    r.open();
    at(APPROVAL_SETTLE_MS + 1);
    r.key('t'); // a bare letter typed at the card
    at(APPROVAL_SETTLE_MS + 1 + APPROVAL_QUIET_MS + 1);
    r.key('y', CTRL);
    await settle();
    expect(r.answer(), 'inside the typeahead window').toBeUndefined();
    at(APPROVAL_SETTLE_MS + 1 + APPROVAL_TYPEAHEAD_MS + APPROVAL_QUIET_MS + 1);
    r.key('y', CTRL);
    await settle();
    expect(r.answer()).toBe('continue');
  });

  it('a bare letter answers nothing, whatever it spells', async () => {
    const r = rig();
    r.open();
    at(APPROVAL_SETTLE_MS + 1);
    for (const letter of ['y', 'n', 'c', 'a', 'g', 'r', 'Y', '1']) {
      at(APPROVAL_SETTLE_MS + 1 + APPROVAL_TYPEAHEAD_MS * 2);
      expect(r.key(letter), letter).toBe('handled');
    }
    await settle();
    expect(r.answer()).toBeUndefined();
    expect(r.store.getSnapshot().checkpoint).toBeDefined();
  });

  it('inside the lockout after another card was resolved by a key, and the held key restarts the window', async () => {
    const r = rig();
    r.open();
    at(APPROVAL_SETTLE_MS + 1);
    r.key('n', CTRL); // a card resolved by a key just now: the checkpoint
    await settle();
    expect(r.answer()).toBe('stop');
    // The next checkpoint of the same turn opens at once: a Ctrl+Y inside the lockout is refused, and so is a held repeat of it.
    const lockedAt = APPROVAL_SETTLE_MS + 1;
    r.open();
    at(lockedAt + APPROVAL_SETTLE_MS + 1);
    r.key('y', CTRL);
    await settle();
    expect(r.store.getSnapshot().checkpoint, 'refused inside the lockout').toBeDefined();
    at(lockedAt + APPROVAL_SETTLE_MS + 1 + APPROVAL_LOCKOUT_MS - 1);
    r.key('y', CTRL); // still held: this restarts the window rather than letting it run out
    expect(r.store.getSnapshot().checkpoint).toBeDefined();
  });
});

describe('the guards that need a timeline of their own (ADR-0136 §4)', () => {
  it('the same frame acknowledged again does not restart the dwell: every host render acknowledges it (a running turn flushes every frame)', async () => {
    const r = rig();
    r.open(); // acknowledged at once
    at(APPROVAL_SETTLE_MS - 50);
    r.show(); // the same frame, as a spinner re-render does
    r.show();
    at(APPROVAL_SETTLE_MS + 1);
    r.key('y', CTRL);
    await settle();
    expect(
      r.answer(),
      'the first acknowledgement counts; a repeat must not push the dwell out',
    ).toBe('continue');
  });

  it('the quiet gap counts on its own: a key that arrives 20 ms after a refused one is refused, and one past the gap counts', async () => {
    const r = rig();
    r.open();
    at(APPROVAL_SETTLE_MS - 10);
    r.key('y', CTRL); // refused by the dwell, and NOT typing evidence
    at(APPROVAL_SETTLE_MS + 10); // the dwell has run; only the gap since the previous key is short
    r.key('y', CTRL);
    await settle();
    expect(r.answer(), 'a held key spends nothing: the previous key was 20 ms ago').toBeUndefined();
    at(APPROVAL_SETTLE_MS + 10 + APPROVAL_QUIET_MS + 1);
    r.key('y', CTRL);
    await settle();
    expect(r.answer()).toBe('continue');
  });
});

describe('an abort or a seal is a cancellation, never an answer', () => {
  it('an abort while the card is open closes it and rejects the hook with an AbortError', async () => {
    const r = rig();
    const controller = new AbortController();
    r.open({ signal: controller.signal });
    controller.abort();
    await settle();
    expect(r.rejected()).toMatchObject({ name: 'AbortError' });
    expect(r.answer()).toBeUndefined();
    expect(r.store.getSnapshot().checkpoint).toBeUndefined();
  });

  it('an already-aborted signal opens no card at all', async () => {
    const r = rig();
    const controller = new AbortController();
    controller.abort();
    r.open({ signal: controller.signal });
    await settle();
    expect(r.rejected()).toMatchObject({ name: 'AbortError' });
    expect(r.store.getSnapshot().checkpoint).toBeUndefined();
  });

  it('a store sealed under an open card rejects it (a cancel), and refuses a later one', async () => {
    const r = rig();
    r.open();
    r.store.sealToolPreviews();
    await settle();
    expect(r.rejected()).toMatchObject({ name: 'AbortError' });
    expect(r.answer()).toBeUndefined();
    await expect(r.store.requestCheckpoint(INFO)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('removes its abort listener once answered: the same handler that was added is taken off again', async () => {
    const r = rig();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const signal = {
      aborted: false,
      addEventListener: (_type: string, handler: unknown) => {
        added.push(handler);
      },
      removeEventListener: (_type: string, handler: unknown) => {
        removed.push(handler);
      },
    };
    void r.store.requestCheckpoint(INFO, signal);
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(0);
    r.key('n', CTRL);
    await settle();
    expect(removed, 'answering takes the listener off').toEqual(added);
  });
});

describe('a resize or a resume starts the dwell over (ADR-0136 §4)', () => {
  it('a frame the person has not seen since the resize cannot be continued by a key already in flight', async () => {
    const r = rig();
    r.open();
    at(APPROVAL_SETTLE_MS + 1);
    r.store.invalidateToolReview();
    r.key('y', CTRL);
    await settle();
    expect(r.answer(), 'the new frame has not been acknowledged').toBeUndefined();
    r.show();
    at(APPROVAL_SETTLE_MS * 2 + APPROVAL_QUIET_MS + 2);
    r.key('y', CTRL);
    await settle();
    expect(r.answer()).toBe('continue');
  });

  it('an acknowledgement of a stale frame counts for nothing', async () => {
    const r = rig();
    r.open({ shown: false });
    const stale = r.store.getSnapshot().checkpointFrame;
    r.store.invalidateToolReview();
    if (stale !== undefined) r.store.acknowledgeCheckpointFrame(stale);
    at(APPROVAL_SETTLE_MS + 1);
    r.key('y', CTRL);
    await settle();
    expect(r.answer()).toBeUndefined();
  });
});

describe('the wait is not the turn’s work', () => {
  it('the busy line counts the card as waiting for the person, and the wait is taken out of the turn time afterwards', async () => {
    const r = rig();
    r.store.apply({
      type: 'session:turn_started',
      sessionId: 's',
      sequenceNumber: 1,
      timestamp: new Date(Date.now()).toISOString(),
    });
    r.open();
    expect(
      r.store.getSnapshot().state.approvalSinceMs,
      'the person’s wait has begun',
    ).toBeDefined();
    at(5 * 60_000);
    r.key('n', CTRL);
    await settle();
    expect(r.store.getSnapshot().state.approvalSinceMs).toBeUndefined();
    expect(r.store.getSnapshot().state.approvalWaitMs).toBeGreaterThanOrEqual(5 * 60_000 - 1);
  });
});
