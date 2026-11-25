/**
 * A resumed session rebuilds its context from the durable transcript through the one history projection, which skips a record row
 * ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6): the state a resume
 * reconstructs — the messages the model is sent, the completed turn spans, the turn count, the receipts, the sequences the persister seeds
 * its boundaries from — is the state of the same transcript without its record rows.
 */
import {
  SessionContextSchema,
  type AgentSessionRecord,
  type SessionMessage,
} from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  reconstructSessionState,
  resumableMessageSequences,
  resumableTurnBoundarySequences,
} from './session-resume.js';

const TS = '2026-11-25T00:00:00.000Z';
const session: AgentSessionRecord = {
  id: 'sess-1',
  agentSlug: 'chatter',
  context: SessionContextSchema.parse({ workingDir: '/workspace/s', fsScopeTier: 'sandboxed' }),
  status: 'idle',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 7,
  totalConservativeMicrocents: 0,
  createdAt: TS,
  updatedAt: TS,
};
let next = 0;
const row = (
  role: SessionMessage['role'],
  content: SessionMessage['content'],
  extra: Partial<SessionMessage> = {},
): SessionMessage => ({
  id: `m-${String(next)}`,
  sessionId: 'sess-1',
  sequenceNumber: next++,
  role,
  content,
  timestamp: TS,
  ...extra,
});
const text = (value: string): SessionMessage['content'] => [{ type: 'text', text: value }];
const modeChange = (from: 'ask' | 'auto' | 'plan', to: 'ask' | 'auto' | 'plan'): SessionMessage =>
  row('system', [], { record: { kind: 'mode_change', from, to } });

describe('resume skips record rows (ADR-0148 §6)', () => {
  it('reconstructs the same state with and without the record rows, and none of them is sent to the model', () => {
    next = 0;
    const id = 'session-tool:1:0';
    const transcript = [
      modeChange('ask', 'auto'),
      row('user', text('read the file')),
      row('assistant', [{ type: 'tool_call', id, name: 'read_file', argsBytes: 2 }]),
      row('tool', [{ type: 'tool_result', toolCallId: id, resultBytes: 4, outcome: 'ok' }]),
      row('assistant', text('it says hello')),
      row('system', [], { record: { kind: 'cost_release', microcents: 300 } }),
      modeChange('auto', 'plan'),
      row('user', text('and now?')),
      // Not a shape the writer produces (a turn is written in one transaction), but the projection must hold even so.
      modeChange('plan', 'auto'),
      row('assistant', text('nothing more')),
      modeChange('auto', 'plan'),
      modeChange('plan', 'ask'),
      row('user', text('trailing, unanswered')),
    ];
    const plain = transcript.filter((message) => message.record === undefined);
    expect(plain.length).toBe(transcript.length - 6);
    const resumed = reconstructSessionState(session, transcript);
    expect(resumed).toEqual(reconstructSessionState(session, plain));
    expect(resumed.turnCount).toBe(2);
    expect(resumed.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'read the file' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'it says hello' }] },
      { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'nothing more' }] },
    ]);
    expect(resumableMessageSequences(transcript)).toEqual(resumableMessageSequences(plain));
    expect(resumableTurnBoundarySequences(transcript)).toEqual(
      resumableTurnBoundarySequences(plain),
    );
    // No sequence a record row holds is a message or a boundary the persister would seed.
    const recordSequences = new Set(
      transcript.filter((m) => m.record !== undefined).map((m) => m.sequenceNumber),
    );
    for (const sequence of [
      ...resumableMessageSequences(transcript),
      ...resumableTurnBoundarySequences(transcript),
    ])
      expect(recordSequences.has(sequence)).toBe(false);
  });

  it('a record row does not count as a compaction boundary or carry a summary into the preamble', () => {
    next = 0;
    const transcript = [
      row('user', text('one')),
      row('assistant', text('first')),
      row('system', text('summary of one'), { compaction: { droppedThroughSequence: 1 } }),
      row('system', [], { record: { kind: 'cost_release', microcents: 1 } }),
      row('user', text('two')),
      row('assistant', text('second')),
    ];
    const resumed = reconstructSessionState(session, transcript);
    expect(resumed).toEqual(
      reconstructSessionState(
        session,
        transcript.filter((m) => m.record === undefined),
      ),
    );
    expect(resumed.turnCount).toBe(1);
    expect(resumed.compactionSummary).toBeDefined();
  });
});
