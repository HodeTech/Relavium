/**
 * `/help`, `/agents`, `/workflows` and `/permissions` at the Home as popups
 * ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10 as amended 2026-11-27, MVP-11 unit 8,
 * OD-24), through the real Home controller: a word typed on the bare Home or chosen from its palette routes to the popup host's one adapter and starts
 * no chat; with a chat in front `/agents` is still the Home's; and what a popup asks the controller for after it has closed itself (`[c]` a chat, `[r]` a
 * run, `[x]` an export, `[h]` the Runs screen) is carried out as the tab's keys used to carry it out: a chat bound by the catalog's path, a `/run` that says
 * it came from `/workflows` and brings the popup back on the workflow when it ends without a run, an export confirmation that does the same, a Runs screen on
 * History or on a run's detail. The ports and the flows are scripted, so "starts no chat" is proved at the one place a chat would begin (`startChat`).
 */
import type { AgentDefinition } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

import {
  buildDefinedModel,
  type DefinedEntry,
  type DefinedPort,
} from '../../history/defined-model.js';
import type { HomeAgentRequest } from '../../home/agent-start.js';
import type { AgentsPort } from '../../home/agents-port.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { LaunchOptions } from '../../home/run-launch.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { HomePopupKind, HomePopupsPort } from '../../popups/home-port.js';
import type { PermissionsPort } from '../../permissions/chat-permissions.js';
import { buildAgentsModel, type AgentsModelItem } from '../../history/agents-model.js';
import { createChatStore } from './chat-store.js';
import { HOME_KEYS } from './help-sheet.js';
import { createChordHistory } from './chord-guard.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

const WAIT_MS = 5000;

const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const ENTER = { return: true } as const;
const submit = (c: HomeController, line: string): void => {
  c.handlePaste(line);
  c.handleKey('', ENTER);
};

const ENTRIES: readonly DefinedEntry[] = [
  {
    slug: 'code-review',
    name: 'Code Review',
    nodeCount: 5,
    path: 'code-review.relavium.yaml',
    valid: true,
  },
  { slug: 'nightly', name: undefined, nodeCount: 1, path: 'nightly.relavium.yaml', valid: true },
];
const definedPort: DefinedPort = {
  read: () => ({
    model: buildDefinedModel({ entries: ENTRIES, pins: [] }),
    slugOf: (index) => ENTRIES[index]?.slug,
    pathOf: (index) => ENTRIES[index]?.path,
  }),
};

const AGENT_ITEMS: readonly AgentsModelItem[] = [
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
];
const REVIEWER: AgentDefinition = {
  id: 'reviewer',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You review code.',
  tools: ['read_file'],
};
const agentsPort: AgentsPort = {
  read: () => ({
    model: buildAgentsModel(AGENT_ITEMS),
    slugOf: (index) => AGENT_ITEMS[index]?.entry.slug,
    pathOf: (index) => AGENT_ITEMS[index]?.entry.path,
    definitionOf: () => REVIEWER,
  }),
};

const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const RUNNING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-0001', cancelling: false },
  last: undefined,
};

interface Opened {
  readonly kind: HomePopupKind;
  readonly port: HomePopupsPort;
  readonly at?: { readonly slug: string } | undefined;
}

interface Options {
  readonly agents?: AgentsPort | undefined;
  readonly defined?: DefinedPort | undefined;
  readonly popups?: boolean;
  readonly launch?: (slug?: string, path?: string, options?: LaunchOptions) => Promise<string>;
  readonly exporter?: (slug: string, origin?: 'home' | 'workflows') => Promise<string | undefined>;
  readonly host?: () => RunHostSnapshot;
  readonly startChat?: (agent?: HomeAgentRequest) => Promise<HomeChatSession>;
  readonly permissions?: PermissionsPort;
  /** Whether a popup is open when the Home is asked to open a flow (the Home's opening gate refuses one then). */
  readonly popupOpen?: () => boolean;
}

/** The Home's monotonic clock, as the key history reads it. */
const clock = 4_321;

function mount(options: Options = {}) {
  const lines: string[] = [];
  const session = (id: string): HomeChatSession => ({
    store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
    sessionId: id,
    processLine: (line) => {
      lines.push(line);
      return Promise.resolve();
    },
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  });
  const startChat = vi.fn<(agent?: HomeAgentRequest) => Promise<HomeChatSession>>(
    options.startChat ?? (() => Promise.resolve(session('sess-started'))),
  );
  const opened: Opened[] = [];
  const announced: string[] = [];
  const settingsOpened: { readonly command: string; readonly closed: (() => void) | undefined }[] =
    [];
  const onExit = vi.fn();
  const chordHistory = createChordHistory();
  const deps: HomeControllerDeps = {
    chordHistory,
    now: () => clock,
    ...(options.agents === undefined ? {} : { agents: options.agents }),
    ...(options.defined === undefined ? {} : { defined: options.defined }),
    ...(options.launch === undefined ? {} : { launchRun: options.launch }),
    ...(options.exporter === undefined ? {} : { exportDefined: options.exporter }),
    ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    ...(options.popupOpen === undefined ? {} : { popupOpen: options.popupOpen }),
    ...(options.popups === false
      ? {}
      : {
          openHomePopup: (request: Opened) => {
            opened.push(request);
          },
        }),
    openSettings: ({ command, closed }) => {
      settingsOpened.push({ command, closed });
    },
    hostedRuns: {
      snapshot: options.host ?? ((): RunHostSnapshot => IDLE),
      cancel: () => true,
      close: () => Promise.resolve(),
    },
    announce: (text) => {
      announced.push(text);
    },
    startChat,
    homeStore: { read: () => EMPTY },
    schedule: () => () => {},
    onExit,
    onError: (cause) => {
      throw cause;
    },
  };
  return {
    controller: createHomeController(deps),
    chordHistory,
    startChat,
    opened,
    announced,
    settingsOpened,
    onExit,
    lines,
  };
}

const last = (opened: readonly Opened[]): Opened => {
  const request = opened.at(-1);
  if (request === undefined) throw new Error('no popup was asked for');
  return request;
};

describe('the words', () => {
  it.each([
    ['/help', 'help'],
    ['/agents', 'agents'],
    ['/workflows', 'workflows'],
  ] as const)(
    'a typed %s asks for its popup on the host, clears the composer and starts no chat',
    async (line, kind) => {
      const { controller, opened, startChat } = mount({ agents: agentsPort, defined: definedPort });
      submit(controller, line);
      await flush();
      expect(opened).toHaveLength(1);
      expect(opened[0]?.kind).toBe(kind);
      expect(controller.getSnapshot().input.text).toBe('');
      expect(controller.getSnapshot().screen, 'a popup is no screen of the slot').toBeUndefined();
      expect(controller.getSnapshot().notice).toBeUndefined();
      expect(startChat).not.toHaveBeenCalled();
    },
  );

  it('is chosen from the palette too', async () => {
    const { controller, opened } = mount({ agents: agentsPort, defined: definedPort });
    controller.handleKey('/', {});
    for (const ch of 'workflows') controller.handleKey(ch, {});
    controller.handleKey('', ENTER);
    await flush();
    expect(opened.map((request) => request.kind)).toEqual(['workflows']);
    expect(controller.getSnapshot().palette).toBeUndefined();
  });

  it('builds the port from what the Home holds: the keys of the Home, the catalogue, the agents', () => {
    const { controller, opened } = mount({ agents: agentsPort, defined: definedPort });
    submit(controller, '/help');
    const port = last(opened).port;
    expect(port.help?.keys.map((key) => key.keys)).toEqual(
      Object.values(HOME_KEYS).map((key) => key.keys),
    );
    expect(port.help?.keys.every((key) => key.verb !== '')).toBe(true);
    expect(port.agents?.read).toBe(agentsPort.read);
    expect(port.workflows?.read).toBe(definedPort.read);
    expect(port.workflows?.now()).toBeGreaterThan(1_700_000_000_000);
  });

  it.each([['/help me'], ['/agents all'], ['/workflows now']])(
    '%s takes no argument: the line says so and opens nothing',
    async (line) => {
      const { controller, opened, startChat } = mount({ agents: agentsPort, defined: definedPort });
      submit(controller, line);
      await flush();
      expect(opened).toEqual([]);
      expect(controller.getSnapshot().notice).toMatch(/accepts no arguments/u);
      expect(startChat).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      '/agents',
      { agents: undefined, defined: definedPort },
      'The project’s agents are not available here.',
    ],
    [
      '/workflows',
      { agents: agentsPort, defined: undefined },
      'The project’s workflows are not available here.',
    ],
    [
      '/help',
      { agents: agentsPort, defined: definedPort, popups: false },
      '/help is not available here.',
    ],
    [
      '/agents',
      { agents: agentsPort, defined: definedPort, popups: false },
      'The project’s agents are not available here.',
    ],
  ] as const)(
    '%s says it is not available when its port or its popup host is not wired, and opens nothing',
    async (line, options, notice) => {
      const { controller, opened, startChat } = mount(options);
      submit(controller, line);
      await flush();
      expect(opened).toEqual([]);
      expect(controller.getSnapshot().notice).toBe(notice);
      expect(startChat).not.toHaveBeenCalled();
    },
  );

  it('/agents is the Home’s: typed in a chat it names the Home and opens nothing', async () => {
    const mounted = mount({ agents: agentsPort, defined: definedPort });
    mounted.controller.handlePaste('hello');
    mounted.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(mounted.controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    await flush();
    submit(mounted.controller, '/agents');
    await flush();
    expect(mounted.opened).toEqual([]);
    expect(mounted.lines).not.toContain('/agents');
  });
});

describe('`[c] chat` hands the controller the agent the detail showed', () => {
  const REQUEST: HomeAgentRequest = {
    path: '.relavium/agents/reviewer.agent.yaml',
    listed: REVIEWER,
  };

  it('begins the build with exactly the path and the definition, in ONE state change that takes nothing else with it, and opens the chat idle', async () => {
    const { controller, opened, startChat, lines } = mount({
      agents: agentsPort,
      defined: definedPort,
    });
    submit(controller, '/agents');
    const states: unknown[] = [];
    controller.subscribe(() => states.push(controller.getSnapshot()));
    last(opened).port.agents?.chat(REQUEST);
    expect(states).toHaveLength(1);
    expect(controller.getSnapshot().mode).toBe('loading');
    expect(startChat.mock.calls).toEqual([[REQUEST]]);
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    await vi.waitFor(() => expect(controller.getSnapshot().submitBusy).toBe(false), {
      timeout: WAIT_MS,
    });
    expect(controller.getSnapshot().session?.sessionId).toBe('sess-started');
    expect(lines, 'no message was sent: the chat opens idle').toEqual([]);
  });

  it('a build refused for a reason says its one fixed sentence on the landing, never the cause', async () => {
    const { HomeAgentStartError } = await import('../../home/agent-start.js');
    const { controller, opened } = mount({
      agents: agentsPort,
      defined: definedPort,
      startChat: () =>
        Promise.reject(new HomeAgentStartError('unreadable', new Error('PRIVATE_FAULT'))),
    });
    submit(controller, '/agents');
    last(opened).port.agents?.chat(REQUEST);
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('home'), {
      timeout: WAIT_MS,
    });
    expect(controller.getSnapshot().notice).toBe(
      'The agent could not be started: its file is missing or cannot be read.',
    );
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('PRIVATE_FAULT');
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
  });
});

describe('`[r]` hands the controller a run, from /workflows', () => {
  const NODE = 'code-review';
  const PATH = 'code-review.relavium.yaml';

  it('starts the launch at that workflow, saying it came from /workflows, and drops the repeats of the `r` that opened it', async () => {
    const launch = vi.fn<
      (slug?: string, path?: string, options?: LaunchOptions) => Promise<string>
    >(() => Promise.resolve(''));
    const { controller, opened, chordHistory } = mount({
      agents: agentsPort,
      defined: definedPort,
      launch,
    });
    submit(controller, '/workflows');
    expect(chordHistory.openedBy, 'no key opened a flow yet').toBeUndefined();
    last(opened).port.workflows?.run(NODE, PATH, 'detail');
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]?.slice(0, 2)).toEqual([NODE, PATH]);
    expect(launch.mock.calls[0]?.[2]).toEqual({
      opener: { origin: 'workflows' },
      onLeave: expect.any(Function) as unknown,
      onStarted: expect.any(Function) as unknown,
    });
    // The `r` that asked is left on the Home's one key history for the flow to take when it begins: this launch never begins one, and the
    // record is forgotten as soon as it settles (a stale record would make the next flow's fast `rr` look like a held key).
    expect(chordHistory.openedBy, 'the `r` is the flow’s to take').toEqual({
      input: 'r',
      at: clock,
    });
    await flush();
    expect(
      chordHistory.openedBy,
      'a launch that began no flow leaves no record behind',
    ).toBeUndefined();
  });

  it('brings the popup back on that workflow when the flow ended without a run (Esc at its first step says nothing)', async () => {
    const launch = vi.fn(() => Promise.resolve(''));
    const { controller, opened } = mount({ agents: agentsPort, defined: definedPort, launch });
    submit(controller, '/workflows');
    last(opened).port.workflows?.run(NODE, PATH, 'detail');
    await vi.waitFor(() => expect(opened).toHaveLength(2), { timeout: WAIT_MS });
    expect(opened[1]?.kind).toBe('workflows');
    expect(opened[1]?.at, 'pressed on the detail: back on the detail').toEqual({
      slug: NODE,
      step: 'detail',
    });
    expect(
      controller.getSnapshot().nativeActionBusy,
      'the keyboard is the Home’s when the popup comes back',
    ).toBe(false);
  });

  it('a refusal (a leg already runs) is said in one notification and the popup comes back; a start that failed after its popup opened is said in the popup and it comes back too', async () => {
    const launch = vi.fn(() => Promise.resolve('A run is already executing (run-0001).'));
    const { controller, opened, announced } = mount({
      agents: agentsPort,
      defined: definedPort,
      launch,
    });
    submit(controller, '/workflows');
    last(opened).port.workflows?.run(NODE, PATH, 'detail');
    await vi.waitFor(() => expect(opened).toHaveLength(2), { timeout: WAIT_MS });
    expect(announced).toEqual(['A run is already executing (run-0001).']);
  });

  it('`Ctrl+C` closes the whole stack: the flow told the Home it was left, so its notification is the whole answer and no popup comes back', async () => {
    const launch = vi.fn(
      (_slug?: string, _path?: string, options?: LaunchOptions): Promise<string> => {
        options?.onLeave?.();
        return Promise.resolve('Run cancelled.');
      },
    );
    const { controller, opened, announced } = mount({
      agents: agentsPort,
      defined: definedPort,
      launch,
    });
    submit(controller, '/workflows');
    last(opened).port.workflows?.run(NODE, PATH, 'detail');
    await flush();
    await flush();
    expect(opened).toHaveLength(1);
    expect(announced).toEqual(['Run cancelled.']);
  });

  it.each([
    { from: 'list', what: 'the catalogue row it was pressed on' },
    { from: 'detail', what: 'the detail it was pressed on' },
  ] as const)(
    'a No (`Ctrl+N`, `Run cancelled.` and no leave) brings the popup back on $from: $what',
    async ({ from }) => {
      const launch = vi.fn(() => Promise.resolve('Run cancelled.'));
      const { controller, opened, announced } = mount({
        agents: agentsPort,
        defined: definedPort,
        launch,
      });
      submit(controller, '/workflows');
      last(opened).port.workflows?.run(NODE, PATH, from);
      await vi.waitFor(() => expect(opened).toHaveLength(2), { timeout: WAIT_MS });
      expect(opened[1]?.at).toEqual({ slug: NODE, step: from });
      expect(announced).toEqual(['Run cancelled.']);
    },
  );

  it.each(['list', 'detail'] as const)(
    'a run that started and was already parked or finished when the host was looked at (from the %s) closes everything and says what a plain `/run` says, the popup not back',
    async (from) => {
      // The host is idle again by the time it is read (the leg parked at a gate, or finished): only the launch's own fact (`onStarted`) says a run started.
      const launch = vi.fn(
        (_slug?: string, _path?: string, options?: LaunchOptions): Promise<string> => {
          options?.onStarted?.();
          return Promise.resolve('Started code-review · run run-0001');
        },
      );
      const { controller, opened, announced } = mount({
        agents: agentsPort,
        defined: definedPort,
        launch,
      });
      submit(controller, '/workflows');
      last(opened).port.workflows?.run(NODE, PATH, from);
      await flush();
      await flush();
      expect(opened, 'no popup comes back').toHaveLength(1);
      expect(controller.getSnapshot().screen, 'no leg executes, so no run view').toBeUndefined();
      expect(announced).toEqual(['Started code-review · run run-0001']);
    },
  );

  it.each(['list', 'detail'] as const)(
    'a refusal whose sentence begins with `Started ` is no run (from the %s): the popup comes back, and the sentence is the one notification (review round 2, S2-4)',
    async (from) => {
      const sentence = 'Started over by another window: nothing was run.';
      const launch = vi.fn(() => Promise.resolve(sentence));
      const { controller, opened, announced } = mount({
        agents: agentsPort,
        defined: definedPort,
        launch,
      });
      submit(controller, '/workflows');
      last(opened).port.workflows?.run(NODE, PATH, from);
      await vi.waitFor(() => expect(opened).toHaveLength(2), { timeout: WAIT_MS });
      expect(opened[1]?.at).toEqual({ slug: NODE, step: from });
      expect(announced).toEqual([sentence]);
    },
  );

  it('a run that started opens the run view and the popup does not come back', async () => {
    let snapshot: RunHostSnapshot = IDLE;
    const launch = vi.fn(() => {
      snapshot = RUNNING;
      return Promise.resolve('Started code-review · run run-0001');
    });
    const { controller, opened, announced } = mount({
      agents: agentsPort,
      defined: definedPort,
      launch,
      host: () => snapshot,
    });
    submit(controller, '/workflows');
    last(opened).port.workflows?.run(NODE, PATH, 'detail');
    await vi.waitFor(() => expect(controller.getSnapshot().screen?.kind).toBe('run-view'), {
      timeout: WAIT_MS,
    });
    expect(opened).toHaveLength(1);
    expect(announced).toEqual(['Started code-review · run run-0001']);
  });

  it('a Home with no launch flow says so and the popup comes back; nothing is started', () => {
    const { controller, opened, announced } = mount({ agents: agentsPort, defined: definedPort });
    submit(controller, '/workflows');
    last(opened).port.workflows?.run(NODE, PATH, 'detail');
    expect(announced).toEqual(['Running a workflow is unavailable in this session.']);
    expect(opened).toHaveLength(2);
  });
});

describe('what a refused or a closing Home leaves behind (review round 1, G04 and G05)', () => {
  const NODE = 'code-review';
  const PATH = 'code-review.relavium.yaml';

  it('a `[r]` the Home refuses because a flow is already open forgets the key that asked, so the next flow does not take it for a key held down (G04)', () => {
    // The first launch never settles: its flow is open, the keyboard is the flow's, and the second `[r]` is refused by the Home itself.
    const launch = vi.fn(() => new Promise<string>(() => {}));
    const { controller, opened, chordHistory } = mount({
      agents: agentsPort,
      defined: definedPort,
      launch,
    });
    submit(controller, '/workflows');
    last(opened).port.workflows?.run(NODE, PATH, 'list');
    expect(controller.getSnapshot().nativeActionBusy).toBe(true);
    expect(chordHistory.openedBy, 'the first `r` is the first flow’s to take').toBeDefined();
    last(opened).port.workflows?.run(NODE, PATH, 'detail');
    expect(launch, 'the second asks for no second flow').toHaveBeenCalledOnce();
    expect(chordHistory.openedBy, 'a refused open leaves no key behind').toBeUndefined();
  });

  it('a `[r]` the Home’s opening gate refuses (a popup is open) forgets the key too: the flow never began, so nothing is left for the next one (G04)', async () => {
    const launch = vi.fn(() => Promise.resolve(''));
    const { controller, opened, announced, chordHistory } = mount({
      agents: agentsPort,
      defined: definedPort,
      launch,
      popupOpen: () => true,
    });
    submit(controller, '/workflows');
    last(opened).port.workflows?.run(NODE, PATH, 'list');
    await flush();
    expect(controller.getSnapshot().nativeActionBusy, 'no flow began').toBe(false);
    expect(announced.join('\n')).toMatch(/Run workflow/u);
    expect(chordHistory.openedBy, 'a refused open leaves no key behind').toBeUndefined();
  });

  it.each([
    ['a run', (port: HomePopupsPort) => port.workflows?.run(NODE, PATH, 'list')],
    ['an export', (port: HomePopupsPort) => port.workflows?.export(NODE, 'detail')],
  ] as const)(
    'a Home that is closing does not bring /workflows back for %s it cannot start (G05)',
    async (_what, ask) => {
      // Neither `launchRun` nor `exportDefined` is wired: both paths answer at once and would reopen the popup on the spot.
      const { controller, opened } = mount({ agents: agentsPort, defined: definedPort });
      submit(controller, '/workflows');
      await flush();
      expect(opened).toHaveLength(1);
      await controller.teardownActive();
      ask(last(opened).port);
      await flush();
      expect(opened, 'nothing is opened into a Home that is going away').toHaveLength(1);
    },
  );

  it('the same request on a Home that is not closing brings the popup back, on the step it was pressed on (the control of the two above)', async () => {
    const { controller, opened } = mount({ agents: agentsPort, defined: definedPort });
    submit(controller, '/workflows');
    last(opened).port.workflows?.run(NODE, PATH, 'detail');
    await flush();
    expect(opened).toHaveLength(2);
    expect(opened[1]?.at).toEqual({ slug: NODE, step: 'detail' });
  });
});

describe('`[x]` hands the controller an export, from /workflows', () => {
  it('runs the export confirmation saying it came from /workflows, says what it came to, and brings the popup back on the workflow', async () => {
    const exporter = vi.fn(() => Promise.resolve<string | undefined>('Nothing exported.'));
    const { controller, opened, announced } = mount({
      agents: agentsPort,
      defined: definedPort,
      exporter,
    });
    submit(controller, '/workflows');
    last(opened).port.workflows?.export('nightly', 'detail');
    expect(exporter.mock.calls).toEqual([['nightly', 'workflows']]);
    await vi.waitFor(() => expect(opened).toHaveLength(2), { timeout: WAIT_MS });
    expect(opened[1]?.at).toEqual({ slug: 'nightly', step: 'detail' });
    expect(announced).toEqual(['Nothing exported.']);
  });

  it('an export started from the catalogue row comes back to the catalogue, not to a detail nobody opened', async () => {
    const exporter = vi.fn(() => Promise.resolve<string | undefined>('Nothing exported.'));
    const { controller, opened } = mount({ agents: agentsPort, defined: definedPort, exporter });
    submit(controller, '/workflows');
    last(opened).port.workflows?.export('nightly', 'list');
    await vi.waitFor(() => expect(opened).toHaveLength(2), { timeout: WAIT_MS });
    expect(opened[1]?.at).toEqual({ slug: 'nightly', step: 'list' });
  });

  it('a Home with no export says so and the popup comes back', () => {
    const { controller, opened, announced } = mount({ agents: agentsPort, defined: definedPort });
    submit(controller, '/workflows');
    last(opened).port.workflows?.export('nightly', 'detail');
    expect(announced).toEqual(['Export is unavailable in this session.']);
    expect(opened).toHaveLength(2);
  });

  it.each(['list', 'detail'] as const)(
    'a Home with no export brings the popup back on the step the key was pressed on (%s), as one that can export does',
    (from) => {
      const { controller, opened } = mount({ agents: agentsPort, defined: definedPort });
      submit(controller, '/workflows');
      last(opened).port.workflows?.export('nightly', from);
      expect(opened[1]?.at).toEqual({ slug: 'nightly', step: from });
    },
  );
});

describe('`[h]` and `Enter` on a last run open the Runs screen', () => {
  it('`[h]` opens it on History, and `Esc` leaves it for the landing', () => {
    const { controller, opened } = mount({ agents: agentsPort, defined: definedPort });
    submit(controller, '/workflows');
    last(opened).port.workflows?.openRuns();
    const screen = controller.getSnapshot().screen;
    expect(screen?.kind).toBe('tab-host');
    expect(screen?.kind === 'tab-host' ? screen.host.tab : undefined).toBe('history');
    controller.handleKey('', { escape: true });
    expect(controller.getSnapshot().screen).toBeUndefined();
  });

  it('a Home that cannot read the history says so in one notification and opens no screen', () => {
    const { controller, opened } = mount({ agents: agentsPort, defined: definedPort });
    submit(controller, '/workflows');
    last(opened).port.workflows?.openRuns('run-9');
    // No history port is wired here: the detail cannot be opened.
    expect(controller.getSnapshot().screen).toBeUndefined();
  });
});

describe('/permissions on the Home', () => {
  const PORT: PermissionsPort = {
    surface: 'project',
    load: () => ({ project: { ok: true, rows: [] }, session: undefined }),
    withdraw: () => ({ tone: 'done', text: 'Withdrawn.' }),
  };

  it('a typed /permissions asks for the settings popup over the project’s port, with no mode, and opens no screen', async () => {
    const { controller, settingsOpened } = mount({ permissions: PORT });
    submit(controller, '/permissions');
    await flush();
    expect(settingsOpened.map((request) => request.command)).toEqual(['permissions']);
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(controller.getSnapshot().notice).toBeUndefined();
  });

  it('says the remembered commands are not available when the Home has no port', async () => {
    const { controller, settingsOpened } = mount({});
    submit(controller, '/permissions');
    await flush();
    expect(settingsOpened).toEqual([]);
    expect(controller.getSnapshot().notice).toBe('Remembered commands are not available here.');
  });

  it('a bare `relavium permissions` opens the popup as the whole job of the run: it ends with the popup, however it closes', () => {
    const { controller, settingsOpened, onExit } = mount({ permissions: PORT });
    controller.openPermissionsAsCommand();
    expect(settingsOpened).toHaveLength(1);
    expect(onExit).not.toHaveBeenCalled();
    settingsOpened[0]?.closed?.();
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('an ordinary /permissions ends nothing when it closes', async () => {
    const { controller, settingsOpened, onExit } = mount({ permissions: PORT });
    submit(controller, '/permissions');
    await flush();
    expect(settingsOpened[0]?.closed).toBeUndefined();
    expect(onExit).not.toHaveBeenCalled();
  });
});
