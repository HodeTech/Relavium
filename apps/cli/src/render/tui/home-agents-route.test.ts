/**
 * `/agents` at the Home ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3 and its 2026-11-23 note, MVP-8 step 5): typed on the bare Home or chosen from its palette it opens the tab host on the agents strip's
 * Defined tab and starts no chat; from the Sessions tab, `Enter` resumes a conversation in place, the screen leaving in the very state change
 * that starts the resume; and `c` on an agent's detail starts a chat bound to that agent, the screen leaving in the very state change that
 * starts the build. With a chat in front `/agents` is not the Home's, and it opens nothing.
 *
 * The Home controller is real; its agents port, sessions port and resume are scripted, so "starts no chat" is proved at the one place a chat
 * would begin (`startChat`) and "resumes" at the resume's own entry (`resumeChat`).
 */
import type { AgentDefinition } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

import { buildAgentsModel, type AgentsModelItem } from '../../history/agents-model.js';
import {
  HomeAgentStartError,
  agentStartNotice,
  type AgentStartReason,
  type HomeAgentRequest,
} from '../../home/agent-start.js';
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

/** The whole definition the catalog holds for an item: what its page is drawn from, and what a chat is asked to be still. */
const definitionOf = (item: AgentsModelItem | undefined): AgentDefinition | undefined =>
  item?.agent === undefined ? undefined : { id: item.entry.slug, ...item.agent };

function agentsPort(listed: readonly AgentsModelItem[] = items) {
  const read = vi.fn(() => ({
    model: buildAgentsModel(listed),
    slugOf: (index: number) => listed[index]?.entry.slug,
    pathOf: (index: number) => listed[index]?.entry.path,
    definitionOf: (index: number) => definitionOf(listed[index]),
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
  /** What `startChat` answers (the built session, or a rejection); absent ⇒ a session that is ready at once. */
  readonly startChat?: (agent?: HomeAgentRequest) => Promise<HomeChatSession>;
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
  const startChat = vi.fn<(agent?: HomeAgentRequest) => Promise<HomeChatSession>>(
    options.startChat ?? (() => Promise.resolve(chatSession('sess-started'))),
  );
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

  it('a resume that fails says so on the landing and frees the keyboard, never the cause', async () => {
    const { controller } = onSessions({
      resume: () => Promise.reject(new Error('PRIVATE_FAULT_TEXT')),
    });
    controller.handleKey('', ENTER);
    await vi.waitFor(
      () => expect(controller.getSnapshot().notice).toBe('Session resume could not be completed.'),
      { timeout: WAIT_MS },
    );
    const after = controller.getSnapshot();
    expect(after.nativeActionBusy, 'the keyboard is the prompt’s again').toBe(false);
    expect(after.screen, 'the screen left with the Enter').toBeUndefined();
    expect(after.mode).toBe('home');
    expect(JSON.stringify(after)).not.toContain('PRIVATE_FAULT_TEXT');
    // The keyboard really is free: a key reaches the prompt.
    controller.handleKey('x', {});
    expect(controller.getSnapshot().input.text).toBe('x');
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

  it('a second Enter while the resume is in flight reaches nothing: the keyboard is the resume’s, and no second resume starts', async () => {
    let finish: (result: ResumeResult) => void = () => undefined;
    const { controller, resumeChat } = onSessions({
      resume: () =>
        new Promise<ResumeResult>((resolve) => {
          finish = resolve;
        }),
    });
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().nativeActionBusy).toBe(true);
    // The resume is still going: `handleKey` drops every key while a native action holds the keyboard (this proves that, not a guard of
    // the Sessions route, which has none: its only caller is that very key path).
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

describe('`c` on an agent’s detail starts a chat bound to that agent', () => {
  /**
   * What `c` on `reviewer`'s page asks for: the path the agents port holds for its row (what the detail showed, and the only thing a chat
   * may be bound by) and the definition the port holds for it (what the page was drawn from).
   */
  const REVIEWER_REQUEST: HomeAgentRequest = {
    path: '.relavium/agents/reviewer.agent.yaml',
    listed: {
      id: 'reviewer',
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      system_prompt: 'You review code.',
      tools: ['read_file'],
    },
  };

  /** The tab host open on the Defined tab, the detail of `reviewer` (a ready agent) open. */
  function onDetail(options: Options = {}, slug = 'reviewer') {
    const mounted = mount(options);
    submit(mounted.controller, '/agents');
    mounted.controller.handleKey('', ENTER);
    expect(hostOf(mounted.controller)?.agents?.detail?.slug).toBe(slug);
    return mounted;
  }

  it('closes the screen and begins the build with the agent’s own path in ONE state change, then opens the chat idle with nothing under it', async () => {
    const { controller, startChat, lines } = onDetail();
    const states: HomeControllerState[] = [];
    const unsubscribe = controller.subscribe(() => states.push(controller.getSnapshot()));
    controller.handleKey('c', {});
    // Synchronously, before anything settles: exactly one transition, and it both took the screen away and began the build.
    expect(states, 'one state change for the key').toHaveLength(1);
    expect(states[0]?.screen, 'the screen is gone in that very change').toBeUndefined();
    expect(states[0]?.mode, 'and the build is what is on screen').toBe('loading');
    expect(states[0]?.pendingMessage, 'there is no typed message to echo').toBe('');
    expect(startChat).toHaveBeenCalledTimes(1);
    // The exact argument list: the path and the definition the port holds, and nothing else (no label, no second argument).
    expect(startChat.mock.calls).toEqual([[REVIEWER_REQUEST]]);
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    await vi.waitFor(() => expect(controller.getSnapshot().submitBusy).toBe(false), {
      timeout: WAIT_MS,
    });
    unsubscribe();
    const after = controller.getSnapshot();
    expect(after.session?.sessionId).toBe('sess-started');
    expect(after.screen, 'the chat is not under a tab host').toBeUndefined();
    expect(after.notice).toBeUndefined();
    expect(lines, 'no message was sent: the chat opens idle').toEqual([]);
    expect(
      states.every((state) => state.screen === undefined),
      'no state after the key shows a screen',
    ).toBe(true);
    expect(
      states.some((state) => state.mode === 'home' && state.screen === undefined),
      'the landing is never drawn between the detail and the chat',
    ).toBe(false);
  });

  it('`C` (Caps Lock) is the same key', () => {
    const { controller, startChat } = onDetail();
    controller.handleKey('C', {});
    expect(startChat.mock.calls).toEqual([[REVIEWER_REQUEST]]);
    expect(controller.getSnapshot().mode).toBe('loading');
  });

  it('binds by the catalog’s path and never by a label: an agent whose id looks like a path and whose file has another name', () => {
    const { controller, startChat } = onDetail(
      {
        agents: agentsPort([
          {
            entry: {
              slug: '../../x',
              name: 'Agent x',
              path: '.relavium/agents/a-file-of-another-name.agent.yaml',
              valid: true,
            },
            agent: {
              model: 'claude-opus-4-8',
              provider: 'anthropic',
              system_prompt: 'x',
              tools: ['read_file'],
            },
          },
        ]).port,
      },
      '../../x',
    );
    controller.handleKey('c', {});
    expect(startChat.mock.calls).toEqual([
      [
        {
          path: '.relavium/agents/a-file-of-another-name.agent.yaml',
          listed: {
            id: '../../x',
            model: 'claude-opus-4-8',
            provider: 'anthropic',
            system_prompt: 'x',
            tools: ['read_file'],
          },
        },
      ],
    ]);
  });

  it('Ctrl+C on the detail closes the screen and starts no chat', () => {
    const { controller, startChat } = onDetail();
    controller.handleKey('c', { ctrl: true });
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(controller.getSnapshot().mode).toBe('home');
    expect(controller.getSnapshot().interruptArmed, 'a browser arms nothing').toBe(false);
    expect(startChat).not.toHaveBeenCalled();
  });

  it('an invalid agent has no detail and so no `c`: the key starts nothing and the tab host stays', () => {
    const { controller, startChat } = mount();
    submit(controller, '/agents');
    controller.handleKey('', DOWN);
    controller.handleKey('', ENTER); // broken-one: says why it has no detail
    expect(hostOf(controller)?.agents?.detail).toBeUndefined();
    controller.handleKey('c', {});
    controller.handleKey('C', {});
    expect(startChat).not.toHaveBeenCalled();
    expect(controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(controller.getSnapshot().mode).toBe('home');
  });

  it('an agent that vanished between the list and the key: the landing says why in one fixed sentence, and nothing is left half-open', async () => {
    const { controller, startChat } = onDetail({
      startChat: () => Promise.reject(new HomeAgentStartError('unreadable', new Error('PRIVATE'))),
    });
    controller.handleKey('c', {});
    expect(controller.getSnapshot().mode, 'building').toBe('loading');
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('home'), {
      timeout: WAIT_MS,
    });
    const after = controller.getSnapshot();
    expect(after.notice).toBe(
      'The agent could not be started: its file is missing or cannot be read.',
    );
    expect(after.mode, 'the loading state is gone').toBe('home');
    expect(after.nativeActionBusy, 'no native action is left holding the keyboard').toBe(false);
    expect(after.session, 'no chat started').toBeUndefined();
    expect(after.screen, 'the Home stays on the landing').toBeUndefined();
    expect(after.errorText).toBeUndefined();
    expect(after.pendingMessage).toBe('');
    expect(startChat).toHaveBeenCalledTimes(1);
    // The keyboard really is the prompt's again.
    controller.handleKey('x', {});
    expect(controller.getSnapshot().input.text).toBe('x');
  });

  it.each([
    ['invalid', 'The agent could not be started: its definition is not valid.'],
    ['unreadable', 'The agent could not be started: its file is missing or cannot be read.'],
    ['no_key', 'The agent could not be started: its provider has no usable key (see /providers).'],
    ['unbuilt', 'The agent could not be started: its session could not be built.'],
    ['changed', 'The agent changed since it was listed. Open the list again.'],
  ] as const satisfies readonly (readonly [AgentStartReason, string])[])(
    'a build refused for the reason `%s` says exactly its fixed sentence',
    async (reason, sentence) => {
      expect(agentStartNotice(reason)).toBe(sentence);
      const { controller } = onDetail({
        startChat: () => Promise.reject(new HomeAgentStartError(reason)),
      });
      controller.handleKey('c', {});
      await vi.waitFor(() => expect(controller.getSnapshot().notice).toBe(sentence), {
        timeout: WAIT_MS,
      });
    },
  );

  it('any other failure of the build is the last fixed sentence, and nothing the error said is shown', async () => {
    const { controller } = onDetail({
      startChat: () => Promise.reject(new Error('PRIVATE_FAULT_TEXT /home/me/secret.agent.yaml')),
    });
    controller.handleKey('c', {});
    await vi.waitFor(
      () =>
        expect(controller.getSnapshot().notice).toBe(
          'The agent could not be started: its session could not be built.',
        ),
      { timeout: WAIT_MS },
    );
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('PRIVATE_FAULT_TEXT');
    expect(controller.getSnapshot().errorText).toBeUndefined();
    expect(controller.getSnapshot().mode).toBe('home');
  });

  it('a Home that is leaving while the agent builds reclaims the session it finished, and never opens it', async () => {
    let finish: (session: HomeChatSession) => void = () => undefined;
    const teardown = vi.fn(() => Promise.resolve());
    const { controller } = onDetail({
      startChat: () =>
        new Promise<HomeChatSession>((resolve) => {
          finish = resolve;
        }),
    });
    controller.handleKey('c', {});
    expect(controller.getSnapshot().mode).toBe('loading');
    const leaving = controller.teardownActive();
    finish({ ...chatOf('sess-late'), teardown });
    await leaving;
    await flush();
    expect(teardown, 'the build that finished after the exit is torn down').toHaveBeenCalled();
    expect(controller.getSnapshot().session, 'and never opened').toBeUndefined();
  });
});

/** A bare chat session the tests above build their own variants from. */
function chatOf(sessionId: string): HomeChatSession {
  return {
    store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
    sessionId,
    processLine: () => Promise.resolve(),
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  };
}
