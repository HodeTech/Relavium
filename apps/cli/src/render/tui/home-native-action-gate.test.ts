/**
 * The Home's opening gate for the flows of the native prompt channel (MVP-11 unit 6, 6.1 item A9; ADR-0148 §2): a flow is a popup, so it opens
 * on a popup's rules. `openNativeAction` refuses while a popup is already open, a chat is being built, a card waits, a sheet is open, a turn,
 * a submit or a `!` command runs, or a two-step is armed, with ONE notification on the Home's channel in the words a refused popup uses, and
 * no Home notice; the overlay it is opened from (the palette it closes, the tab host) is no refusal. Of the caller's own change only a cleared
 * editor is kept (a key-shaped draft never stays in the prompt).
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { POPUP_NOTICE_MAX_COLUMNS } from '../../popups/geometry.js';
import { refusedOpenText } from '../../popups/popup-host.js';
import { displayWidth } from './viewport.js';
import type { AskUserRequest, ToolApprovalRequest } from '@relavium/core';

import { createChatStore, type ChatStoreController } from './chat-store.js';
import {
  createHomeController,
  homeNativeActionRefusal,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
  type HomeControllerState,
} from './home-controller.js';
import { createRunCard } from './run-card-model.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

const GATE_REQUEST: ToolApprovalRequest = {
  toolId: 'edit_file',
  action: 'fs_write',
  preview: { path: 'src/app.ts' },
  unredactedPreview: { path: 'src/app.ts' },
};
const GATE_QUESTION: AskUserRequest = {
  questions: [
    {
      header: 'Pick',
      question: 'Which file?',
      multiSelect: false,
      options: [
        { label: 'alpha.ts', description: 'The first file' },
        { label: 'beta.ts', description: 'The second file' },
      ],
    },
  ],
};

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const ENTER = { return: true } as const;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A Home whose native flows record that they opened and never end (the keyboard stays the flow's). */
function home(overrides: Partial<HomeControllerDeps> = {}) {
  const opened: string[] = [];
  const never = (name: string) => (): Promise<never> => {
    opened.push(name);
    return new Promise<never>(() => undefined);
  };
  const announce = vi.fn<(text: string) => void>();
  const deps: HomeControllerDeps = {
    startChat: () => new Promise(() => undefined),
    homeStore: { read: () => EMPTY },
    schedule: () => () => undefined,
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
    initializeProject: never('init'),
    importDefined: never('import'),
    pricing: never('pricing'),
    launchRun: never('run'),
    providerSetup: { initialKeyless: false, open: never('providers') },
    announce,
    ...overrides,
  };
  const controller = createHomeController(deps);
  return { controller, opened, announce };
}

/** Type a line into the landing and submit it, as a person does. */
function typeLine(controller: HomeController, line: string): void {
  controller.handlePaste(line);
  controller.handleKey('', ENTER);
}

const WORDS = [
  ['/init', 'init', 'Project initialization'],
  ['/import', 'import', 'Import'],
  ['/pricing', 'pricing', 'Model pricing'],
  ['/run', 'run', 'Run workflow'],
  ['/providers', 'providers', 'Provider setup'],
] as const;

describe('a native flow opens on a popup’s rules', () => {
  it.each(WORDS)(
    '%s while a popup is open: refused in one notification, no notice, nothing opened, the keyboard free',
    async (line, name, label) => {
      const h = home({ popupOpen: () => true });
      typeLine(h.controller, line);
      await flush();
      expect(h.opened).not.toContain(name);
      expect(h.announce).toHaveBeenCalledTimes(1);
      expect(h.announce).toHaveBeenCalledWith(refusedOpenText(label, 'popup-open'));
      // drawn beside the open popup's way back: the reason is whole and the line fits its 54 columns (a long label is what is cut)
      const said = h.announce.mock.calls[0]?.[0] ?? '';
      expect(said.endsWith(' cannot open now: another popup is open')).toBe(true);
      expect(displayWidth(said)).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
      const state = h.controller.getSnapshot();
      expect(state.notice).toBeUndefined();
      expect(state.nativeActionBusy).toBe(false);
    },
  );

  it.each(WORDS)('%s with nothing in the way opens, and announces nothing', async (line, name) => {
    const h = home({ popupOpen: () => false });
    typeLine(h.controller, line);
    await flush();
    expect(h.opened).toEqual([name]);
    expect(h.announce).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().nativeActionBusy).toBe(true);
  });

  it('a Home with no popup port opens as before (no popup is ever open)', async () => {
    const h = home();
    typeLine(h.controller, '/init');
    await flush();
    expect(h.opened).toEqual(['init']);
  });

  it('a refusal with no announcement port says nothing and opens nothing (never a Home notice)', async () => {
    const opened: string[] = [];
    const controller = createHomeController({
      startChat: () => new Promise(() => undefined),
      homeStore: { read: () => EMPTY },
      schedule: () => () => undefined,
      onExit: vi.fn(),
      onError: (cause) => {
        throw cause;
      },
      popupOpen: () => true,
      initializeProject: () => {
        opened.push('init');
        return new Promise<never>(() => undefined);
      },
    });
    typeLine(controller, '/init');
    await flush();
    expect(opened).toEqual([]);
    expect(controller.getSnapshot().notice).toBeUndefined();
  });

  it('while a chat is being built the landing takes no line, so no flow is reached and nothing is said (the gate’s `starting` fact is the second line)', async () => {
    const h = home({ popupOpen: () => false });
    typeLine(h.controller, 'hello');
    await flush();
    expect(h.controller.getSnapshot().mode).toBe('loading');
    typeLine(h.controller, '/init');
    await flush();
    expect(h.opened).toEqual([]);
    expect(h.announce).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().notice).toBeUndefined();
  });

  it('the keyless Home: a key-shaped draft is cleared even when the setup is refused, and the refusal is the one notification', async () => {
    const h = home({
      popupOpen: () => true,
      providerSetup: { initialKeyless: true, open: () => new Promise<never>(() => undefined) },
    });
    h.controller.handlePaste('sk-ant-api03-' + 'A'.repeat(48));
    expect(h.controller.getSnapshot().input.text).not.toBe('');
    h.controller.handleKey('', ENTER);
    await flush();
    expect(h.controller.getSnapshot().input.text).toBe('');
    expect(h.announce).toHaveBeenCalledTimes(1);
    expect(h.announce).toHaveBeenCalledWith(refusedOpenText('Provider setup', 'popup-open'));
    expect(h.controller.getSnapshot().notice).toBeUndefined();
  });

  it('the keyless Home: a draft that is not a key stays in the prompt when the setup is refused', async () => {
    const h = home({
      popupOpen: () => true,
      providerSetup: { initialKeyless: true, open: () => new Promise<never>(() => undefined) },
    });
    h.controller.handlePaste('hello there');
    h.controller.handleKey('', ENTER);
    await flush();
    expect(h.controller.getSnapshot().input.text).toBe('hello there');
    expect(h.announce).toHaveBeenCalledTimes(1);
  });
});

/**
 * The gate's facts, one by one (`homeNativeActionRefusal`, pure): the keyboard routing keeps most of them out of reach today (a card or a
 * running turn holds the keys), so each is proved here on the state the Home would have, as the reviews asked.
 */
describe('the gate’s facts, each on its own', () => {
  const homeStore = { read: () => EMPTY };
  const base = createHomeController({
    startChat: () => new Promise(() => undefined),
    homeStore,
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
  }).getSnapshot();

  /**
   * A live chat whose store is the real one, opened on the card `open` asks for (left unanswered); `running` reports a turn in flight, and
   * `without` hides one card field of the snapshot so another can be proved on its own.
   */
  function withChat(
    open?: (store: ChatStoreController) => void,
    options: { readonly running?: boolean; readonly without?: 'approval' } = {},
  ): HomeControllerState {
    const real = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    open?.(real);
    const store: ChatStoreController = {
      ...real,
      getSnapshot: () => {
        const snapshot = real.getSnapshot();
        return {
          ...snapshot,
          ...(options.without === 'approval' ? { approval: undefined } : {}),
          state:
            options.running === true ? { ...snapshot.state, status: 'running' } : snapshot.state,
        };
      },
    };
    const session: HomeChatSession = {
      store,
      sessionId: 'sess-gate',
      processLine: () => Promise.resolve(),
      shouldStop: () => false,
      stopReason: () => 'exit',
      teardown: () => Promise.resolve(),
    };
    return { ...base, mode: 'chat', session };
  }
  const swallow = (promise: Promise<unknown>): void => {
    promise.catch(() => undefined);
  };
  const gateCard: HomeControllerState['screen'] = {
    kind: 'gate-card',
    runId: 'run-1',
    card: createRunCard({
      runId: 'run-1',
      gates: [],
      resume: () => Promise.reject(new Error('unused')),
    }),
    back: 'landing',
    from: 'landing',
  };

  it('nothing in the way: it opens', () => {
    expect(homeNativeActionRefusal(base, {}, false)).toBeUndefined();
    expect(homeNativeActionRefusal(withChat(), {}, false)).toBeUndefined();
  });

  it('a popup already open refuses first, whatever else holds', () => {
    expect(homeNativeActionRefusal(base, {}, true)).toBe('popup-open');
    expect(homeNativeActionRefusal({ ...base, mode: 'loading' }, {}, true)).toBe('popup-open');
  });

  it('a chat being built refuses (`starting`)', () => {
    expect(homeNativeActionRefusal({ ...base, mode: 'loading' }, {}, false)).toBe('starting');
  });

  it.each([
    [
      'an approval',
      (store: ChatStoreController) => swallow(store.requestApproval(GATE_REQUEST, false)),
    ],
    [
      'the agent’s question',
      (store: ChatStoreController) => swallow(store.requestQuestion(GATE_QUESTION)),
    ],
    [
      'a continue checkpoint',
      (store: ChatStoreController) =>
        swallow(store.requestCheckpoint({ rounds: 32, interval: 32 })),
    ],
  ] as const)('%s waiting refuses (`card-open`)', (_name, open) => {
    const state = withChat(open);
    expect(homeNativeActionRefusal(state, {}, false)).toBe('card-open');
  });

  it('the tool review open refuses (`card-open`), the approval hidden so the review is proved on its own', () => {
    const state = withChat(
      (store) => {
        swallow(store.requestApproval(GATE_REQUEST, false));
        store.openDetails();
      },
      { without: 'approval' },
    );
    expect(state.session?.store.getSnapshot().review).toBeDefined();
    expect(state.session?.store.getSnapshot().approval).toBeUndefined();
    expect(homeNativeActionRefusal(state, {}, false)).toBe('card-open');
  });

  it('a sheet refuses (`sheet-open`): the exit guard, and a gate card', () => {
    expect(homeNativeActionRefusal({ ...base, exitGuard: 'confirm' }, {}, false)).toBe(
      'sheet-open',
    );
    expect(homeNativeActionRefusal({ ...base, screen: gateCard }, {}, false)).toBe('sheet-open');
  });

  it('a turn, a `!` command or a submit in flight refuses (`turn-running`)', () => {
    expect(homeNativeActionRefusal(withChat(undefined, { running: true }), {}, false)).toBe(
      'turn-running',
    );
    expect(homeNativeActionRefusal({ ...base, shellBusy: true }, {}, false)).toBe('turn-running');
    expect(homeNativeActionRefusal({ ...base, submitBusy: true }, {}, false)).toBe('turn-running');
  });

  it('a two-step armed refuses (`armed`)', () => {
    expect(homeNativeActionRefusal({ ...base, interruptArmed: true }, {}, false)).toBe('armed');
  });

  it('the overlay a flow is opened from is no refusal: the palette, a search, a mention, a screen of the slot', () => {
    const palette = createHomeController({
      startChat: () => new Promise(() => undefined),
      homeStore,
      onExit: vi.fn(),
      onError: (cause) => {
        throw cause;
      },
    });
    palette.handleKey('/', {});
    const open = palette.getSnapshot();
    expect(open.palette).toBeDefined();
    expect(homeNativeActionRefusal(open, {}, false)).toBeUndefined();
  });

  it('is read on the Home as the action’s own change leaves it (`patch`)', () => {
    // a change that takes the sheet away opens; one that brings one refuses
    expect(
      homeNativeActionRefusal({ ...base, screen: gateCard }, { screen: undefined }, false),
    ).toBeUndefined();
    expect(homeNativeActionRefusal(base, { exitGuard: 'confirm' }, false)).toBe('sheet-open');
  });

  it('says the reasons in the one order of `popupRefusal`: a chat being built before a card, a card before a sheet, a sheet before a turn, a turn before a two-step', () => {
    const everything = {
      ...withChat((store) => swallow(store.requestCheckpoint({ rounds: 1, interval: 1 })), {
        running: true,
      }),
      exitGuard: 'confirm' as const,
      interruptArmed: true,
    };
    expect(homeNativeActionRefusal({ ...everything, mode: 'loading' }, {}, false)).toBe('starting');
    expect(homeNativeActionRefusal(everything, {}, false)).toBe('card-open');
  });
});
