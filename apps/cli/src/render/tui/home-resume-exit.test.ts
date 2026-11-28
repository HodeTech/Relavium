/**
 * A `/resume` that is answered after the Home began to close does nothing (MVP-11 unit 6, round 1: test gaps Z18, Z21, Z23). The stages of a resume
 * are asynchronous (the picker waits for a person, the restore for a database), and a signal can end the Home in between (`teardownActive`). What a
 * stage that arrives late must not do: restore a session for a Home that is leaving (`resumeChat`), say a notification on a channel that is going,
 * or adopt a conversation the closing Home would then never tear down (it is torn down at once instead). The controller is the real one over
 * the same fakes `resume-popup.test.ts` uses.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeChatSession } from './home-controller.js';
import { createHomeController, RESUME_CANCELLED } from './home-controller.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function chatSession(id: string, teardown: () => Promise<void>): HomeChatSession {
  return {
    store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
    sessionId: id,
    processLine: () => Promise.resolve(),
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown,
  };
}

function rig(options: {
  readonly pick: Promise<string | undefined>;
  readonly resume?: Promise<HomeChatSession | { notice: string } | undefined>;
  /** The conversation the Home hosts already (`startChat` hands it back on the first message). */
  readonly open?: HomeChatSession;
}) {
  const announced: string[] = [];
  const resumeChat = vi.fn(() => options.resume ?? Promise.resolve(undefined));
  const frames: string[] = [];
  const controller = createHomeController({
    startChat: () =>
      options.open === undefined
        ? Promise.reject(new Error('no chat is started in this test'))
        : Promise.resolve(options.open),
    homeStore: {
      read: () => ({
        failedRuns: [],
        recentSessions: [],
        recentRuns: [],
        recentAgents: [],
        unreadableRuns: [],
        totals: { attention: 0, sessions: 0, runs: 0 },
        isEmpty: true,
      }),
    },
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
    announce: (text) => announced.push(text),
    pickSession: () => options.pick,
    resumeChat,
    resumeFrame: async (origin, run) => {
      frames.push(origin);
      await run();
    },
  });
  const typeResume = async (): Promise<void> => {
    controller.handlePaste('/resume');
    controller.handleKey('', { return: true });
    await settle();
  };
  const toChat = async (): Promise<void> => {
    controller.handlePaste('hello');
    controller.handleKey('', { return: true });
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'));
  };
  return { controller, announced, resumeChat, frames, typeResume, toChat };
}

describe('a resume answered after the Home began to close does nothing', () => {
  it('Z21: a picker that answers after teardownActive restores nothing and says nothing', async () => {
    const pick = deferred<string | undefined>();
    const r = rig({ pick: pick.promise });
    await r.typeResume();
    expect(r.frames, 'the picker is open').toEqual(['home']);
    // The signal handler ends the Home while the picker waits for the person; the person then answers.
    const terminating = r.controller.teardownActive();
    pick.resolve('s1');
    await terminating;
    await settle();
    expect(
      r.resumeChat,
      'no session is restored for a Home that is leaving',
    ).not.toHaveBeenCalled();
    expect(r.announced).toEqual([]);
    expect(r.controller.getSnapshot().mode).toBe('home');
  });

  it('Z23: a restore that comes to a sentence after teardownActive does not say it', async () => {
    const restore = deferred<undefined>();
    const r = rig({ pick: Promise.resolve('s1'), resume: restore.promise });
    await r.typeResume();
    expect(r.resumeChat, 'the restore is under way').toHaveBeenCalledTimes(1);
    const terminating = r.controller.teardownActive();
    restore.resolve(undefined);
    await terminating;
    await settle();
    // The same restore, for a Home that stays, says RESUME_CANCELLED (`resume-popup.test.ts`): a Home that is leaving says nothing.
    expect(r.announced).not.toContain(RESUME_CANCELLED);
    expect(r.announced).toEqual([]);
  });

  it('Z18: a conversation restored after teardownActive is torn down at once, never adopted', async () => {
    const restore = deferred<HomeChatSession>();
    const teardown = vi.fn(() => Promise.resolve());
    const r = rig({ pick: Promise.resolve('s1'), resume: restore.promise });
    await r.typeResume();
    expect(r.resumeChat).toHaveBeenCalledTimes(1);
    const terminating = r.controller.teardownActive();
    restore.resolve(chatSession('s1', teardown));
    await terminating;
    await settle();
    expect(
      teardown,
      'the conversation the leaving Home never adopts is torn down',
    ).toHaveBeenCalled();
    expect(r.controller.getSnapshot().mode, 'and it never took the Home’s place').toBe('home');
    expect(r.controller.getSnapshot().session).toBeUndefined();
  });

  it('Z18: with a conversation open, the one restored after teardownActive is torn down, and the open one is torn down once (the adoption does not do it again)', async () => {
    const restore = deferred<HomeChatSession>();
    const openTeardown = vi.fn(() => Promise.resolve());
    const restoredTeardown = vi.fn(() => Promise.resolve());
    const r = rig({
      pick: Promise.resolve('s2'),
      resume: restore.promise,
      open: chatSession('s1', openTeardown),
    });
    await r.toChat();
    await r.typeResume();
    expect(r.resumeChat).toHaveBeenCalledTimes(1);
    const terminating = r.controller.teardownActive();
    restore.resolve(chatSession('s2', restoredTeardown));
    await terminating;
    await settle();
    expect(restoredTeardown, 'the conversation a leaving Home never adopts').toHaveBeenCalled();
    expect(
      openTeardown,
      'the open conversation: torn down by the signal, not again by the adoption',
    ).toHaveBeenCalledTimes(1);
  });

  it('R2-23 the Home began to close WHILE the open conversation was being torn down for the resume: the restored one is torn down, never adopted', async () => {
    const closing = deferred<void>();
    const openTeardown = vi.fn(() => closing.promise);
    const restoredTeardown = vi.fn(() => Promise.resolve());
    const r = rig({
      pick: Promise.resolve('s2'),
      resume: Promise.resolve(chatSession('s2', restoredTeardown)),
      open: chatSession('s1', openTeardown),
    });
    await r.toChat();
    await r.typeResume();
    expect(r.resumeChat).toHaveBeenCalledTimes(1);
    expect(openTeardown, 'the open conversation is being closed for the resume').toHaveBeenCalled();
    // The signal handler ends the Home while that close is still pending; then the close finishes.
    const terminating = r.controller.teardownActive();
    closing.resolve();
    await terminating;
    await settle();
    expect(restoredTeardown, 'the conversation a leaving Home never adopts').toHaveBeenCalled();
    expect(r.controller.getSnapshot().session?.sessionId).not.toBe('s2');
  });
});

describe('what a resumed conversation starts with', () => {
  it('R2-26 a resumed conversation starts with no recall of the lines typed in the one it replaced (the composer history is the conversation’s)', async () => {
    const restoredTeardown = vi.fn(() => Promise.resolve());
    const r = rig({
      pick: Promise.resolve('s2'),
      resume: Promise.resolve(chatSession('s2', restoredTeardown)),
      open: chatSession('s1', () => Promise.resolve()),
    });
    await r.toChat(); // `hello` is sent in s1: it is the one line in the recall
    await r.typeResume();
    await vi.waitFor(() => expect(r.controller.getSnapshot().session?.sessionId).toBe('s2'));
    r.controller.handleKey('', { upArrow: true });
    await settle();
    expect(r.controller.getSnapshot().input.text, 'nothing of s1 is recalled in s2').toBe('');
  });
});
