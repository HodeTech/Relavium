import { describe, expect, it, vi } from 'vitest';

import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { ParkedRunRow } from './home-attention.js';
import {
  createHomeController,
  EMPTY_PROMPT_ENTER_NOTICE,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import { EXAMPLE_PROMPT } from './home-layout.js';

/**
 * The empty Home's prompt keys ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §1; MVP-11 unit 7, H1): `Tab` fills the dim example in (only where the example is on screen), the example is never sent, and `Enter` on an
 * empty prompt answers with one notification instead of nothing when it has nothing to open. The hint that names `Tab` is
 * `home-hint-keys.test.tsx` (which presses every key a hint lists); the frames are `home-landing-frames.test.tsx`.
 */

const EMPTY: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const session: HomeSessionRow = {
  sessionId: 'session-1',
  workingDir: '/work/1',
  title: 'Conversation 1',
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
};
const run: HomeRunRow = {
  runId: 'run-1',
  workflowSlug: 'wf-1',
  status: 'completed',
  createdAt: '2026-11-23T00:00:00.000Z',
  startedAt: undefined,
  completedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
};
const BUSY: HomeSnapshot = {
  ...EMPTY,
  recentSessions: [session],
  recentRuns: [run],
  isEmpty: false,
};
const EXECUTING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: 'run-0001', cancelling: false },
  last: undefined,
};

const TAB = { tab: true } as const;
const ENTER = { return: true } as const;

function home(
  deps: Partial<HomeControllerDeps> = {},
  snapshot: HomeSnapshot = EMPTY,
): {
  readonly c: HomeController;
  readonly announced: string[];
  readonly startChat: ReturnType<typeof vi.fn>;
} {
  const announced: string[] = [];
  const startChat = vi.fn(() => new Promise<never>(() => {}));
  const c = createHomeController({
    startChat,
    homeStore: { read: () => snapshot },
    announce: (text) => announced.push(text),
    schedule: () => () => {},
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
    ...deps,
  });
  return { c, announced, startChat };
}
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};

describe('Tab at the empty prompt of the empty Home fills the example in', () => {
  it('puts the example in the editor with the cursor at its end, and Enter sends it as any typed line', () => {
    const { c, startChat } = home();
    c.handleKey('', TAB);
    expect(c.getSnapshot().input).toEqual({ text: EXAMPLE_PROMPT, cursor: EXAMPLE_PROMPT.length });
    expect(startChat, 'filling it in sends nothing').not.toHaveBeenCalled();
    c.handleKey('', ENTER);
    expect(startChat, 'Enter sends what is in the editor').toHaveBeenCalledOnce();
    expect(c.getSnapshot().pendingMessage).toBe(EXAMPLE_PROMPT);
  });

  it('clears the notice the person was reading, as any first edit does', () => {
    const { c } = home();
    c.setProviderState(false, 'a report that is on screen');
    expect(c.getSnapshot().notice).toBe('a report that is on screen');
    c.handleKey('', TAB);
    expect(c.getSnapshot().notice).toBeUndefined();
  });

  it('fills the fixed example whatever the terminal shows: the plain `e.g.` form is the view’s, and never part of the text', () => {
    const { c } = home();
    c.handleKey('', TAB);
    expect(c.getSnapshot().input.text).not.toContain('e.g.');
    expect(c.getSnapshot().input.text).toBe('summarize the files in this folder');
  });

  it('does nothing with a draft: the key is what it was (the draft is untouched)', () => {
    const { c } = home();
    type(c, 'hi');
    c.handleKey('', TAB);
    expect(c.getSnapshot().input).toEqual({ text: 'hi', cursor: 2 });
  });

  // The landing is ALWAYS the calm landing (MVP-11 unit 7): its prompt shows the example whatever there is to continue, so `Tab` fills it there;
  // the work page's docked prompt shows no example, and there `Tab` is what it was: nothing.
  it('fills the example on a Home that has something to continue too: the landing always shows it', () => {
    const { c } = home({}, BUSY);
    c.handleKey('', TAB);
    expect(c.getSnapshot().input.text).toBe('summarize the files in this folder');
  });

  it('does nothing on the work page, whose docked prompt shows no example (a parked run listed, the focus on its row or on the prompt)', () => {
    const parked: ParkedRunRow = { runId: 'run-p1', kind: 'approval', gates: 1 };
    const { c } = home({
      gateCards: {
        list: () => [parked],
        read: () => undefined,
        resume: () => new Promise(() => {}),
      },
    });
    c.handleKey('', { downArrow: true });
    expect(c.getSnapshot().homePage).toBe('work');
    c.handleKey('', TAB);
    expect(c.getSnapshot().input.text, 'on the row').toBe('');
    c.handleKey('', TAB);
    expect(c.getSnapshot().input.text, 'on the docked prompt').toBe('');
  });

  it('does nothing with Shift, Ctrl or Meta held, and with no key.tab', () => {
    const { c } = home();
    for (const key of [
      { tab: true, shift: true },
      { tab: true, ctrl: true },
      { tab: true, meta: true },
      {},
    ])
      c.handleKey('', key);
    expect(c.getSnapshot().input.text).toBe('');
  });

  it('does nothing while the palette is open: the palette owns the key', () => {
    const { c } = home();
    c.handleKey('/', {});
    expect(c.getSnapshot().palette).toBeDefined();
    c.handleKey('', TAB);
    expect(c.getSnapshot().input.text).toBe('');
    expect(c.getSnapshot().palette).toBeDefined();
  });

  it('does nothing while a native action owns the keyboard', () => {
    let release: () => void = () => {};
    const { c } = home({
      initializeProject: () =>
        new Promise<string | undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    });
    type(c, '/init');
    c.handleKey('', ENTER);
    expect(c.getSnapshot().nativeActionBusy).toBe(true);
    c.handleKey('', TAB);
    expect(c.getSnapshot().input.text).toBe('');
    release();
  });

  it('a second Tab with the example already filled in does nothing more (it is a draft now)', () => {
    const { c } = home();
    c.handleKey('', TAB);
    c.handleKey('', TAB);
    expect(c.getSnapshot().input.text).toBe(EXAMPLE_PROMPT);
  });

  it('with no provider key it fills the example in too, and Enter then connects and keeps the draft, sending nothing', () => {
    const open = vi.fn(() => new Promise<void>(() => {}));
    const { c, startChat } = home({ providerSetup: { initialKeyless: true, open } });
    c.handleKey('', TAB);
    expect(c.getSnapshot().input.text).toBe(EXAMPLE_PROMPT);
    c.handleKey('', ENTER);
    expect(open, 'the provider setup opens').toHaveBeenCalledOnce();
    expect(startChat, 'nothing is built or sent').not.toHaveBeenCalled();
    expect(c.getSnapshot().input.text, 'the draft is kept').toBe(EXAMPLE_PROMPT);
  });
});

describe('the example is never sent', () => {
  it('Enter on an empty prompt submits nothing and builds no chat', () => {
    const { c, startChat } = home();
    c.handleKey('', ENTER);
    expect(startChat).not.toHaveBeenCalled();
    expect(c.getSnapshot().mode).toBe('home');
    expect(c.getSnapshot().input.text).toBe('');
    expect(c.getSnapshot().pendingMessage).toBe('');
  });

  it('the first key replaces it: what is typed is the text, with none of the example in it', () => {
    const { c } = home();
    c.handleKey('h', {});
    expect(c.getSnapshot().input).toEqual({ text: 'h', cursor: 1 });
  });

  it('a draft of blanks is not a message either: Enter clears it and sends nothing', () => {
    const { c, startChat } = home();
    type(c, '   ');
    c.handleKey('', ENTER);
    expect(startChat).not.toHaveBeenCalled();
    expect(c.getSnapshot().input.text).toBe('');
  });
});

describe('Enter at an empty prompt that has nothing to open says how to start, in one notification', () => {
  it('names the way to chat and the palette, by the legend’s bracket rule', () => {
    expect(EMPTY_PROMPT_ENTER_NOTICE).toBe('Type a message to chat · [/] commands');
    const { c, announced } = home();
    c.handleKey('', ENTER);
    expect(announced).toEqual([EMPTY_PROMPT_ENTER_NOTICE]);
    // Never the Home's notice (a notification leaves nothing behind), never a chat.
    expect(c.getSnapshot().notice).toBeUndefined();
  });

  it('says it on a Home that has something to continue too (Enter with no focused row has nothing to open there either)', () => {
    const { c, announced } = home({}, BUSY);
    c.handleKey('', ENTER);
    expect(announced).toEqual([EMPTY_PROMPT_ENTER_NOTICE]);
  });

  it('says nothing when a hosted run is there to show: Enter opens its view', () => {
    const { c, announced } = home({
      hostedRuns: { snapshot: () => EXECUTING, cancel: () => true, close: () => Promise.resolve() },
    });
    c.handleKey('', ENTER);
    expect(c.getSnapshot().screen).toMatchObject({ kind: 'run-view', runId: 'run-0001' });
    expect(announced).toEqual([]);
  });

  it('says nothing with no provider key: Enter opens the provider setup', () => {
    const open = vi.fn(() => new Promise<void>(() => {}));
    const { c, announced } = home({ providerSetup: { initialKeyless: true, open } });
    c.handleKey('', ENTER);
    expect(open).toHaveBeenCalledOnce();
    expect(announced).toEqual([]);
  });

  it('is silent on a Home with no notification channel (a test’s Home), and changes nothing else', () => {
    const c = createHomeController({
      startChat: () => new Promise<never>(() => {}),
      homeStore: { read: () => EMPTY },
      schedule: () => () => {},
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    expect(() => {
      c.handleKey('', ENTER);
    }).not.toThrow();
    expect(c.getSnapshot().input.text).toBe('');
  });
});
