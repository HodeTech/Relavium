/**
 * The registry and the Home's dispatch agree ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §7, MVP-11
 * Step 2.2). The Home does not dispatch through the registry's `run`: a command it opens itself is marked `opener: 'home'` in the registry and
 * has an entry in the controller's ONE table of words, which a typed line and a palette selection are both looked up in; the few words that
 * run over the Home's own context (`/help`, `/exit`, `/doctor`, `/clear`, `/models`) are answered beside it. So a registry entry can exist with
 * nothing behind it. This test drives the REAL controller with the line of every command the registry places on the Home (pasted, and typed
 * through the palette, with and without an argument) and with the chat the Home hosts, and fails for an entry that is answered as an unknown
 * command or as a word that "works in a chat", and for a word of a chat that the Home would open. It also holds the palette's first row,
 * its dim rows and its direction to what the host does with them: `/` then `Enter` never leaves the application, a dim row says why and runs
 * nothing, and `/exit` is reached and run only by an explicit selection.
 *
 * Through the real Home controller; the ports and the timers are scripted.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  COMMAND_DEFINITIONS,
  commandDefinitionsOf,
  REPL_COMMANDS_BY_NAME,
  unavailableNotice,
} from '../../commands/repl-commands.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

const WAIT_MS = 5000; // the siblings' bound for a step that has to settle; the default `vi.waitFor` gives it one second
const ENTER = { return: true } as const;
const UP = { upArrow: true } as const;
const DOWN = { downArrow: true } as const;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const snapshotWith = (sessions: number): HomeSnapshot => ({
  attention: { gates: [], failedRuns: [] },
  recentSessions: Array.from({ length: sessions }, (_, index) => ({
    sessionId: `saved-${String(index)}`,
    title: `Saved conversation ${String(index)}`,
    workingDir: '/workspace',
    agentSlug: 'chat',
    modelId: undefined,
    status: 'ended' as const,
    updatedAt: '2026-11-10T00:00:00.000Z',
    totalCostMicrocents: 0,
  })),
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: sessions === 0,
});

interface Mounted {
  readonly controller: HomeController;
  readonly onExit: ReturnType<typeof vi.fn>;
  readonly startChat: ReturnType<typeof vi.fn>;
  /** The lines the chat was handed. */
  readonly lines: string[];
}

/** A Home with NO port wired, so each command answers at its own gate; `extra` wires the few the tests need. */
function mount(options: { sessions?: number; extra?: Partial<HomeControllerDeps> } = {}): Mounted {
  const lines: string[] = [];
  const onExit = vi.fn();
  const startChat = vi.fn(() => {
    let stopped = false;
    const session: HomeChatSession = {
      store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
      sessionId: 'live-chat',
      processLine: (line) => {
        lines.push(line);
        if (line === '/exit') stopped = true;
        return Promise.resolve();
      },
      shouldStop: () => stopped,
      stopReason: () => 'exit',
      teardown: () => Promise.resolve(),
    };
    return Promise.resolve(session);
  });
  const controller = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat,
    homeStore: { read: () => snapshotWith(options.sessions ?? 0) },
    schedule: () => () => {},
    onExit,
    onError: (cause) => {
      throw cause;
    },
    ...options.extra,
  });
  return { controller, onExit, startChat, lines };
}

const type = (c: HomeController, text: string): void => {
  for (const char of text) c.handleKey(char, {});
};
const paste = (c: HomeController, text: string): void => {
  c.handlePaste(text);
  c.handleKey('', ENTER);
};

/** A chat in front: a first message starts it, and the lines it was handed are cleared. */
async function intoChat(m: Mounted): Promise<void> {
  type(m.controller, 'hello');
  m.controller.handleKey('', ENTER);
  await vi.waitFor(() => expect(m.controller.getSnapshot().mode).toBe('chat'), {
    timeout: WAIT_MS,
  });
  await flush();
  m.lines.length = 0;
}

describe('every command the registry places on the Home is handled by the Home’s dispatch', () => {
  const HOME_COMMANDS = commandDefinitionsOf('home').map((definition) => definition.name);

  it('has the fifteen of the Home’s order', () => {
    expect(HOME_COMMANDS).toHaveLength(15);
  });

  /**
   * What each word does with NO port wired, by name: the screen it opens, the exit it makes, or the fixed sentence it refuses with. "Answered
   * with some notice" was the whole oracle once, and a word whose branch said the wrong thing, or the notice of another word, passed it. A new
   * command has to be given its outcome here: the first test below fails for a name that is missing.
   */
  type Outcome =
    | { readonly notice: string }
    | { readonly screen: 'help' }
    | { readonly exit: true };
  const OUTCOMES: Readonly<Record<string, Outcome>> = {
    resume: { notice: 'Session resume is unavailable here.' },
    run: { notice: 'Running a workflow is unavailable in this session.' },
    workflows: { notice: 'The project’s workflows are not available here.' },
    agents: { notice: 'The project’s agents are not available here.' },
    providers: { notice: 'Provider setup is unavailable in this session.' },
    models: { notice: '/models is unavailable here.' },
    mode: { notice: 'Startup mode settings are unavailable here.' },
    permissions: { notice: 'Remembered commands are not available here.' },
    pricing: { notice: 'Model pricing is not available here.' },
    init: { notice: 'Project initialization is unavailable in this session.' },
    import: { notice: 'Import is unavailable in this session.' },
    // The fast tier starts at once: the notice is its progress line, replaced by the report when the probes settle.
    doctor: { notice: 'doctor: checking…' },
    help: { screen: 'help' },
    clear: { notice: unavailableNotice('clear', 'no conversation to clear') },
    exit: { exit: true },
  };

  it('has an outcome for every command of the Home’s order, and for nothing else', () => {
    expect(Object.keys(OUTCOMES).sort()).toEqual([...HOME_COMMANDS].sort());
  });

  /** What the Home did, in the terms of {@link Outcome}, or why it did not. */
  const outcomeOf = (name: string, m: Mounted): string | undefined => {
    const snapshot = m.controller.getSnapshot();
    const expected = OUTCOMES[name];
    if (expected === undefined) return `/${name} has no expected outcome`;
    if ('exit' in expected)
      return m.onExit.mock.calls.length === 1
        ? undefined
        : `onExit was called ${String(m.onExit.mock.calls.length)} times`;
    if (m.onExit.mock.calls.length > 0) return 'the Home exited';
    if ('screen' in expected)
      return snapshot.screen?.kind === expected.screen
        ? undefined
        : `screen: ${snapshot.screen?.kind ?? '(none)'}`;
    if (snapshot.screen !== undefined) return `opened the ${snapshot.screen.kind} screen`;
    return snapshot.notice === expected.notice
      ? undefined
      : `notice: ${snapshot.notice ?? '(none)'}`;
  };

  it.each(HOME_COMMANDS)('the line /%s, pasted, does exactly what the Home does for it', (name) => {
    const m = mount({ sessions: 1 });
    paste(m.controller, `/${name}`);
    expect(m.startChat, `/${name} starts no chat`).not.toHaveBeenCalled();
    expect(outcomeOf(name, m), `/${name}`).toBeUndefined();
  });

  it.each(HOME_COMMANDS.filter((name) => name !== 'clear'))(
    'the entry /%s, chosen in the palette by its name, does the same',
    (name) => {
      const m = mount({ sessions: 1 });
      type(m.controller, `/${name}`);
      m.controller.handleKey('', ENTER);
      expect(m.startChat).not.toHaveBeenCalled();
      expect(m.controller.getSnapshot().palette, 'the palette is closed').toBeUndefined();
      expect(outcomeOf(name, m), `/${name}`).toBeUndefined();
    },
  );

  /** The ordinary "answered as unknown" test: the oracle above has to be able to say no. */
  const unknown = (m: Mounted): boolean => {
    const notice = m.controller.getSnapshot().notice ?? '';
    return /^Unknown command/u.test(notice) || notice.includes('works in a chat');
  };

  it('answers a word the registry does not place on the Home as unknown, so the check above can fail', () => {
    const m = mount();
    paste(m.controller, '/definitely-not-a-command');
    expect(unknown(m)).toBe(true);
    // …and the per-word oracle refuses it too: its notice is no word's outcome.
    expect(Object.values(OUTCOMES)).not.toContainEqual({
      notice: m.controller.getSnapshot().notice,
    });
  });

  it('every command of the chat the Home hosts is the chat’s own dispatch or the Home’s /resume', () => {
    const homeHandled = commandDefinitionsOf('home-chat')
      .map((definition) => definition.name)
      .filter((name) => !REPL_COMMANDS_BY_NAME.has(name));
    expect(homeHandled).toEqual(['resume']);
  });

  it('/resume typed in the chat the Home hosts is the Home’s: it opens the picker and is not sent to the chat', async () => {
    const pickSession = vi.fn(() => Promise.resolve(undefined));
    const m = mount({
      extra: { pickSession, resumeChat: () => Promise.resolve({ notice: 'unexpected' }) },
    });
    await intoChat(m);
    paste(m.controller, '/resume');
    await flush();
    expect(pickSession).toHaveBeenCalledOnce();
    expect(m.lines).toEqual([]);
  });
});

describe('a word of the Home, with an argument, is refused with its own sentence, typed or chosen in the palette', () => {
  /**
   * The sentence of each word of the Home's order when it is given something after its name. The sentences are fixed, per word: some say where
   * the input is asked instead (`/run`, `/import`, `/resume`), the words that run over the Home's own context share one template, and
   * `/mode` says there is no conversation to set it for. Written out here, so a word added to the Home has to be given its own.
   */
  const REFUSED: Readonly<Record<string, string>> = {
    resume: '/resume accepts no arguments. Use its picker to select a session.',
    run: '/run accepts no arguments. Use its picker to choose a workflow.',
    workflows: '/workflows accepts no arguments.',
    agents: '/agents accepts no arguments.',
    providers: '/providers accepts no arguments.',
    models: '/models accepts no arguments here. Start a chat to use them.',
    mode: 'No conversation is active. Use /mode to set the startup default.',
    permissions: '/permissions accepts no arguments.',
    pricing: '/pricing accepts no arguments.',
    init: '/init accepts no arguments.',
    import: '/import accepts no arguments. It asks for the path.',
    doctor: '/doctor accepts no arguments here. Start a chat to use them.',
    help: '/help accepts no arguments.',
    clear: '/clear accepts no arguments here. Start a chat to use them.',
    exit: '/exit accepts no arguments here. Start a chat to use them.',
  };
  const HOME_COMMANDS = commandDefinitionsOf('home').map((definition) => definition.name);

  it('has a sentence for every command of the Home’s order, and for nothing else', () => {
    expect(Object.keys(REFUSED).sort()).toEqual([...HOME_COMMANDS].sort());
  });

  const refused = (m: Mounted): string | undefined => {
    const snapshot = m.controller.getSnapshot();
    if (m.onExit.mock.calls.length > 0) return 'the Home exited';
    if (snapshot.screen !== undefined) return `opened the ${snapshot.screen.kind} screen`;
    if (snapshot.nativeActionBusy) return 'started a native action';
    return snapshot.notice;
  };

  it.each(HOME_COMMANDS)('/%s extra, pasted, says its sentence and opens nothing', (name) => {
    const m = mount({ sessions: 1 });
    paste(m.controller, `/${name} extra`);
    expect(m.startChat).not.toHaveBeenCalled();
    expect(refused(m), `/${name} extra`).toBe(REFUSED[name]);
    expect(m.controller.getSnapshot().input.text, 'the line left the editor').toBe('');
  });

  it.each(HOME_COMMANDS)(
    '/%s extra, typed after the `/` of the palette, says the same sentence (the query matches no row)',
    (name) => {
      const m = mount({ sessions: 1 });
      type(m.controller, `/${name} extra`);
      m.controller.handleKey('', ENTER);
      expect(m.startChat).not.toHaveBeenCalled();
      expect(m.controller.getSnapshot().palette, 'the palette is closed').toBeUndefined();
      expect(refused(m), `/${name} extra`).toBe(REFUSED[name]);
    },
  );
});

describe('a word that is a chat’s is not the Home’s (the table has no entry for it)', () => {
  const HOME = new Set(commandDefinitionsOf('home').map((definition) => definition.name));
  const CHAT_ONLY = COMMAND_DEFINITIONS.map((definition) => definition.name).filter(
    (name) => !HOME.has(name),
  );

  it('has chat-only commands to check', () => {
    expect(CHAT_ONLY).toContain('cost');
    expect(CHAT_ONLY).toContain('effort');
    expect(CHAT_ONLY.every((name) => REPL_COMMANDS_BY_NAME.has(name))).toBe(true);
  });

  it.each(CHAT_ONLY)('/%s at the landing says it works in a chat, and opens nothing', (name) => {
    const m = mount({ sessions: 1 });
    paste(m.controller, `/${name}`);
    const snapshot = m.controller.getSnapshot();
    expect(snapshot.notice).toBe(
      `/${name} works in a chat. Start one, then type it. /help lists the commands.`,
    );
    expect(snapshot.screen).toBeUndefined();
    expect(snapshot.nativeActionBusy).toBe(false);
    expect(m.startChat).not.toHaveBeenCalled();
  });

  it.each(['workflows', 'permissions', 'mode', 'models', 'doctor', 'help'])(
    '/%s typed in the chat the Home hosts is the chat’s own: it is handed to the chat, and the Home opens nothing',
    async (name) => {
      const m = mount({ sessions: 1 });
      await intoChat(m);
      paste(m.controller, `/${name}`);
      await flush();
      expect(m.lines, `/${name} reached the chat`).toEqual([`/${name}`]);
      const snapshot = m.controller.getSnapshot();
      expect(snapshot.screen).toBeUndefined();
      expect(snapshot.nativeActionBusy).toBe(false);
      expect(snapshot.notice).toBeUndefined();
    },
  );

  it.each(['workflows', 'permissions', 'mode', 'models', 'doctor', 'help'])(
    '/%s chosen in the palette of the chat the Home hosts is handed to the chat as the typed line is',
    async (name) => {
      const m = mount({ sessions: 1 });
      await intoChat(m);
      m.controller.handleKey('/', {});
      type(m.controller, name);
      m.controller.handleKey('', ENTER);
      await flush();
      expect(m.lines, `/${name} reached the chat`).toEqual([`/${name}`]);
      expect(m.controller.getSnapshot().screen).toBeUndefined();
    },
  );

  it('/resume chosen in the palette of the chat the Home hosts is the Home’s, as the typed line is: its picker opens and the chat is sent nothing', async () => {
    const pickSession = vi.fn(() => Promise.resolve(undefined));
    const m = mount({
      sessions: 1,
      extra: { pickSession, resumeChat: () => Promise.resolve({ notice: 'unexpected' }) },
    });
    await intoChat(m);
    m.controller.handleKey('/', {});
    type(m.controller, 'resume');
    m.controller.handleKey('', ENTER);
    await flush();
    expect(pickSession).toHaveBeenCalledOnce();
    expect(m.lines).toEqual([]);
  });

  it('/resume with an argument in the chat the Home hosts is refused in the Home’s own words, in the chat too', async () => {
    const m = mount({ sessions: 1 });
    await intoChat(m);
    paste(m.controller, '/resume extra');
    await flush();
    const said = 'Use its picker to select a session.';
    expect(m.controller.getSnapshot().notice).toContain(said);
    // …and the chat in front is told too, in its warnings channel (`store.note`), where a person looking at the chat reads it.
    const warnings = m.controller.getSnapshot().session?.store.getSnapshot().state.warnings ?? [];
    expect(warnings).toContainEqual(expect.stringContaining(said));
    expect(m.lines).toEqual([]);
  });
});

describe('`/` then `Enter` never leaves the application, and /exit runs only on an explicit selection', () => {
  it('on a Home with a saved session, runs /resume (the first row)', async () => {
    const pickSession = vi.fn(() => Promise.resolve(undefined));
    const m = mount({
      sessions: 2,
      extra: { pickSession, resumeChat: () => Promise.resolve({ notice: 'unexpected' }) },
    });
    m.controller.handleKey('/', {});
    m.controller.handleKey('', ENTER);
    await flush();
    expect(pickSession).toHaveBeenCalledOnce();
    expect(m.onExit).not.toHaveBeenCalled();
    expect(m.controller.getSnapshot().mode).toBe('home');
  });

  it('on a Home with none, runs /run: /resume is dim and the highlight starts past it', () => {
    const launchRun = vi.fn(() => Promise.resolve('The launch ran.'));
    const m = mount({ sessions: 0, extra: { launchRun } });
    m.controller.handleKey('/', {});
    expect(m.controller.getSnapshot().palette?.state.index).toBe(1);
    m.controller.handleKey('', ENTER);
    expect(launchRun).toHaveBeenCalledOnce();
    expect(m.onExit).not.toHaveBeenCalled();
  });

  it('on a keyless Home, runs /providers: the connect-a-provider call to action leads the list', () => {
    const open = vi.fn(() => Promise.resolve());
    const m = mount({
      sessions: 2,
      extra: { providerSetup: { initialKeyless: true, open } },
    });
    m.controller.handleKey('/', {});
    expect(m.controller.getSnapshot().palette?.list.rows[0]?.command.name).toBe('providers');
    expect(m.controller.getSnapshot().palette?.state.index).toBe(0);
    m.controller.handleKey('', ENTER);
    expect(open).toHaveBeenCalledOnce();
    expect(m.onExit).not.toHaveBeenCalled();
  });

  it('in the chat the Home hosts, selects /models and neither ends the session nor sends /exit', async () => {
    const m = mount();
    await intoChat(m);
    m.controller.handleKey('/', {});
    expect(
      m.controller.getSnapshot().palette?.list.layout,
      'a chat’s list runs up from the prompt',
    ).toBe('up');
    m.controller.handleKey('', ENTER);
    await flush();
    expect(m.lines).toEqual(['/models']);
    expect(m.lines).not.toContain('/exit');
    expect(m.controller.getSnapshot().mode).toBe('chat');
    expect(m.onExit).not.toHaveBeenCalled();
  });

  it('on the bare Home, ↓ walks to /exit and stops there; nothing runs until Enter, which then exits', () => {
    const m = mount();
    m.controller.handleKey('/', {});
    for (let step = 0; step < 40; step += 1) m.controller.handleKey('', DOWN);
    const { palette } = m.controller.getSnapshot();
    expect(palette?.list.rows[palette.state.index]?.command.name).toBe('exit');
    expect(m.onExit, 'the highlight alone runs nothing').not.toHaveBeenCalled();
    m.controller.handleKey('', ENTER);
    expect(m.onExit).toHaveBeenCalledOnce();
  });

  it('in the chat the Home hosts, ↑ walks to /exit (the list runs up), ↓ goes back, and only Enter sends /exit', async () => {
    const m = mount();
    await intoChat(m);
    m.controller.handleKey('/', {});
    m.controller.handleKey('', DOWN); // before the first entry: nothing, and no wrap-around
    expect(m.controller.getSnapshot().palette?.state.index).toBe(0);
    m.controller.handleKey('', UP);
    expect(m.controller.getSnapshot().palette?.state.index).toBe(1);
    m.controller.handleKey('', DOWN);
    expect(m.controller.getSnapshot().palette?.state.index).toBe(0);
    for (let step = 0; step < 40; step += 1) m.controller.handleKey('', UP);
    const { palette } = m.controller.getSnapshot();
    expect(palette?.list.rows[palette.state.index]?.command.name).toBe('exit');
    expect(m.lines, 'the highlight alone sends nothing').toEqual([]);
    m.controller.handleKey('', ENTER);
    await flush();
    expect(m.lines).toEqual(['/exit']);
  });
});

describe('a row that cannot act says why and runs nothing', () => {
  it('on the bare Home /clear is dim: Enter on it keeps the palette open with the reason, never "unknown command"', () => {
    const m = mount({ sessions: 1 });
    m.controller.handleKey('/', {});
    type(m.controller, 'clear');
    expect(m.controller.getSnapshot().palette?.list.rows[0]?.enabled).toBe(false);
    expect(
      m.controller.getSnapshot().palette?.state,
      'the typed exact name is highlighted',
    ).toEqual({
      query: 'clear',
      index: 0,
    });
    m.controller.handleKey('', ENTER);
    const snapshot = m.controller.getSnapshot();
    expect(snapshot.notice).toBe(unavailableNotice('clear', 'no conversation to clear'));
    expect(snapshot.palette, 'the palette stays open').toBeDefined();
    expect(snapshot.notice).not.toMatch(/unknown/iu);
    expect(m.startChat).not.toHaveBeenCalled();
    expect(m.onExit).not.toHaveBeenCalled();
  });

  it('/resume with nothing to resume is dim in the same way, and its picker is never opened', async () => {
    const pickSession = vi.fn(() => Promise.resolve(undefined));
    const m = mount({
      sessions: 0,
      extra: { pickSession, resumeChat: () => Promise.resolve({ notice: 'unexpected' }) },
    });
    m.controller.handleKey('/', {});
    type(m.controller, 'resume');
    m.controller.handleKey('', ENTER);
    await flush();
    expect(m.controller.getSnapshot().notice).toBe(
      unavailableNotice('resume', 'nothing to resume'),
    );
    expect(m.controller.getSnapshot().palette).toBeDefined();
    expect(pickSession).not.toHaveBeenCalled();
  });

  it('keeps working after the reason: Esc closes the palette and the Home is as it was', () => {
    const m = mount({ sessions: 1 });
    m.controller.handleKey('/', {});
    type(m.controller, 'clear');
    m.controller.handleKey('', ENTER);
    m.controller.handleKey('', { escape: true });
    expect(m.controller.getSnapshot().palette).toBeUndefined();
    expect(m.controller.getSnapshot().mode).toBe('home');
    expect(m.onExit).not.toHaveBeenCalled();
  });
});

describe('a word only the Home has, typed in a chat (ADR-0145 §7.4)', () => {
  it.each(['providers', 'init', 'import', 'pricing', 'run', 'agents'])(
    '/%s answers one line that names the Home and opens nothing',
    async (name) => {
      const open = vi.fn(() => Promise.resolve());
      const m = mount({ extra: { providerSetup: { initialKeyless: false, open } } });
      await intoChat(m);
      paste(m.controller, `/${name}`);
      await flush();
      const session = m.controller.getSnapshot().session;
      const said = (session?.store.getSnapshot().state.transcript ?? []).flatMap((entry) =>
        entry.role === 'notice' ? [entry.text] : [],
      );
      expect(said).toContain(`/${name} is available from the Home.`);
      expect(open).not.toHaveBeenCalled();
      expect(m.lines, 'not sent to the chat').toEqual([]);
      expect(m.controller.getSnapshot().notice, 'not an unknown command').toBeUndefined();
      expect(m.controller.getSnapshot().nativeActionBusy).toBe(false);
    },
  );
});
