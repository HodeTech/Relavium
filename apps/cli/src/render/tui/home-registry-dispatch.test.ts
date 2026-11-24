/**
 * The registry and the Home's dispatch agree ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §7, MVP-11
 * Step 2.2). The Home does not dispatch through the registry's `run` (its commands have a `run` that does nothing) but through a chain of
 * regular expressions in the controller, so a registry entry can exist with nothing behind it. This test drives the REAL controller with the
 * line of every command the registry places on the Home (pasted, and typed through the palette) and with the chat the Home hosts, and fails
 * for an entry that is answered as an unknown command or as a word that "works in a chat". It also holds the palette's first row, its dim
 * rows and its direction to what the host does with them: `/` then `Enter` never leaves the application, a dim row says why and runs
 * nothing, and `/exit` is reached and run only by an explicit selection.
 *
 * Through the real Home controller; the ports and the timers are scripted.
 */
import { describe, expect, it, vi } from 'vitest';

import {
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
  await vi.waitFor(() => expect(m.controller.getSnapshot().mode).toBe('chat'));
  await flush();
  m.lines.length = 0;
}

describe('every command the registry places on the Home is handled by the Home’s dispatch', () => {
  const HOME_COMMANDS = commandDefinitionsOf('home').map((definition) => definition.name);

  it('has the fifteen of the Home’s order', () => {
    expect(HOME_COMMANDS).toHaveLength(15);
  });

  /** What "handled" means with no port wired: it answered with its own gate, opened its own screen or exited: never as an unknown word. */
  const handled = (m: Mounted): boolean => {
    const snapshot = m.controller.getSnapshot();
    const notice = snapshot.notice ?? '';
    if (/^Unknown command/u.test(notice) || notice.includes('works in a chat')) return false;
    return notice.length > 0 || snapshot.screen !== undefined || m.onExit.mock.calls.length > 0;
  };

  it.each(HOME_COMMANDS)('the line /%s, pasted, is answered by the Home', (name) => {
    const m = mount({ sessions: 1 });
    paste(m.controller, `/${name}`);
    expect(m.startChat, `/${name} starts no chat`).not.toHaveBeenCalled();
    expect(handled(m), `/${name}: ${m.controller.getSnapshot().notice ?? '(no notice)'}`).toBe(
      true,
    );
  });

  it.each(HOME_COMMANDS.filter((name) => name !== 'clear'))(
    'the entry /%s, chosen in the palette by its name, is answered by the Home',
    (name) => {
      const m = mount({ sessions: 1 });
      type(m.controller, `/${name}`);
      m.controller.handleKey('', ENTER);
      expect(m.startChat).not.toHaveBeenCalled();
      expect(m.controller.getSnapshot().palette, 'the palette is closed').toBeUndefined();
      expect(handled(m), `/${name}: ${m.controller.getSnapshot().notice ?? '(no notice)'}`).toBe(
        true,
      );
    },
  );

  it('answers a word the registry does not place on the Home as unknown, so the check above can fail', () => {
    const m = mount();
    paste(m.controller, '/definitely-not-a-command');
    expect(handled(m)).toBe(false);
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
    expect(m.controller.getSnapshot().palette?.index).toBe(1);
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
    expect(m.controller.getSnapshot().paletteList?.rows[0]?.command.name).toBe('providers');
    expect(m.controller.getSnapshot().palette?.index).toBe(0);
    m.controller.handleKey('', ENTER);
    expect(open).toHaveBeenCalledOnce();
    expect(m.onExit).not.toHaveBeenCalled();
  });

  it('in the chat the Home hosts, selects /models and neither ends the session nor sends /exit', async () => {
    const m = mount();
    await intoChat(m);
    m.controller.handleKey('/', {});
    expect(
      m.controller.getSnapshot().paletteList?.layout,
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
    const { palette, paletteList } = m.controller.getSnapshot();
    expect(paletteList?.rows[palette?.index ?? -1]?.command.name).toBe('exit');
    expect(m.onExit, 'the highlight alone runs nothing').not.toHaveBeenCalled();
    m.controller.handleKey('', ENTER);
    expect(m.onExit).toHaveBeenCalledOnce();
  });

  it('in the chat the Home hosts, ↑ walks to /exit (the list runs up), ↓ goes back, and only Enter sends /exit', async () => {
    const m = mount();
    await intoChat(m);
    m.controller.handleKey('/', {});
    m.controller.handleKey('', DOWN); // before the first entry: nothing, and no wrap-around
    expect(m.controller.getSnapshot().palette?.index).toBe(0);
    m.controller.handleKey('', UP);
    expect(m.controller.getSnapshot().palette?.index).toBe(1);
    m.controller.handleKey('', DOWN);
    expect(m.controller.getSnapshot().palette?.index).toBe(0);
    for (let step = 0; step < 40; step += 1) m.controller.handleKey('', UP);
    const { palette, paletteList } = m.controller.getSnapshot();
    expect(paletteList?.rows[palette?.index ?? -1]?.command.name).toBe('exit');
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
    expect(m.controller.getSnapshot().paletteList?.rows[0]?.enabled).toBe(false);
    expect(m.controller.getSnapshot().palette, 'the typed exact name is highlighted').toEqual({
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
