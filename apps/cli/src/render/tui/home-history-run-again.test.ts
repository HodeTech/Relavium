/**
 * `r` on a History run's detail through the REAL Home controller ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §6, MVP-11 unit 7, W4c). The controller is real; the history, the catalog and the launch flow are scripted, so "the form is the only way to
 * a start" is proved at the one place a run would begin (`launchRun`, which takes a slug and a path and nothing else: no input of the run
 * travels) and the other doors of the Home (a chat, a resume, a gate's answer, a media continue, a cancel) are spies that must stay shut.
 *
 * What it proves: `r` on the ready detail of a run of this directory opens the launch flow at the catalog's entry once, and holds the
 * keyboard (a held `r` reaches nothing and opens no second form); what the flow says is shown on the DETAIL's own message row and never in the
 * Home's notice or its channel; a run that started is shown and `Esc` returns to the History tab; a refusal opens nothing; and `r` typed
 * anywhere else (the landing, the work page, the History list, a chat) does what it did. The form's own lockout against a held `Ctrl+Y` is
 * `home-history-run-again-flow.test.ts`'s, over the real prompt channel.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HistoryQuery, HistoryRead } from '../../history/history-source.js';
import type { RunDetailLoad } from '../../history/run-detail-source.js';
import type { HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import {
  NEWER_RUN,
  definedPortOver,
  historyListOfRun,
  runDetailRead,
} from './run-again.test-support.js';
import { RUN_AGAIN_NOT_DEFINED, RUN_AGAIN_OTHER_DIRECTORY } from './run-again.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import type { TabHostState } from './tab-host.js';
import type { HistoryPort } from './tab-host-history.js';
import type { DefinedPort } from '../../history/defined-model.js';

const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const WITH_SESSION: HomeSnapshot = {
  ...EMPTY,
  recentSessions: [
    {
      sessionId: 'session-1',
      title: 'Conversation 1',
      agentSlug: 'chat',
      modelId: undefined,
      status: 'ended',
      updatedAt: '2026-11-23T00:00:00.000Z',
      totalCostMicrocents: 0,
    } satisfies HomeSessionRow,
  ],
  totals: { attention: 0, sessions: 1, runs: 0 },
  isEmpty: false,
};

const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const RUNNING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-0001', cancelling: false },
  last: undefined,
};
const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const DOWN = { downArrow: true } as const;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Options {
  readonly detail?: RunDetailLoad;
  readonly defined?: DefinedPort | undefined;
  readonly launch?: ((slug?: string, path?: string) => Promise<string>) | undefined;
  readonly host?: () => RunHostSnapshot;
  readonly snapshot?: HomeSnapshot;
  /** What the History port answers a read with (default: the list holding the one run). */
  readonly list?: (query: HistoryQuery) => HistoryRead;
}

function mount(options: Options = {}) {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const session: HomeChatSession = {
    store,
    sessionId: 'sess-run-again',
    processLine: () => Promise.resolve(),
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  };
  const startChat = vi.fn(() => Promise.resolve(session));
  const resumeChat = vi.fn(() => new Promise<undefined>(() => {}));
  const continueMedia = vi.fn(() => Promise.resolve(undefined));
  const gateCards = {
    list: vi.fn(() => []),
    read: vi.fn(() => undefined),
    resume: vi.fn(() => new Promise<never>(() => {})),
  };
  const cancel = vi.fn(() => true);
  const defined = 'defined' in options ? options.defined : definedPortOver().port;
  const loadDetail = vi.fn(() =>
    Promise.resolve<RunDetailLoad>(options.detail ?? { kind: 'ready', detail: runDetailRead() }),
  );
  const read = vi.fn(
    (query: HistoryQuery): HistoryRead => options.list?.(query) ?? historyListOfRun(),
  );
  const history: HistoryPort = {
    read,
    cost: () => ({ kind: 'text', text: '$0.01' }),
    loadDetail,
  };
  const announced: string[] = [];
  const deps: HomeControllerDeps = {
    history,
    ...(defined === undefined ? {} : { defined }),
    ...(options.launch === undefined ? {} : { launchRun: options.launch }),
    hostedRuns: {
      snapshot: options.host ?? ((): RunHostSnapshot => IDLE),
      cancel,
      close: () => Promise.resolve(),
    },
    startChat,
    resumeChat,
    continueMedia,
    gateCards,
    homeStore: { read: () => options.snapshot ?? EMPTY },
    schedule: () => () => {},
    announce: (text) => {
      announced.push(text);
    },
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
    continueMedia,
    gateCards,
    cancel,
    loadDetail,
    read,
    announced,
    session,
  };
}

const hostOf = (c: HomeController): TabHostState | undefined => {
  const screen = c.getSnapshot().screen;
  return screen?.kind === 'tab-host' ? screen.host : undefined;
};
const detailOf = (c: HomeController) => hostOf(c)?.history?.detail;

/** The History tab opened, the run's detail asked for and landed. */
async function onDetail(c: HomeController): Promise<void> {
  expect(c.openScreen('tab-host', { tab: 'history' })).toBe(true);
  c.handleKey('', ENTER);
  await flush();
  expect(detailOf(c)?.phase).toBe('ready');
}

describe('r on the detail of a run of this directory opens the launch flow at the catalog’s entry, once, and holds the keyboard', () => {
  it('asks the flow for the slug and the path of the workflow, and for nothing else: no input of the run travels', async () => {
    let finish: (said: string) => void = () => undefined;
    const launch = vi.fn(
      (slug?: string, path?: string) =>
        new Promise<string>((resolve) => {
          void slug;
          void path;
          finish = resolve;
        }),
    );
    const m = mount({ launch });
    await onDetail(m.controller);
    const cursor = detailOf(m.controller)?.cursor;
    m.controller.handleKey('r', {});
    expect(launch).toHaveBeenCalledTimes(1);
    expect(
      launch.mock.calls[0],
      'exactly the slug and the catalog path, no third argument',
    ).toEqual(['nightly', 'nightly.yaml']);
    expect(m.controller.getSnapshot().nativeActionBusy).toBe(true);
    // The flow owns the keyboard: a key at the screen behind it moves nothing.
    m.controller.handleKey('', DOWN);
    expect(detailOf(m.controller)?.cursor, 'the detail did not move under the form').toBe(cursor);
    finish('Run cancelled.');
    await flush();
    expect(m.controller.getSnapshot().nativeActionBusy).toBe(false);
  });

  it('opens the form once for a key held down: the repeats that arrive while it is open reach nothing and open no second one', async () => {
    let finish: (said: string) => void = () => undefined;
    const launch = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const m = mount({ launch });
    await onDetail(m.controller);
    m.controller.handleKey('r', {});
    for (let repeat = 0; repeat < 40; repeat += 1) m.controller.handleKey('r', {});
    expect(launch, 'one form for a held key').toHaveBeenCalledTimes(1);
    finish('Run cancelled.');
    await flush();
    expect(
      launch,
      'the repeats did not wait for the form to close and open it again',
    ).toHaveBeenCalledTimes(1);
  });

  it('starts no run by itself: no other door of the Home is opened by `r` (no chat, no resume, no gate answer, no media continue, no cancel)', async () => {
    const launch = vi.fn(() => Promise.resolve('Run cancelled.'));
    const m = mount({ launch });
    await onDetail(m.controller);
    m.controller.handleKey('r', {});
    await flush();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(m.startChat).not.toHaveBeenCalled();
    expect(m.resumeChat).not.toHaveBeenCalled();
    expect(m.continueMedia).not.toHaveBeenCalled();
    expect(m.gateCards.resume).not.toHaveBeenCalled();
    expect(m.cancel).not.toHaveBeenCalled();
  });

  it('reads nothing of the run again: the detail is not loaded a second time by the key', async () => {
    const launch = vi.fn(() => Promise.resolve('Run cancelled.'));
    const m = mount({ launch });
    await onDetail(m.controller);
    const loads = m.loadDetail.mock.calls.length;
    m.controller.handleKey('r', {});
    await flush();
    expect(m.loadDetail.mock.calls.length, 'the key made no read of the run').toBe(loads);
  });
});

describe('what the flow said is on the detail’s own message row, never in the Home’s notice or its channel (ADR-0148 §6)', () => {
  it('shows a cancel on the detail, and leaves the tab, the detail and the cursor where they were', async () => {
    const launch = vi.fn(() => Promise.resolve('Run cancelled.'));
    const m = mount({ launch });
    await onDetail(m.controller);
    const cursor = detailOf(m.controller)?.cursor;
    m.controller.handleKey('r', {});
    await flush();
    expect(detailOf(m.controller)?.message).toBe('Run cancelled.');
    expect(hostOf(m.controller)?.tab).toBe('history');
    expect(detailOf(m.controller)?.cursor).toBe(cursor);
    expect(hostOf(m.controller)?.history?.message, 'not the list’s row').toBeUndefined();
    expect(m.controller.getSnapshot().notice, 'not the Home’s notice').toBeUndefined();
    expect(m.announced, 'not the Home’s channel').toEqual([]);
  });

  it('shows the host’s refusal of a second run on the detail and does not open the view of the run that executes', async () => {
    const launch = vi.fn(() => Promise.resolve('A run is already executing: run-0001.'));
    const m = mount({ launch, host: () => RUNNING });
    await onDetail(m.controller);
    m.controller.handleKey('r', {});
    await flush();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(m.controller.getSnapshot().screen?.kind, 'the tab host is still in front').toBe(
      'tab-host',
    );
    expect(detailOf(m.controller)?.message).toBe('A run is already executing: run-0001.');
    expect(m.controller.getSnapshot().notice).toBeUndefined();
  });

  it('adds nothing when the popup has already said it (the flow answers the empty word)', async () => {
    const launch = vi.fn(() => Promise.resolve(''));
    const m = mount({ launch });
    await onDetail(m.controller);
    m.controller.handleKey('r', {});
    await flush();
    expect(detailOf(m.controller)?.message).toBeUndefined();
    expect(m.controller.getSnapshot().notice).toBeUndefined();
    expect(m.announced).toEqual([]);
  });

  it('says on the detail that running is unavailable when the Home has no launch flow, and opens nothing', async () => {
    const m = mount({});
    await onDetail(m.controller);
    m.controller.handleKey('r', {});
    expect(detailOf(m.controller)?.message).toBe(
      'Running a workflow is unavailable in this session.',
    );
    expect(m.controller.getSnapshot().nativeActionBusy).toBe(false);
    expect(m.controller.getSnapshot().notice).toBeUndefined();
  });

  it('shows a run that started at once, and Esc returns to the History tab, not to the Home', async () => {
    let snapshot: RunHostSnapshot = IDLE;
    const launch = vi.fn(() => {
      snapshot = RUNNING; // the host latched a leg, as a started run does
      return Promise.resolve('Started nightly as run run-0001. It runs in the background.');
    });
    const m = mount({ launch, host: () => snapshot });
    await onDetail(m.controller);
    m.controller.handleKey('r', {});
    await flush();
    const screen = m.controller.getSnapshot().screen;
    expect(screen?.kind).toBe('run-view');
    expect(screen?.kind === 'run-view' ? screen.from : undefined).toBe('tab-host');
    m.controller.handleKey('', ESC);
    expect(hostOf(m.controller)?.tab, 'back on the tab the key was pressed on').toBe('history');
    expect(m.announced).toEqual(['Started nightly as run run-0001. It runs in the background.']);
  });
});

describe('the result of a run started from the detail is seen without a second key (round 2, observation F5)', () => {
  const STARTED_SAID = 'Started nightly as run run-0002. It runs in the background.';

  it('a run that ended before its view could open leaves the detail with its sentence, and Esc lands on a list that has the run', async () => {
    let started = false;
    const launch = vi.fn(() => {
      started = true; // the run began and ended inside the form's own answer: the host has no leg to show
      return Promise.resolve(STARTED_SAID);
    });
    const m = mount({
      launch,
      host: () => IDLE,
      list: () => historyListOfRun(started ? [NEWER_RUN] : []),
    });
    await onDetail(m.controller);
    m.controller.handleKey('r', {});
    await flush();
    expect(m.controller.getSnapshot().screen?.kind, 'no view: the run is over').toBe('tab-host');
    expect(detailOf(m.controller)?.message, 'the detail says what started').toBe(STARTED_SAID);
    const reads = m.read.mock.calls.length;
    m.controller.handleKey('', ESC);
    expect(detailOf(m.controller), 'back on the list').toBeUndefined();
    expect(m.read.mock.calls.length, 'one read on the way back').toBe(reads + 1);
    expect(
      m.read.mock.calls.at(-1)?.[0],
      'fresh: the source keeps the pages it fetched',
    ).toMatchObject({ page: 0, fresh: true });
    const rows = hostOf(m.controller)?.history?.read?.rows ?? [];
    expect(
      rows.map((entry) => (entry.kind === 'run' ? entry.row.id : undefined)),
      'the new run is in the list, ahead of the run the person came from',
    ).toEqual([NEWER_RUN, '0a1b2c3d-0000-4000-8000-000000000001']);
  });

  it('a run that is still executing shows its view, and Esc from it lands on the tab with the list read again', async () => {
    let snapshot: RunHostSnapshot = IDLE;
    const launch = vi.fn(() => {
      snapshot = RUNNING;
      return Promise.resolve(STARTED_SAID);
    });
    const m = mount({
      launch,
      host: () => snapshot,
      list: () => historyListOfRun(snapshot === RUNNING ? [NEWER_RUN] : []),
    });
    await onDetail(m.controller);
    m.controller.handleKey('r', {});
    await flush();
    expect(m.controller.getSnapshot().screen?.kind).toBe('run-view');
    const reads = m.read.mock.calls.length;
    m.controller.handleKey('', ESC);
    expect(hostOf(m.controller)?.tab).toBe('history');
    expect(m.read.mock.calls.length, 'the tab was entered again, and read').toBeGreaterThan(reads);
    const ids = (hostOf(m.controller)?.history?.read?.rows ?? []).map((entry) =>
      entry.kind === 'run' ? entry.row.id : undefined,
    );
    expect(ids).toContain(NEWER_RUN);
  });

  it('a detail whose catalog has the workflow is offered `r`, one whose catalog lacks it is not, and the controller’s catalog is what decides', async () => {
    const offered = mount({ launch: vi.fn(() => Promise.resolve('')) });
    await onDetail(offered.controller);
    expect(detailOf(offered.controller)?.runAgain).toBe(true);
    const lacking = mount({
      launch: vi.fn(() => Promise.resolve('')),
      detail: {
        kind: 'ready',
        detail: runDetailRead({ directory: 'here', workflowSlug: 'retired' }),
      },
    });
    await onDetail(lacking.controller);
    expect(detailOf(lacking.controller)?.runAgain).toBe(false);
    const bare = mount({ launch: vi.fn(() => Promise.resolve('')), defined: undefined });
    await onDetail(bare.controller);
    expect(detailOf(bare.controller)?.runAgain, 'no catalog: nothing is offered').toBe(false);
  });
});

describe('a refusal opens no form', () => {
  it('a run of another directory: the line is on the detail, nothing is asked of the flow, the Home’s notice is clean', async () => {
    const launch = vi.fn(() => Promise.resolve('unexpected'));
    const m = mount({
      launch,
      detail: {
        kind: 'ready',
        detail: runDetailRead({ directory: 'elsewhere', workflowSlug: 'nightly' }),
      },
    });
    await onDetail(m.controller);
    m.controller.handleKey('r', {});
    await flush();
    expect(launch).not.toHaveBeenCalled();
    expect(m.controller.getSnapshot().nativeActionBusy).toBe(false);
    expect(detailOf(m.controller)?.message).toBe(RUN_AGAIN_OTHER_DIRECTORY);
    expect(m.controller.getSnapshot().notice).toBeUndefined();
    expect(m.announced).toEqual([]);
  });

  it('a workflow that is not in the catalog any more', async () => {
    const launch = vi.fn(() => Promise.resolve('unexpected'));
    const m = mount({
      launch,
      detail: {
        kind: 'ready',
        detail: runDetailRead({ directory: 'here', workflowSlug: 'retired' }),
      },
    });
    await onDetail(m.controller);
    m.controller.handleKey('r', {});
    await flush();
    expect(launch).not.toHaveBeenCalled();
    expect(detailOf(m.controller)?.message).toBe(RUN_AGAIN_NOT_DEFINED);
  });

  it('a Home with no catalog', async () => {
    const launch = vi.fn(() => Promise.resolve('unexpected'));
    const m = mount({ launch, defined: undefined });
    await onDetail(m.controller);
    m.controller.handleKey('r', {});
    await flush();
    expect(launch).not.toHaveBeenCalled();
    expect(detailOf(m.controller)?.message).toBe(
      'The workflows of this project could not be listed.',
    );
  });
});

describe('r typed anywhere else is unchanged', () => {
  it('on the landing it is typed into the prompt, and opens nothing', () => {
    const launch = vi.fn(() => Promise.resolve('unexpected'));
    const m = mount({ launch });
    m.controller.handleKey('r', {});
    expect(launch).not.toHaveBeenCalled();
    expect(m.controller.getSnapshot().screen).toBeUndefined();
    expect(m.controller.getSnapshot().input.text, 'the letter is the person’s typing').toBe('r');
  });

  it('on the work page it is typed into the one draft, and opens nothing', () => {
    const launch = vi.fn(() => Promise.resolve('unexpected'));
    const m = mount({ launch, snapshot: WITH_SESSION });
    m.controller.handleKey('', DOWN); // the page behind `↓`
    m.controller.handleKey('r', {});
    expect(launch).not.toHaveBeenCalled();
    expect(m.controller.getSnapshot().screen).toBeUndefined();
    expect(m.controller.getSnapshot().input.text).toBe('r');
  });

  it('on the History list it moves nothing and starts nothing: no list row binds it', async () => {
    const launch = vi.fn(() => Promise.resolve('unexpected'));
    const m = mount({ launch });
    expect(m.controller.openScreen('tab-host', { tab: 'history' })).toBe(true);
    const before = hostOf(m.controller)?.history;
    m.controller.handleKey('r', {});
    await flush();
    expect(launch).not.toHaveBeenCalled();
    expect(m.controller.getSnapshot().nativeActionBusy).toBe(false);
    const after = hostOf(m.controller)?.history;
    expect(after?.detail, 'no detail opened').toBeUndefined();
    expect(after?.message, 'no sentence').toBeUndefined();
    expect(after?.cursor).toBe(before?.cursor);
  });

  it('on a detail that is still loading, missing or unreadable it does nothing', async () => {
    for (const load of [{ kind: 'missing' }, { kind: 'unreadable' }] as const) {
      const launch = vi.fn(() => Promise.resolve('unexpected'));
      const m = mount({ launch, detail: load });
      expect(m.controller.openScreen('tab-host', { tab: 'history' })).toBe(true);
      m.controller.handleKey('', ENTER);
      await flush();
      expect(detailOf(m.controller)?.phase).toBe(load.kind);
      m.controller.handleKey('r', {});
      expect(launch, load.kind).not.toHaveBeenCalled();
      expect(detailOf(m.controller)?.message).toBeUndefined();
    }
  });

  it('in a chat it is the person’s typing, and opens no flow', async () => {
    const launch = vi.fn(() => Promise.resolve('unexpected'));
    const m = mount({ launch });
    m.controller.handlePaste('hello');
    m.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(m.startChat).toHaveBeenCalled());
    await flush();
    expect(m.controller.getSnapshot().mode).toBe('chat');
    m.controller.handleKey('r', {});
    expect(launch).not.toHaveBeenCalled();
    expect(m.controller.getSnapshot().screen, 'no screen over the chat').toBeUndefined();
    expect(m.controller.getSnapshot().nativeActionBusy).toBe(false);
  });
});
