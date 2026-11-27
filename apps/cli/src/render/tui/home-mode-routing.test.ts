/**
 * `/mode` on the bare Home's landing ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §6,
 * dated note of 2026-11-27; MVP-11 unit 8, OD-25): the controller opens the popup HOST's list over the Home's own settings port, never a native
 * action (a popup may not open over one), and brackets the hand-off to the startup-default flow with the composer's busy mark. What it pins: the typed
 * word and the palette open the popup with the Home's member (`scope: 'home'`, the saved startup default read through the dependency, the writer
 * handed off); a word with an argument opens nothing and says why; a Home without the dependency or without a channel to say what applied on says
 * `/mode` is unavailable; the member is the Home's own (a chat in front has its own); and a hand-off that ended for good (the Home closing) starts
 * nothing.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type {
  SettingsKind,
  SettingsPort,
  StartupDefaultOutcome,
} from '../../popups/settings-port.js';
import {
  createHomeController,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';

const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const ENTER = { return: true } as const;
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};

function home(deps: Partial<HomeControllerDeps> = {}) {
  const opened: { command: SettingsKind; chat: SettingsPort }[] = [];
  const c = createHomeController({
    startChat: vi.fn(() => new Promise<never>(() => {})),
    homeStore: { read: () => EMPTY },
    announce: vi.fn(),
    schedule: () => () => {},
    openSettings: (request) => {
      opened.push(request);
    },
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
    ...deps,
  });
  return { c, opened };
}

const SAID: StartupDefaultOutcome = { kind: 'said' };
const startupMode = () => ({
  read: vi.fn(() => 'plan' as const),
  save: vi.fn((): Promise<StartupDefaultOutcome> => Promise.resolve(SAID)),
});

describe('the typed /mode opens the popup host’s list over the Home’s own member', () => {
  it('`/mode` + Enter opens the `mode` setting once: scope `home`, the saved default read through the dependency, the writer handed off', async () => {
    const port = startupMode();
    const { c, opened } = home({ startupMode: port });
    type(c, '/mode');
    c.handleKey('', ENTER);
    expect(opened).toHaveLength(1);
    const request = opened[0];
    expect(request?.command).toBe('mode');
    expect(request?.chat.surface).toBe('home');
    const member = request?.chat.mode;
    if (member?.scope !== 'home') throw new Error('the Home’s member');
    expect(member.startup()).toBe('plan');
    expect(port.read).toHaveBeenCalledOnce();
    // nothing is started by the controller itself: the list is the host's
    expect(port.save).not.toHaveBeenCalled();
    await expect(member.saveStartupDefault('accept-edits')).resolves.toEqual(SAID);
    expect(port.save).toHaveBeenCalledWith('accept-edits');
    expect(c.getSnapshot().submitBusy).toBe(false);
    // the line is cleared, and nothing reached the Home’s notice or a chat
    expect(c.getSnapshot().notice).toBeUndefined();
  });

  it('the composer is busy while the hand-off is open (the flow’s keys are its own) and free again however it ended', async () => {
    let finish: (outcome: StartupDefaultOutcome) => void = () => {};
    const port = {
      read: () => 'ask' as const,
      save: () =>
        new Promise<StartupDefaultOutcome>((resolve) => {
          finish = resolve;
        }),
    };
    const { c, opened } = home({ startupMode: port });
    type(c, '/mode');
    c.handleKey('', ENTER);
    const member = opened[0]?.chat.mode;
    if (member === undefined) throw new Error('the Home’s member');
    const pending = member.saveStartupDefault('plan');
    expect(c.getSnapshot().submitBusy).toBe(true);
    finish({ kind: 'back' });
    await expect(pending).resolves.toEqual({ kind: 'back' });
    expect(c.getSnapshot().submitBusy).toBe(false);
  });

  it('a word with an argument opens nothing and says the startup default is what `/mode` sets here', () => {
    const { c, opened } = home({ startupMode: startupMode() });
    type(c, '/mode plan');
    c.handleKey('', ENTER);
    expect(opened).toEqual([]);
    expect(c.getSnapshot().notice).toBe(
      'No conversation is active. Use /mode to set the startup default.',
    );
  });

  it('a Home without the dependency, or with no channel to say what applied on, says `/mode` is unavailable and opens nothing', () => {
    for (const deps of [{}, { startupMode: startupMode(), announce: undefined }] as const) {
      const { c, opened } = home(deps);
      type(c, '/mode');
      c.handleKey('', ENTER);
      expect(opened, JSON.stringify(Object.keys(deps))).toEqual([]);
      expect(c.getSnapshot().notice).toBe('Startup mode settings are unavailable here.');
    }
  });

  it('a Home that closed starts nothing: a hand-off asked of it afterwards is closed, and the dependency is never called', async () => {
    const port = startupMode();
    const { c, opened } = home({ startupMode: port });
    type(c, '/mode');
    c.handleKey('', ENTER);
    const member = opened[0]?.chat.mode;
    if (member === undefined) throw new Error('the Home’s member');
    c.handleKey('c', { ctrl: true });
    c.handleKey('c', { ctrl: true }); // two presses leave
    await expect(member.saveStartupDefault('plan')).resolves.toEqual({ kind: 'closed' });
    expect(port.save).not.toHaveBeenCalled();
  });
});
