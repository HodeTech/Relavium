import { mkdtempSync, rmSync } from 'node:fs';
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
 * The settings of a chat session ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §6;
 * MVP-11 step 5), as the session's own line handler hands them to the driver: an interactive driver gets the settings port (`/effort`: the bound
 * model's tiers, the tier in force, the session's setter, and the announcement) and the announcer it binds to its channel; a typed
 * `/effort <tier>` applies directly and announces on that channel, writing nothing into the transcript; a plain chat keeps its text byte for
 * byte. A new file: the pinned counts of `chat.test.ts` belong to the causal and secrets controls.
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

describe('the settings a chat session hands its driver', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();
  let run = 0;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-settings-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-settings-home-'));
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

  const transcriptText = (ctx: ChatDriveContext): string =>
    ctx.store
      .getSnapshot()
      .state.transcript.map((entry) => entry.text)
      .join('\n');

  it('an interactive driver gets the port of a stand-alone chat: the bound model’s tiers, the tier in force and the session’s setter', async () => {
    let seen: ChatDriveContext | undefined;
    await chatWith(true, async (ctx) => {
      seen = ctx;
      const settings = ctx.settings;
      expect(settings?.surface).toBe('standalone-chat');
      const effort = settings?.effort;
      if (effort === undefined) throw new Error('no /effort member');
      expect(effort.tiers().length).toBeGreaterThan(1);
      expect(effort.current()).toBeUndefined();
      effort.apply('high');
      expect(effort.current()).toBe('high');
      // The setter is the session's own: the footer's tier moved with it.
      expect(ctx.store.getSnapshot().reasoningEffort).toBe('high');
      await Promise.resolve();
    });
    expect(typeof seen?.setAnnouncer).toBe('function');
  });

  it('its `/mode` member reads the chat’s mode, applies through the session’s one setter (the footer moves) and carries a startup-default writer', async () => {
    await chatWith(true, async (ctx) => {
      const mode = ctx.settings?.mode;
      if (mode === undefined) throw new Error('no /mode member');
      expect(mode.current()).toBe('ask');
      expect(mode.apply('plan')).toBe(true);
      // The setter is the session's own: the status line's mode moved with it, and the member reads it back.
      expect(ctx.store.getSnapshot().mode).toBe('plan');
      expect(mode.current()).toBe('plan');
      expect(typeof mode.saveStartupDefault).toBe('function');
      await Promise.resolve();
    });
  });

  it('its `/permissions` member reads this chat’s lists and its mode now: the project’s remembered commands, this session’s approvals, and the mode in force', async () => {
    await chatWith(true, async (ctx) => {
      const permissions = ctx.settings?.permissions;
      if (permissions === undefined) throw new Error('no /permissions member');
      expect(permissions.port.surface).toBe('chat');
      expect(permissions.port.load()).toEqual({ project: { ok: true, rows: [] }, session: [] });
      expect(permissions.mode()).toBe('ask');
      ctx.onModeChange?.('plan');
      expect(permissions.mode()).toBe('plan');
      await Promise.resolve();
    });
  });

  it('a typed `/effort <tier>` applies and announces on the bound channel, and writes nothing into the transcript', async () => {
    const announced: string[] = [];
    await chatWith(true, async (ctx) => {
      ctx.setAnnouncer?.((text) => announced.push(text));
      const before = transcriptText(ctx);
      await ctx.processLine('/effort high');
      expect(ctx.store.getSnapshot().reasoningEffort).toBe('high');
      await ctx.processLine('/effort high');
      expect(transcriptText(ctx)).toBe(before);
      // The port's own announcement goes the same way.
      ctx.settings?.announce('said through the port');
    });
    expect(announced).toEqual([
      'Reasoning effort: high · applies to the next message',
      'Already at reasoning effort high.',
      'said through the port',
    ]);
  });

  it('with the announcer unbound (the chat unmounted) a typed tier still applies and says nothing anywhere', async () => {
    const announced: string[] = [];
    const { err } = await chatWith(true, async (ctx) => {
      ctx.setAnnouncer?.((text) => announced.push(text));
      ctx.setAnnouncer?.(undefined);
      const before = transcriptText(ctx);
      await ctx.processLine('/effort low');
      expect(ctx.store.getSnapshot().reasoningEffort).toBe('low');
      expect(transcriptText(ctx)).toBe(before);
    });
    expect(announced).toEqual([]);
    expect(err).not.toContain('reasoning effort');
  });

  it('a refused tier still says why in the transcript (a refusal is no residue): the typed path changes only the success line', async () => {
    await chatWith(true, async (ctx) => {
      ctx.setAnnouncer?.(() => undefined);
      await ctx.processLine('/effort ultra');
      expect(transcriptText(ctx)).toContain("/effort: unknown argument 'ultra'");
    });
  });

  it('a plain chat has no settings port and no announcer, and prints the typed tier byte for byte as before', async () => {
    let seen: ChatDriveContext | undefined;
    const { err } = await chatWith(false, async (ctx) => {
      seen = ctx;
      await ctx.processLine('/effort high');
    });
    expect(seen?.settings).toBeUndefined();
    expect(seen?.setAnnouncer).toBeUndefined();
    expect(err).toContain('reasoning effort: high — applies to your next message.\n');
  });
});
