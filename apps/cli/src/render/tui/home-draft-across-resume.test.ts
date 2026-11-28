/**
 * The Home's ONE draft and a conversation opened from the work page (MVP-11 unit 7, round 1: SE74). `↓` with a draft lands on the first row,
 * and `Enter` there resumes the session: the draft was not sent, so it is not lost either. The resumed chat starts with an empty composer, and
 * when the chat ends the Home's prompt holds the draft again, exactly as typed. A draft that looks like a provider key is still never kept (it
 * is cleared, as every path that meets one clears it). Through the real controller and a real chat store; the resume is scripted.
 */
import { describe, expect, it } from 'vitest';

import type { HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import { createChatStore } from './chat-store.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

const sessionRow = (sessionId: string): HomeSessionRow => ({
  sessionId,
  title: undefined,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});
const SESSIONS: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [sessionRow('s1')],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 1, runs: 0 },
  isEmpty: false,
};
const DRAFT = 'a long message I was writing\nthree paragraphs of it';
/** A string the provider-key detector takes for a key (the shape of an Anthropic key). */
const KEY_SHAPED = `sk-ant-api03-${'A'.repeat(90)}`;

/** Turn the event loop until `predicate` holds (a resume's native action and a chat's teardown settle over a few turns). */
async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !predicate(); turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function rig() {
  let stopped = false;
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const session: HomeChatSession = {
    store,
    sessionId: 's1',
    // Any line the chat sends ends it, as `/exit` does.
    processLine: () => {
      stopped = true;
      return Promise.resolve();
    },
    shouldStop: () => stopped,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  };
  const controller = createHomeController({
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => SESSIONS },
    resumeChat: () => Promise.resolve(session),
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
  return { controller, state: () => controller.getSnapshot() };
}

/** Type `draft`, `↓` onto the session row, `Enter`: the conversation is resumed and in front. Then `/exit` ends it. */
async function resumeFromTheRowThenLeave(draft: string) {
  const r = rig();
  r.controller.handlePaste(draft);
  r.controller.handleKey('', { downArrow: true });
  expect(r.state().stripFocus?.id, 'on the session row').toBe('s1');
  r.controller.handleKey('', { return: true });
  await until(() => r.state().mode === 'chat');
  expect(r.state().mode).toBe('chat');
  const inTheChat = r.state().input.text;
  r.controller.handlePaste('/exit');
  r.controller.handleKey('', { return: true });
  await until(() => r.state().mode === 'home');
  return { inTheChat, after: r.state() };
}

describe('a conversation resumed from the work page keeps the Home’s draft for when it ends', () => {
  it('the resumed chat starts with an empty composer, and the draft is back on the Home’s prompt when it ends, exactly as typed', async () => {
    const { inTheChat, after } = await resumeFromTheRowThenLeave(DRAFT);
    expect(inTheChat, 'the draft is not the resumed chat’s message').toBe('');
    expect(after.mode).toBe('home');
    expect(after.input.text).toBe(DRAFT);
    expect(after.input.cursor, 'the cursor at its end').toBe(DRAFT.length);
  });

  it('a draft that looks like a provider key is not kept: the Home comes back with an empty prompt', async () => {
    const { inTheChat, after } = await resumeFromTheRowThenLeave(KEY_SHAPED);
    expect(inTheChat).toBe('');
    expect(after.input.text).toBe('');
  });
});
