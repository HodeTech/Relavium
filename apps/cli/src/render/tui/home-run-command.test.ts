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
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};

/** A launch whose flow, host and catalog are all spies: whatever it would have begun or started is counted. */
function scriptedLaunch() {
  const begin = vi.fn(() => new AbortController().signal);
  const end = vi.fn(() => Promise.resolve());
  const select = vi.fn(() => Promise.resolve(Symbol('cancel')));
  const flow = {
    begin,
    end,
    select,
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
  const controller = createHomeController({
    ...(opts.launch === undefined ? {} : { launchRun: opts.launch }),
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => Promise.resolve(session),
    homeStore: { read: () => EMPTY },
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
  });
  return { controller, lines, store };
}

describe('/run on the bare Home', () => {
  it('opens the launch flow, clears the composer and shows the notice it resolves with', async () => {
    const launchRun = vi.fn(() =>
      Promise.resolve('Started w as run r-1. It runs in the background.'),
    );
    const { controller } = mount({ launch: launchRun });
    controller.handlePaste('/run');
    controller.handleKey('', ENTER);
    expect(launchRun).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().input.text).toBe('');
    expect(
      controller.getSnapshot().nativeActionBusy,
      'the composer is held while the flow is open',
    ).toBe(true);
    await flush();
    expect(controller.getSnapshot().notice).toBe(
      'Started w as run r-1. It runs in the background.',
    );
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
  });

  it('is opened by the palette too', async () => {
    const launchRun = vi.fn(() => Promise.resolve('done'));
    const { controller } = mount({ launch: launchRun });
    controller.handleKey('/', {}); // an empty prompt: the palette opens
    expect(controller.getSnapshot().palette).toBeDefined();
    type(controller, 'run');
    controller.handleKey('', ENTER);
    await flush();
    expect(launchRun).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().notice).toBe('done');
  });

  it('takes no argument', () => {
    const launchRun = vi.fn(() => Promise.resolve('unexpected'));
    const { controller } = mount({ launch: launchRun });
    controller.handlePaste('/run my-workflow');
    controller.handleKey('', ENTER);
    expect(launchRun).not.toHaveBeenCalled();
    expect(controller.getSnapshot().notice).toContain('accepts no arguments');
  });

  it('says it is unavailable when no launch is wired', () => {
    const { controller } = mount();
    controller.handlePaste('/run');
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().notice).toBe(
      'Running a workflow is unavailable in this session.',
    );
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
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'));
    await flush();

    // A pasted line, because a typed `/` at an empty prompt opens the palette (the next test); this is the line itself, submitted.
    controller.handlePaste('/run');
    controller.handleKey('', ENTER);
    await flush();

    expect(s.begin, 'no prompt flow was begun').not.toHaveBeenCalled();
    expect(s.list, 'no catalog was read').not.toHaveBeenCalled();
    expect(s.start, 'no run was started').not.toHaveBeenCalled();
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
    // The line was the chat's to handle, not the Home's: it reached the chat as the unknown slash it is, or the Home's typo hint
    // for an unknown slash answered it; either way it was not a launch.
    expect(
      lines.includes('/run') ||
        (controller.getSnapshot().notice ?? '').startsWith('Unknown command'),
    ).toBe(true);
  });

  it('is not in the chat palette either', async () => {
    const s = scriptedLaunch();
    const { controller } = mount({ launch: () => s.launch.open() });
    type(controller, 'hello');
    controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'));
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
