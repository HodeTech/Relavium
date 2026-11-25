/**
 * The persister's record rows ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6): the
 * one writer of `session_messages` appends a content-free record row at ITS next sequence number (so nothing else ever collides with its
 * next turn), adopts that number only after the row landed, keeps the row out of the real-message and turn-boundary slots a compaction
 * maps through, writes it in a usage-acknowledged transaction (ADR-0104), and reports a failed write by its return value WITHOUT the
 * durability latch (the session keeps its egress).
 */
import {
  createClient,
  createSessionStore,
  createSessionUsageStore,
  runMigrations,
  type DbClient,
  type SessionRecordSlot,
  type SessionStore,
} from '@relavium/db';
import type { SessionStreamHandleEvent } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedChatConfig } from '../config/resolve.js';
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
let listenerNotes: string[];
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  store = createSessionStore(client.db);
  listenerNotes = [];
});
afterEach(() => {
  client.sqlite.close();
  vi.restoreAllMocks();
});

async function setup(turns: number) {
  let tick = Date.parse('2026-11-25T00:00:00.000Z');
  const now = () => tick++;
  let id = 0;
  /** The persister's own stream listener, so a test can deliver an event the engine no longer emits (a pre-W7 trim). */
  let deliver: ((event: SessionStreamHandleEvent) => void) | undefined;
  const built = await buildChatSession({
    chat: EMPTY_CHAT,
    agentRef: undefined,
    cwd: '/workspace',
    projectConfigDir: undefined,
    now,
    uuid: () => 'sess-1',
    providers: scriptedResolver(
      Array.from({ length: turns }, (_, n) => textTurn(`a${String(n + 1)}`)),
    ),
    onListenerError: (note: string) => listenerNotes.push(note),
  });
  const usageStore = createSessionUsageStore(client.db);
  const persister = createSessionPersister({
    usageStore,
    mode: 'fresh',
    attachUsageWriter: built.attachUsageWriter,
    governor: undefined,
    store,
    handle: {
      ...built.handle,
      subscribe: (listener) => {
        deliver = listener;
        return built.handle.subscribe(listener);
      },
    },
    attachEffectTurnAllocator: built.attachEffectTurnAllocator,
    attachDurabilityProbe: built.attachDurabilityProbe,
    sessionId: built.sessionId,
    agent: built.agent,
    context: built.context,
    now,
    uuid: () => `row-${String(id++)}`,
  });
  return {
    built,
    persister,
    usageStore,
    deliver: (event: SessionStreamHandleEvent) => deliver?.(event),
  };
}

/** The durable transcript as `sequence:role[:record kind]`. */
const transcript = (): string[] =>
  store
    .loadMessages('sess-1')
    .map(
      (row) =>
        `${String(row.sequenceNumber)}:${row.role}${row.record === undefined ? '' : `:${row.record.kind}`}`,
    );

describe('appendRecord', () => {
  it('writes nothing and says false before start and after close', async () => {
    const { persister } = await setup(0);
    expect(persister.appendRecord({ kind: 'mode_change', from: 'ask', to: 'auto' })).toBe(false);
    persister.start();
    persister.close();
    expect(persister.appendRecord({ kind: 'mode_change', from: 'ask', to: 'auto' })).toBe(false);
    expect(transcript()).toEqual([]);
  });

  it('appends at the next sequence and adopts it only after the write: the next turn follows the record without a gap or a collision', async () => {
    const { built, persister } = await setup(1);
    persister.start();
    built.session.start();
    expect(persister.appendRecord({ kind: 'mode_change', from: 'ask', to: 'auto' })).toBe(true);
    persister.beginUserTurn('q1');
    await built.session.sendMessage('q1');
    expect(persister.appendRecord({ kind: 'cost_release', microcents: 42 })).toBe(true);
    expect(transcript()).toEqual([
      '0:system:mode_change',
      '1:user',
      '2:assistant',
      '3:system:cost_release',
    ]);
    expect(store.loadMessages('sess-1')[0]).toMatchObject({
      role: 'system',
      content: [],
      record: { kind: 'mode_change', from: 'ask', to: 'auto' },
    });
    expect(persister.durabilityFailure).toBeUndefined();
  });

  it('a record written while a turn is running takes the next number, and the turn commits after it (no collision, no latch)', async () => {
    const { built, persister } = await setup(1);
    persister.start();
    built.session.start();
    persister.beginUserTurn('q1');
    const running = built.session.sendMessage('q1');
    // The turn has started and not committed: it stages its rows at its completion, from the sequence it finds then.
    expect(persister.appendRecord({ kind: 'mode_change', from: 'ask', to: 'plan' })).toBe(true);
    await running;
    expect(transcript()).toEqual(['0:system:mode_change', '1:user', '2:assistant']);
    expect(persister.durabilityFailure).toBeUndefined();
    expect(listenerNotes).toEqual([]);
  });

  it('a failed write returns false, latches nothing, moves no sequence, and the next turn still lands', async () => {
    const { built, persister } = await setup(1);
    persister.start();
    built.session.start();
    const writeTurn = vi.spyOn(store, 'writeTurn').mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    expect(persister.appendRecord({ kind: 'mode_change', from: 'ask', to: 'auto' })).toBe(false);
    expect(writeTurn).toHaveBeenCalledOnce();
    expect(persister.durabilityFailure).toBeUndefined();
    expect(listenerNotes).toEqual([]);
    persister.beginUserTurn('q1');
    await built.session.sendMessage('q1');
    expect(transcript()).toEqual(['0:user', '1:assistant']);
    expect(persister.durabilityFailure).toBeUndefined();
  });

  it('a record row is neither a real message nor a turn boundary: a /trim maps its boundary exactly as it does without one', async () => {
    const { built, persister } = await setup(2);
    persister.start();
    built.session.start();
    persister.beginUserTurn('q1');
    await built.session.sendMessage('q1');
    expect(persister.appendRecord({ kind: 'mode_change', from: 'ask', to: 'auto' })).toBe(true);
    persister.beginUserTurn('q2');
    await built.session.sendMessage('q2');
    expect(persister.appendRecord({ kind: 'mode_change', from: 'auto', to: 'ask' })).toBe(true);
    expect(built.session.trimHistory(2).kind).toBe('trimmed'); // keep the last exchange
    // q1 is 0, a1 is 1, the record is 2, q2 is 3, a2 is 4: the dropped exchange ends at 1, never at a record's 2 or 5.
    expect(transcript()).toEqual([
      '0:user',
      '1:assistant',
      '2:system:mode_change',
      '3:user',
      '4:assistant',
      '5:system:mode_change',
      '6:system',
    ]);
    const marker = store.loadMessages('sess-1').find((row) => row.compaction !== undefined);
    expect(marker?.compaction).toEqual({ droppedThroughSequence: 1 });
  });

  it('a pre-W7 trim (no turn count) maps through the real-message sequences, which hold no record row either', async () => {
    const { built, persister, deliver } = await setup(2);
    persister.start();
    built.session.start();
    expect(persister.appendRecord({ kind: 'mode_change', from: 'ask', to: 'plan' })).toBe(true);
    persister.beginUserTurn('q1');
    await built.session.sendMessage('q1');
    expect(persister.appendRecord({ kind: 'mode_change', from: 'plan', to: 'ask' })).toBe(true);
    persister.beginUserTurn('q2');
    await built.session.sendMessage('q2');
    // record 0, q1 1, a1 2, record 3, q2 4, a2 5: keeping the last two real messages drops through a1 (2), never a record's 3.
    deliver({
      type: 'session:trimmed',
      sessionId: 'sess-1',
      sequenceNumber: 99,
      timestamp: '2026-11-25T00:00:00.000Z',
      reason: 'manual',
      keptMessageCount: 2,
      droppedMessageCount: 2,
    });
    const marker = store.loadMessages('sess-1').find((row) => row.compaction !== undefined);
    expect(marker?.compaction).toEqual({ droppedThroughSequence: 2 });
  });

  it('keeps a fresh session’s usage coverage verified: the trigger’s revision bump is acknowledged in the same transaction', async () => {
    const { built, persister, usageStore } = await setup(0);
    persister.start();
    built.session.start();
    const revisions = () =>
      client.sqlite
        .prepare(
          "SELECT usage_mutation_revision AS revision, usage_ack_revision AS ack, usage_unverified AS unverified FROM agent_sessions WHERE id = 'sess-1'",
        )
        .get() as { revision: number; ack: number; unverified: number };
    const before = revisions();
    expect(usageStore.loadCoverage('sess-1')?.coverage.unverified).toBe(false);
    expect(persister.appendRecord({ kind: 'mode_change', from: 'ask', to: 'accept-edits' })).toBe(
      true,
    );
    const after = revisions();
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.ack).toBe(after.revision);
    expect(after.unverified).toBe(0);
    expect(usageStore.loadCoverage('sess-1')?.coverage.unverified).toBe(false);
  });
});

describe('withRecordSlot', () => {
  it('refuses before start, without calling the write', async () => {
    const { persister } = await setup(0);
    const write = vi.fn(() => 1);
    expect(() => persister.withRecordSlot(write, () => true)).toThrow(
      'session persistence is unavailable',
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('hands out the next sequence, and adopts it only when the row landed', async () => {
    const { built, persister } = await setup(1);
    persister.start();
    built.session.start();
    const slots: SessionRecordSlot[] = [];
    // Not landed: the next row reuses the number.
    expect(
      persister.withRecordSlot(
        (slot) => {
          slots.push(slot);
          return 0;
        },
        (n) => n > 0,
      ),
    ).toBe(0);
    // Landed (a real row at the slot): the next turn moves past it.
    persister.withRecordSlot(
      (slot) => {
        slots.push(slot);
        store.appendMessage({
          id: slot.id,
          sessionId: 'sess-1',
          sequenceNumber: slot.sequenceNumber,
          role: 'system',
          content: [],
          record: { kind: 'cost_release', microcents: 5 },
          timestamp: slot.timestamp,
        });
        return 5;
      },
      (n) => n > 0,
    );
    expect(slots.map((slot) => slot.sequenceNumber)).toEqual([0, 0]);
    persister.beginUserTurn('q1');
    await built.session.sendMessage('q1');
    expect(transcript()).toEqual(['0:system:cost_release', '1:user', '2:assistant']);
    expect(persister.durabilityFailure).toBeUndefined();
  });

  it('a write that throws adopts nothing and propagates', async () => {
    const { built, persister } = await setup(1);
    persister.start();
    built.session.start();
    expect(() =>
      persister.withRecordSlot(
        () => {
          throw new Error('refused');
        },
        () => true,
      ),
    ).toThrow('refused');
    persister.beginUserTurn('q1');
    await built.session.sendMessage('q1');
    expect(transcript()).toEqual(['0:user', '1:assistant']);
  });
});
