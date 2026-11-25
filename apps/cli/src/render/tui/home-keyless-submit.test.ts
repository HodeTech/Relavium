import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  KEY_SHAPED_DRAFT_NOTICE,
  KEY_SHAPED_LINE_NOTICE,
  KEY_SHAPED_SEND_NOTICE,
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
/** A key as the four providers write one, long enough to be one. */
const FAKE_KEY = 'sk-ant-api03-journeyfakefakefakefake0123456789';
const OTHER_KEYS = [
  ['OpenAI project', 'sk-proj-journeyfakefakefakefake0123456789'],
  ['DeepSeek', 'sk-journeyfake0123456789abcdef01234567'],
  ['Gemini', 'AIzajourneyfakefakefakefake0123456789_-x'],
] as const;

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

  // The line is PASTED: typing `/` opens the palette, which owns Enter, so a typed line never reaches `submit()` and the test would say
  // nothing about the order of `managementCommand` and the keyless branch there.
  it.each(['/models', '/doctor', '/help'])(
    'still lets a pasted slash command through: %s is a command, not a message, and opens no setup',
    (line) => {
      const f = fixture();
      f.c.handlePaste(line);
      expect(f.c.getSnapshot().palette, 'a paste does not open the palette').toBeUndefined();
      expect(f.c.getSnapshot().input.text).toBe(line);
      f.c.handleKey('', ENTER);
      expect(f.open, 'the keyless branch did not take the command').not.toHaveBeenCalled();
      expect(f.startChat).not.toHaveBeenCalled();
      expect(f.c.getSnapshot().input.text, 'the command ran and cleared the line').toBe('');
    },
  );

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

  it.each(OTHER_KEYS)('a %s key is just as unkept and unrecorded', (_provider, key) => {
    const f = fixture();
    f.c.handlePaste(`my key: ${key}`);
    f.c.handleKey('', ENTER);
    const state = f.c.getSnapshot();
    expect(state.input.text).toBe('');
    expect(state.historyEntries).toEqual([]);
    expect(state.notice).toBe(KEY_SHAPED_DRAFT_NOTICE);
    expect(JSON.stringify(state)).not.toContain('journeyfake');
  });

  it('says what happened in the fixed words (kept nowhere, to be pasted in the setup, and nothing about where it is stored), and never echoes any part of the draft', () => {
    expect(KEY_SHAPED_DRAFT_NOTICE).toBe(
      'That looked like an API key, so it was not kept. Choose a provider in the setup that just opened and paste it there.',
    );
    expect(
      KEY_SHAPED_DRAFT_NOTICE,
      'the keychain may be down: no promise about storage',
    ).not.toContain('keychain');
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

  // The sentence says "in the setup that just opened"; once the setup has closed with nothing to say of its own it is false (round 2, K4).
  it('takes the sentence down when the setup closes with nothing of its own, and keeps any notice the setup left', async () => {
    const closed = fixture();
    closed.c.handlePaste(FAKE_KEY);
    closed.c.handleKey('', ENTER);
    expect(closed.c.getSnapshot().notice).toBe(KEY_SHAPED_DRAFT_NOTICE);
    await closed.close(true);
    expect(closed.c.getSnapshot().notice, 'no setup is open any more').toBeUndefined();

    const skipped = fixture();
    skipped.c.handlePaste(FAKE_KEY);
    skipped.c.handleKey('', ENTER);
    await skipped.close(true, 'Setup skipped · /providers connects a provider any time');
    expect(skipped.c.getSnapshot().notice).toBe(
      'Setup skipped · /providers connects a provider any time',
    );

    // Any OTHER notice survives a close that has nothing to say, as it always did.
    const other = fixture();
    other.c.handlePaste('/models');
    other.c.handleKey('', ENTER);
    const before = other.c.getSnapshot().notice;
    other.c.setProviderState(true);
    expect(other.c.getSnapshot().notice).toBe(before);
  });

  it('a short or ordinary dash-word is not mistaken for a key: the draft is kept', () => {
    const f = fixture();
    type(f.c, 'sk-learn is a library');
    f.c.handleKey('', ENTER);
    expect(f.c.getSnapshot().input.text).toBe('sk-learn is a library');
    expect(f.open.mock.calls[0]?.[0]).toBeUndefined();
  });

  // The diagnostic scrubber masked all of these, discarded the message and said 'API key' (observed); none of them is a key.
  it.each([
    'What is the basic idea of a monad?',
    'Explain Basic auth',
    'the bearer of bad news',
    'https://user@example.com',
    'what does x-api-key: header do',
    'sk-learn-intelex-2024-02',
  ])('the ordinary message %j is kept and takes the normal keyless Enter path', (message) => {
    const f = fixture();
    f.c.handlePaste(message);
    f.c.handleKey('', ENTER);
    expect(f.c.getSnapshot().input.text, 'kept exactly as typed').toBe(message);
    expect(f.open.mock.calls[0]?.[0], 'with no key-shaped reason on the card').toBeUndefined();
    expect(f.c.getSnapshot().notice).toBeUndefined();
  });

  describe('a line that starts with a slash is not echoed back when it holds a key', () => {
    it.each([
      ['a slash and the key', `/${FAKE_KEY}`],
      ['a capitalised word and the key on the next line', `/Foo\n${FAKE_KEY}`],
      ['a lower-case word and the key', `/unknown ${FAKE_KEY}`],
      [
        'a path-like word that is all lower-case letters and hyphens',
        '/sk-ant-journeyfakefakefakefakefake',
      ],
    ])(
      '%s: a fixed sentence, the editor cleared, nothing recorded, no setup opened',
      (_name, line) => {
        const f = fixture();
        f.c.handlePaste(line);
        f.c.handleKey('', ENTER);
        const state = f.c.getSnapshot();
        expect(state.notice).toBe(KEY_SHAPED_LINE_NOTICE);
        expect(state.input.text).toBe('');
        expect(state.historyEntries).toEqual([]);
        expect(JSON.stringify(state), 'no part of the line is on screen or in state').not.toContain(
          'journeyfake',
        );
        expect(f.open, 'the line was a command line, so no setup opens').not.toHaveBeenCalled();
        expect(f.startChat).not.toHaveBeenCalled();
      },
    );

    it('still names an ordinary unknown command', () => {
      const f = fixture();
      f.c.handlePaste('/Users/x/file.txt');
      f.c.handleKey('', ENTER);
      expect(f.c.getSnapshot().notice).toBe(
        'Unknown command: /Users/x/file.txt. /help lists the commands.',
      );
    });

    it('says it without a promise about storage and without naming a setup that did not open', () => {
      expect(KEY_SHAPED_LINE_NOTICE).toBe(
        'That looked like an API key, so it was not shown or kept. Use /providers to connect a provider and paste it there.',
      );
    });
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

  it('records an ordinary message that failed to build, so Up still recalls it', async () => {
    const f = fixture({ keyless: false, startChat: () => Promise.reject(new Error('refused')) });
    type(f.c, 'hello');
    f.c.handleKey('', ENTER);
    await flush();
    expect(f.c.getSnapshot().historyEntries).toEqual(['hello']);
  });

  it('draws the failure as ONE bounded line with the host glyphs blanked, whatever the error carries', async () => {
    const hostile = `first\nsecond\r\n━━ Approval needed ━━ ✓ Connected ▶ run [Ctrl+Y] ${'x'.repeat(5000)}`;
    const f = fixture({ keyless: false, startChat: () => Promise.reject(new Error(hostile)) });
    type(f.c, 'hello');
    f.c.handleKey('', ENTER);
    await flush();
    const notice = f.c.getSnapshot().notice ?? '';
    expect(notice.startsWith('Couldn’t start the chat: first second')).toBe(true);
    expect(notice, 'one logical line').not.toMatch(/[\n\r\t]/u);
    expect(notice, 'the host rule and tick are blanked').not.toMatch(/[━✓▶]/u);
    expect(notice, 'a chord is made inert').not.toContain('[Ctrl+Y]');
    expect(notice, 'no more than the bound').toHaveLength('Couldn’t start the chat: '.length + 301);
    expect(notice.endsWith('…')).toBe(true);
  });

  it('keeps a failure under the bound whole', async () => {
    const f = fixture({
      keyless: false,
      startChat: () => Promise.reject(new Error('y'.repeat(300))),
    });
    type(f.c, 'hello');
    f.c.handleKey('', ENTER);
    await flush();
    expect(f.c.getSnapshot().notice).toBe(`Couldn’t start the chat: ${'y'.repeat(300)}`);
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

describe('a draft that looks like a provider key on a keyed Home (round 2, A1)', () => {
  // A key pasted on a keyed Home used to be shown as the pending message, sent to the model, appended to the transcript and written to
  // `history.db` unencrypted (round 2, A1). It is refused BEFORE a chat is built, like the keyless Enter, whatever the build would have done.
  it.each<readonly [string, string]>([['Anthropic', FAKE_KEY], ...OTHER_KEYS])(
    'refuses a %s key on a keyed Home: no chat is built, nothing reaches processLine, the prompt is empty and no history is written',
    async (_provider, key) => {
      const f = fixture({ keyless: false });
      f.c.handlePaste(key);
      f.c.handleKey('', ENTER);
      await flush();
      const state = f.c.getSnapshot();
      expect(f.startChat, 'no chat is built for it').not.toHaveBeenCalled();
      expect(f.lines, 'processLine never receives it').toEqual([]);
      expect(state.mode, 'no loading echo').toBe('home');
      expect(state.pendingMessage, 'it is never shown as the pending message').toBe('');
      expect(state.input.text, 'the editor is cleared').toBe('');
      expect(state.historyEntries, 'nothing recorded').toEqual([]);
      expect(state.notice).toBe(KEY_SHAPED_SEND_NOTICE);
      expect(f.open, 'a keyed Home opens no setup for it').not.toHaveBeenCalled();
      expect(JSON.stringify(state), 'the key is nowhere in the state').not.toContain('journeyfake');
      f.c.handleKey('', { upArrow: true });
      expect(f.c.getSnapshot().input.text, 'Up recalls nothing').toBe('');
      // The next message that IS sent finds a history that holds only itself: the refused draft was never recorded behind the state.
      type(f.c, 'hello');
      f.c.handleKey('', ENTER);
      await flush();
      expect(f.c.getSnapshot().historyEntries).toEqual(['hello']);
    },
  );

  it('refuses a key inside a sentence or on a later line of the draft, with the same fixed sentence', async () => {
    for (const draft of [`here is my key ${FAKE_KEY} please use it`, `first line\n${FAKE_KEY}`]) {
      const f = fixture({ keyless: false });
      f.c.handlePaste(draft);
      f.c.handleKey('', ENTER);
      await flush();
      expect(f.startChat).not.toHaveBeenCalled();
      expect(f.c.getSnapshot().notice).toBe(KEY_SHAPED_SEND_NOTICE);
      expect(f.c.getSnapshot().input.text).toBe('');
    }
  });

  it('says it in fixed words that name where keys go and echo nothing of the draft', () => {
    expect(KEY_SHAPED_SEND_NOTICE).toBe(
      'That looked like an API key, so it was not sent. Keys are managed with /providers.',
    );
  });

  it('still starts the chat for an ordinary message that merely mentions a key format', async () => {
    const f = fixture({ keyless: false });
    type(f.c, 'sk-learn is a library');
    f.c.handleKey('', ENTER);
    await flush();
    expect(f.startChat).toHaveBeenCalledTimes(1);
    expect(f.lines).toEqual(['sk-learn is a library']);
  });
});
