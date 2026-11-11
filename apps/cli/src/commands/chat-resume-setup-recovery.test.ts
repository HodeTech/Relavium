import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { ProviderResolver } from '../engine/providers.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { chatCommand, chatResumeCommand, type ChatDriver } from './chat.js';

const inert = {
  writeControl: () => {},
  lifecycle: {
    onProcessExit: () => () => {},
    onTerminationSignal: () => () => {},
    onInterrupt: () => () => {},
    setRawMode: () => {},
    exit: () => {},
  },
  jobControlLifecycle: {
    supported: false,
    onSuspend: () => () => {},
    onContinue: () => () => {},
    suspendSelf: () => {},
  },
};

describe('interactive resume after skipped credential setup', () => {
  let root: string;
  let cwd: string;
  let client: DbClient;
  let global: GlobalOptions;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-resume-setup-'));
    cwd = realpathSync(root);
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    client = createClient(':memory:');
    runMigrations(client.db);
    global = {
      cwd,
      configPath: undefined,
      color: false,
      json: false,
      noAltScreen: true,
      verbosity: 'normal',
    };
  });
  afterEach(() => {
    client.sqlite.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  async function seed() {
    const store = createSessionStore(client.db);
    const { io } = captureIo();
    const drive: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      await ctx.processLine('seeded prompt', 'seeded prompt');
      await ctx.processLine('/exit');
      return { kind: ctx.stopReason() };
    };
    expect(
      await chatCommand(
        { agent: undefined },
        {
          ...inert,
          global,
          io,
          drive,
          providers: scriptedResolver([textTurn('seeded answer')]),
          openSessionStore: () => ({ store, db: client.db, close: () => {} }),
        },
      ),
    ).toBe(4);
    const record = store.listSessions()[0];
    if (record === undefined) throw new Error('No seeded session');
    return { store, record };
  }

  it.each(['cancelled', 'deferred'] as const)(
    '%s opens the guarded saved session, refuses keyless sends and accepts a later key',
    async (status) => {
      const { store, record } = await seed();
      const captured = captureIo();
      let hasKey = false;
      let calls = 0;
      const scripted = scriptedResolver([textTurn('continued answer')]);
      const providers: ProviderResolver = {
        ...scripted,
        hasKey: () => hasKey,
        resolveProvider: (id) => {
          const adapter = scripted.resolveProvider(id);
          return adapter === undefined
            ? undefined
            : {
                ...adapter,
                stream: (request, signal) => {
                  calls++;
                  return adapter.stream(request, signal);
                },
              };
        },
      };
      const setup = vi.fn(() => Promise.resolve({ status, changed: false }));
      const close = vi.fn();
      const drive = vi.fn<ChatDriver>(async (ctx) => {
        ctx.startSession();
        await ctx.onActivated?.(() => !ctx.shouldStop());
        expect(setup).toHaveBeenCalledOnce();
        expect(
          ctx.store
            .getSnapshot()
            .state.transcript.some(
              (entry) => entry.role === 'notice' && entry.text.includes('/models'),
            ),
        ).toBe(true);
        const prior = store.loadFull(record.id)?.messages;
        await ctx.processLine('must stay unsent', 'must stay unsent');
        await ctx.processLine('/compact');
        expect(calls).toBe(0);
        expect(store.loadFull(record.id)?.messages).toEqual(prior);
        hasKey = true;
        await ctx.processLine('continued prompt', 'continued prompt');
        expect(calls).toBe(1);
        await ctx.processLine('/exit');
        return { kind: ctx.stopReason() };
      });
      expect(
        await chatResumeCommand(
          { sessionId: record.id },
          {
            ...inert,
            global,
            io: { ...captured.io, stdoutIsTty: true },
            drive,
            resolveKeys: () => ({ providers, prepareInteractiveSetup: setup }),
            openSessionStore: () => ({ store, db: client.db, close }),
          },
        ),
      ).toBe(4);
      expect(drive).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      const restored = store.loadFull(record.id);
      expect(restored?.session.agentSnapshot?.model).toBe(record.agentSnapshot?.model);
      const userTexts = restored?.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content);
      expect(userTexts).not.toContainEqual([{ type: 'text', text: 'must stay unsent' }]);
      expect(userTexts).toContainEqual([{ type: 'text', text: 'continued prompt' }]);
    },
  );

  it.each([false, true])(
    'keeps keyless machine resume refused without setup or host activation (json=%s)',
    async (json) => {
      const { store, record } = await seed();
      const captured = captureIo();
      const providers: ProviderResolver = { ...scriptedResolver([]), hasKey: () => false };
      const setup = vi.fn(() => Promise.resolve({ status: 'cancelled' as const, changed: false }));
      const drive = vi.fn<ChatDriver>();
      const close = vi.fn();
      await expect(
        chatResumeCommand(
          { sessionId: record.id },
          {
            ...inert,
            global: { ...global, json },
            io: captured.io,
            drive,
            resolveKeys: () => ({ providers, prepareInteractiveSetup: setup }),
            openSessionStore: () => ({ store, db: client.db, close }),
          },
        ),
      ).rejects.toMatchObject({ code: 'invalid_invocation' });
      expect(setup).not.toHaveBeenCalled();
      expect(drive).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(captured.out()).toBe('');
    },
  );
});
