/**
 * The edge of the release record's slot ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §6) that `cost-release-record.test.ts` leaves open, found by the step-5 round-1 mutation sweep (it pins 500 micro-cents and nothing): a release
 * of exactly ONE micro-cent is a release. The store records its row, so the persister adopts the slot (the sequence number the row took), and the
 * next turn follows the row instead of colliding with it.
 */
import {
  createClient,
  createSessionStore,
  createSessionUsageStore,
  runMigrations,
  type DbClient,
  type SessionStore,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedChatConfig } from '../config/resolve.js';
import { releaseHeldEstimates } from './cost-release.js';
import { createSessionPersister } from './persister.js';
import { buildChatSession } from './session-host.js';
import { scriptedResolver, textTurn } from './test-support.js';

const EMPTY_CHAT: ResolvedChatConfig = {
  defaultMode: 'ask',
  defaultModeSource: 'fallback',
  defaultModel: undefined,
  defaultProvider: undefined,
  fsScope: undefined,
  maxTurns: undefined,
  maxMessages: undefined,
  autoCompact: undefined,
  compactThreshold: undefined,
  maxCostMicrocents: undefined,
  maxTokens: undefined,
  onExceed: undefined,
  strictCostCap: false,
  allowedCommands: undefined,
  allowedCommandGlobs: undefined,
  reasoningEffort: undefined,
};

let client: DbClient;
let store: SessionStore;
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  store = createSessionStore(client.db);
});
afterEach(() => {
  client.sqlite.close();
  vi.restoreAllMocks();
});

async function setup() {
  let tick = Date.parse('2026-11-25T00:00:00.000Z');
  const now = () => tick++;
  let id = 0;
  const built = await buildChatSession({
    chat: EMPTY_CHAT,
    agentRef: undefined,
    cwd: '/workspace',
    projectConfigDir: undefined,
    now,
    uuid: () => 'sess-1',
    providers: scriptedResolver([textTurn('a1')]),
  });
  const persister = createSessionPersister({
    usageStore: createSessionUsageStore(client.db),
    mode: 'fresh',
    attachUsageWriter: built.attachUsageWriter,
    governor: undefined,
    store,
    handle: built.handle,
    attachEffectTurnAllocator: built.attachEffectTurnAllocator,
    attachDurabilityProbe: built.attachDurabilityProbe,
    sessionId: built.sessionId,
    agent: built.agent,
    context: built.context,
    now,
    uuid: () => `row-${String(id++)}`,
  });
  persister.start();
  built.session.start();
  return {
    persister,
    release: () =>
      releaseHeldEstimates({
        store,
        sessionId: 'sess-1',
        governor: undefined,
        now: () => 99,
        record: persister,
      }),
    hold: (amount: number): void => {
      store.recordSessionConservativeCommitment({
        id: 'k',
        sessionId: 'sess-1',
        model: 'm',
        estimateMicrocents: amount,
        ts: 1,
      });
    },
    turn: async (text: string): Promise<void> => {
      persister.beginUserTurn(text);
      await built.session.sendMessage(text);
    },
  };
}

/** The durable transcript as `sequence:role[:record]`. */
const transcript = (): string[] =>
  store
    .loadMessages('sess-1')
    .map(
      (row) =>
        `${String(row.sequenceNumber)}:${row.role}${row.record === undefined ? '' : `:${JSON.stringify(row.record)}`}`,
    );

describe('a release of exactly one micro-cent', () => {
  it('is recorded, and the next turn follows its row: the slot was adopted, nothing collides, nothing is latched', async () => {
    const { persister, release, hold, turn } = await setup();
    hold(1);
    expect(release()).toEqual({ durable: 1, live: undefined });
    await turn('q1');
    expect(transcript()).toEqual([
      '0:system:{"kind":"cost_release","microcents":1}',
      '1:user',
      '2:assistant',
    ]);
    expect(persister.durabilityFailure).toBeUndefined();
  });
});
