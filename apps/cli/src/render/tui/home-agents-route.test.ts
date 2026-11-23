/**
 * `/agents` at the Home ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3 and its 2026-11-23 note, MVP-8 step 5): typed on the bare Home or chosen from its palette it opens the tab host on the agents strip's
 * Defined tab and starts no chat; from the Sessions tab, `Enter` resumes a conversation in place, the screen leaving in the very state change
 * that starts the resume. With a chat in front `/agents` is not the Home's, and it opens nothing.
 *
 * The Home controller is real; its agents port, sessions port and resume are scripted, so "starts no chat" is proved at the one place a chat
 * would begin (`startChat`) and "resumes" at the resume's own entry (`resumeChat`).
 */
import { describe, expect, it, vi } from 'vitest';

import { buildAgentsModel, type AgentsModelItem } from '../../history/agents-model.js';
import type { AgentsPort } from '../../home/agents-port.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
  type HomeControllerState,
} from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import type { TabHostState } from './tab-host.js';
import { SESSIONS_RESUME_UNAVAILABLE, type SessionsPort } from './tab-host-sessions.js';

/** The one named bound of every `vi.waitFor` in this file: a wait that needs it is a defect, not a slow machine. */
const WAIT_MS = 5000;

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const DOWN = { downArrow: true } as const;
const RIGHT = { rightArrow: true } as const;
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};

const items: readonly AgentsModelItem[] = [
  {
    entry: {
      slug: 'reviewer',
      name: 'Code Reviewer',
      path: '.relavium/agents/reviewer.agent.yaml',
      valid: true,
    },
    agent: {
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      system_prompt: 'You review code.',
      tools: ['read_file'],
    },
  },
  {
    entry: {
      slug: 'broken-one',
      name: undefined,
      path: '.relavium/agents/broken-one.agent.yaml',
      valid: false,
      error: 'unknown key "bogus" at the top level',
    },
    agent: undefined,
  },
];

function agentsPort() {
  const read = vi.fn(() => ({
    model: buildAgentsModel(items),
    slugOf: (index: number) => items[index]?.entry.slug,
    pathOf: (index: number) => items[index]?.entry.path,
  }));
  return { port: { read } satisfies AgentsPort, read };
}

const SESSIONS = [
  { id: 'sess-aaa', title: 'Fix the flaky test', agent: 'coder', age: '5m ago' },
  { id: 'sess-bbb', title: 'Plan the release', agent: 'writer', age: '2h ago' },
];

function sessionsPort(options: { readonly fails?: boolean } = {}) {
  const read = vi.fn(() => {
    if (options.fails === true) throw new Error('PRIVATE_FAULT_TEXT');
    return { rows: SESSIONS, more: false };
  });
  return { port: { read } satisfies SessionsPort, read };
}

type ResumeResult = HomeChatSession | { readonly notice: string } | undefined;

interface Options {
  readonly agents?: AgentsPort | undefined;
  readonly sessions?: SessionsPort | undefined;
  /** What `resumeChat` answers; absent ⇒ no resume is wired. */
  readonly resume?: ((sessionId: string) => Promise<ResumeResult>) | 'none';
}

function mount(options: Options = {}) {
  const lines: string[] = [];
  const chatSession = (sessionId: string): HomeChatSession => {
    let stopped = false;
    return {
      store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
      sessionId,
      processLine: (line) => {
        lines.push(line);
        if (line === '/exit') stopped = true;
        return Promise.resolve();
      },
      shouldStop: () => stopped,
      stopReason: () => 'exit',
      teardown: () => Promise.resolve(),
    };
  };
  const startChat = vi.fn(() => Promise.resolve(chatSession('sess-started')));
  const fakeAgents = agentsPort();
  const fakeSessions = sessionsPort();
  const agents = 'agents' in options ? options.agents : fakeAgents.port;
  const sessions = 'sessions' in options ? options.sessions : fakeSessions.port;
  const resumeChat = vi.fn(
    (sessionId: string): Promise<ResumeResult> =>
      options.resume === undefined || options.resume === 'none'
        ? Promise.resolve(chatSession(sessionId))
        : options.resume(sessionId),
  );
  const deps: HomeControllerDeps = {
    ...(agents === undefined ? {} : { agents }),
    ...(sessions === undefined ? {} : { sessions }),
    ...(options.resume === 'none' ? {} : { resumeChat }),
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat,
    homeStore: { read: () => EMPTY },
    schedule: () => () => {},
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
  };
  const controller = createHomeController(deps);
  return {
    controller,
    startChat,
    resumeChat,
    lines,
    agentReads: fakeAgents.read,
    sessionReads: fakeSessions.read,
  };
}

const hostOf = (c: HomeController): TabHostState | undefined => {
  const screen = c.getSnapshot().screen;
  return screen?.kind === 'tab-host' ? screen.host : undefined;
};
const submit = (c: HomeController, line: string): void => {
  c.handlePaste(line);
  c.handleKey('', ENTER);
};

describe('a typed /agents at the Home', () => {
  it('opens the tab host on the agents strip’s Defined tab, clears the composer, and starts no chat', async () => {
    const { controller, startChat, agentReads, sessionReads } = mount();
    submit(controller, '/agents');
    await flush();
    const host = hostOf(controller);
    expect(host?.tab).toBe('agents');
    expect(host?.agents?.read.model.rows.map((row) => [row.slug, row.state])).toEqual([
      ['reviewer', 'ready'],
      ['broken-one', 'invalid'],
    ]);
    expect(agentReads, 'the catalog was read on entering').toHaveBeenCalledTimes(1);
    expect(
      sessionReads,
      'the Sessions tab is read when it is entered, not before',
    ).not.toHaveBeenCalled();
    expect(controller.getSnapshot().input.text).toBe('');
    expect(controller.getSnapshot().mode, 'still the Home').toBe('home');
    expect(controller.getSnapshot().session).toBeUndefined();
    expect(startChat, 'no chat began').not.toHaveBeenCalled();
  });

  it('is opened by the palette too, and Esc leaves it for the landing', async () => {
    const { controller, startChat } = mount();
    controller.handleKey('/', {}); // an empty prompt: the palette opens
    expect(controller.getSnapshot().palette).toBeDefined();
    type(controller, 'agents');
    controller.handleKey('', ENTER);
    await flush();
    expect(hostOf(controller)?.tab).toBe('agents');
    expect(controller.getSnapshot().palette).toBeUndefined();
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(startChat).not.toHaveBeenCalled();
  });

  it('takes no argument: the line says so and opens nothing and starts nothing', async () => {
    const { controller, startChat, agentReads } = mount();
    submit(controller, '/agents all');
    await flush();
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(controller.getSnapshot().notice).toBe('/agents accepts no arguments.');
    expect(controller.getSnapshot().input.text).toBe('');
    expect(agentReads).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
  });

  it('says the agents are not available when no catalog is wired, and still starts no chat', async () => {
    const { controller, startChat } = mount({ agents: undefined });
    submit(controller, '/agents');
    await flush();
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(controller.getSnapshot().notice).toBe('The project’s agents are not available here.');
    expect(startChat).not.toHaveBeenCalled();
  });

  it('opens on a line that says it cannot list when the read fails, never on a crash and never the cause', async () => {
    const { controller } = mount({
      agents: {
        read: () => {
          throw new Error('PRIVATE_FAULT_TEXT');
        },
      },
    });
    submit(controller, '/agents');
    await flush();
    expect(hostOf(controller)?.unreadable).toBe(true);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('PRIVATE_FAULT_TEXT');
  });

  it('walks the Esc ladder: the detail first, then the screen, and Ctrl+C closes from the detail', () => {
    const { controller } = mount();
    submit(controller, '/agents');
    controller.handleKey('', ENTER);
    expect(hostOf(controller)?.agents?.detail?.slug).toBe('reviewer');
    controller.handleKey('', ESC);
    expect(hostOf(controller)?.agents?.detail, 'the first Esc leaves the detail').toBeUndefined();
    expect(controller.getSnapshot().screen?.kind).toBe('tab-host');
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen, 'the second Esc closes the screen').toBeUndefined();
    submit(controller, '/agents');
    controller.handleKey('', ENTER);
    controller.handleKey('c', { ctrl: true });
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(controller.getSnapshot().interruptArmed, 'a browser arms nothing').toBe(false);
  });

  it('forgets the strip when the screen closes: the next /agents starts at the top of the Defined tab', () => {
    const { controller } = mount();
    submit(controller, '/agents');
    controller.handleKey('', DOWN);
    controller.handleKey('', RIGHT);
    expect(hostOf(controller)?.tab).toBe('sessions');
    controller.handleKey('', ESC);
    submit(controller, '/agents');
    expect(hostOf(controller)?.tab).toBe('agents');
    expect(hostOf(controller)?.agents?.cursor).toBe(0);
  });
});

describe('/agents inside a chat', () => {
  async function chatting(options: Options = {}) {
    const mounted = mount(options);
    type(mounted.controller, 'hello');
    mounted.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(mounted.controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    await flush();
    return mounted;
  }

  it('is not the Home’s: the tab host does not open and its catalog is not read, and the line reaches the chat', async () => {
    const { controller, lines, agentReads } = await chatting();
    controller.handlePaste('/agents');
    controller.handleKey('', ENTER);
    await flush();
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(agentReads).not.toHaveBeenCalled();
    expect(lines, 'the chat received the line, as it receives any slash it does not own').toContain(
      '/agents',
    );
  });

  it('is not in the chat palette either', async () => {
    const { controller, lines, agentReads } = await chatting();
    controller.handleKey('/', {});
    expect(controller.getSnapshot().palette).toBeDefined();
    type(controller, 'agents');
    controller.handleKey('', ENTER);
    await flush();
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(agentReads).not.toHaveBeenCalled();
    expect(lines).not.toContain('/agents');
  });
});

describe('Enter on a session of the Sessions tab resumes it in place', () => {
  /** The tab host open on the Sessions tab, the cursor on the second conversation. */
  function onSessions(options: Options = {}) {
    const mounted = mount(options);
    submit(mounted.controller, '/agents');
    mounted.controller.handleKey('', RIGHT);
    mounted.controller.handleKey('', DOWN);
    return mounted;
  }

  it('closes the screen and begins the resume in ONE state change, then opens the chat with nothing under it', async () => {
    const { controller, resumeChat, startChat } = onSessions();
    expect(hostOf(controller)?.tab).toBe('sessions');
    expect(hostOf(controller)?.sessions?.cursor).toBe(1);
    const states: HomeControllerState[] = [];
    const unsubscribe = controller.subscribe(() => states.push(controller.getSnapshot()));
    controller.handleKey('', ENTER);
    // Synchronously, before anything settles: exactly one transition, and it is the one that took the screen away.
    expect(states, 'one state change for the Enter').toHaveLength(1);
    expect(states[0]?.screen, 'the screen is gone in that very change').toBeUndefined();
    expect(states[0]?.nativeActionBusy, 'and it is the one that began the resume').toBe(true);
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(resumeChat, 'the resume was asked for the row’s own id').toHaveBeenCalledTimes(1);
    expect(resumeChat).toHaveBeenCalledWith('sess-bbb');
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    unsubscribe();
    const after = controller.getSnapshot();
    expect(after.session?.sessionId).toBe('sess-bbb');
    expect(after.screen, 'the chat is not under a tab host').toBeUndefined();
    expect(startChat, 'a resume starts no new chat').not.toHaveBeenCalled();
    expect(
      states.every((state) => state.screen === undefined),
      'no state after the Enter shows a screen',
    ).toBe(true);
  });

  it('forgets the strip with the screen, as any close does: the next /agents starts at the Defined tab', async () => {
    const { controller } = onSessions();
    controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    controller.handlePaste('/exit');
    controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('home'), {
      timeout: WAIT_MS,
    });
    submit(controller, '/agents');
    expect(hostOf(controller)?.tab).toBe('agents');
  });

  it('a conversation that cannot be resumed says so on the landing, and no screen is left open', async () => {
    const { controller } = onSessions({
      resume: () => Promise.resolve({ notice: 'That conversation could not be resumed.' }),
    });
    controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(controller.getSnapshot().nativeActionBusy).toBe(false), {
      timeout: WAIT_MS,
    });
    await flush();
    const after = controller.getSnapshot();
    expect(after.notice).toBe('That conversation could not be resumed.');
    expect(after.screen).toBeUndefined();
    expect(after.mode).toBe('home');
  });

  it('says so on the tab, and leaves the tab open, when this Home cannot resume at all', () => {
    const { controller, resumeChat } = onSessions({ resume: 'none' });
    controller.handleKey('', ENTER);
    expect(resumeChat).not.toHaveBeenCalled();
    expect(controller.getSnapshot().screen?.kind, 'the tab host is still in front').toBe(
      'tab-host',
    );
    expect(hostOf(controller)?.tab).toBe('sessions');
    expect(hostOf(controller)?.sessions?.message).toBe(SESSIONS_RESUME_UNAVAILABLE);
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
  });

  it('does nothing while another native action holds the keyboard', async () => {
    let finish: (result: ResumeResult) => void = () => undefined;
    const { controller, resumeChat } = onSessions({
      resume: () =>
        new Promise<ResumeResult>((resolve) => {
          finish = resolve;
        }),
    });
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().nativeActionBusy).toBe(true);
    // The resume is still going: a second Enter reaches nothing (the keyboard is the flow's), and no second resume starts.
    controller.handleKey('', ENTER);
    expect(resumeChat).toHaveBeenCalledTimes(1);
    finish(undefined);
    await flush();
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
    expect(controller.getSnapshot().screen, 'the screen left with the first Enter').toBeUndefined();
  });

  it('opens on a line that says it cannot list when the sessions cannot be read, never the cause', () => {
    const { controller } = mount({ sessions: sessionsPort({ fails: true }).port });
    submit(controller, '/agents');
    controller.handleKey('', RIGHT);
    expect(hostOf(controller)?.tab).toBe('sessions');
    expect(hostOf(controller)?.unreadable).toBe(true);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('PRIVATE_FAULT_TEXT');
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
  });
});
