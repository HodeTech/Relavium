import {
  createClient,
  createSessionStore,
  runMigrations,
  type DbClient,
  type SessionStore,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedChatConfig } from '../config/resolve.js';
import { createSessionPersister } from './persister.js';
import { buildChatSession } from './session-host.js';
import { scriptedResolver, textTurn } from './test-support.js';
import type { ProviderResolver } from '../engine/providers.js';

const EMPTY_CHAT: ResolvedChatConfig = {
  defaultModel: undefined,
  defaultProvider: undefined,
  fsScope: undefined,
  maxTurns: undefined,
  maxMessages: undefined,
  autoCompact: undefined,
  compactThreshold: undefined,
  maxCostMicrocents: undefined,
  onExceed: undefined,
  strictCostCap: false,
  allowedCommands: undefined,
  allowedCommandGlobs: undefined,
  reasoningEffort: undefined,
};

describe('probe: failed turn tokens must not leak into the next turn totals', () => {
  let client: DbClient;
  let store: SessionStore;
  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    store = createSessionStore(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
  });

  async function setup(providers: ProviderResolver) {
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    const now = () => tick++;
    let msgId = 0;
    const built = await buildChatSession({
      chat: EMPTY_CHAT,
      agentRef: undefined,
      cwd: '/workspace',
      projectConfigDir: undefined,
      now,
      uuid: () => 'sess-1',
      providers,
    });
    const persister = createSessionPersister({
      store,
      handle: built.handle,
      sessionId: built.sessionId,
      agent: built.agent,
      context: built.context,
      now,
      uuid: () => `msg-${msgId++}`,
    });
    return { built, persister };
  }

  it('records only the landed turn tokens', async () => {
    const { built, persister } = await setup(
      scriptedResolver([textTurn('hi'), textTurn('again')]),
    );
    built.session.start();
    persister.start();
    vi.spyOn(store, 'writeTurn').mockImplementationOnce(() => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });
    persister.beginUserTurn('first');
    await built.session.sendMessage('first');
    vi.restoreAllMocks();
    persister.beginUserTurn('second');
    await built.session.sendMessage('second');
    const session = store.loadSession('sess-1');
    // eslint-disable-next-line no-console
    console.log('PROBE totals', session?.totalInputTokens, session?.totalOutputTokens);
    expect(session?.totalInputTokens).toBe(10);
    expect(session?.totalOutputTokens).toBe(5);
  });
});
