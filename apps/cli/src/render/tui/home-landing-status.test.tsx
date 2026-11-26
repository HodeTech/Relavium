import './force-color.js';

import type { ModelCatalogEntry } from '@relavium/llm';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeStatusFacts } from '../../home/home-status-facts.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { ModelsSettingsPort, SettingsKind, SettingsPort } from '../../popups/settings-port.js';
import { createChatStore } from './chat-store.js';
import { settleFrames } from './harness-util.js';
import { RootApp } from './home-app.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
  type HomeModelsPort,
} from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * The landing's status line and where its facts come from ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §2; MVP-11 unit 7, H1): the controller reads the next chat's facts ONCE when it is built and again only when something that can change them was
 * done (a provider run, a `/models` default, a `/mode` default, a chat ending), never while it draws, because a draw touches no keychain and no
 * disk (the chat repaints every 80 ms and a key read blocks the event loop). What the facts are, and that they are the facts of the chat a new
 * start builds, is `home/next-chat-facts.test.ts` and `home/drive-home-status.test.ts`.
 */
afterEach(cleanup);

const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const FIRST: HomeStatusFacts = {
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  mode: 'ask',
  directory: '~/acme-web',
};
const SECOND: HomeStatusFacts = { ...FIRST, provider: 'openai', model: 'gpt-5', effort: 'high' };
const ENTER = { return: true } as const;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};

/** A reader whose facts a test moves, and whose reads are counted: the controller is told nothing else about the configuration. */
function reader(first: HomeStatusFacts = FIRST) {
  let facts = first;
  const read = vi.fn(() => ({ ...facts })); // a fresh object each read: only an unchanged VALUE may publish nothing
  return {
    read,
    set: (next: HomeStatusFacts): void => {
      facts = next;
    },
  };
}

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

const entry = (modelId: string, provider: ModelCatalogEntry['provider']): ModelCatalogEntry => ({
  modelId,
  provider,
  displayName: modelId,
  pricingSource: 'catalog',
  priceKnown: true,
  available: true,
  deprecated: false,
});
function modelsPort(): HomeModelsPort {
  let written: string | undefined;
  return {
    load: () => ({ entries: [entry('gpt-5', 'openai')], refreshedAt: undefined }),
    refreshIfStale: () => Promise.resolve(undefined),
    refresh: () => Promise.resolve({ providers: [] }),
    currentDefault: () => written,
    currentEffort: () => undefined,
    writeDefault: (modelId) => {
      written = modelId;
    },
  };
}
const membersOf = (opened: readonly { chat: SettingsPort }[]): ModelsSettingsPort => {
  const models = opened.at(-1)?.chat.models;
  if (models === undefined) throw new Error('no /models member was opened');
  return models;
};

/** A chat session whose first line ends it (as `/exit` does): the Home comes back from it once that line is processed. */
function endingSession(): HomeChatSession {
  let stopped = false;
  return {
    store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
    sessionId: 'sess-ending',
    processLine: () => {
      stopped = true;
      return Promise.resolve();
    },
    shouldStop: () => stopped,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  };
}

describe('the status facts are read at construction and at the events, and published only when they differ', () => {
  it('reads once when the controller is built and holds what it read', () => {
    const facts = reader();
    const { c } = home({ statusFacts: { read: facts.read } });
    expect(facts.read).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().status).toEqual(FIRST);
  });

  it('a controller with no reader has no status and reads nothing', () => {
    const { c } = home();
    expect(c.getSnapshot().status).toBeUndefined();
  });

  it('is NOT read when the Home draws: keys, a resize and a long run of frames do not touch it', async () => {
    const facts = reader();
    const { c } = home({ statusFacts: { read: facts.read } });
    let size = { cols: 100, rows: 30 };
    let resize: () => void = () => {};
    render(
      <RootApp
        controller={c}
        nowMs={() => 0}
        color={false}
        getSize={() => size}
        subscribeResize={(cb) => {
          resize = cb;
          return () => {};
        }}
        alternateScreen
      />,
    );
    await settleFrames();
    type(c, 'hello there');
    c.handleKey('', { backspace: true });
    size = { cols: 80, rows: 24 };
    resize();
    c.handleKey('/', {});
    c.handleKey('', { escape: true });
    for (let n = 0; n < 5; n += 1) await settleFrames();
    expect(facts.read, 'draws read nothing').toHaveBeenCalledTimes(1);
  });

  it('a provider state change reads it again, and a change is shown', () => {
    const facts = reader();
    const { c } = home({ statusFacts: { read: facts.read } });
    facts.set(SECOND);
    c.setProviderState(false);
    expect(facts.read).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot().status).toEqual(SECOND);
  });

  it('a re-read that finds the same facts keeps the very object the Home has (nothing repaints for it)', () => {
    const facts = reader();
    const { c } = home({ statusFacts: { read: facts.read } });
    const before = c.getSnapshot().status;
    c.setProviderState(false);
    c.setProviderState(true);
    expect(facts.read).toHaveBeenCalledTimes(3);
    expect(c.getSnapshot().status).toBe(before);
  });

  it('the `/models` default of new chats reads it again when the write is over', async () => {
    const facts = reader();
    const { c, opened } = home({ statusFacts: { read: facts.read }, models: modelsPort() });
    type(c, '/models');
    c.handleKey('', ENTER);
    facts.set(SECOND); // what the write changed
    const reads = facts.read.mock.calls.length;
    await membersOf(opened).saveDefault?.({
      modelId: 'gpt-5',
      provider: 'openai',
      reasoningEffort: 'high',
    });
    expect(facts.read).toHaveBeenCalledTimes(reads + 1);
    expect(c.getSnapshot().status, 'the model, its provider and its effort tier').toEqual(SECOND);
    expect(c.getSnapshot().submitBusy).toBe(false);
  });

  it('the `/mode` default of new chats reads it again when its popup is over, however it ended', async () => {
    for (const outcome of ['resolves', 'rejects'] as const) {
      const facts = reader();
      const openModeSettings = vi.fn(() =>
        outcome === 'resolves'
          ? Promise.resolve(undefined)
          : Promise.reject(new Error('the card failed')),
      );
      const { c } = home({ statusFacts: { read: facts.read }, openModeSettings });
      type(c, '/mode');
      c.handleKey('', ENTER);
      facts.set({ ...FIRST, mode: 'plan' });
      await flush();
      expect(openModeSettings, outcome).toHaveBeenCalledOnce();
      expect(facts.read, outcome).toHaveBeenCalledTimes(2);
      expect(c.getSnapshot().status?.mode, outcome).toBe('plan');
    }
  });

  it('a chat that ends reads it again: what the chat saved as the default is what the returned Home says', async () => {
    const facts = reader();
    const { c } = home({
      statusFacts: { read: facts.read },
      startChat: () => Promise.resolve(endingSession()),
    });
    type(c, 'hello');
    c.handleKey('', ENTER);
    facts.set({ ...FIRST, model: 'claude-opus-4-8' }); // saved from the chat's own `/models`, which the Home does not see
    await flush();
    await flush();
    expect(c.getSnapshot().mode).toBe('home');
    expect(facts.read).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot().status?.model).toBe('claude-opus-4-8');
  });

  it('is not read while a chat is live: a provider state change under a conversation leaves the facts, and its end reads them', async () => {
    const facts = reader();
    const live: HomeChatSession = { ...endingSession(), shouldStop: () => false };
    const { c } = home({
      statusFacts: { read: facts.read },
      startChat: () => Promise.resolve(live),
    });
    type(c, 'hello');
    c.handleKey('', ENTER);
    await flush();
    await flush();
    expect(c.getSnapshot().mode).toBe('chat');
    facts.set(SECOND);
    c.setProviderState(false);
    expect(facts.read, 'no configuration read under a live conversation').toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().status).toEqual(FIRST);
  });

  it('a read that throws drops the facts the Home had (and one that throws at construction leaves none), and never throws', () => {
    const throwing = vi.fn((): HomeStatusFacts => {
      throw new Error('the configuration does not parse');
    });
    expect(() => home({ statusFacts: { read: throwing } })).not.toThrow();
    expect(home({ statusFacts: { read: throwing } }).c.getSnapshot().status).toBeUndefined();

    let broken = false;
    const sometimes = vi.fn((): HomeStatusFacts => {
      if (broken) throw new Error('the configuration does not parse now');
      return FIRST;
    });
    const { c } = home({ statusFacts: { read: sometimes } });
    broken = true;
    expect(() => {
      c.setProviderState(false);
    }).not.toThrow();
    // MVP-11 unit 7, round 1 (SE72): the facts it had may no longer be what the next chat uses, so the line says nothing until a read succeeds.
    expect(c.getSnapshot().status, 'the line no longer says what it said').toBeUndefined();
  });
});

describe('the status line as the Home draws it', () => {
  const frameOf = (facts: HomeStatusFacts, size = { cols: 80, rows: 24 }): string[] => {
    const { c } = home({ statusFacts: { read: () => facts } });
    const harness = render(
      <RootApp
        controller={c}
        nowMs={() => 0}
        color={false}
        getSize={() => size}
        subscribeResize={() => () => {}}
        alternateScreen
      />,
    );
    return (harness.lastFrame() ?? '').split('\n');
  };
  // eslint-disable-next-line no-control-regex -- the escape that starts a styling sequence
  const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/gu, '');
  /** The status row: the row under the rule. */
  const statusRow = (rows: readonly string[]): string => {
    const rule = rows.findIndex((row) => /^ +-{20,}$/u.test(plain(row)));
    return plain(rows[rule + 1] ?? '');
  };

  it('says what the next chat will use and where it works: provider, model and mode with no label, the directory plainly after a gap', () => {
    expect(statusRow(frameOf(FIRST)).trim()).toBe(
      'anthropic · claude-haiku-5-5 · ask mode   ~/acme-web',
    );
    expect(
      statusRow(
        frameOf({ ...FIRST, mode: 'auto', effort: 'high' }, { cols: 100, rows: 30 }),
      ).trim(),
    ).toBe('anthropic · claude-haiku-5-5 · auto mode · effort high   ~/acme-web');
  });

  it('draws a provider, a model and a directory that are hostile as text and nothing else, in one row inside the width', () => {
    const bidi = String.fromCharCode(0x202e);
    const lineSeparator = String.fromCharCode(0x2028);
    const nextLine = String.fromCharCode(0x85);
    const rows = frameOf({
      provider: `anthropic · auto mode\u001b]52;c;QUJD\u0007${bidi}`,
      model: `m${bidi}${'x'.repeat(10_000)}\u001b[2J`,
      mode: 'ask',
      directory: `~/a · b${nextLine}${lineSeparator}\u001b]8;;http://x\u0007c`,
    });
    const raw = rows.join('\n');
    // eslint-disable-next-line no-control-regex -- looking for what must not be there
    expect(raw).not.toMatch(/\u001b\](?:8|52)|\u001b\[2J|\u0007/u);
    const hostile = new Set([
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
    ]);
    for (const code of [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x85, 0x2028, 0x2029])
      hostile.add(code);
    expect(
      [...raw].filter((ch) => hostile.has(ch.codePointAt(0) ?? 0)),
      'no bidirectional, zero-width or line-separator character reaches the terminal',
    ).toEqual([]);
    const row = statusRow(rows);
    expect(row.trimEnd().length, 'one row, inside 80 columns').toBeLessThanOrEqual(80);
    expect(row, 'the mode is never cut').toContain('ask mode');
    // The separator inside a value is inert: the line has its fields (the label's group of three, then the gap), no more.
    expect(row.match(/ · /gu)?.length ?? 0).toBeLessThanOrEqual(2);
  });
});
