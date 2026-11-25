/**
 * `/cost --release` keeps a content-free record ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §6): through the real store and the real persister, a release of a held amount appends one `cost_release` row naming exactly the durable
 * amount it cleared, atomically with clearing it, at the persister's next sequence; a release of nothing records nothing; a row that cannot
 * be inserted rolls the release back and never reaches the live governor; and the next turn's sequence is not disturbed either way.
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
  const governor = { releaseConservativeCommitments: vi.fn(() => 3) };
  const release = () =>
    releaseHeldEstimates({
      store,
      sessionId: 'sess-1',
      governor,
      now: () => 99,
      record: persister,
    });
  const hold = (model: string, amount: number): void => {
    store.recordSessionConservativeCommitment({
      id: `k-${model}`,
      sessionId: 'sess-1',
      model,
      estimateMicrocents: amount,
      ts: 1,
    });
  };
  const turn = async (text: string): Promise<void> => {
    persister.beginUserTurn(text);
    await built.session.sendMessage(text);
  };
  return { persister, governor, release, hold, turn };
}

/** The durable transcript as `sequence:role[:record]`. */
const transcript = (): string[] =>
  store
    .loadMessages('sess-1')
    .map(
      (row) =>
        `${String(row.sequenceNumber)}:${row.role}${row.record === undefined ? '' : `:${JSON.stringify(row.record)}`}`,
    );
const held = () => ({
  total: store.loadSession('sess-1')?.totalConservativeMicrocents,
  rows: store
    .loadSessionCosts('sess-1')
    .map((row) => row.conservativeMicrocents)
    .sort((a, b) => a - b),
});

describe('the release record (ADR-0148 §6)', () => {
  it('a release of a held amount writes one row with exactly the durable amount, the holds read 0 0, and the next turn follows it', async () => {
    const { release, hold, turn, governor } = await setup();
    hold('m1', 400);
    hold('m2', 100);
    expect(release()).toEqual({ durable: 500, live: 3 });
    expect(governor.releaseConservativeCommitments).toHaveBeenCalledOnce();
    expect(held()).toEqual({ total: 0, rows: [0, 0] });
    await turn('q1');
    expect(transcript()).toEqual([
      '0:system:{"kind":"cost_release","microcents":500}',
      '1:user',
      '2:assistant',
    ]);
  });

  it('a release of nothing writes no row, and the next turn takes the same sequence it would have', async () => {
    const { release, turn } = await setup();
    expect(release()).toEqual({ durable: 0, live: 3 });
    await turn('q1');
    expect(transcript()).toEqual(['0:user', '1:assistant']);
  });

  it('a row that cannot be inserted rolls the release back: the holds are intact, the governor is untouched, nothing is recorded', async () => {
    const { release, hold, governor, persister } = await setup();
    hold('m1', 400);
    hold('m2', 100);
    // A row another writer put at the persister's next number: the release's record row collides with it.
    store.appendMessage({
      id: 'foreign',
      sessionId: 'sess-1',
      sequenceNumber: 0,
      role: 'user',
      content: [{ type: 'text', text: 'x' }],
      timestamp: '2026-11-25T00:00:00.000Z',
    });
    expect(() => release()).toThrow();
    expect(held()).toEqual({ total: 500, rows: [100, 400] });
    expect(governor.releaseConservativeCommitments).not.toHaveBeenCalled();
    expect(transcript()).toEqual(['0:user']);
    // A refused release is reported by the caller (the popup's failed-release step, the plain command's catch): never the latch.
    expect(persister.durabilityFailure).toBeUndefined();
  });
});
