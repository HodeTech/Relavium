import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  KEY_SHAPED_DRAFT_NOTICE,
  type HomeChatSession,
  type HomeController,
} from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * What `Enter` on a typed message does while there is no provider key (MVP-11 Step 2.4, ADR-0146 §6, OD-19): the chat that cannot start is
 * never built, the setup opens, and the message stays in the prompt exactly as typed; a draft that looks like a key is never kept and never
 * recorded; a chat that fails to build for any other reason gives the message back and shows its whole failure.
 */

const SNAPSHOT: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const ENTER = { return: true } as const;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};
/** A key as the scrubber knows it (an OpenAI/Anthropic `sk-` key), long enough to be one. */
const FAKE_KEY = 'sk-ant-api03-journeyfakefakefakefake0123456789';

function session(lines: string[]): HomeChatSession {
  return {
    store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
    sessionId: 'sess-keyless',
    processLine: (line) => {
      lines.push(line);
      return Promise.resolve();
    },
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  };
}

/** A Home over a fake setup port. `close` is how the setup ends (what it reports to the Home as it does). */
function fixture(
  options: {
    keyless?: boolean;
    startChat?: () => Promise<HomeChatSession>;
  } = {},
) {
  const lines: string[] = [];
  const startChat = vi.fn(options.startChat ?? (() => Promise.resolve(session(lines))));
  let finish: () => void = () => {};
  const open = vi.fn<(options?: { readonly note?: string }) => Promise<void>>(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const c = createHomeController({
    homeStore: { read: () => SNAPSHOT },
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat,
    onExit: () => {},
    onError: () => {},
    providerSetup: { initialKeyless: options.keyless ?? true, open },
  });
  /** The setup closes, as the Home's wiring reports it: whether a key exists now, and the notice the setup left. */
  const close = async (keyless: boolean, notice?: string): Promise<void> => {
    c.setProviderState(keyless, notice);
    finish();
    await flush();
  };
  return { c, open, startChat, lines, close };
}

describe('Enter on a typed message while keyless', () => {
  it('opens the provider setup, builds no chat, and keeps the message in the prompt exactly as typed (OD-19)', () => {
    const f = fixture();
    type(f.c, 'hello  there');
    f.c.handleKey('', ENTER);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(
      f.open.mock.calls[0]?.[0],
      'an ordinary draft needs no extra note on the card',
    ).toBeUndefined();
    expect(f.startChat, 'a chat that cannot start is never built').not.toHaveBeenCalled();
    const state = f.c.getSnapshot();
    expect(state.nativeActionBusy).toBe(true);
    expect(state.mode, 'no loading echo, no chat').toBe('home');
    expect(state.input.text, 'the draft is untouched, spaces and all').toBe('hello  there');
    expect(state.pendingMessage).toBe('');
  });

  it('does not record the unsent message in the input history', () => {
    const f = fixture();
    type(f.c, 'hello');
    f.c.handleKey('', ENTER);
    expect(f.c.getSnapshot().historyEntries).toEqual([]);
  });

  it('keeps the draft when the setup closes in any way, and sends nothing', async () => {
    const f = fixture();
    type(f.c, 'hello');
    f.c.handleKey('', ENTER);
    await f.close(true, 'Setup skipped · /providers connects a provider any time');
    expect(f.c.getSnapshot().input.text).toBe('hello');
    expect(f.c.getSnapshot().notice).toBe(
      'Setup skipped · /providers connects a provider any time',
    );
    expect(f.c.getSnapshot().nativeActionBusy).toBe(false);
    expect(f.startChat).not.toHaveBeenCalled();
    expect(f.lines).toEqual([]);
  });

  it('keeps the draft when a key WAS stored too (a message is not sent to a model nobody looked at), and the next Enter sends it', async () => {
    const f = fixture();
    type(f.c, 'hello');
    f.c.handleKey('', ENTER);
    await f.close(false, 'Connected: Verified and stored your Anthropic key in the OS keychain.');
    expect(f.c.getSnapshot().keyless).toBe(false);
    expect(f.c.getSnapshot().input.text, 'the draft is still there after the key').toBe('hello');
    expect(f.startChat, 'the key did not send it').not.toHaveBeenCalled();
    f.c.handleKey('', ENTER);
    await flush();
    expect(f.startChat).toHaveBeenCalledTimes(1);
    expect(f.lines, 'the chat started with that message').toEqual(['hello']);
    expect(f.c.getSnapshot().mode).toBe('chat');
    expect(f.c.getSnapshot().historyEntries, 'recorded once it was sent').toEqual(['hello']);
  });

  it('still lets a slash command through: /models is not a message, and opens no setup', () => {
    const f = fixture();
    type(f.c, '/models');
    f.c.handleKey('', ENTER);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.startChat).not.toHaveBeenCalled();
  });

  it('is the same Enter an empty prompt opens the setup with, and that one clears nothing', () => {
    const f = fixture();
    f.c.handleKey('', ENTER);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.c.getSnapshot().input.text).toBe('');
  });

  it('does nothing keyless-specific with a key: the message starts the chat as it always did', async () => {
    const f = fixture({ keyless: false });
    type(f.c, 'hello');
    f.c.handleKey('', ENTER);
    await flush();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.startChat).toHaveBeenCalledTimes(1);
    expect(f.lines).toEqual(['hello']);
  });
});

describe('a draft that looks like a provider key is never kept and never recorded (ADR-0146 §6)', () => {
  it.each([
    ['a bare key', FAKE_KEY],
    ['a key inside a sentence', `here is my key ${FAKE_KEY} please use it`],
    ['a key on the second line of a draft', `first line\n${FAKE_KEY}`],
  ])(
    '%s: the editor is cleared, the history is empty, the setup opens with the reason',
    (_name, draft) => {
      const f = fixture();
      f.c.handlePaste(draft);
      expect(f.c.getSnapshot().input.text, 'pasted into the prompt').toBe(draft);
      f.c.handleKey('', ENTER);
      const state = f.c.getSnapshot();
      expect(state.input.text, 'the key is not kept in the prompt').toBe('');
      expect(state.historyEntries, 'and is never recorded').toEqual([]);
      expect(state.notice).toBe(KEY_SHAPED_DRAFT_NOTICE);
      expect(f.open).toHaveBeenCalledTimes(1);
      expect(
        f.open.mock.calls[0]?.[0],
        'the card carries the reason where the person is looking',
      ).toEqual({
        note: KEY_SHAPED_DRAFT_NOTICE,
      });
      expect(f.startChat).not.toHaveBeenCalled();
      expect(JSON.stringify(state), 'the key is nowhere in the state').not.toContain('journeyfake');
    },
  );

  it('says what happened in the fixed words, and never echoes any part of the draft', () => {
    expect(KEY_SHAPED_DRAFT_NOTICE).toBe(
      'That looked like an API key, so it was not kept. Paste it in the setup that just opened; it is stored in your OS keychain.',
    );
    expect(KEY_SHAPED_DRAFT_NOTICE).not.toContain('sk-');
  });

  it('cannot be recalled with Up once the setup has closed: it is in no history', async () => {
    const f = fixture();
    f.c.handlePaste(FAKE_KEY);
    f.c.handleKey('', ENTER);
    await f.close(true);
    f.c.handleKey('', { upArrow: true });
    expect(f.c.getSnapshot().input.text).toBe('');
    expect(JSON.stringify(f.c.getSnapshot())).not.toContain('journeyfake');
  });

  it('a short or ordinary dash-word is not mistaken for a key: the draft is kept', () => {
    const f = fixture();
    type(f.c, 'sk-learn is a library');
    f.c.handleKey('', ENTER);
    expect(f.c.getSnapshot().input.text).toBe('sk-learn is a library');
    expect(f.open.mock.calls[0]?.[0]).toBeUndefined();
  });
});

describe('a chat that fails to build for any other reason (G6)', () => {
  const LONG =
    "no API key for provider 'anthropic' — open `/providers` to connect a key or review its source. " +
    'The second sentence of the failure goes on for a while so that it cannot fit one row of an 80-column terminal.';

  it('gives the message back to the prompt and shows the whole failure in the notice', async () => {
    const f = fixture({ keyless: false, startChat: () => Promise.reject(new Error(LONG)) });
    type(f.c, 'hello  there');
    f.c.handleKey('', ENTER);
    expect(f.c.getSnapshot().mode, 'building').toBe('loading');
    expect(f.c.getSnapshot().input.text, 'the editor is clear while it builds').toBe('');
    await flush();
    const state = f.c.getSnapshot();
    expect(state.mode).toBe('home');
    expect(state.input.text, 'restored exactly as typed').toBe('hello  there');
    expect(state.notice, 'the whole message, not a one-row cut').toBe(
      `Couldn’t start the chat: ${LONG}`,
    );
    expect(state.pendingMessage).toBe('');
    expect(state.session).toBeUndefined();
  });

  it('text pasted while the session builds is dropped, so the restore puts back exactly the message that was sent', async () => {
    let fail: (error: Error) => void = () => {};
    const f = fixture({
      keyless: false,
      startChat: () =>
        new Promise<HomeChatSession>((_resolve, reject) => {
          fail = reject;
        }),
    });
    type(f.c, 'hello');
    f.c.handleKey('', ENTER);
    f.c.handlePaste('typed during the build'); // dropped while a session builds (the loading invariant)
    fail(new Error('boom'));
    await flush();
    expect(f.c.getSnapshot().input.text).toBe('hello');
    expect(f.c.getSnapshot().notice).toBe('Couldn’t start the chat: boom');
  });

  it('does not give a draft that looks like a key back to the prompt, and the failure still shows', async () => {
    const f = fixture({ keyless: false, startChat: () => Promise.reject(new Error('refused')) });
    f.c.handlePaste(FAKE_KEY);
    f.c.handleKey('', ENTER);
    await flush();
    expect(f.c.getSnapshot().input.text).toBe('');
    expect(f.c.getSnapshot().notice).toBe('Couldn’t start the chat: refused');
  });

  it('does not let a failure carry a key into the notice', async () => {
    const f = fixture({
      keyless: false,
      startChat: () => Promise.reject(new Error(`rejected ${FAKE_KEY} by the provider`)),
    });
    type(f.c, 'hello');
    f.c.handleKey('', ENTER);
    await flush();
    expect(f.c.getSnapshot().notice).not.toContain('journeyfake');
  });
});
