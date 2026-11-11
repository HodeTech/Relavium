import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import type { LlmProvider } from '@relavium/llm';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildChatSession, buildResumedChatSession } from '../chat/session-host.js';
import { scriptedProvider, textTurn } from '../chat/test-support.js';
import { writeGlobalPreferences } from '../config/write.js';
import {
  createProviderResolver,
  providerHasKey,
  type ProviderResolver,
} from '../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import { CliError } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { chatCommand, chatResumeCommand, type ChatCommandDeps, type ChatDriver } from './chat.js';

const INERT = {
  writeControl: () => undefined,
  lifecycle: {
    onProcessExit: () => () => undefined,
    onTerminationSignal: () => () => undefined,
    onInterrupt: () => () => undefined,
    setRawMode: () => undefined,
    exit: () => undefined,
  },
  jobControlLifecycle: {
    supported: false,
    onSuspend: () => () => undefined,
    onContinue: () => () => undefined,
    suspendSelf: () => undefined,
  },
};
const first = ['synthetic', 'source', 'first'].join('-');
const second = ['synthetic', 'source', 'second'].join('-');
const exitDriver: ChatDriver = async (ctx) => {
  ctx.startSession();
  await ctx.onActivated?.(() => !ctx.shouldStop());
  await ctx.processLine('/exit');
  return { kind: ctx.stopReason() };
};

describe('standalone chat credential setup integration', () => {
  let root: string;
  let cwd: string;
  let selected: string;
  let client: DbClient;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-chat-setup-'));
    cwd = join(realpathSync(root), 'project');
    mkdirSync(cwd);
    selected = join(root, 'selected.toml');
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(options: { projectModel?: string; ephemeral?: boolean } = {}) {
    if (options.projectModel !== undefined) {
      mkdirSync(join(cwd, '.relavium'));
      writeFileSync(
        join(cwd, '.relavium', 'project.toml'),
        `[chat]\ndefault_model = "${options.projectModel}"\ndefault_provider = "openai"\n`,
      );
    }
    const global: GlobalOptions = {
      cwd,
      configPath: selected,
      json: false,
      color: false,
      noAltScreen: true,
      verbosity: 'normal',
    };
    const captured = captureIo();
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: first };
    const keys: string[] = [];
    const base = scriptedProvider([textTurn('first answer'), textTurn('second answer')], 'openai');
    const adapter: LlmProvider = {
      ...base,
      stream: (request, key, work) => {
        keys.push(key);
        return base.stream(request, key, work);
      },
    };
    const store = createSessionStore(client.db);
    const close = vi.fn();
    const open = vi.fn(() => ({ store, db: client.db, close }));
    let providers: ProviderResolver | undefined;
    const setup = vi.fn((_lifetime: unknown, liveDb: DbClient['db'] | undefined) => {
      expect(liveDb).toBe(client.db);
      expect(open).toHaveBeenCalled();
      expect(providers).toBeDefined();
      expect(() => providers?.keyFor('openai')).toThrow('has not been allowed');
      policy?.allowForInvocation('openai');
      if (options.ephemeral !== true)
        writeGlobalPreferences(
          { defaultModel: 'gpt-starter-fixture', defaultProvider: 'openai' },
          root,
          selected,
        );
      return Promise.resolve({
        status: 'ready' as const,
        changed: true,
        ...(options.ephemeral === true
          ? { ephemeralDefault: { model: 'gpt-ephemeral-fixture', provider: 'openai' as const } }
          : {}),
      });
    });
    let policy: ReturnType<typeof createStandardEnvKeyPolicy> | undefined;
    const resolveKeys: NonNullable<ChatCommandDeps['resolveKeys']> = (db, loaded) => {
      expect(loaded?.globalConfigPath).toBe(selected);
      if (db === undefined) expect(open).not.toHaveBeenCalled();
      else expect(db).toBe(client.db);
      policy = createStandardEnvKeyPolicy(loaded?.globalConfig?.preferences);
      const actual = createProviderResolver(env, undefined, {
        standardEnvPolicy: policy,
        credentialSurface: 'standalone-chat',
      });
      providers = { ...actual, resolveProvider: (id) => (id === 'openai' ? adapter : undefined) };
      return { providers, prepareInteractiveSetup: setup };
    };
    const deps: ChatCommandDeps = {
      ...INERT,
      io: { ...captured.io, env, stdoutIsTty: true },
      global,
      resolveKeys,
      openSessionStore: open,
      drive: exitDriver,
    };
    return { deps, store, close, open, setup, keys, env, providers: () => providers };
  }

  it.each([false, true])(
    'reloads fresh saved/ephemeral defaults before host construction and retains project model override (ephemeral=%s)',
    async (ephemeral) => {
      for (const projectModel of [undefined, 'gpt-project-fixture']) {
        // Separate cases share only the in-memory DB; each setup invocation has its own policy/default binding.
        if (projectModel === undefined) rmSync(selected, { force: true });
        const f = fixture({ ephemeral, ...(projectModel === undefined ? {} : { projectModel }) });
        const seen: string[] = [];
        const build: typeof buildChatSession = (options) => {
          expect(f.setup).toHaveBeenCalledOnce();
          seen.push(options.chat.defaultModel ?? 'none');
          return buildChatSession(options);
        };
        expect(await chatCommand({ agent: undefined }, { ...f.deps, buildSession: build })).toBe(4);
        expect(seen).toEqual([
          projectModel ?? (ephemeral ? 'gpt-ephemeral-fixture' : 'gpt-starter-fixture'),
        ]);
        expect(f.open).toHaveBeenCalledOnce();
        expect(f.close).toHaveBeenCalledOnce();
        if (projectModel !== undefined)
          expect(readFileSync(join(cwd, '.relavium', 'project.toml'), 'utf8')).toContain(
            projectModel,
          );
      }
    },
  );

  it.each(['clear', 'reseat'] as const)(
    'reuses the authorized source and reads current credentials across actual %s hosts',
    async (swap) => {
      const f = fixture({ ephemeral: swap === 'clear' });
      let round = 0;
      const drive: ChatDriver = async (ctx) => {
        ctx.startSession();
        await ctx.onActivated?.(() => !ctx.shouldStop());
        if (round++ === 0) {
          await ctx.processLine('first');
          f.env['OPENAI_API_KEY'] = second;
          if (swap === 'clear') await ctx.processLine('/clear');
          else {
            if (ctx.onReseat === undefined) throw new Error('missing reseat port');
            ctx.onReseat({ modelId: 'gpt-reseat-fixture', provider: 'openai' });
          }
        } else {
          await ctx.processLine('second');
          await ctx.processLine('/exit');
        }
        return { kind: ctx.stopReason() };
      };
      expect(await chatCommand({ agent: undefined }, { ...f.deps, drive })).toBe(4);
      expect(f.setup).toHaveBeenCalledOnce();
      expect(f.keys).toEqual([first, second]);
      expect(f.open).toHaveBeenCalledOnce();
      expect(f.close).toHaveBeenCalledOnce();
      const providers = f.providers();
      if (providers === undefined) throw new Error('missing fixture resolver');
      expect(providerHasKey(providers, 'openai')).toBe(true);
    },
  );

  it.each([
    { tty: false, json: false, ci: false },
    { tty: true, json: true, ci: false },
    { tty: true, json: false, ci: true },
  ])('does not invoke setup on a machine path %j', async ({ tty, json, ci }) => {
    const f = fixture();
    const machine = createProviderResolver({ OPENAI_API_KEY: first });
    const provider = scriptedProvider([], 'openai');
    const resolveKeys = vi.fn(() => ({
      providers: { ...machine, resolveProvider: () => provider },
      prepareInteractiveSetup: f.setup,
    }));
    expect(
      await chatCommand(
        { agent: undefined },
        {
          ...f.deps,
          global: { ...f.deps.global, json },
          io: { ...f.deps.io, stdoutIsTty: tty, env: ci ? { CI: 'true' } : {} },
          resolveKeys,
        },
      ),
    ).toBe(4);
    expect(f.setup).not.toHaveBeenCalled();
    expect(machine.keyFor('openai')).toBe(first);
  });

  it('closes its early shared DB after setup cancellation refuses fresh host construction', async () => {
    const f = fixture();
    const keyless = createProviderResolver({}, undefined, {
      standardEnvPolicy: createStandardEnvKeyPolicy(),
    });
    const setup = vi.fn(() => Promise.resolve({ status: 'cancelled' as const, changed: false }));
    await expect(
      chatCommand(
        { agent: undefined },
        { ...f.deps, resolveKeys: () => ({ providers: keyless, prepareInteractiveSetup: setup }) },
      ),
    ).rejects.toThrow('no API key');
    expect(setup).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('keeps resumed saved agent/model even when first-run setup saves a different starter default', async () => {
    const f = fixture();
    // A real completed session establishes its saved original workspace and frozen bound agent.
    const initial = createProviderResolver({ RELAVIUM_OPENAI_API_KEY: first });
    const scripted = scriptedProvider([textTurn('seed')], 'openai');
    const model = 'gpt-saved-fixture';
    writeGlobalPreferences({ defaultModel: model, defaultProvider: 'openai' }, root, selected);
    expect(
      await chatCommand(
        { agent: undefined },
        {
          ...f.deps,
          resolveKeys: () => ({}),
          providers: { ...initial, resolveProvider: () => scripted },
          drive: async (ctx) => {
            ctx.startSession();
            await ctx.onActivated?.(() => !ctx.shouldStop());
            await ctx.processLine('seed');
            await ctx.processLine('/exit');
            return { kind: ctx.stopReason() };
          },
        },
      ),
    ).toBe(4);
    const saved = f.store.listSessions()[0];
    if (saved === undefined) throw new Error('missing seeded session');
    const seen: string[] = [];
    expect(
      await chatResumeCommand(
        { sessionId: saved.id },
        {
          ...f.deps,
          buildResumedSession: (options) => {
            seen.push(options.record.agentSnapshot?.model ?? 'missing');
            expect(f.setup).toHaveBeenCalledOnce();
            return buildResumedChatSession(options);
          },
        },
      ),
    ).toBe(4);
    expect(seen).toEqual([model]);
  });

  it('refuses credential construction before opening fresh interactive history', async () => {
    const f = fixture();
    const boundary = new CliError('cli_internal', 'synthetic credential construction refusal');
    const resolveKeys = vi.fn(() => {
      throw boundary;
    });
    await expect(chatCommand({ agent: undefined }, { ...f.deps, resolveKeys })).rejects.toThrow(
      boundary,
    );
    expect(resolveKeys).toHaveBeenCalledOnce();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.setup).not.toHaveBeenCalled();
  });

  it('retains grammar admission before credential factories and early DB acquisition', async () => {
    const f = fixture();
    const resolveKeys = vi.fn(() => {
      throw new CliError('cli_internal', 'should not enter');
    });
    await expect(
      chatCommand(
        { agent: undefined },
        { ...f.deps, global: { ...f.deps.global, allowFsRoots: ['relative-root'] }, resolveKeys },
      ),
    ).rejects.toThrow();
    expect(resolveKeys).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });
});
