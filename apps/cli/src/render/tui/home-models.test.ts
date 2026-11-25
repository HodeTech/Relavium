/**
 * The Home's `/models` ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §6;
 * [ADR-0064](../../../../../docs/decisions/0064-live-model-catalog.md) §10; [ADR-0059](../../../../../docs/decisions/0059-cli-mid-session-model-reseat.md)),
 * at the controller: the routing of the line, the ports the controller builds for the popup (the bare Home's, and the `/models` member of the
 * chat in front) and the Home's writers the popup applies through, which stay the controller's: the default of new chats and the reseat of
 * the chat in front. The popup itself is `popups/models-*.test.ts`; the hosts are `popups/models-hosts.test.tsx`. The cases of the retired
 * picker that are about these writers moved here (`home-controller.test.ts`' `/models picker` block).
 */
import type { ModelCatalogEntry } from '@relavium/llm';
import { describe, expect, it, vi } from 'vitest';

import type { ReseatTarget } from '../../commands/chat.js';
import { ConfigWriteRefusedError } from '../../config/write.js';
import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import { CliError } from '../../process/errors.js';
import {
  MODEL_SWITCH_FAILED,
  type ModelsSettingsPort,
  type SettingsKind,
  type SettingsPort,
} from '../../popups/settings-port.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeControllerDeps,
  type HomeModelsPort,
} from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND, type TranscriptEntry } from './session-view-model.js';

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const homeStore: HomeStore = { read: () => EMPTY };
const ENTER = { return: true } as const;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const entry = (modelId: string, provider: ModelCatalogEntry['provider']): ModelCatalogEntry => ({
  modelId,
  provider,
  displayName: modelId,
  pricingSource: 'catalog',
  priceKnown: true,
  available: true,
  deprecated: false,
});

/** The Home's catalog port: its write recorded and what it comes to as asked; the effective default is the override, else the last write. */
function homeModels(
  options: {
    readonly write?: HomeModelsPort['writeDefault'];
    readonly override?: string;
    readonly readFault?: boolean;
  } = {},
) {
  const writes: Parameters<HomeModelsPort['writeDefault']>[] = [];
  let written: string | undefined;
  const port: HomeModelsPort = {
    load: () => ({ entries: [entry('claude-opus-4-8', 'anthropic')], refreshedAt: undefined }),
    refreshIfStale: () => Promise.resolve(undefined),
    refresh: () => Promise.resolve({ providers: [] }),
    currentDefault: () => {
      if (options.readFault === true) throw new Error('the config does not parse now');
      return options.override ?? written;
    },
    currentEffort: () => 'medium',
    writeDefault: (modelId, provider, effort) => {
      writes.push([modelId, provider, effort]);
      const result = options.write?.(modelId, provider, effort);
      written = modelId;
      return result;
    },
  };
  return { port, writes };
}

/** A Home over `deps`, its `openSettings` recorded, and the line typed and submitted. */
function home(deps: Partial<HomeControllerDeps>) {
  const opened: { command: SettingsKind; chat: SettingsPort }[] = [];
  const c = createHomeController({
    startChat: vi.fn(),
    homeStore,
    onExit: vi.fn(),
    onError: vi.fn(),
    openSettings: (request) => {
      opened.push(request);
    },
    ...deps,
  });
  const typeLine = (line: string): void => {
    for (const ch of line) c.handleKey(ch, {});
    c.handleKey('', ENTER);
  };
  return { c, opened, typeLine };
}

const membersOf = (opened: readonly { chat: SettingsPort }[]): ModelsSettingsPort => {
  const models = opened.at(-1)?.chat.models;
  if (models === undefined) throw new Error('no /models member was opened');
  return models;
};

describe('/models on the bare Home: routed to the popup over the Home’s own port', () => {
  it('a typed bare /models opens it, with the Home’s catalog, its effective default and tier, and the Home’s writer; nothing in the notice', () => {
    const { port } = homeModels({ override: 'claude-opus-4-8' });
    const announce = vi.fn();
    const { c, opened, typeLine } = home({ models: port, announce });
    typeLine('/models');
    expect(opened).toHaveLength(1);
    expect(opened[0]?.command).toBe('models');
    expect(opened[0]?.chat).toMatchObject({ surface: 'home', announce });
    const models = membersOf(opened);
    expect(models.scope).toBe('home');
    expect(models.current()).toBe('claude-opus-4-8');
    expect(models.currentEffort()).toBe('medium');
    expect(models.load().entries.map((row) => row.modelId)).toEqual(['claude-opus-4-8']);
    // On the Home there is no live chat: nothing to switch, no session tier.
    expect(models.switchModel).toBeUndefined();
    expect(models.setEffort).toBeUndefined();
    expect(c.getSnapshot().notice).toBeUndefined();
    expect(c.getSnapshot().input.text).toBe('');
  });

  it('the palette’s /models opens it the same way', () => {
    const { port } = homeModels();
    const { c, opened } = home({ models: port, announce: vi.fn() });
    c.handleKey('/', {});
    for (const ch of 'models') c.handleKey(ch, {});
    c.handleKey('', ENTER);
    expect(opened.map((request) => request.command)).toEqual(['models']);
  });

  it('`/models x` is refused in one line and opens nothing; a Home without the catalog or a channel says /models is unavailable', () => {
    const { port } = homeModels();
    const withArgs = home({ models: port, announce: vi.fn() });
    withArgs.typeLine('/models x');
    expect(withArgs.opened).toEqual([]);
    expect(withArgs.c.getSnapshot().notice).toBe(
      '/models accepts no arguments here. Start a chat to use them.',
    );
    for (const deps of [{ announce: vi.fn() }, { models: port }]) {
      const missing = home(deps);
      missing.typeLine('/models');
      expect(missing.opened).toEqual([]);
      expect(missing.c.getSnapshot().notice).toBe('/models is unavailable here.');
    }
  });
});

describe('the Home’s writer of the default of new chats (the popup hands off to it)', () => {
  it('writes the model, its provider and its tier in one write, gates input while it runs, and says it applies', async () => {
    let release: () => void = () => {};
    const { port, writes } = homeModels({
      write: () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ durability: 'confirmed' });
          };
        }),
    });
    const { c, opened, typeLine } = home({ models: port, announce: vi.fn() });
    typeLine('/models');
    const pending = membersOf(opened).saveDefault?.({
      modelId: 'gpt-5',
      provider: 'openai',
      reasoningEffort: 'high',
    });
    expect(writes).toEqual([['gpt-5', 'openai', 'high']]);
    expect(c.getSnapshot().submitBusy).toBe(true);
    release();
    await expect(pending).resolves.toEqual({
      kind: 'saved',
      durability: 'confirmed',
      effect: 'applies',
    });
    expect(c.getSnapshot().submitBusy).toBe(false);
    expect(c.getSnapshot().notice).toBeUndefined();
  });

  it('a project or workspace that names another model is overridden, never applied; a config that cannot be read back is unknown', async () => {
    const overridden = homeModels({ override: 'claude-opus-4-8' });
    const a = home({ models: overridden.port, announce: vi.fn() });
    a.typeLine('/models');
    await expect(
      membersOf(a.opened).saveDefault?.({ modelId: 'gpt-5', provider: 'openai' }),
    ).resolves.toMatchObject({ kind: 'saved', effect: 'overridden' });
    const unreadable = homeModels({ readFault: true });
    const b = home({ models: unreadable.port, announce: vi.fn() });
    b.typeLine('/models');
    // The popup reads what is in force when it opens; the write's own read back is what fails here.
    await expect(
      membersOf(b.opened).saveDefault?.({ modelId: 'gpt-5', provider: 'openai' }),
    ).resolves.toMatchObject({ kind: 'saved', effect: 'unknown' });
  });

  it('a refused or failed write is said by kind, an unexpected fault is the owner’s first, and the Home takes input again', async () => {
    const failure = vi.fn();
    for (const [cause, reason] of [
      [new ConfigWriteRefusedError(), 'symlink'],
      [new CliError('invalid_invocation', 'Default model change cancelled.'), 'cancelled'],
      [new Error('disk full'), 'failed'],
    ] as const) {
      const { port } = homeModels({ write: () => Promise.reject(cause) });
      const { c, opened, typeLine } = home({
        models: port,
        announce: vi.fn(),
        workOwner: { enter: (operation) => operation(), failure },
      });
      typeLine('/models');
      await expect(
        membersOf(opened).saveDefault?.({ modelId: 'gpt-5', provider: 'openai' }),
      ).resolves.toEqual({ kind: 'refused', reason });
      expect(c.getSnapshot().submitBusy).toBe(false);
    }
    expect(failure).toHaveBeenCalledTimes(3);
  });

  it('a Home that is exiting says nothing and writes nothing', async () => {
    const { port, writes } = homeModels();
    const onExit = vi.fn();
    const { c, opened, typeLine } = home({ models: port, announce: vi.fn(), onExit });
    typeLine('/models');
    const save = membersOf(opened).saveDefault;
    c.handleKey('d', { ctrl: true }); // Ctrl+D on the empty buffer: the Home exits
    expect(onExit).toHaveBeenCalledTimes(1);
    await expect(save?.({ modelId: 'gpt-5', provider: 'openai' })).resolves.toEqual({
      kind: 'refused',
      reason: 'closing',
    });
    expect(writes).toEqual([]);
  });
});

/** A chat session for the Home: its store bound to `model`, its tier setter and its settings port recorded. */
function chatSession(model: string, sessionId = 'sess-A', setter = true) {
  const store = createChatStore(false, { model, transcript: [] }, INLINE_TRANSCRIPT_BOUND);
  store.setReasoningEffort('low');
  const onSetEffort = vi.fn();
  const teardown = vi.fn(() => Promise.resolve());
  const announce = vi.fn();
  const lines: string[] = [];
  const session: HomeChatSession = {
    store,
    sessionId,
    processLine: (line) => {
      lines.push(line);
      return Promise.resolve();
    },
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown,
    ...(setter ? { onSetEffort } : {}),
    settings: { surface: 'home-chat', announce },
  };
  return { session, store, onSetEffort, teardown, announce, lines };
}

async function inChat(deps: Partial<HomeControllerDeps>, session: HomeChatSession) {
  const h = home({ startChat: () => Promise.resolve(session), ...deps });
  h.typeLine('hi');
  await flush();
  expect(h.c.getSnapshot().mode).toBe('chat');
  return h;
}

describe('/models in a chat the Home hosts: the chat’s member, the Home’s reseat', () => {
  it('routes the chat’s bare /models to the popup with a member over the Home’s catalog and the chat’s own model and tier', async () => {
    const a = chatSession('claude-opus-4-8');
    const { port } = homeModels();
    const reseatChat = vi.fn(() => new Promise<HomeChatSession>(() => {}));
    const { opened, typeLine } = await inChat({ models: port, reseatChat }, a.session);
    typeLine('/models');
    expect(opened.map((request) => request.command)).toEqual(['models']);
    expect(opened[0]?.chat.surface).toBe('home-chat');
    const models = membersOf(opened);
    expect(models.scope).toBe('chat');
    expect(models.current()).toBe('claude-opus-4-8');
    expect(models.currentEffort()).toBe('low');
    models.setEffort?.('high');
    expect(a.onSetEffort).toHaveBeenCalledWith('high');
    expect(a.lines).toEqual(['hi']);
  });

  it('`This chat` reseats the chat in front with its rendered transcript, and swaps it in (the marker is the reseat’s)', async () => {
    const a = chatSession('claude-opus-4-8');
    a.store.appendUser('what is 2+2');
    const b = chatSession('gpt-5');
    const notice = vi.spyOn(b.store, 'notice');
    const reseatChat = vi.fn<
      (
        id: string,
        target: ReseatTarget,
        carried: readonly TranscriptEntry[],
      ) => Promise<HomeChatSession>
    >(() => Promise.resolve(b.session));
    const { c, opened, typeLine } = await inChat(
      { models: homeModels().port, reseatChat },
      a.session,
    );
    typeLine('/models');
    const carried = a.store.getSnapshot().state.transcript;
    membersOf(opened).switchModel?.({
      modelId: 'gpt-5',
      provider: 'openai',
      reasoningEffort: 'high',
    });
    await flush();
    expect(reseatChat).toHaveBeenCalledWith(
      'sess-A',
      { modelId: 'gpt-5', provider: 'openai', reasoningEffort: 'high' },
      carried,
    );
    expect(carried).not.toHaveLength(0);
    expect(a.teardown).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().session).toBe(b.session);
    expect(c.getSnapshot().mode).toBe('chat');
    expect(
      notice.mock.calls.map((call) => call[0]).some((line) => line.includes('model changed')),
    ).toBe(true);
  });

  it('a reseat whose build fails says so on the Home’s channel, never in the transcript, and the chat stays, taking input', async () => {
    const a = chatSession('claude-opus-4-8');
    const note = vi.spyOn(a.store, 'note');
    const announce = vi.fn();
    const { c, opened, typeLine } = await inChat(
      {
        models: homeModels().port,
        reseatChat: () => Promise.reject(new Error('the build failed')),
        announce,
      },
      a.session,
    );
    typeLine('/models');
    membersOf(opened).switchModel?.({ modelId: 'gpt-5', provider: 'openai' });
    await flush();
    expect(announce).toHaveBeenCalledWith(MODEL_SWITCH_FAILED);
    expect(note).not.toHaveBeenCalled();
    expect(a.teardown).not.toHaveBeenCalled();
    expect(c.getSnapshot().session).toBe(a.session);
    expect(c.getSnapshot().submitBusy).toBe(false);
  });

  it('`New chats` is the Home’s own writer of the default', async () => {
    const a = chatSession('claude-opus-4-8');
    const { port, writes } = homeModels();
    const { opened, typeLine } = await inChat(
      { models: port, reseatChat: () => new Promise<HomeChatSession>(() => {}) },
      a.session,
    );
    typeLine('/models');
    await expect(
      membersOf(opened).saveDefault?.({ modelId: 'gpt-5', provider: 'openai' }),
    ).resolves.toMatchObject({ kind: 'saved' });
    expect(writes).toEqual([['gpt-5', 'openai', undefined]]);
  });

  it('a Home with no catalog or no reseat builder, or a chat with no tier setter, has no /models popup: the line is dispatched', async () => {
    for (const [deps, setter] of [
      [{ reseatChat: () => new Promise<HomeChatSession>(() => {}) }, true],
      [{ models: homeModels().port }, true],
      [
        { models: homeModels().port, reseatChat: () => new Promise<HomeChatSession>(() => {}) },
        false,
      ],
    ] as const) {
      const a = chatSession('claude-opus-4-8', 'sess-A', setter);
      const { opened, typeLine } = await inChat(deps, a.session);
      typeLine('/models');
      await flush();
      expect(opened).toEqual([]);
      expect(a.lines).toContain('/models');
    }
  });
});
