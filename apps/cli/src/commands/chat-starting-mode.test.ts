import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import type { SessionTurnPolicy } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildChatSession, buildResumedChatSession } from '../chat/session-host.js';
import type { ChatModeSelection } from '../chat/starting-mode.js';
import { scriptedResolver } from '../chat/test-support.js';
import { captureIo } from '../test-support.js';
import { chatCommand, chatResumeCommand, type ChatCommandDeps, type ChatDriver } from './chat.js';

const inertTerminal = {
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

describe('standalone starting mode construction', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-start-mode-work-')));
    home = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-start-mode-home-')));
    for (const key of ['HOME', 'USERPROFILE']) {
      saved.set(key, process.env[key]);
      process.env[key] = home;
    }
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeGlobal(mode: string): void {
    mkdirSync(join(home, '.relavium'), { recursive: true });
    writeFileSync(
      join(home, '.relavium', 'config.toml'),
      `[preferences]\ndefault_mode = "${mode}"\n`,
    );
  }
  function writeProject(mode: string): void {
    mkdirSync(join(cwd, '.relavium'), { recursive: true });
    writeFileSync(join(cwd, '.relavium', 'project.toml'), `[chat]\ndefault_mode = "${mode}"\n`);
  }
  function dependencies(drive: ChatDriver, interactive = true) {
    const { io, err } = captureIo();
    let id = 0;
    const store = createSessionStore(client.db);
    const freshModes: string[] = [];
    const resumedModes: string[] = [];
    const selections: ChatModeSelection[] = [];
    const agentGrants: string[][] = [];
    const policies: (() => SessionTurnPolicy | undefined)[] = [];
    const d: ChatCommandDeps = {
      ...inertTerminal,
      io: { ...io, stdoutIsTty: interactive },
      global: { cwd, json: false, color: false, configPath: undefined, verbosity: 'normal' },
      providers: scriptedResolver([]),
      openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
      uuid: () => `starting-mode-${id++}`,
      drive,
      buildSession: async (options) => {
        freshModes.push(options.startingMode?.mode ?? 'missing');
        if (options.startingMode !== undefined) selections.push(options.startingMode);
        const built = await buildChatSession(options);
        agentGrants.push([...(built.agent.tools ?? [])]);
        const observer = vi.spyOn(built.session, 'setTurnPolicy');
        policies.push(() => observer.mock.calls.at(-1)?.[0]);
        return built;
      },
      buildResumedSession: async (options) => {
        resumedModes.push(options.startingMode?.mode ?? 'missing');
        if (options.startingMode !== undefined) selections.push(options.startingMode);
        const built = await buildResumedChatSession(options);
        agentGrants.push([...(built.agent.tools ?? [])]);
        const observer = vi.spyOn(built.session, 'setTurnPolicy');
        policies.push(() => observer.mock.calls.at(-1)?.[0]);
        return built;
      },
    };
    return { d, err, freshModes, resumedModes, policies, selections, agentGrants };
  }

  it('applies the configured mode to the first interactive footer and session policy', async () => {
    writeGlobal('auto');
    const footer: string[] = [];
    const drive: ChatDriver = async (ctx) => {
      footer.push(ctx.store.getSnapshot().mode);
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      return { kind: 'exit' };
    };
    const { d, freshModes, policies } = dependencies(drive);
    await chatCommand({ agent: undefined }, d);
    expect(freshModes).toEqual(['auto']);
    expect(footer).toEqual(['auto']);
    const policy = policies[0]?.();
    expect(policy?.advertise).toBeUndefined();
    expect(policy?.confirm).toBeTypeOf('function');
    await expect(
      policy?.confirm?.({
        toolId: 'write_file',
        action: 'fs_write',
        preview: { path: 'notes.md' },
        unredactedPreview: { path: 'notes.md' },
      }),
    ).resolves.toEqual({ outcome: 'approve' });
  });

  it('re-reads the workspace at construction after the initial config snapshot', async () => {
    writeGlobal('ask');
    const footer: string[] = [];
    const { d, freshModes, policies } = dependencies(async (ctx) => {
      footer.push(ctx.store.getSnapshot().mode);
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      return { kind: 'exit' };
    });
    await chatCommand(
      { agent: undefined },
      {
        ...d,
        resolveKeys: () => {
          writeProject('plan');
          return {};
        },
      },
    );
    expect(freshModes).toEqual(['plan']);
    expect(footer).toEqual(['plan']);
    expect(policies[0]?.()?.advertise?.('write_file')).toBe(false);
  });

  it('rejects a shadowed invalid repository auto before constructing a session', async () => {
    writeGlobal('ask');
    writeProject('plan');
    writeFileSync(join(cwd, '.relavium', 'workspace.toml'), '[chat]\ndefault_mode = "auto"\n');
    const { d, freshModes } = dependencies(() => Promise.resolve({ kind: 'exit' }));
    await expect(chatCommand({ agent: undefined }, d)).rejects.toThrow();
    expect(freshModes).toEqual([]);
  });

  it.each(['plain', 'json'] as const)(
    'forces %s startup to ask even when the global default is auto',
    async (surface) => {
      writeGlobal('auto');
      const footer: string[] = [];
      const observed: (SessionTurnPolicy | undefined)[] = [];
      let readPolicy: () => SessionTurnPolicy | undefined = () => undefined;
      const drive: ChatDriver = async (ctx) => {
        footer.push(ctx.store.getSnapshot().mode);
        observed.push(readPolicy());
        ctx.startSession();
        await ctx.onActivated?.(() => !ctx.shouldStop());
        ctx.onModeChange?.('auto');
        footer.push(ctx.store.getSnapshot().mode);
        observed.push(readPolicy());
        await ctx.processLine('/mode auto');
        footer.push(ctx.store.getSnapshot().mode);
        observed.push(readPolicy());
        await ctx.processLine('/mode accept-edits');
        footer.push(ctx.store.getSnapshot().mode);
        observed.push(readPolicy());
        ctx.onModeChange?.('plan'); // the next-mode/cycle callback uses the same live control
        footer.push(ctx.store.getSnapshot().mode);
        observed.push(readPolicy());
        return { kind: 'exit' };
      };
      const { d, err, freshModes, policies } = dependencies(drive, surface === 'json');
      readPolicy = () => policies[0]?.();
      await chatCommand(
        { agent: undefined },
        { ...d, global: { ...d.global, json: surface === 'json' } },
      );
      expect(freshModes).toEqual(['ask']);
      expect(footer).toEqual(['ask', 'ask', 'ask', 'ask', 'ask']);
      expect(observed).toHaveLength(5);
      for (const policy of observed) {
        expect(policy?.advertise?.('write_file')).toBe(false);
        await expect(
          policy?.confirm?.({
            toolId: 'write_file',
            action: 'fs_write',
            preview: { path: 'notes.md' },
            unredactedPreview: { path: 'notes.md' },
          }),
        ).resolves.toMatchObject({ outcome: 'reject' });
      }
      expect(err().match(/mode: ask/g)).toHaveLength(2);
      expect(err()).not.toContain('mode: auto');
      expect(err()).not.toContain('mode: accept edits');
    },
  );

  it.each(['auto', 'invalid-mode'])(
    'strictly rejects unsupported repository mode %s',
    async (mode) => {
      writeGlobal('ask');
      writeProject(mode);
      const { d, freshModes } = dependencies(() => Promise.resolve({ kind: 'exit' }));
      await expect(chatCommand({ agent: undefined }, d)).rejects.toThrow();
      expect(freshModes).toEqual([]);
    },
  );

  it('re-reads a narrower mode on clear and refuses a later file-only auto re-admission', async () => {
    writeGlobal('auto');
    const footer: string[] = [];
    const drive: ChatDriver = async (ctx) => {
      footer.push(ctx.store.getSnapshot().mode);
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      if (footer.length === 1) writeGlobal('plan');
      else writeGlobal('auto');
      return { kind: 'clear' };
    };
    const { d, err, freshModes, policies, selections } = dependencies(drive);
    await chatCommand({ agent: undefined }, d);
    expect(freshModes).toEqual(['auto', 'plan']);
    expect(footer).toEqual(['auto', 'plan']);
    expect(policies[1]?.()?.advertise?.('write_file')).toBe(false);
    expect(err()).toContain('could not start a new session after /clear');
    const initial = selections[0];
    expect(initial).toBeDefined();
    if (initial === undefined) throw new Error('missing initial selection');
    expect(() => initial.authority.assertDispatch(initial, 'write_file')).toThrow(/revoked/);
  });

  it('re-reads the workspace mode for a same-terminal model reseat', async () => {
    writeGlobal('ask');
    const footer: string[] = [];
    const drive: ChatDriver = async (ctx) => {
      footer.push(ctx.store.getSnapshot().mode);
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      if (footer.length === 1) {
        writeProject('plan');
        ctx.onReseat?.({ modelId: 'claude-opus-4-8', provider: 'anthropic' });
      }
      return { kind: ctx.stopReason() };
    };
    const { d, freshModes, resumedModes, policies } = dependencies(drive);
    await chatCommand({ agent: undefined }, d);
    expect(freshModes).toEqual(['ask']);
    expect(resumedModes).toEqual(['plan']);
    expect(footer).toEqual(['ask', 'plan']);
    expect(policies[1]?.()?.advertise?.('write_file')).toBe(false);
  });

  it('keeps an explicit current auto choice distinct from a later file change', async () => {
    writeGlobal('plan');
    const footer: string[] = [];
    const drive: ChatDriver = async (ctx) => {
      ctx.startSession();
      footer.push(ctx.store.getSnapshot().mode);
      ctx.onModeChange?.('auto');
      writeGlobal('auto');
      footer.push(ctx.store.getSnapshot().mode);
      await ctx.onActivated?.(() => !ctx.shouldStop());
      return { kind: 'exit' };
    };
    const { d, policies, selections } = dependencies(drive);
    await chatCommand({ agent: undefined }, d);
    expect(footer).toEqual(['plan', 'auto']);
    const selected = selections[0];
    expect(selected?.origin).toBe('configured');
    await expect(
      policies[0]?.()?.confirm?.({
        toolId: 'write_file',
        action: 'fs_write',
        preview: { path: 'notes.md' },
        unredactedPreview: { path: 'notes.md' },
      }),
    ).resolves.toEqual({ outcome: 'approve' });
  });

  it('keeps an authored relavium-chat agent grant unchanged across fresh, clear and reseat', async () => {
    writeGlobal('plan');
    const agentPath = join(cwd, 'authored.agent.yaml');
    writeFileSync(
      agentPath,
      [
        'id: relavium-chat',
        'provider: anthropic',
        'model: claude-sonnet-4-6',
        'system_prompt: Authored agent.',
        'tools:',
        '  - read_file',
        '',
      ].join('\n'),
    );
    let calls = 0;
    const drive: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      calls += 1;
      if (calls === 1) return { kind: 'clear' };
      if (calls === 2) ctx.onReseat?.({ modelId: 'claude-opus-4-8', provider: 'anthropic' });
      return { kind: ctx.stopReason() };
    };
    const { d, freshModes, resumedModes, agentGrants } = dependencies(drive);
    await chatCommand({ agent: agentPath }, d);
    expect(calls).toBe(3);
    expect(freshModes).toEqual(['plan', 'plan']);
    expect(resumedModes).toEqual(['plan']);
    expect(agentGrants).toEqual([['read_file'], ['read_file'], ['read_file']]);
  });

  it('applies a fresh workspace mode when resuming an existing session', async () => {
    writeGlobal('ask');
    const first = dependencies(async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      return { kind: 'exit' };
    });
    await chatCommand({ agent: undefined }, first.d);
    writeProject('plan');
    const footer: string[] = [];
    const resumed = dependencies(async (ctx) => {
      footer.push(ctx.store.getSnapshot().mode);
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      return { kind: 'exit' };
    });
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere);
    await chatResumeCommand(
      { sessionId: 'starting-mode-0' },
      { ...resumed.d, global: { ...resumed.d.global, cwd: elsewhere } },
    );
    expect(resumed.resumedModes).toEqual(['plan']);
    expect(footer).toEqual(['plan']);
    expect(resumed.policies[0]?.()?.advertise?.('write_file')).toBe(false);
  });
});
