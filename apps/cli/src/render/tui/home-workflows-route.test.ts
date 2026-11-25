/**
 * `/workflows` at the Home ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): typed on the bare Home or chosen from its palette it opens the tab host on its Defined tab and starts no chat; with a
 * chat in front it is the chat's own command, unchanged. From the tab, `r` and `x` reach the Home's launch flow and export card.
 *
 * The Home controller is real; its catalog port, launch flow and export card are scripted, so "starts no chat" is proved at the one
 * place a chat would begin (`startChat`) and "reaches the flow" at the flow's own entry.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildDefinedModel, type DefinedEntry } from '../../history/defined-model.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import type { TabHostState } from './tab-host.js';
import type { DefinedPort } from './tab-host-workflows.js';

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
const UP = { upArrow: true } as const;
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};

const entries: readonly DefinedEntry[] = [
  {
    slug: 'code-review',
    name: 'Code Review',
    nodeCount: 5,
    path: 'code-review.relavium.yaml',
    valid: true,
  },
  {
    slug: 'nightly',
    name: undefined,
    nodeCount: 1,
    path: 'nightly.relavium.yaml',
    valid: true,
  },
];

const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const RUNNING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-0001', cancelling: false },
  last: undefined,
};

interface Options {
  readonly withChat?: boolean;
  readonly defined?: DefinedPort | undefined;
  readonly launch?: ((slug?: string, path?: string) => Promise<string>) | undefined;
  readonly exporter?: ((slug: string) => Promise<string>) | undefined;
  readonly host?: () => RunHostSnapshot;
  /** Pins that put an entry the catalog lacks in front of the others. */
  readonly pinned?: readonly string[];
}

function definedPort(pinned: readonly string[] = []) {
  const read = vi.fn(() => ({
    model: buildDefinedModel({
      entries,
      pins: pinned.map((ref, index) => ({
        kind: 'workflow',
        ref,
        rowid: index + 1,
        oversized: false,
      })),
    }),
    slugOf: (index: number) => entries[index]?.slug,
    pathOf: (index: number) => entries[index]?.path,
  }));
  return { port: { read } satisfies DefinedPort, read };
}

function mount(options: Options = {}) {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const lines: string[] = [];
  const session: HomeChatSession = {
    store,
    sessionId: 'sess-workflows-route',
    processLine: (line) => {
      lines.push(line);
      return Promise.resolve();
    },
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  };
  const startChat = vi.fn(() => Promise.resolve(session));
  const fake = definedPort(options.pinned);
  const port = 'defined' in options ? options.defined : fake.port;
  const deps: HomeControllerDeps = {
    ...(port === undefined ? {} : { defined: port }),
    ...(options.launch === undefined ? {} : { launchRun: options.launch }),
    ...(options.exporter === undefined ? {} : { exportDefined: options.exporter }),
    hostedRuns: {
      snapshot: options.host ?? ((): RunHostSnapshot => IDLE),
      cancel: () => true,
      close: () => Promise.resolve(),
    },
    startChat,
    homeStore: { read: () => EMPTY },
    schedule: () => () => {},
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
  };
  const controller = createHomeController(deps);
  return { controller, startChat, lines, read: fake.read };
}

const hostOf = (c: HomeController): TabHostState | undefined => {
  const screen = c.getSnapshot().screen;
  return screen?.kind === 'tab-host' ? screen.host : undefined;
};
const messageOf = (c: HomeController): string | undefined => hostOf(c)?.defined?.message;
const submit = (c: HomeController, line: string): void => {
  c.handlePaste(line);
  c.handleKey('', ENTER);
};

describe('a typed /workflows at the Home', () => {
  it('opens the tab host on the Defined tab, clears the composer, and starts no chat', async () => {
    const { controller, startChat, read } = mount();
    submit(controller, '/workflows');
    await flush();
    const host = hostOf(controller);
    expect(host?.tab).toBe('defined');
    expect(host?.defined?.read.model.rows.map((row) => row.slug)).toEqual([
      'code-review',
      'nightly',
    ]);
    expect(read, 'the catalog and the pins were read on entering').toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().input.text).toBe('');
    expect(controller.getSnapshot().mode, 'still the Home').toBe('home');
    expect(startChat, 'no chat began').not.toHaveBeenCalled();
    expect(controller.getSnapshot().session).toBeUndefined();
  });

  it('is opened by the palette too, and Esc leaves it for the landing', async () => {
    const { controller, startChat } = mount();
    controller.handleKey('/', {}); // an empty prompt: the palette opens
    expect(controller.getSnapshot().palette).toBeDefined();
    type(controller, 'workflows');
    controller.handleKey('', ENTER);
    await flush();
    expect(hostOf(controller)?.tab).toBe('defined');
    expect(controller.getSnapshot().palette).toBeUndefined();
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(startChat).not.toHaveBeenCalled();
  });

  it('takes no argument: the line says so and opens nothing and starts nothing', async () => {
    const { controller, startChat, read } = mount();
    submit(controller, '/workflows everything');
    await flush();
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(controller.getSnapshot().notice).toBe('/workflows accepts no arguments.');
    expect(read).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
  });

  it('says the workflows are not available when no catalog is wired, and still starts no chat', async () => {
    const { controller, startChat } = mount({ defined: undefined });
    submit(controller, '/workflows');
    await flush();
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(controller.getSnapshot().notice).toBe('The project’s workflows are not available here.');
    expect(startChat).not.toHaveBeenCalled();
  });

  it('opens on a line that says it cannot list when the read fails, never on a crash', async () => {
    const { controller } = mount({
      defined: {
        read: () => {
          throw new Error('PRIVATE_FAULT_TEXT');
        },
      },
    });
    submit(controller, '/workflows');
    await flush();
    expect(hostOf(controller)?.unreadable).toBe(true);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('PRIVATE_FAULT_TEXT');
  });
});

describe('/workflows inside a chat', () => {
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

  it('is the chat’s own command, handed to the chat unchanged: the tab host does not open and its catalog is not read', async () => {
    const { controller, lines, read } = await chatting();
    controller.handlePaste('/workflows');
    controller.handleKey('', ENTER);
    await flush();
    expect(lines, 'the chat received the line').toContain('/workflows');
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('the chat palette’s /workflows is the chat’s too', async () => {
    const { controller, lines, read } = await chatting();
    controller.handleKey('/', {});
    expect(controller.getSnapshot().palette).toBeDefined();
    type(controller, 'workflows');
    controller.handleKey('', ENTER);
    await flush();
    expect(lines).toContain('/workflows');
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('the Defined tab’s keys reach the Home’s flows', () => {
  it('r opens the launch flow at the row’s workflow, holds the keyboard meanwhile, and shows what it said on the tab', async () => {
    let finish: (notice: string) => void = () => undefined;
    const launch = vi.fn(
      (slug?: string) =>
        new Promise<string>((resolve) => {
          void slug;
          finish = resolve;
        }),
    );
    const { controller } = mount({ launch });
    submit(controller, '/workflows');
    controller.handleKey('', DOWN);
    controller.handleKey('r', {});
    expect(launch).toHaveBeenCalledTimes(1);
    // The row's slug and the catalog path it was listed from: the flow refuses a slug whose file is another one by the time of the press.
    expect(launch).toHaveBeenCalledWith('nightly', 'nightly.relavium.yaml');
    expect(controller.getSnapshot().nativeActionBusy).toBe(true);
    // The flow owns the keyboard: a key at the screen behind it moves nothing (the cursor is on the last row, so only ↑ would show it).
    controller.handleKey('', UP);
    expect(hostOf(controller)?.defined?.cursor).toBe(1);
    finish('Run cancelled.');
    await flush();
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
    expect(messageOf(controller)).toBe('Run cancelled.');
    expect(hostOf(controller)?.defined?.cursor, 'the tab is left where it was').toBe(1);
  });

  it('a run that started is shown, and Esc returns to the tab on the row it came from', async () => {
    let snapshot: RunHostSnapshot = IDLE;
    const launch = vi.fn(() => {
      snapshot = RUNNING; // the host latched a leg, as a started run does
      return Promise.resolve('Started nightly as run run-0001. It runs in the background.');
    });
    const { controller } = mount({ launch, host: () => snapshot });
    submit(controller, '/workflows');
    controller.handleKey('', DOWN);
    controller.handleKey('r', {});
    await flush();
    const screen = controller.getSnapshot().screen;
    expect(screen?.kind).toBe('run-view');
    expect(screen?.kind === 'run-view' ? screen.from : undefined).toBe('tab-host');
    controller.handleKey('', ESC);
    expect(hostOf(controller)?.tab).toBe('defined');
    expect(hostOf(controller)?.defined?.cursor).toBe(1);
  });

  it('r with a leg already executing shows the refusal on the tab and does not open the view of the other run', async () => {
    // The host refuses a second start while a leg executes, so the flow's notice is the refusal; the leg that is executing is another run,
    // and its view is not what `r` asked for.
    const launch = vi.fn(() => Promise.resolve('A run is already executing: run-0001.'));
    const { controller } = mount({ launch, host: () => RUNNING });
    submit(controller, '/workflows');
    controller.handleKey('', DOWN);
    controller.handleKey('r', {});
    await flush();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().screen?.kind, 'the tab host is still in front').toBe(
      'tab-host',
    );
    expect(hostOf(controller)?.tab).toBe('defined');
    expect(messageOf(controller)).toBe('A run is already executing: run-0001.');
    expect(hostOf(controller)?.defined?.cursor, 'the tab is left where it was').toBe(1);
  });

  it('r refused while a resume leg is still acquiring its run keeps the Defined tab: the id that leg gets later is not a run this launch started', async () => {
    // A resume leg is between its confirmation and the engine's start result: `launching`, a leg with no run id yet. This launch is refused
    // ("a run is already starting"), and by the time the flow answers the resume has its id.
    let snapshot: RunHostSnapshot = {
      launching: true,
      active: { leg: 'resume', runId: undefined, cancelling: false },
      last: undefined,
    };
    const launch = vi.fn(() => {
      snapshot = {
        launching: false,
        active: { leg: 'resume', runId: 'run-0009', cancelling: false },
        last: undefined,
      };
      return Promise.resolve('A run is already starting.');
    });
    const { controller } = mount({ launch, host: () => snapshot });
    submit(controller, '/workflows');
    controller.handleKey('', DOWN);
    controller.handleKey('r', {});
    await flush();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().screen?.kind, 'the run view of the resume is not opened').toBe(
      'tab-host',
    );
    expect(hostOf(controller)?.tab).toBe('defined');
    expect(messageOf(controller)).toBe('A run is already starting.');
  });

  it('r that ends with the leg gone and nothing started shows what the flow said on the tab', async () => {
    let snapshot: RunHostSnapshot = RUNNING;
    const launch = vi.fn(() => {
      snapshot = IDLE; // the leg that was executing settled while the form was open, and this launch was left
      return Promise.resolve('Run cancelled.');
    });
    const { controller } = mount({ launch, host: () => snapshot });
    submit(controller, '/workflows');
    controller.handleKey('', DOWN);
    controller.handleKey('r', {});
    await flush();
    expect(controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(messageOf(controller)).toBe('Run cancelled.');
  });

  it('r that starts a run while another one ended meanwhile shows the new run’s view', async () => {
    let snapshot: RunHostSnapshot = RUNNING;
    const launch = vi.fn(() => {
      snapshot = {
        launching: false,
        active: { leg: 'start', runId: 'run-0002', cancelling: false },
        last: undefined,
      };
      return Promise.resolve('Started nightly as run run-0002. It runs in the background.');
    });
    const { controller } = mount({ launch, host: () => snapshot });
    submit(controller, '/workflows');
    controller.handleKey('', DOWN);
    controller.handleKey('r', {});
    await flush();
    const screen = controller.getSnapshot().screen;
    expect(screen?.kind).toBe('run-view');
    expect(screen?.kind === 'run-view' ? screen.runId : undefined).toBe('run-0002');
  });

  it('r on a row that is not a workflow of the catalog opens no flow', async () => {
    const launch = vi.fn(() => Promise.resolve('unexpected'));
    const { controller } = mount({ launch, pinned: ['../../x'] });
    submit(controller, '/workflows');
    controller.handleKey('r', {}); // the pin comes first: it is the selected row
    await flush();
    expect(launch).not.toHaveBeenCalled();
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
    expect(messageOf(controller)).toBe('Cannot run ../../x: it is not in the catalog.');
  });

  it('x opens the export card for the row’s workflow and shows what it said on the tab', async () => {
    const exporter = vi.fn((slug: string) => {
      void slug;
      return Promise.resolve('Exported workflow nightly.');
    });
    const { controller } = mount({ exporter });
    submit(controller, '/workflows');
    controller.handleKey('', DOWN);
    controller.handleKey('x', {});
    expect(exporter).toHaveBeenCalledTimes(1);
    expect(exporter).toHaveBeenCalledWith('nightly');
    expect(controller.getSnapshot().nativeActionBusy).toBe(true);
    await flush();
    expect(messageOf(controller)).toBe('Exported workflow nightly.');
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
  });

  it('x on a row that is not a workflow of the catalog opens no card', async () => {
    const exporter = vi.fn(() => Promise.resolve('unexpected'));
    const { controller } = mount({ exporter, pinned: ['../../x'] });
    submit(controller, '/workflows');
    controller.handleKey('x', {});
    await flush();
    expect(exporter).not.toHaveBeenCalled();
    expect(messageOf(controller)).toBe('Cannot export ../../x: it is not in the catalog.');
  });

  it('says so, on the tab, when no launch or no export is wired', () => {
    const { controller } = mount();
    submit(controller, '/workflows');
    controller.handleKey('r', {});
    expect(messageOf(controller)).toBe('Running a workflow is unavailable in this session.');
    controller.handleKey('x', {});
    expect(messageOf(controller)).toBe('Export is unavailable in this session.');
  });

  it('a fault in the card is a notice, not a crash, and the tab is still there', async () => {
    const { controller } = mount({
      exporter: () => Promise.reject(new Error('PRIVATE_FAULT_TEXT')),
    });
    submit(controller, '/workflows');
    controller.handleKey('x', {});
    await flush();
    expect(controller.getSnapshot().notice).toBe('Export could not be completed.');
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('PRIVATE_FAULT_TEXT');
    expect(hostOf(controller)?.tab).toBe('defined');
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
  });
});
