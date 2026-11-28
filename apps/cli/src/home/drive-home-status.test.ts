import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { expect, it, vi } from 'vitest';

import {
  buildChatSession,
  type BuildChatSessionOptions,
  type BuiltChatSession,
} from '../chat/session-host.js';
import { DEFAULT_CHAT_MODEL } from '../chat/default-agent.js';
import { KNOWN_PROVIDERS, type ProviderResolver } from '../engine/providers.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { captureIo } from '../test-support.js';
import { driveHome } from './drive-home.js';
import { statusDirectory } from './next-chat-facts.js';

vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({ get: () => null, set: () => undefined, delete: () => false }),
}));

/**
 * The line the real Home shows says what the chat it starts will use ([ADR-0146](../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §2; MVP-11 unit 7, H1). The pure rules are `next-chat-facts.test.ts`; this drives the real `driveHome` over real configuration files, reads the
 * facts the controller it built holds, starts a chat, and compares them with what the session build was given and the agent it bound, so the wire
 * from the configuration to the line, and `startChat`'s own use of the same rule, are held, and a controller test with fake facts proves neither.
 */

interface Host {
  readonly props: RootAppProps;
  readonly cwd: string;
  readonly homeDir: string;
  readonly configPath: string;
  /** What the session build was last given (the starting mode and the `[chat]` settings) and what it bound. */
  readonly build: () => { options: BuildChatSessionOptions; built: BuiltChatSession } | undefined;
}

async function withHome(
  config: string | undefined,
  use: (host: Host) => Promise<void>,
  providers: ProviderResolver = scriptedResolver([textTurn('first')]),
): Promise<void> {
  const f = invocationFixture();
  const client = createClient(':memory:');
  runMigrations(client.db);
  const sessions = createSessionStore(client.db);
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-home-status-')));
  const homeDir = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'relavium-home-status-operator-')),
  );
  const configPath = join(cwd, 'global.toml');
  if (config !== undefined) writeFileSync(configPath, config);
  let props: RootAppProps | undefined;
  let last: { options: BuildChatSessionOptions; built: BuiltChatSession } | undefined;
  let id = 0;
  let finishRender = () => {};
  const exited = new Promise<void>((resolve) => {
    finishRender = resolve;
  });
  const running = driveHome({
    homeDir,
    invocation: f.invocation,
    io: { ...captureIo().io, stdoutIsTty: true, stdinIsTty: true },
    global: { cwd, json: false, color: false, configPath, verbosity: 'normal' },
    providers,
    now: () => Date.parse('2026-11-26T00:00:00.000Z'),
    uuid: () => `home-status-${++id}`,
    buildSession: async (options) => {
      const built = await buildChatSession(options);
      last = { options, built };
      return built;
    },
    openSessionStore: () => ({
      store: sessions,
      db: client.db,
      close: () => client.sqlite.close(),
    }),
    // The real controller and everything it reads; the Home is not drawn here, so nothing opens by itself.
    firstRunSetup: 'off',
    render: (value) => {
      props = value;
      value.onRendererReady?.(async (publish) => {
        await publish?.();
      });
      return {
        unmount: finishRender,
        waitUntilExit: () => exited,
        waitUntilRenderFlush: () => Promise.resolve(),
      };
    },
    getSize: () => ({ cols: 120, rows: 40 }),
    subscribeResize: () => () => {},
    subscribeSignals: () => () => {},
    subscribeProcessExit: () => () => {},
    jobControlLifecycle: {
      supported: false,
      onSuspend: () => () => {},
      onContinue: () => () => {},
      suspendSelf: () => {},
    },
  });
  try {
    if (props === undefined) throw new Error('Expected the Home to be mounted.');
    await use({ props, cwd, homeDir, configPath, build: () => last });
  } finally {
    finishRender();
    await running;
    vi.restoreAllMocks();
    if (client.sqlite.open) client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

/** Type a first message and wait for the chat the Home builds for it. */
async function startChat(
  host: Host,
): Promise<{ options: BuildChatSessionOptions; built: BuiltChatSession }> {
  const { controller } = host.props;
  for (const char of 'hello') controller.handleKey(char, {});
  controller.handleKey('', { return: true });
  await vi.waitFor(() => {
    expect(controller.getSnapshot().session).toBeDefined();
  });
  const build = host.build();
  if (build === undefined) throw new Error('Expected the session build to have run.');
  return build;
}

it('a configured model, provider, effort and mode are the line, and the chat the Home starts is built from the same ones', async () => {
  await withHome(
    '[preferences]\ndefault_model = "gpt-4o"\ndefault_provider = "openai"\nreasoning_effort = "high"\ndefault_mode = "plan"\n',
    async (host) => {
      const facts = host.props.controller.getSnapshot().status;
      expect(facts, 'the controller read its facts before the first paint').toEqual({
        provider: 'openai',
        model: 'gpt-4o',
        mode: 'plan',
        effort: 'high',
        directory: statusDirectory(host.cwd, host.homeDir),
      });
      expect(facts?.directory, 'never absolute').toBe(`…/${basename(host.cwd)}`);
      expect(facts?.directory).not.toContain(host.cwd);
      const { options, built } = await startChat(host);
      expect(options.chat.defaultModel).toBe(facts?.model);
      expect(options.chat.defaultProvider).toBe(facts?.provider);
      expect(options.chat.reasoningEffort).toBe(facts?.effort);
      expect(options.startingMode?.mode).toBe(facts?.mode);
      expect(built.agent.model).toBe(facts?.model);
      expect(built.agent.provider).toBe(facts?.provider);
    },
  );
});

it('with nothing configured the line is the zero-config chat: the first provider with a key and its starter model, in the mode a chat starts in', async () => {
  await withHome(undefined, async (host) => {
    const facts = host.props.controller.getSnapshot().status;
    expect(facts).toMatchObject({ provider: 'anthropic', model: DEFAULT_CHAT_MODEL, mode: 'ask' });
    expect(facts?.effort).toBeUndefined();
    const { options, built } = await startChat(host);
    expect(options.startingMode?.mode).toBe(facts?.mode);
    expect(built.agent.model).toBe(facts?.model);
    expect(built.agent.provider).toBe(facts?.provider);
  });
});

it('a config edited in another terminal leaves the line as it was until an event reads it again, and then it is what the next chat builds (review M5: its own provider, never the startup one)', async () => {
  await withHome(
    '[preferences]\ndefault_model = "gpt-4o"\ndefault_provider = "openai"\n',
    async (host) => {
      const { controller } = host.props;
      expect(controller.getSnapshot().status).toMatchObject({
        provider: 'openai',
        model: 'gpt-4o',
      });
      writeFileSync(host.configPath, '[preferences]\ndefault_model = "claude-sonnet-4-6"\n');
      // Nothing happened that reads it: a stale line, as the reference page says.
      controller.handleKey('x', {});
      expect(controller.getSnapshot().status).toMatchObject({
        provider: 'openai',
        model: 'gpt-4o',
      });
      // A provider state change (a `/providers` run, a key stored) is one of the events that read it again.
      controller.setProviderState(false);
      const facts = controller.getSnapshot().status;
      expect(facts).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
      controller.handleKey('', { backspace: true });
      const { options, built } = await startChat(host);
      expect(options.chat.defaultModel).toBe(facts?.model);
      expect(built.agent.model).toBe(facts?.model);
      expect(built.agent.provider).toBe(facts?.provider);
    },
  );
});

it('with nothing configured and a key for OpenAI alone the line is OpenAI’s starter model, read from the Home’s sample of the keys, and the chat built is the same', async () => {
  // Only OpenAI has a key: the first provider that has one is the default agent's provider (`defaultChatModel`), and the starter table names its model.
  const providers: ProviderResolver = {
    ...scriptedResolver([textTurn('first')], 'openai'),
    hasKey: (id) => id === 'openai',
    keyFor: (id) => {
      if (id !== 'openai') throw new Error('no key');
      return 'test-key';
    },
  };
  await withHome(
    undefined,
    async (host) => {
      const facts = host.props.controller.getSnapshot().status;
      expect(facts).toMatchObject({
        provider: 'openai',
        model: KNOWN_PROVIDERS.openai.starterModel,
      });
      const { built } = await startChat(host);
      expect(built.agent.provider).toBe('openai');
      expect(built.agent.model).toBe(facts?.model);
    },
    providers,
  );
});
