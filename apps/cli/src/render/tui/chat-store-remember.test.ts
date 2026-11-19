/**
 * `Ctrl+O` on a command card (ADR-0118 §1): remember this exact command for this project. Like the session-wide `Ctrl+G` it is a
 * TWO-step answer — the first press asks, only ENTER (no other key between, 800 ms to 5 s later) grants — and like every
 * affirmative chord it is refused until the card has been on screen, the keyboard has been quiet and nothing was typed just
 * before. It exists only on a card whose facts offer it: any other card, and a command that is a code carrier or names a
 * protected path, has no such key.
 */
import type { ToolApprovalRequest, ToolPreview } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandCardFacts } from '../../chat/command-facts.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import {
  APPROVAL_CONFIRM_MAX_MS,
  APPROVAL_CONFIRM_MIN_MS,
  toolReviewPage,
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
  if (delta < -1e-6) throw new Error('the clock cannot run backwards');
  vi.advanceTimersByTime(Math.max(0, delta));
};

const REQUEST: ToolApprovalRequest = {
  toolId: 'run_command',
  action: 'process',
  preview: { command: 'npm test' },
  unredactedPreview: { command: 'npm test' },
  argv: ['npm', 'test'],
  commandAdmitted: false,
};
const PREVIEW: ToolPreview = {
  kind: 'operation',
  target: 'npm test',
  fields: [
    { name: 'program', value: 'npm' },
    { name: 'argument 1', value: 'test' },
  ],
};
const FACTS = (remember: boolean, session = true): CommandCardFacts => ({
  standing: 'not-pre-approved',
  runsCode: false,
  protectedPath: false,
  cwd: '/work/project',
  offers: { session, remember },
});

function rig(facts: CommandCardFacts | undefined) {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const answers: unknown[] = [];
  void store
    .requestApproval(
      REQUEST,
      facts?.offers.session ?? false,
      undefined,
      { callId: 'call', preview: PREVIEW },
      facts,
    )
    .then((answer) => answers.push(answer));
  const review = store.getSnapshot().review;
  if (review === undefined) throw new Error('the card did not open');
  store.bindReviewVisibility(() => store.getSnapshot().review === review);
  store.acknowledgeReviewFrame(review, toolReviewPage(review, 80, 24));
  return {
    store,
    answers,
    chord: (letter: string) => String(store.handleReviewInput(letter, { ctrl: true })),
    enter: () => String(store.handleReviewInput('', { return: true })),
    key: (input: string) => String(store.handleReviewInput(input, {})),
    pending: () => store.getSnapshot().approval !== undefined,
    snapshot: () => store.getSnapshot(),
  };
}
const flush = async (): Promise<void> => {
  await Promise.resolve();
};

describe('Ctrl+O on a command card', () => {
  it('the card carries the facts it was opened with', () => {
    const r = rig(FACTS(true));
    expect(r.snapshot().approval?.facts).toEqual(FACTS(true));
    expect(r.snapshot().review?.facts).toEqual(FACTS(true));
  });

  it('the first press asks and resolves nothing; ENTER in the window remembers', async () => {
    const r = rig(FACTS(true));
    at(1000);
    expect(r.chord('o')).toBe('handled');
    expect(r.pending()).toBe(true);
    expect(r.snapshot().rememberConfirm).toBe(true);
    expect(r.snapshot().alwaysConfirm, 'it is not the session question').toBe(false);
    at(1000 + APPROVAL_CONFIRM_MIN_MS);
    expect(r.enter()).toBe('handled');
    await flush();
    expect(r.answers).toEqual([{ outcome: 'approve', scope: 'remember' }]);
    expect(r.snapshot().rememberConfirm).toBe(false);
  });

  it.each([
    ['an Enter that comes too soon', APPROVAL_CONFIRM_MIN_MS - 100],
    ['an Enter that comes too late', APPROVAL_CONFIRM_MAX_MS + 100],
  ])('%s does not remember', async (_what, gap) => {
    const r = rig(FACTS(true));
    at(1000);
    r.chord('o');
    at(1000 + gap);
    r.enter();
    await flush();
    expect(r.answers).toEqual([]);
    expect(r.pending()).toBe(true);
    expect(r.snapshot().rememberConfirm).toBe(false);
  });

  it('a second Ctrl+O, any other key, or Ctrl+G ends the question instead of confirming it', async () => {
    for (const interrupt of [
      (r: ReturnType<typeof rig>) => r.chord('o'),
      (r: ReturnType<typeof rig>) => r.key('x'),
      (r: ReturnType<typeof rig>) => r.chord('g'),
    ]) {
      origin = performance.now();
      const r = rig(FACTS(true));
      at(1000);
      r.chord('o');
      at(1000 + APPROVAL_CONFIRM_MIN_MS - 200);
      interrupt(r);
      // Late enough that an Enter would confirm a question ASKED AGAIN by the interrupting key, so this fails if it asked again.
      at(1000 + APPROVAL_CONFIRM_MIN_MS - 200 + APPROVAL_CONFIRM_MIN_MS + 100);
      r.enter();
      await flush();
      expect(r.answers, 'nothing was remembered').toEqual([]);
      expect(r.snapshot().rememberConfirm).toBe(false);
    }
  });

  it('is refused until the card has been on screen long enough (dwell), like every affirmative chord', async () => {
    const r = rig(FACTS(true));
    at(50);
    r.chord('o');
    expect(r.snapshot().rememberConfirm, 'the dwell has not passed, so nothing was asked').toBe(
      false,
    );
    await flush();
    expect(r.answers).toEqual([]);
  });

  it('is no answer on a card that does not offer it, and is consumed (never composer text)', async () => {
    for (const facts of [FACTS(false), undefined]) {
      origin = performance.now();
      const r = rig(facts);
      at(1000);
      expect(r.chord('o')).toBe('handled');
      expect(r.snapshot().rememberConfirm).toBe(false);
      at(1000 + APPROVAL_CONFIRM_MIN_MS);
      r.enter();
      await flush();
      expect(r.answers).toEqual([]);
      expect(r.pending()).toBe(true);
    }
  });

  it('Ctrl+Y still allows this call once, and Ctrl+G still asks the session question with its own scope', async () => {
    const once = rig(FACTS(true));
    at(1000);
    once.chord('y');
    await flush();
    expect(once.answers).toEqual([{ outcome: 'approve', scope: 'once' }]);
    origin = performance.now();
    const session = rig(FACTS(true));
    at(1000);
    session.chord('g');
    expect(session.snapshot().alwaysConfirm).toBe(true);
    expect(session.snapshot().rememberConfirm).toBe(false);
    at(1000 + APPROVAL_CONFIRM_MIN_MS);
    session.enter();
    await flush();
    expect(session.answers).toEqual([{ outcome: 'approve', scope: 'always' }]);
  });
});
