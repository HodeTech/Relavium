import { describe, expect, it, vi } from 'vitest';
import type { HomeSnapshot } from '../../home/home-store.js';
import {
  CHAT_PALETTE_COMMANDS,
  HOME_CHAT_PALETTE_COMMANDS,
  HOME_PALETTE_COMMANDS,
} from '../../commands/repl-commands.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeModelsPort,
} from './home-controller.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

const snapshot: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(
  options: { keyless?: boolean; open?: () => Promise<void>; models?: HomeModelsPort } = {},
) {
  const open = options.open ?? vi.fn(() => Promise.resolve());
  const c = createHomeController({
    homeStore: { read: () => snapshot },
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => {
      throw new Error('unexpected chat');
    },
    onExit: () => {},
    onError: () => {},
    providerSetup: { initialKeyless: options.keyless ?? true, open },
    ...(options.models === undefined ? {} : { models: options.models }),
  });
  return { c, open };
}

describe('Home provider setup', () => {
  it('exposes provider setup in Home palettes but never standalone chat', () => {
    expect(HOME_PALETTE_COMMANDS.some((item) => item.name === 'providers')).toBe(true);
    expect(HOME_CHAT_PALETTE_COMMANDS.some((item) => item.name === 'providers')).toBe(true);
    expect(CHAT_PALETTE_COMMANDS.some((item) => item.name === 'providers')).toBe(false);
    expect(HOME_PALETTE_COMMANDS.find((item) => item.name === 'providers')?.description).toContain(
      'keys',
    );
  });
  it('opens setup on empty Enter while keyless, gates concurrent input, and uses cached updates', async () => {
    let release = (): void => {};
    const open = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { c } = fixture({ open });
    c.handleKey('', { return: true });
    expect(open).toHaveBeenCalledOnce();
    expect(c.getSnapshot().nativeActionBusy).toBe(true);
    c.handleKey('x', {});
    expect(c.getSnapshot().input.text).toBe('');
    c.setProviderState(false, 'Source consent saved.');
    release();
    await flush();
    expect(c.getSnapshot()).toMatchObject({
      keyless: false,
      nativeActionBusy: false,
      notice: 'Source consent saved.',
    });
  });
  it('runs palette and typed setup, rejects arguments and suggests the nearest name', async () => {
    const { c, open } = fixture();
    c.handleKey('/', {});
    for (const ch of 'login') c.handleKey(ch, {});
    c.handleKey('', { return: true });
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
    c.handlePaste('/providers secret-value');
    c.handleKey('', { return: true });
    expect(c.getSnapshot().notice).toBe('/providers accepts no arguments.');
    expect(c.getSnapshot().notice).not.toContain('secret-value');
    c.handlePaste('/provider');
    c.handleKey('', { return: true });
    expect(c.getSnapshot().notice).toContain('Use /providers');
    expect(open).toHaveBeenCalledTimes(1);
    c.handlePaste('/providers');
    c.handleKey('', { return: true });
    await flush();
    expect(open).toHaveBeenCalledTimes(2);
  });
  it('intercepts /providers in Home chat without sending it as a chat line', async () => {
    const lines: string[] = [];
    const session: HomeChatSession = {
      store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
      sessionId: 'fake',
      processLine: (line) => {
        lines.push(line);
        return Promise.resolve();
      },
      shouldStop: () => false,
      stopReason: () => 'exit',
      teardown: () => Promise.resolve(),
    };
    const open = vi.fn(() => Promise.resolve());
    const c = createHomeController({
      homeStore: { read: () => snapshot },
      doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
      startChat: () => Promise.resolve(session),
      onExit: () => {},
      onError: () => {},
      providerSetup: { initialKeyless: false, open },
    });
    c.handlePaste('hello');
    c.handleKey('', { return: true });
    await flush();
    expect(lines).toEqual(['hello']);
    c.handlePaste('/providers');
    c.handleKey('', { return: true });
    await flush();
    expect(open).toHaveBeenCalledOnce();
    expect(lines).toEqual(['hello']);
  });

  it('samples key availability once on return to Home, not on render or initial chat open', async () => {
    let stop = false;
    const readKeyless = vi.fn(() => true);
    const session: HomeChatSession = {
      store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
      sessionId: 'fake',
      processLine: () => Promise.resolve(),
      shouldStop: () => stop,
      stopReason: () => 'exit',
      teardown: () => Promise.resolve(),
    };
    const c = createHomeController({
      homeStore: { read: () => snapshot },
      doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
      startChat: () => Promise.resolve(session),
      onExit: () => {},
      onError: () => {},
      providerSetup: { initialKeyless: false, open: () => Promise.resolve(), readKeyless },
    });
    c.getSnapshot();
    c.getSnapshot();
    c.handlePaste('hello');
    c.handleKey('', { return: true });
    await flush();
    expect(readKeyless).not.toHaveBeenCalled();
    stop = true;
    c.handlePaste('/exit');
    c.handleKey('', { return: true });
    await flush();
    expect(c.getSnapshot().mode).toBe('home');
    expect(c.getSnapshot().keyless).toBe(true);
    expect(readKeyless).toHaveBeenCalledOnce();
    c.getSnapshot();
    expect(readKeyless).toHaveBeenCalledOnce();
  });

  it('does not publish a late completion after teardown', async () => {
    let release = (): void => {};
    const { c } = fixture({
      open: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    c.handleKey('', { return: true });
    let joined = false;
    const teardown = c.teardownActive().then(() => {
      joined = true;
    });
    const sealed = c.getSnapshot();
    await flush();
    expect(joined).toBe(false);
    release();
    await teardown;
    await flush();
    expect(joined).toBe(true);
    expect(c.getSnapshot()).toBe(sealed);
  });
  it('waits for an asynchronous model save and reports unconfirmed durability', async () => {
    let release: (result: { durability: 'unconfirmed' }) => void = () => {};
    const models: HomeModelsPort = {
      load: () => ({
        entries: [
          {
            modelId: 'model',
            displayName: 'Model',
            provider: 'openai',
            pricingSource: 'catalog',
            priceKnown: true,
            available: true,
            deprecated: false,
          },
        ],
        refreshedAt: undefined,
      }),
      refresh: () => Promise.resolve({ providers: [] }),
      refreshIfStale: () => Promise.resolve(undefined),
      currentDefault: () => 'model',
      currentEffort: () => undefined,
      writeDefault: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    const { c } = fixture({ keyless: false, models });
    c.handleKey('/', {});
    for (const ch of 'models') c.handleKey(ch, {});
    c.handleKey('', { return: true });
    await flush();
    c.handleKey('', { return: true });
    expect(c.getSnapshot().submitBusy).toBe(true);
    expect(c.getSnapshot().notice).toBeUndefined();
    release({ durability: 'unconfirmed' });
    await flush();
    expect(c.getSnapshot().notice).toContain('Crash persistence is unconfirmed');
  });
});
