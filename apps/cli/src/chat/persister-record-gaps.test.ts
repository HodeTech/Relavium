/**
 * The persister's record rows ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6) as far
 * as the step-5 round-1 mutation sweep found `persister-record.test.ts` silent: a record row carries the persister's own clock; a persister that
 * has not started never touches the store for a record; a slot is never handed out once the persister has closed; and adopting a slot never moves
 * the sequence backwards (a slot older than the sequence, as when the write that holds it appended rows of its own).
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
import { createSessionPersister } from './persister.js';
import { buildChatSession } from './session-host.js';
import { scriptedResolver } from './test-support.js';

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

/** The persister's clock in these tests: one instant, so a row's timestamp can only be this or something the persister did not take from it. */
const CLOCK = '2026-11-25T12:34:56.789Z';

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
  const now = (): number => Date.parse(CLOCK);
  let id = 0;
  const built = await buildChatSession({
    chat: EMPTY_CHAT,
    agentRef: undefined,
    cwd: '/workspace',
    projectConfigDir: undefined,
    now,
    uuid: () => 'sess-1',
    providers: scriptedResolver([]),
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
  return { persister, built };
}

const MODE = { kind: 'mode_change', from: 'ask', to: 'auto' } as const;

describe('a record row carries the persister’s clock', () => {
  it('appendRecord stamps the row with the instant the persister’s clock gave', async () => {
    const { persister, built } = await setup();
    persister.start();
    built.session.start();
    expect(persister.appendRecord(MODE)).toBe(true);
    expect(store.loadMessages('sess-1').map((row) => row.timestamp)).toEqual([CLOCK]);
  });

  it('withRecordSlot hands out a slot stamped with the same clock', async () => {
    const { persister, built } = await setup();
    persister.start();
    built.session.start();
    let stamped: string | undefined;
    persister.withRecordSlot(
      (slot) => {
        stamped = slot.timestamp;
        return 0;
      },
      () => false,
    );
    expect(stamped).toBe(CLOCK);
  });
});

describe('a persister that is not running', () => {
  it('appendRecord before start never touches the store', async () => {
    const { persister } = await setup();
    const writeTurn = vi.spyOn(store, 'writeTurn');
    expect(persister.appendRecord(MODE)).toBe(false);
    expect(writeTurn).not.toHaveBeenCalled();
  });

  it('withRecordSlot after close refuses and never calls the write', async () => {
    const { persister, built } = await setup();
    persister.start();
    built.session.start();
    persister.close();
    const write = vi.fn(() => 1);
    expect(() => persister.withRecordSlot(write, () => true)).toThrow(
      'session persistence is unavailable',
    );
    expect(write).not.toHaveBeenCalled();
  });
});

describe('adopting a slot', () => {
  it('never moves the sequence backwards: a slot older than the rows its own write appended leaves the next record after them', async () => {
    const { persister, built } = await setup();
    persister.start();
    built.session.start();
    // The write that holds slot 0 appends two rows of its own (the persister's next numbers are 0 and 1) before it reports it landed.
    persister.withRecordSlot(
      () => {
        expect(persister.appendRecord(MODE)).toBe(true);
        expect(persister.appendRecord({ kind: 'mode_change', from: 'auto', to: 'plan' })).toBe(
          true,
        );
        return 'landed';
      },
      () => true,
    );
    expect(persister.appendRecord({ kind: 'mode_change', from: 'plan', to: 'ask' })).toBe(true);
    expect(store.loadMessages('sess-1').map((row) => row.sequenceNumber)).toEqual([0, 1, 2]);
  });
});
