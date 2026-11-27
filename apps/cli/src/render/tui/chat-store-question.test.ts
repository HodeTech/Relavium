/**
 * The `ask_user` question card in the real chat store (ADR-0132): the pending promise, who may resolve it, how a stop and a
 * sealed store reject it, and the transcript entry. The key reducer and the layout are pinned in `question-card-model.test.ts`
 * and `question-card.test.ts`; this file proves they are wired into the store a surface actually runs.
 */
import type { AskUserAnswer, AskUserRequest } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatStore, type ChatStoreController } from './chat-store.js';
import { QUESTION_SETTLE_MS } from './question-card-model.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

const REQUEST: AskUserRequest = {
  questions: [
    {
      header: 'Pick',
      question: 'Which file?',
      multiSelect: false,
      options: [
        { label: 'alpha.ts', description: 'The first file' },
        { label: 'beta.ts', description: 'The second file' },
      ],
    },
  ],
};

// Choosing keys count only once a question has been on screen for QUESTION_SETTLE_MS; the clocks are the only thing faked (the settle runs on
// the monotonic clock, `performance.now`, since unit 8's fix wave, S-5; the transcript's times on the wall clock).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
});
/** Let the open question's frame settle, as a person reading the card would. */
const settle = (): void => {
  vi.advanceTimersByTime(QUESTION_SETTLE_MS);
};

const newStore = (): ChatStoreController =>
  createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);

/** Settle a promise into a tagged outcome without an unhandled rejection. */
async function outcome(
  promise: Promise<AskUserAnswer>,
): Promise<{ ok: true; answer: AskUserAnswer } | { ok: false; error: Error }> {
  try {
    return { ok: true, answer: await promise };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

const notices = (store: ChatStoreController): string[] =>
  store
    .getSnapshot()
    .state.transcript.flatMap((entry) => (entry.role === 'notice' ? [entry.text] : []));

describe('requestQuestion (ADR-0132 §3, §4)', () => {
  it('publishes the card and opens the person’s wait (the busy line and the footer exclude it from the turn)', async () => {
    const store = newStore();
    const pending = store.requestQuestion(REQUEST);
    settle();
    expect(store.getSnapshot().question?.request).toBe(REQUEST);
    expect(store.getSnapshot().state.approvalSinceMs).toBeDefined();
    store.bindQuestionVisibility(() => true);
    store.handleReviewInput('1', {});
    expect(await outcome(pending)).toEqual({
      ok: true,
      answer: { kind: 'answered', answers: [{ selected: ['alpha.ts'] }] },
    });
    expect(store.getSnapshot().question).toBeUndefined();
    expect(store.getSnapshot().state.approvalSinceMs).toBeUndefined();
  });

  it('ignores a choosing key until the card’s exact frame is acknowledged visible — a key typed ahead cannot choose', async () => {
    const store = newStore();
    const pending = store.requestQuestion(REQUEST);
    settle();
    // No visibility is bound at all: nothing was ever shown.
    expect(store.handleReviewInput('1', {})).toBe('handled');
    expect(store.getSnapshot().question).toBeDefined();
    store.bindQuestionVisibility(() => false);
    expect(store.handleReviewInput('2', {})).toBe('handled');
    expect(store.handleReviewInput('', { return: true })).toBe('handled');
    expect(store.getSnapshot().question).toBeDefined();
    store.bindQuestionVisibility(() => true);
    store.handleReviewInput('2', {});
    expect(await outcome(pending)).toMatchObject({
      ok: true,
      answer: { answers: [{ selected: ['beta.ts'] }] },
    });
  });

  it('resolves a skip as skipped and ends the wait', async () => {
    const store = newStore();
    const pending = store.requestQuestion(REQUEST);
    settle();
    store.bindQuestionVisibility(() => true);
    store.handleReviewInput('s', { ctrl: true });
    expect(await outcome(pending)).toEqual({ ok: true, answer: { kind: 'skipped' } });
    expect(store.getSnapshot().question).toBeUndefined();
  });

  it.each([
    ['Esc', '', { escape: true }],
    ['Ctrl-C', 'c', { ctrl: true }],
  ])(
    '%s asks the host to stop the turn; the card stays until the stop reaches it',
    async (_n, input, key) => {
      const store = newStore();
      const controller = new AbortController();
      const pending = store.requestQuestion(REQUEST, controller.signal);
      settle();
      store.bindQuestionVisibility(() => false); // even before the frame is acknowledged
      expect(store.handleReviewInput(input, key)).toBe('abort');
      expect(store.getSnapshot().question).toBeDefined(); // the store itself does not resolve it
      controller.abort();
      const result = await outcome(pending);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.name).toBe('AbortError'); // a CANCEL, never a skip
      expect(store.getSnapshot().question).toBeUndefined();
      expect(store.getSnapshot().state.approvalSinceMs).toBeUndefined();
    },
  );

  it('rejects with an AbortError when the turn is already stopped, without publishing a card', async () => {
    const store = newStore();
    const controller = new AbortController();
    controller.abort();
    const result = await outcome(store.requestQuestion(REQUEST, controller.signal));
    expect(!result.ok && result.error.name).toBe('AbortError');
    expect(store.getSnapshot().question).toBeUndefined();
  });

  it('a sealed store rejects a pending question with an AbortError — it is never resolved as a skip', async () => {
    const store = newStore();
    const pending = store.requestQuestion(REQUEST);
    settle();
    store.sealToolPreviews();
    const result = await outcome(pending);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.name).toBe('AbortError');
    expect(store.getSnapshot().question).toBeUndefined();
    // …and a sealed store refuses a new one the same way.
    const later = await outcome(store.requestQuestion(REQUEST));
    expect(!later.ok && later.error.name).toBe('AbortError');
  });

  it('allows one overlay at a time: a second question, or a question during an approval, is a cancel', async () => {
    const store = newStore();
    const first = store.requestQuestion(REQUEST);
    settle();
    const second = await outcome(store.requestQuestion(REQUEST));
    expect(!second.ok && second.error.name).toBe('AbortError');
    expect(store.getSnapshot().question).toBeDefined(); // the first card is untouched
    store.bindQuestionVisibility(() => true);
    store.handleReviewInput('1', {});
    await first;

    const withApproval = newStore();
    void withApproval.requestApproval(
      { toolId: 'write_file', action: 'fs_write', preview: { path: 'a.txt' } },
      true,
    );
    const refused = await outcome(withApproval.requestQuestion(REQUEST));
    expect(!refused.ok && refused.error.name).toBe('AbortError');
  });

  it('refuses a request that is not plain text as a HOST FAULT (not a cancel): the card is the product’s own chrome', async () => {
    const store = newStore();
    const hostile: AskUserRequest = {
      questions: [{ ...REQUEST.questions[0]!, question: 'forged\u001b[2J screen' }],
    };
    const result = await outcome(store.requestQuestion(hostile));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.name).not.toBe('AbortError');
    expect(store.getSnapshot().question).toBeUndefined();
  });

  it('replaces the card state with a NEW object on every change (the frame acknowledgement keys on identity)', () => {
    const store = newStore();
    void store.requestQuestion(REQUEST);
    settle();
    store.bindQuestionVisibility(() => true);
    const before = store.getSnapshot().question;
    store.handleReviewInput('', { downArrow: true });
    const after = store.getSnapshot().question;
    expect(after).not.toBe(before);
    expect(after?.request).toBe(before?.request);
  });
});

describe('the transcript entry (ADR-0132 §6)', () => {
  it('records what was asked and what was chosen — one entry, built from the answer the card holds', async () => {
    const store = newStore();
    const pending = store.requestQuestion(REQUEST);
    settle();
    store.bindQuestionVisibility(() => true);
    store.handleReviewInput('2', {});
    await pending;
    const [entry] = notices(store);
    expect(entry).toContain('Pick');
    expect(entry).toContain('Which file?');
    expect(entry).toContain('beta.ts');
    expect(notices(store)).toHaveLength(1);
  });

  it('quotes the person’s own text, and carries no control character', async () => {
    const store = newStore();
    const pending = store.requestQuestion(REQUEST);
    settle();
    store.bindQuestionVisibility(() => true);
    store.handleReviewInput('', { downArrow: true });
    store.handleReviewInput('', { downArrow: true });
    store.handleReviewInput('', { return: true }); // open the own-answer field
    store.pasteIntoQuestion('my own\u001b[31m answer');
    store.handleReviewInput('', { return: true });
    expect(await outcome(pending)).toMatchObject({
      answer: { answers: [{ selected: [], other: 'my own answer' }] },
    });
    const [entry] = notices(store);
    expect(entry).toContain('“my own answer”');
    expect(entry).not.toContain(String.fromCharCode(27));
  });

  it('records a skip', async () => {
    const store = newStore();
    const pending = store.requestQuestion(REQUEST);
    settle();
    store.bindQuestionVisibility(() => true);
    store.handleReviewInput('s', { ctrl: true });
    await pending;
    expect(notices(store)[0]).toMatch(/Skipped the agent's question: Pick/);
  });

  it('leaves NO entry when the turn is stopped — nothing was answered', async () => {
    const store = newStore();
    const controller = new AbortController();
    const pending = store.requestQuestion(REQUEST, controller.signal);
    settle();
    controller.abort();
    await outcome(pending);
    expect(notices(store)).toEqual([]);
  });
});

describe('a paste into the card', () => {
  it('is consumed by an open question, and ignored (returns false) when none is open', () => {
    const store = newStore();
    expect(store.pasteIntoQuestion('x')).toBe(false);
    void store.requestQuestion(REQUEST);
    settle();
    expect(store.pasteIntoQuestion('x')).toBe(true); // consumed even when there is no field to take it
  });

  it('goes into the own-answer field only once the frame is visible, and is cut nowhere', () => {
    const store = newStore();
    void store.requestQuestion(REQUEST);
    settle();
    store.bindQuestionVisibility(() => true);
    for (let i = 0; i < 2; i += 1) store.handleReviewInput('', { downArrow: true });
    store.handleReviewInput('', { return: true });
    store.bindQuestionVisibility(() => false);
    store.pasteIntoQuestion('hidden');
    expect(store.getSnapshot().question?.field?.text).toBe('');
    store.bindQuestionVisibility(() => true);
    store.pasteIntoQuestion('shown');
    expect(store.getSnapshot().question?.field?.text).toBe('shown');
  });
});

const THREE: AskUserRequest = {
  questions: ['One', 'Two', 'Three'].map((header) => ({
    header,
    question: `${header}?`,
    multiSelect: false,
    options: [
      { label: `${header}-a`, description: 'first' },
      { label: `${header}-b`, description: 'second' },
    ],
  })),
};

describe('a question must be on screen long enough to read before a key counts (ADR-0132 §3, review)', () => {
  it('ignores a choosing key until the settle window has passed, then accepts it', async () => {
    const store = newStore();
    const pending = store.requestQuestion(REQUEST);
    store.bindQuestionVisibility(() => true);
    store.handleReviewInput('1', {}); // the frame is acknowledged, but nobody could have read it yet
    expect(store.getSnapshot().question).toBeDefined();
    vi.advanceTimersByTime(QUESTION_SETTLE_MS - 1);
    store.handleReviewInput('1', {});
    expect(store.getSnapshot().question).toBeDefined();
    vi.advanceTimersByTime(1);
    store.handleReviewInput('1', {});
    expect(await outcome(pending)).toMatchObject({ ok: true });
  });

  it('the stop keys never wait', () => {
    const store = newStore();
    void store.requestQuestion(REQUEST);
    expect(store.handleReviewInput('', { escape: true })).toBe('abort');
    expect(store.handleReviewInput('c', { ctrl: true })).toBe('abort');
  });

  it('a HELD Enter cannot answer every question with its first option: each new tab is a new frame that must settle', async () => {
    const store = newStore();
    const pending = store.requestQuestion(THREE);
    store.bindQuestionVisibility(() => true);
    settle();
    store.handleReviewInput('', { return: true }); // answers question 1 with its first option
    expect(store.getSnapshot().question?.index).toBe(1);
    // The key repeats at once: question 2 has been visible for no time at all.
    store.handleReviewInput('', { return: true });
    store.handleReviewInput('', { return: true });
    expect(store.getSnapshot().question?.index).toBe(1);
    expect(store.getSnapshot().question?.entries[1]?.ticked).toEqual([]);
    settle();
    store.handleReviewInput('', { return: true });
    expect(store.getSnapshot().question?.index).toBe(2);
    settle();
    store.handleReviewInput('', { return: true }); // answers question 3: the REVIEW tab shows, nothing is sent yet
    expect(store.getSnapshot().question?.index).toBe(3);
    store.handleReviewInput('', { return: true }); // held: the Review tab has not settled
    expect(store.getSnapshot().question).toBeDefined();
    settle();
    store.handleReviewInput('', { return: true }); // the person reviewed it and sends
    expect(await outcome(pending)).toMatchObject({
      ok: true,
      answer: {
        answers: [{ selected: ['One-a'] }, { selected: ['Two-a'] }, { selected: ['Three-a'] }],
      },
    });
  });

  it('mints a NEW frame for each question, and none once the card is gone', async () => {
    const store = newStore();
    const pending = store.requestQuestion(THREE);
    const opening = store.getSnapshot().questionFrame;
    expect(opening).toBeDefined();
    store.bindQuestionVisibility(() => true);
    settle();
    store.handleReviewInput('', { downArrow: true }); // same question: the frame is the same object
    expect(store.getSnapshot().questionFrame).toBe(opening);
    store.handleReviewInput('', { return: true }); // next question
    const next = store.getSnapshot().questionFrame;
    expect(next).toBeDefined();
    expect(next).not.toBe(opening);
    store.handleReviewInput('s', { ctrl: true }); // ignored: the new frame has not settled
    settle();
    store.handleReviewInput('s', { ctrl: true });
    await pending;
    expect(store.getSnapshot().questionFrame).toBeUndefined();
  });

  it('a resize or a resume from suspend (invalidateToolReview) forces the open question to be acknowledged and settle again', async () => {
    const store = newStore();
    const pending = store.requestQuestion(REQUEST);
    store.bindQuestionVisibility(() => true);
    settle();
    const before = store.getSnapshot().questionFrame;
    store.invalidateToolReview();
    expect(store.getSnapshot().questionFrame).not.toBe(before);
    store.handleReviewInput('1', {}); // a key typed right after `fg`, before the repaint
    expect(store.getSnapshot().question).toBeDefined();
    settle();
    store.handleReviewInput('1', {});
    expect(await outcome(pending)).toMatchObject({ ok: true });
  });

  it('the overlay exclusion holds in BOTH directions: an approval cannot open under a question card', async () => {
    const store = newStore();
    void store.requestQuestion(REQUEST);
    const refused = await store
      .requestApproval(
        { toolId: 'write_file', action: 'fs_write', preview: { path: 'a.txt' } },
        true,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refused).toMatchObject({ name: 'AbortError' });
    expect(store.getSnapshot().question).toBeDefined(); // the question is untouched
  });
});
