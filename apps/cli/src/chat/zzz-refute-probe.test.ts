import {
  createClient,
  createSessionStore,
  runMigrations,
  type DbClient,
  type SessionStore,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

describe('probe: a turn AFTER a boundary marker', () => {
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

  it('/compact then one more turn: contiguous sequence numbers, no UNIQUE collision', async () => {
    const { built, persister } = await setup(
      scriptedResolver([
        textTurn('a1'),
        textTurn('a2'),
        textTurn('the summary text'),
        textTurn('a3'),
      ]),
    );
    persister.start();
    built.session.start();
    persister.beginUserTurn('q1');
    await built.session.sendMessage('q1');
    persister.beginUserTurn('q2');
    await built.session.sendMessage('q2');

    const compacted = await built.session.compact('manual');
    expect(compacted.kind).toBe('compacted');

    // The turn AFTER the marker — the uncovered path.
    persister.beginUserTurn('q3');
    await built.session.sendMessage('q3');

    const rows = store.loadMessages('sess-1');
    expect(rows.map((m) => [m.role, m.sequenceNumber])).toEqual([
      ['user', 0],
      ['assistant', 1],
      ['user', 2],
      ['assistant', 3],
      ['system', 4],
      ['user', 5],
      ['assistant', 6],
    ]);
  });

  it('/trim then one more turn: contiguous sequence numbers, no UNIQUE collision', async () => {
    const { built, persister } = await setup(
      scriptedResolver([textTurn('a1'), textTurn('a2'), textTurn('a3')]),
    );
    persister.start();
    built.session.start();
    persister.beginUserTurn('q1');
    await built.session.sendMessage('q1');
    persister.beginUserTurn('q2');
    await built.session.sendMessage('q2');

    expect(built.session.trimHistory(2).kind).toBe('trimmed');

    persister.beginUserTurn('q3');
    await built.session.sendMessage('q3');

    const rows = store.loadMessages('sess-1');
    expect(rows.map((m) => [m.role, m.sequenceNumber])).toEqual([
      ['user', 0],
      ['assistant', 1],
      ['user', 2],
      ['assistant', 3],
      ['system', 4],
      ['user', 5],
      ['assistant', 6],
    ]);
  });
});
