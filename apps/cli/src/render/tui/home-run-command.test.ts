/**
 * `/run` is a Home command ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §7): typed on the bare
 * Home or chosen from its palette it opens the launch flow, and with a chat in front it starts nothing.
 *
 * The launch behind it is the real {@link createRunLaunch} over a scripted host and a scripted prompt flow, so "starts nothing" is
 * proved at the two places a run could begin: the host's `start` and the prompt flow's `begin`.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { HostedLaunch } from '../../home/run-host.js';
import { createRunLaunch, type LaunchCatalog } from '../../home/run-launch.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
} from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/** The one named bound of every `vi.waitFor` in this file: a wait that needs it is a defect, not a slow machine. */
const WAIT_MS = 5000;

const EMPTY: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const ENTER = { return: true } as const;
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};

/** A launch whose flow, host and catalog are all spies: whatever it would have begun or started is counted. */
function scriptedLaunch() {
  const begin = vi.fn(() => new AbortController().signal);
  const end = vi.fn(() => Promise.resolve());
  const select = vi.fn(() => Promise.resolve(Symbol('cancel')));
  // Every member the `/run` popup's frame wraps (`framedFlow` takes the whole channel flow and its chord card); none is called here.
  const flow = {
    begin,
    end,
    select,
    cancel: vi.fn(),
    pick: vi.fn(),
    chord: vi.fn(),
    note: vi.fn(),
    busy: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
    confirm: vi.fn(),
  };
  const start = vi.fn((): Promise<HostedLaunch> => Promise.reject(new Error('unexpected start')));
  const list = vi.fn(() => [
    { slug: 'one', name: undefined, tags: [], path: 'one.yaml', valid: true as const },
  ]);
  const catalog: LaunchCatalog = {
    list,
    load: () => {
      throw new Error('unexpected load');
    },
  };
  const launch = createRunLaunch({ flow, host: { start }, catalog });
  return { launch, begin, select, start, list };
}

function mount(opts: { launch?: () => Promise<string>; withChat?: boolean } = {}) {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const lines: string[] = [];
  const session: HomeChatSession = {
    store,
    sessionId: 'sess-run-command',
    processLine: (line) => {
      lines.push(line);
      return Promise.resolve();
    },
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  };
  // The Home's one notification channel: what `/run` says (ADR-0148 §6), never the Home's notice.
  const announced: string[] = [];
  const controller = createHomeController({
    ...(opts.launch === undefined ? {} : { launchRun: opts.launch }),
    startChat: () => Promise.resolve(session),
    homeStore: { read: () => EMPTY },
    announce: (text) => announced.push(text),
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
  });
  return { controller, lines, store, announced };
}

describe('/run on the bare Home', () => {
  it('opens the launch flow, clears the composer and says what it resolves with in one notification', async () => {
    const launchRun = vi.fn(() => Promise.resolve('Started w · run r-1'));
    const { controller, announced } = mount({ launch: launchRun });
    controller.handlePaste('/run');
    controller.handleKey('', ENTER);
    expect(launchRun).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().input.text).toBe('');
    expect(
      controller.getSnapshot().nativeActionBusy,
      'the composer is held while the flow is open',
    ).toBe(true);
    await flush();
    expect(announced).toEqual(['Started w · run r-1']);
    expect(controller.getSnapshot().notice, 'nothing in the Home`s notice').toBeUndefined();
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
  });

  it('is opened by the palette too', async () => {
    const launchRun = vi.fn(() => Promise.resolve('done'));
    const { controller, announced } = mount({ launch: launchRun });
    controller.handleKey('/', {}); // an empty prompt: the palette opens
    expect(controller.getSnapshot().palette).toBeDefined();
    type(controller, 'run');
    controller.handleKey('', ENTER);
    await flush();
    expect(launchRun).toHaveBeenCalledTimes(1);
    expect(announced).toEqual(['done']);
    expect(controller.getSnapshot().notice).toBeUndefined();
  });

  it('takes no argument', () => {
    const launchRun = vi.fn(() => Promise.resolve('unexpected'));
    const { controller } = mount({ launch: launchRun });
    controller.handlePaste('/run my-workflow');
    controller.handleKey('', ENTER);
    expect(launchRun).not.toHaveBeenCalled();
    expect(controller.getSnapshot().notice).toContain('accepts no arguments');
  });

  it('says it is unavailable when no launch is wired, in one notification', () => {
    const { controller, announced } = mount();
    controller.handlePaste('/run');
    controller.handleKey('', ENTER);
    expect(announced).toEqual(['Running a workflow is unavailable in this session.']);
    expect(controller.getSnapshot().notice).toBeUndefined();
  });

  it('a popup that said it all (an empty answer) adds no notification', async () => {
    const { controller, announced } = mount({ launch: () => Promise.resolve('') });
    controller.handlePaste('/run');
    controller.handleKey('', ENTER);
    await flush();
    expect(announced).toEqual([]);
    expect(controller.getSnapshot().notice).toBeUndefined();
  });

  it('a fault in the flow becomes a notice, not a crash', async () => {
    const { controller } = mount({ launch: () => Promise.reject(new Error('PRIVATE_FAULT_TEXT')) });
    controller.handlePaste('/run');
    controller.handleKey('', ENTER);
    await flush();
    expect(controller.getSnapshot().notice).toBe('Run workflow could not be completed.');
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('PRIVATE_FAULT_TEXT');
  });
});

describe('/run in a chat', () => {
  it('starts nothing: no flow is begun, no catalog is read, no host start is made', async () => {
    const s = scriptedLaunch();
    const { controller, lines } = mount({ launch: () => s.launch.open() });
    type(controller, 'hello');
    controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    await flush();

    // A pasted line, because a typed `/` at an empty prompt opens the palette (the next test); this is the line itself, submitted.
    controller.handlePaste('/run');
    controller.handleKey('', ENTER);
    await flush();

    expect(s.begin, 'no prompt flow was begun').not.toHaveBeenCalled();
    expect(s.list, 'no catalog was read').not.toHaveBeenCalled();
    expect(s.start, 'no run was started').not.toHaveBeenCalled();
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
    // `/run` is the Home's (ADR-0145 §7.4): typed in a chat it is answered with one line that names the Home, in the transcript; it was not
    // a launch, was not sent to the chat and is not an unknown command.
    const transcript = controller.getSnapshot().session?.store.getSnapshot().state.transcript ?? [];
    expect(transcript.flatMap((entry) => (entry.role === 'notice' ? [entry.text] : []))).toContain(
      '/run is available from the Home.',
    );
    expect(lines).not.toContain('/run');
    expect(controller.getSnapshot().notice).toBeUndefined();
  });

  it('is not in the chat palette either', async () => {
    const s = scriptedLaunch();
    const { controller } = mount({ launch: () => s.launch.open() });
    type(controller, 'hello');
    controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    await flush();
    controller.handleKey('/', {});
    expect(controller.getSnapshot().palette).toBeDefined();
    type(controller, 'run');
    controller.handleKey('', ENTER);
    await flush();
    expect(s.begin).not.toHaveBeenCalled();
    expect(s.start).not.toHaveBeenCalled();
  });
});
