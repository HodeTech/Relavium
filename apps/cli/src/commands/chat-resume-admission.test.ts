import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createProviderStore, createSessionStore, runMigrations } from '@relavium/db';
import { AgentSchema } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';
import { SessionChatLifetime } from '../chat/session-chat-lifetime.js';
import { loadResolvedConfig } from '../config/load.js';
import { createProviderResolver } from '../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { chatResumeCommand, type ChatResumeCommandDeps } from './chat.js';
import { runStandaloneProviderSetup } from './standalone-provider-setup.js';

const lifecycle = {
  onInterrupt: () => () => {},
  onTerminationSignal: () => () => {},
  onProcessExit: () => () => {},
  setRawMode: () => {},
  exit: () => {},
};

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-resume-admission-')));
  const client = createClient(':memory:');
  runMigrations(client.db);
  const store = createSessionStore(client.db);
  const f = invocationFixture();
  const captured = captureIo();
  const global = {
    cwd: root,
    configPath: join(root, 'absent.toml'),
    json: false,
    color: false,
    noAltScreen: true,
    verbosity: 'normal' as const,
  };
  const policy = createStandardEnvKeyPolicy();
  const afterStop = vi.fn();
  const keychain = {
    get: vi.fn(() => {
      if (f.registry.termination !== undefined) afterStop();
      return 'synthetic-test-credential';
    }),
    set: () => {},
    delete: () => false,
  };
  const resolver = createProviderResolver({}, keychain, {
    standardEnvPolicy: policy,
    credentialSurface: 'standalone-chat',
  });
  const providerStore = createProviderStore(client.db, { uuid: () => 'provider-id', now: () => 0 });
  return {
    ...f,
    root,
    client,
    store,
    captured,
    global,
    policy,
    keychain,
    resolver,
    providerStore,
    afterStop,
    close: () => {
      client.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe.each([false, true])('restored-history admission handoff stopped=%s', (stopped) => {
  it('samples credentials only while admitted, including the actual setup readiness fast path', async () => {
    const h = fixture();
    try {
      const agent = AgentSchema.parse({
        id: 'offline',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        system_prompt: 'offline',
      });
      const iso = '2026-11-10T00:00:00.000Z';
      h.store.createSession({
        id: 'saved',
        agentSlug: agent.id,
        agentSnapshot: agent,
        context: { workingDir: h.root, fsScopeTier: 'sandboxed' },
        status: 'ended',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostMicrocents: 0,
        totalConservativeMicrocents: 0,
        createdAt: iso,
        updatedAt: iso,
      });
      const record = h.store.loadSession('saved');
      if (record === undefined) throw new Error('Missing seeded session');
      h.store.writeTurn({
        session: record,
        messages: [
          {
            message: {
              id: 'u',
              sessionId: 'saved',
              sequenceNumber: 0,
              role: 'user',
              content: [{ type: 'text', text: 'canonical' }],
              timestamp: iso,
            },
            meta: { userDisplayText: 'visible' },
          },
          {
            message: {
              id: 'a',
              sessionId: 'saved',
              sequenceNumber: 1,
              role: 'assistant',
              content: [{ type: 'text', text: 'answer' }],
              timestamp: iso,
            },
          },
        ],
      });
      const read = h.store.loadUserDisplayTexts;
      vi.spyOn(h.store, 'loadUserDisplayTexts').mockImplementation((...args) => {
        // The synchronous DB read finishes first; termination wins the caller's awaited handoff.
        if (stopped) queueMicrotask(() => h.invocation.finiteExit.signal(15));
        return read(...args);
      });
      const close = vi.fn();
      const keys = vi.fn<NonNullable<ChatResumeCommandDeps['resolveKeys']>>((db, loaded) => {
        if (db === undefined || loaded === undefined) throw new Error('Missing setup context');
        return {
          providers: h.resolver,
          prepareInteractiveSetup: async (lifetime) => {
            if (lifetime === undefined) throw new Error('Missing chat lifetime');
            return runStandaloneProviderSetup({
              lifetime,
              loaded,
              global: h.global,
              io: h.captured.io,
              resolver: h.resolver,
              policy: h.policy,
              keychain: h.keychain,
              store: h.providerStore,
            });
          },
        };
      });
      const result = await chatResumeCommand(
        { sessionId: 'saved' },
        {
          invocation: h.invocation,
          global: h.global,
          io: { ...h.captured.io, stdinIsTty: true, stdoutIsTty: true },
          lifecycle,
          resolveKeys: keys,
          openSessionStore: (_home, captureClose) => {
            captureClose?.(close);
            return { store: h.store, db: h.client.db, close };
          },
          // The control deliberately exits before the native host's activation handshake.
          drive: () => Promise.resolve({ kind: 'exit' }),
        },
      );
      // Session surfaces leave native signal exit to the invocation's finite authority.
      expect(result).toBe(4);
      expect(keys).toHaveBeenCalledTimes(stopped ? 0 : 1);
      expect(h.afterStop).not.toHaveBeenCalled();
      if (stopped) expect(h.keychain.get).not.toHaveBeenCalled();
      else expect(h.keychain.get).toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      expect(h.registry.activeOwners).toBe(0);
      if (stopped) expect(await h.invocation.finiteExit.exited).toBe(143);
    } finally {
      h.close();
    }
  });
});

it('refuses an already stopped setup before observing even a usable key', async () => {
  const h = fixture();
  try {
    const lifetime = new SessionChatLifetime(h.invocation, lifecycle);
    const loaded = loadResolvedConfig({
      cwd: h.root,
      configPath: h.global.configPath,
      home: h.root,
    });
    const result = await lifetime.execute(async () => {
      h.invocation.finiteExit.signal(15);
      await runStandaloneProviderSetup({
        lifetime,
        loaded,
        global: h.global,
        io: h.captured.io,
        resolver: h.resolver,
        policy: h.policy,
        keychain: h.keychain,
        store: h.providerStore,
      });
      return 0;
    });
    expect(result).toBe(4);
    expect(h.keychain.get).not.toHaveBeenCalled();
    expect(h.registry.activeOwners).toBe(0);
    expect(await h.invocation.finiteExit.exited).toBe(143);
  } finally {
    h.close();
  }
});
