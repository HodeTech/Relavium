/**
 * Exporting a session to a workflow derives its steps through the one history projection, which skips a record row
 * ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6): a record row is never a
 * step, never part of a step's prompt and grants no tool. And the export's transcript copy (`metadata.relaviumExport.messages`) does not
 * carry record rows at all: a workflow file is meant to be committed and shared, and a mode history or a released amount in micro-cents
 * is not provenance of the workflow (the precedent is the question records, ADR-0133).
 */
import {
  AgentSchema,
  SessionContextSchema,
  type AgentSessionRecord,
  type SessionMessage,
} from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { sessionToWorkflow } from './serializer.js';

const TS = '2026-11-25T00:00:00.000Z';
const session: AgentSessionRecord = {
  id: 'sess-1',
  agentSlug: 'chatter',
  agentSnapshot: AgentSchema.parse({
    id: 'chatter',
    model: 'claude-opus-4-8',
    provider: 'anthropic',
    system_prompt: 'You are concise.',
  }),
  title: 'My Chat',
  context: SessionContextSchema.parse({ workingDir: '/workspace/s', fsScopeTier: 'sandboxed' }),
  status: 'ended',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  totalConservativeMicrocents: 0,
  createdAt: TS,
  updatedAt: TS,
};
const msg = (
  sequenceNumber: number,
  role: SessionMessage['role'],
  content: SessionMessage['content'],
  extra: Partial<SessionMessage> = {},
): SessionMessage => ({
  id: `m-${String(sequenceNumber)}`,
  sessionId: 'sess-1',
  sequenceNumber,
  role,
  content,
  timestamp: TS,
  ...extra,
});

describe('export skips record rows when it derives steps (ADR-0148 §6)', () => {
  it('derives the same nodes and edges with and without record rows', () => {
    const id = 'session-tool:1:0';
    const transcript = [
      msg(0, 'system', [], { record: { kind: 'mode_change', from: 'ask', to: 'auto' } }),
      msg(1, 'user', [{ type: 'text', text: 'write the notes' }]),
      msg(2, 'assistant', [{ type: 'tool_call', id, name: 'write_file', argsBytes: 2 }]),
      msg(3, 'tool', [{ type: 'tool_result', toolCallId: id, resultBytes: 0, outcome: 'ok' }]),
      msg(4, 'assistant', [{ type: 'text', text: 'written' }]),
      msg(5, 'system', [], { record: { kind: 'cost_release', microcents: 300 } }),
      msg(6, 'user', [{ type: 'text', text: 'read it back' }]),
      // Inside an open exchange: not a shape the writer produces, but no record row may end (or split) the exchange.
      msg(7, 'system', [], { record: { kind: 'mode_change', from: 'auto', to: 'ask' } }),
      msg(8, 'assistant', [
        { type: 'tool_call', id: 'session-tool:2:0', name: 'read_file', argsBytes: 2 },
      ]),
      msg(9, 'tool', [
        { type: 'tool_result', toolCallId: 'session-tool:2:0', resultBytes: 3, outcome: 'ok' },
      ]),
      msg(10, 'assistant', [{ type: 'text', text: 'here it is' }]),
    ];
    const plain = transcript.filter((message) => message.record === undefined);
    const exported = sessionToWorkflow(session, transcript);
    const withoutRecords = sessionToWorkflow(session, plain);
    expect(exported.workflow.nodes).toEqual(withoutRecords.workflow.nodes);
    expect(exported.workflow.edges).toEqual(withoutRecords.workflow.edges);
    expect(exported.workflow.nodes.map((node) => node.id)).toEqual([
      'input',
      'turn-1',
      'turn-2',
      'output',
    ]);
    // The second step keeps the tool its exchange used after the record row: the row did not end the exchange.
    expect(exported.workflow.nodes[2]).toMatchObject({ tools: ['read_file'] });
    expect(JSON.stringify(exported.workflow.nodes)).not.toMatch(/mode_change|cost_release/u);
    // The transcript copy carries every conversation row, as persisted, and no record row.
    const kept = (
      exported.workflow.metadata?.['relaviumExport'] as { messages: SessionMessage[] } | undefined
    )?.messages;
    expect(kept).toEqual(plain);
    expect(JSON.stringify(exported.workflow)).not.toMatch(/"record"|mode_change|cost_release|300/u);
  });
});
