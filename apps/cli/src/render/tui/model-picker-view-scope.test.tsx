import type { ModelCatalogEntry } from '@relavium/llm';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import { createChatStore } from './chat-store.js';
import { RootApp } from './home-app.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeModelsPort,
} from './home-controller.js';
import { settleFrames, waitFor } from './harness-util.js';
import { ModelPickerView } from './model-picker-view.js';
import type { ModelPickerState } from './model-picker.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

afterEach(cleanup);

/**
 * What the `/models` picker says `Enter` does (MVP-11 Step 2 review, C3). The bare Home's picker writes the default of NEXT chats; the picker of
 * a chat that is open (the same view, the live reseat) switches THIS chat's model and writes no default. The title and the footer said
 * `Set your default model` / `Enter set default` in both.
 */

const STATE: ModelPickerState = {
  entries: [],
  filter: '',
  selected: 0,
  loading: false,
  currentDefault: undefined,
  refreshedAt: undefined,
  banner: undefined,
  hint: undefined,
  effortTiers: [],
  phase: 'model',
  effortStep: false,
  pending: undefined,
  effortSelected: 0,
  currentEffort: undefined,
};

describe('ModelPickerView scope', () => {
  it('next-chat: it is the default of new chats, and Enter sets the default', () => {
    const frame =
      render(
        <ModelPickerView state={STATE} color={false} nowMs={0} scope="next-chat" />,
      ).lastFrame() ?? '';
    expect(frame).toContain('Default model for new chats');
    expect(frame).toContain('↑/↓ select · Enter set default · [Ctrl+R] refresh · Esc close');
    expect(frame).not.toContain('Switch this chat');
  });

  it('this-chat: it switches this chat, and Enter switches; no word of a default', () => {
    const frame =
      render(
        <ModelPickerView state={STATE} color={false} nowMs={0} scope="this-chat" />,
      ).lastFrame() ?? '';
    expect(frame).toContain('Switch this chat’s model');
    expect(frame).toContain('↑/↓ select · Enter switch · [Ctrl+R] refresh · Esc close');
    expect(frame).not.toContain('default');
    expect(frame).not.toContain('Enter set');
  });
});

describe('the hosts say which picker it is', () => {
  const snapshot: HomeSnapshot = {
    attention: { gates: [], failedRuns: [] },
    recentSessions: [],
    recentRuns: [],
    recentAgents: [],
    unreadableRunIds: [],
    isEmpty: true,
  };
  const homeStore: HomeStore = { read: () => snapshot };
  const entry: ModelCatalogEntry = {
    modelId: 'model-x',
    provider: 'anthropic',
    displayName: 'Model X',
    pricingSource: 'catalog',
    priceKnown: true,
    available: true,
    deprecated: false,
  };
  const models: HomeModelsPort = {
    load: () => ({ entries: [entry], refreshedAt: undefined }),
    refreshIfStale: () => Promise.resolve(undefined),
    refresh: () => Promise.resolve({ providers: [] }),
    currentDefault: () => undefined,
    currentEffort: () => undefined,
    writeDefault: () => {},
  };
  const session = (): HomeChatSession => ({
    store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
    sessionId: 'sess-scope',
    processLine: async () => {},
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  });
  function mount(c: HomeController): ReturnType<typeof render> {
    return render(
      <RootApp
        controller={c}
        nowMs={() => Date.now()}
        color={false}
        getSize={() => ({ cols: 100, rows: 30 })}
        subscribeResize={() => () => {}}
      />,
    );
  }
  const openPicker = async (c: HomeController, h: ReturnType<typeof render>): Promise<string> => {
    c.handleKey('/', {});
    for (const ch of 'models') c.handleKey(ch, {});
    c.handleKey('', { return: true });
    await waitFor(() => c.getSnapshot().modelPicker !== undefined);
    await settleFrames();
    return h.lastFrame() ?? '';
  };

  it('the bare Home: the picker sets the default of new chats', async () => {
    const c = createHomeController({
      startChat: () => Promise.resolve(session()),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
      models,
    });
    const frame = await openPicker(c, mount(c));
    expect(frame).toContain('Default model for new chats');
    expect(frame).toContain('Enter set default');
  });

  it('a chat the Home hosts: the same picker switches this chat', async () => {
    const c = createHomeController({
      startChat: () => Promise.resolve(session()),
      reseatChat: () => Promise.resolve(session()),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
      models,
    });
    const harness = mount(c);
    c.handleKey('h', {});
    c.handleKey('', { return: true });
    await waitFor(() => c.getSnapshot().mode === 'chat');
    const frame = await openPicker(c, harness);
    expect(frame).toContain('Switch this chat’s model');
    expect(frame).toContain('Enter switch');
    expect(frame).not.toContain('Default model for new chats');
  });
});
