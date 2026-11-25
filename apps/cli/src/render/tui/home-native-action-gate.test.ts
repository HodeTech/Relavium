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
import {
  createHomeController,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';

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
