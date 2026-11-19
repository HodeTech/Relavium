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

describe('the card opens and says what it was told', () => {
  it('publishes the rounds, the interval and the turn time with the person’s waits excluded, and holds the hook open', async () => {
    const r = rig();
    r.store.apply({
      type: 'session:turn_started',
      sessionId: 's',
      sequenceNumber: 1,
      timestamp: new Date(performance.timeOrigin + performance.now() - 12_000).toISOString(),
    });
    // The wall clock and the event timestamps share the faked `Date`: 12 s of turn so far.
    r.open();
    const card = r.store.getSnapshot().checkpoint;
    expect(card?.rounds).toBe(32);
    expect(card?.interval).toBe(32);
    expect(card?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(r.store.getSnapshot().checkpointFrame).toBeDefined();
    await settle();
    expect(r.answer(), 'nothing settles it but the person: there is no timeout').toBeUndefined();
    at(10 * 60_000);
    await settle();
    expect(r.answer(), 'ten minutes later it is still the same stopped spend').toBeUndefined();
    expect(r.store.getSnapshot().checkpoint).toBeDefined();
  });

  it('refuses a second overlay and an open approval: one card at a time, both directions', async () => {
    const r = rig();
    r.open();
    await expect(r.store.requestCheckpoint(INFO)).rejects.toMatchObject({ name: 'AbortError' });
    const other = rig();
    void other.store.requestApproval(
      { toolId: 'write_file', action: 'fs_write', preview: {}, unredactedPreview: {} },
      false,
    );
    await expect(other.store.requestCheckpoint(INFO)).rejects.toMatchObject({ name: 'AbortError' });
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

  it('removes its abort listener once answered: a late abort changes nothing', async () => {
    const r = rig();
    const controller = new AbortController();
    r.open({ signal: controller.signal });
    r.key('n', CTRL);
    await settle();
    controller.abort();
    await settle();
    expect(r.answer()).toBe('stop');
    expect(r.rejected()).toBeUndefined();
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
