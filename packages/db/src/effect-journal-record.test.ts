/**
 * Effect disclosure reads a session's WHOLE history (`select *`, so it carries the record columns without naming them) through the one
 * history projection. A record row ([ADR-0148](../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6)
 * is skipped by that projection: it neither completes a turn (which would silence a `turn_incomplete` disclosure) nor breaks one.
 */
import {
  effectScope,
  type AgentSessionRecord,
  type EffectCorrelation,
  type SessionMessage,
} from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { createEffectJournalStore } from './effect-journal-store.js';
import { createSessionStore } from './session-store.js';

const timestamp = '2026-11-25T00:00:00.000Z';
const owner: AgentSessionRecord = {
  id: 's1',
  agentSlug: 'chatter',
  context: { workingDir: '/workspace', fsScopeTier: 'sandboxed' },
  status: 'active',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  totalConservativeMicrocents: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};
let client: DbClient;
let counter: number;
const journal = () =>
  createEffectJournalStore(client.db, { uuid: () => `e${String(++counter)}`, now: () => counter });

/** A committed `run_command` effect of session turn `turn`, attributed to the call id the transcript names. */
function committedEffect(turn: number): void {
  const correlation: EffectCorrelation = { kind: 'session', sessionId: 's1', turn };
  const identity = { scope: effectScope(correlation), slot: 0, toolId: 'run_command' };
  journal().prepare(
    identity,
    correlation,
    { providerAttempt: 1, toolCallId: `session-tool:${String(turn)}:0` },
    3,
    'scrubbed-digest',
  );
  journal().settle(identity, 'committed');
}

type Row = Pick<SessionMessage, 'role' | 'content'> &
  Partial<Pick<SessionMessage, 'interruption' | 'record'>>;
const exchange = (turn: number, ending: Row): Row[] => {
  const id = `session-tool:${String(turn)}:0`;
  return [
    { role: 'user', content: [{ type: 'text', text: `prompt ${String(turn)}` }] },
    { role: 'assistant', content: [{ type: 'tool_call', id, name: 'run_command', argsBytes: 7 }] },
    {
      role: 'tool',
      content: [{ type: 'tool_result', toolCallId: id, resultBytes: 4, outcome: 'ok' }],
    },
    ending,
  ];
};
const modeRecord = (from: 'ask' | 'auto', to: 'ask' | 'auto'): Row => ({
  role: 'system',
  content: [],
  record: { kind: 'mode_change', from, to },
});

function write(rows: readonly Row[]): void {
  const sessions = createSessionStore(client.db);
  rows.forEach((row, sequenceNumber) => {
    sessions.appendMessage({
      ...row,
      id: `m${String(sequenceNumber)}`,
      sessionId: 's1',
      sequenceNumber,
      timestamp,
    });
  });
}

beforeEach(() => {
  client = createClient(':memory:');
  counter = 0;
  runMigrations(client.db);
  createSessionStore(client.db).createSession(owner);
});
afterEach(() => {
  client.sqlite.close();
});

describe('effect disclosure skips record rows (ADR-0148 §6)', () => {
  it('a completed turn stays completed and an interrupted one stays disclosed as turn_incomplete, with record rows around and between them', () => {
    committedEffect(1);
    committedEffect(2);
    write([
      modeRecord('ask', 'auto'),
      ...exchange(1, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }),
      { role: 'system', content: [], record: { kind: 'cost_release', microcents: 12 } },
      ...exchange(2, { role: 'system', content: [], interruption: { reason: 'aborted' } }),
      modeRecord('auto', 'ask'),
    ]);
    const snapshot = journal().readSessionDisclosureSnapshot('s1');
    expect(snapshot.committed).toHaveLength(2);
    // Exactly what the same transcript without its record rows discloses: turn 1 is complete (no notice), turn 2 is not.
    expect(snapshot.disclosures).toEqual([
      { toolId: 'run_command', state: 'committed', reason: 'turn_incomplete' },
    ]);
  });

  it('a record row after an unanswered exchange does not complete it: the effect is still disclosed', () => {
    committedEffect(1);
    write([
      ...exchange(1, {
        role: 'system',
        content: [],
        record: { kind: 'cost_release', microcents: 1 },
      }),
    ]);
    const snapshot = journal().readSessionDisclosureSnapshot('s1');
    expect(snapshot.committed).toHaveLength(1);
    expect(snapshot.disclosures).toHaveLength(1);
    expect(snapshot.disclosures[0]?.state).toBe('committed');
  });
});
