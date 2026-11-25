import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import {
  chatCommand,
  type ChatCommandDeps,
  type ChatDriveContext,
  type ChatDriver,
} from './chat.js';

/**
 * The `/models` member of a stand-alone chat's settings port ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6; MVP-11 step 5), as the session's own line handler hands it to the driver: the session's half (its bound model and provider, its
 * tier and tier setter, the catalog) and the writer of the default of new chats over the chat's native card, which a chat never had; the
 * switch is the host's (`bindModelSwitch`), so the member carries none, and the driver keeps `onReseat` for it. A plain chat has no member
 * and keeps its `/models` sentence, which now names the layer the Home writes. A new file: the pinned counts of `chat.test.ts` belong to the
 * causal and secrets controls.
 */
const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;
const INERT_HOIST = {
  writeControl: (): void => undefined,
  lifecycle: {
    onProcessExit: (): (() => void) => () => undefined,
    onTerminationSignal: (): (() => void) => () => undefined,
    onInterrupt: (): (() => void) => () => undefined,
    setRawMode: (): void => undefined,
    exit: (): void => undefined,
  },
  jobControlLifecycle: {
    supported: false,
    onSuspend: (): (() => void) => () => undefined,
    onContinue: (): (() => void) => () => undefined,
    suspendSelf: (): void => undefined,
  },
} as const;

describe('the /models member a chat session hands its driver', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();
  let run = 0;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-models-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-models-home-'));
    for (const v of HOME_ENV_VARS) {
      savedHome.set(v, process.env[v]);
      process.env[v] = home; // the operator's real home is never read
    }
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
    for (const v of HOME_ENV_VARS) {
      const prev = savedHome.get(v);
      if (prev === undefined) delete process.env[v];
      else process.env[v] = prev;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  /** Run one chat whose driver is `drive`, interactive or plain; returns what the process wrote. */
  async function chatWith(
    interactive: boolean,
    drive: (ctx: ChatDriveContext) => Promise<void>,
  ): Promise<{ readonly err: string; readonly out: string }> {
    const { io, err, out } = captureIo();
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    let id = 0;
    run += 1;
    const driver: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      await drive(ctx);
      return { kind: 'exit' };
    };
    const global: GlobalOptions = {
      json: false,
      color: false,
      cwd,
      configPath: undefined,
      verbosity: 'normal',
    };
    const deps: ChatCommandDeps = {
      io: { ...io, stdoutIsTty: interactive, stdinIsTty: interactive },
      global,
      providers: scriptedResolver([textTurn('unused')]),
      openSessionStore: () => ({
        store: createSessionStore(client.db),
        db: client.db,
        close: () => undefined,
      }),
      drive: driver,
      ...(interactive ? INERT_HOIST : {}),
      now: () => tick++,
      uuid: () => `run${run}-id-${id++}`,
    };
    await chatCommand({ agent: undefined }, deps);
    return { err: err(), out: out() };
  }

  it('an interactive driver gets the session’s half: its bound model and provider, its tier and setter, the catalog, and no switch', async () => {
    let seen: ChatDriveContext | undefined;
    await chatWith(true, async (ctx) => {
      seen = ctx;
      const models = ctx.settings?.models;
      if (models === undefined) throw new Error('no /models member');
      expect(models.scope).toBe('chat');
      // The model the session is bound to: the same the `/effort` member reads.
      expect(models.current()).toBe(ctx.settings?.effort?.model());
      expect(models.current()).toBe('claude-sonnet-4-6');
      expect(models.currentProvider()).toBe('anthropic');
      expect(models.currentEffort()).toBeUndefined();
      models.setEffort?.('high');
      expect(models.currentEffort()).toBe('high');
      expect(ctx.store.getSnapshot().reasoningEffort).toBe('high');
      expect(Array.isArray(models.load().entries)).toBe(true);
      expect(models.providerName('openai')).toBe('OpenAI');
      // The switch is the host's, bound by the host; the driver has the reseat it binds.
      expect(models.switchModel).toBeUndefined();
      expect(typeof ctx.onReseat).toBe('function');
      expect(models.saveDefault).toBeDefined();
      await Promise.resolve();
    });
    expect(seen).toBeDefined();
  });

  it('`New chats` writes the global default through the chat’s own writer, and says it applies (the effective default read again)', async () => {
    await chatWith(true, async (ctx) => {
      const save = ctx.settings?.models?.saveDefault;
      if (save === undefined) throw new Error('no writer');
      // No global config exists yet in this home: it is written with no card (nothing is rewritten).
      await expect(
        save({ modelId: 'claude-opus-4-5', provider: 'anthropic', reasoningEffort: 'high' }),
      ).resolves.toEqual({ kind: 'saved', durability: 'confirmed', effect: 'applies' });
      const written = readFileSync(join(home, '.relavium', 'config.toml'), 'utf8');
      expect(written).toMatch(/default_model = "claude-opus-4-5"/u);
      expect(written).toMatch(/default_provider = "anthropic"/u);
      expect(written).toMatch(/reasoning_effort = "high"/u);
      // The session's own model is untouched: this chat stays.
      expect(ctx.store.getSnapshot().state.model).not.toBe('claude-opus-4-5');
    });
  });

  it('a plain chat has no member, and `/models` says it needs a terminal and names `[preferences].default_model`', async () => {
    let seen: ChatDriveContext | undefined;
    const { err } = await chatWith(false, async (ctx) => {
      seen = ctx;
      await ctx.processLine('/models');
    });
    expect(seen?.settings).toBeUndefined();
    expect(seen?.onReseat).toBeUndefined();
    expect(err).toContain(
      '/models needs an interactive terminal to switch the model live. From a pipe, set `[preferences].default_model` in your config, or run `relavium` (the Home) to change the default.\n',
    );
  });
});
