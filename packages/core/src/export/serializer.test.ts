import {
  AgentSchema,
  SessionContextSchema,
  type AgentSessionRecord,
  type SessionMessage,
} from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { parseWorkflow } from '../parser.js';
import { serializeWorkflow, sessionToWorkflow } from './serializer.js';

const TS = '2026-06-17T08:00:00.000Z';
const CTX = SessionContextSchema.parse({ workingDir: '/workspace/s', fsScopeTier: 'sandboxed' });
const AGENT = AgentSchema.parse({
  id: 'chatter',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You are concise.',
});

const session = (overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  id: 'sess-1',
  agentSlug: 'chatter',
  agentSnapshot: AGENT,
  title: 'My Chat',
  context: CTX,
  status: 'ended',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  createdAt: TS,
  updatedAt: TS,
  ...overrides,
});

const msg = (
  sequenceNumber: number,
  role: SessionMessage['role'],
  content: SessionMessage['content'],
): SessionMessage => ({
  id: `m-${sequenceNumber}`,
  sessionId: 'sess-1',
  sequenceNumber,
  role,
  content,
  timestamp: TS,
});

describe('sessionToWorkflow (1.Z) — linear-chain scaffold', () => {
  it('maps assistant turns to a linear agent-node chain (input → turn-n → output) with edges', () => {
    const def = sessionToWorkflow(session(), [
      msg(0, 'user', [{ type: 'text', text: 'hello' }]),
      msg(1, 'assistant', [{ type: 'text', text: 'hi there' }]),
      msg(2, 'user', [{ type: 'text', text: 'use a tool' }]),
      msg(3, 'assistant', [
        { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'x' } },
        { type: 'text', text: 'done' },
      ]),
    ]);
    const { nodes, edges } = def.workflow;
    expect(nodes.map((n) => n.id)).toEqual(['input', 'turn-1', 'turn-2', 'output']);
    expect(nodes.map((n) => n.type)).toEqual(['input', 'agent', 'agent', 'output']);

    const turn1 = nodes[1];
    expect(turn1?.type === 'agent' && turn1.agent_ref).toBe('chatter');
    expect(turn1?.type === 'agent' && turn1.prompt_template).toBe('hello');
    expect(turn1?.type === 'agent' && turn1.tools).toBeUndefined(); // text-only turn → no node-level tools

    const turn2 = nodes[2];
    expect(turn2?.type === 'agent' && turn2.prompt_template).toBe('use a tool');
    expect(turn2?.type === 'agent' && turn2.tools).toEqual(['read_file']);

    expect(edges).toEqual([
      { from: 'input', to: 'turn-1' },
      { from: 'turn-1', to: 'turn-2' },
      { from: 'turn-2', to: 'output' },
    ]);
    expect(def.workflow.agents).toEqual([AGENT]);
    expect(def.workflow.name).toBe('My Chat');
    expect(def.workflow.id).toBe('my-chat'); // kebab slug of the title
  });

  it('preserves the full transcript under metadata.relaviumExport', () => {
    const messages = [
      msg(0, 'user', [{ type: 'text', text: 'hi' }]),
      msg(1, 'assistant', [{ type: 'text', text: 'yo' }]),
    ];
    const def = sessionToWorkflow(session(), messages);
    const serialized = JSON.stringify(def.workflow.metadata);
    expect(serialized).toContain('relaviumExport');
    expect(serialized).toContain('"sessionId":"sess-1"');
    expect(serialized).toContain('"agentSlug":"chatter"');
    // the entire transcript (both messages) is carried, not just the assistant turns
    expect(serialized).toContain('"sequenceNumber":0');
    expect(serialized).toContain('"sequenceNumber":1');
  });

  it('handles a session with no assistant turns (input → output)', () => {
    const def = sessionToWorkflow(session(), [msg(0, 'user', [{ type: 'text', text: 'hi' }])]);
    expect(def.workflow.nodes.map((n) => n.id)).toEqual(['input', 'output']);
    expect(def.workflow.edges).toEqual([{ from: 'input', to: 'output' }]);
    expect(() => parseWorkflow(serializeWorkflow(def))).not.toThrow();
  });

  it('omits agents when no snapshot was captured (the scaffold still parses)', () => {
    const def = sessionToWorkflow(session({ agentSnapshot: undefined }), [
      msg(0, 'user', [{ type: 'text', text: 'hi' }]),
      msg(1, 'assistant', [{ type: 'text', text: 'yo' }]),
    ]);
    expect(def.workflow.agents).toBeUndefined();
    expect(() => parseWorkflow(serializeWorkflow(def))).not.toThrow();
  });

  it('collapses a split-row tool-loop turn into ONE node (prompt + tools), not one per assistant message', () => {
    const def = sessionToWorkflow(session(), [
      msg(0, 'user', [{ type: 'text', text: 'read the file' }]),
      msg(1, 'assistant', [
        { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'x' } },
      ]),
      msg(2, 'tool', [
        { type: 'tool_result', toolCallId: 'c1', result: 'contents', isError: false },
      ]),
      msg(3, 'assistant', [{ type: 'text', text: 'here is what it says' }]),
    ]);
    expect(def.workflow.nodes.map((n) => n.id)).toEqual(['input', 'turn-1', 'output']); // ONE turn node
    const turn1 = def.workflow.nodes[1];
    expect(turn1?.type === 'agent' && turn1.prompt_template).toBe('read the file');
    expect(turn1?.type === 'agent' && turn1.tools).toEqual(['read_file']);
  });

  it('dedupes a tool invoked multiple times within one turn', () => {
    const def = sessionToWorkflow(session(), [
      msg(0, 'user', [{ type: 'text', text: 'read two files' }]),
      msg(1, 'assistant', [
        { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a' } },
        { type: 'tool_call', id: 'c2', name: 'read_file', args: { path: 'b' } },
      ]),
      msg(2, 'assistant', [{ type: 'text', text: 'done' }]),
    ]);
    const turn1 = def.workflow.nodes[1];
    expect(turn1?.type === 'agent' && turn1.tools).toEqual(['read_file']); // not ['read_file', 'read_file']
  });
});

describe('serializeWorkflow (1.Z) — deterministic, round-trippable YAML emitter', () => {
  const transcript = [
    msg(0, 'user', [{ type: 'text', text: 'hello' }]),
    msg(1, 'assistant', [{ type: 'text', text: 'hi there' }]),
  ];

  it('round-trips: an exported session parses as a valid workflow, and parse→serialize is byte-stable', () => {
    const def = sessionToWorkflow(session(), transcript);
    const yaml1 = serializeWorkflow(def);
    const parsed = parseWorkflow(yaml1); // must not throw — the export is a valid workflow
    const yaml2 = serializeWorkflow(parsed);
    expect(yaml2).toBe(yaml1); // byte-stable round-trip (including metadata)
    // the parsed workflow's agent nodes mirror the turns
    expect(parsed.workflow.nodes.filter((n) => n.type === 'agent').map((n) => n.id)).toEqual([
      'turn-1',
    ]);
  });

  it('is deterministic (sorted keys) and stable across repeated emits', () => {
    const def = sessionToWorkflow(session(), transcript);
    expect(serializeWorkflow(def)).toBe(serializeWorkflow(def));
    const yaml = serializeWorkflow(def);
    // sorted map keys: within the document, `schema_version` precedes `workflow`
    expect(yaml.indexOf('schema_version')).toBeLessThan(yaml.indexOf('workflow:'));
  });

  it('serializes no reasoning signature and no secret (the durable transcript is structurally clean)', () => {
    const yaml = serializeWorkflow(
      sessionToWorkflow(session(), [
        msg(0, 'user', [{ type: 'text', text: 'think about it' }]),
        msg(1, 'assistant', [
          { type: 'reasoning', text: 'internal reasoning here' },
          { type: 'text', text: 'the answer' },
        ]),
      ]),
    );
    expect(yaml).toContain('internal reasoning here'); // reasoning TEXT is preserved in the transcript
    expect(yaml).not.toContain('signature'); // …but the ephemeral signature never is (ADR-0030)
    expect(yaml).not.toMatch(/secret:\s*true/); // no MaskedSecret value (ADR-0029)
  });

  it('neutralizes interpolation syntax a user typed, so the export still parses + round-trips', () => {
    // A user literally typing `{{ secrets.X }}` in chat would otherwise make prompt_template fail the
    // parse-time secret-taint gate (ADR-0029) — breaking the round-trip. The opener is neutralized.
    const def = sessionToWorkflow(session(), [
      msg(0, 'user', [{ type: 'text', text: 'how do I reference {{ secrets.OPENAI_KEY }} here?' }]),
      msg(1, 'assistant', [{ type: 'text', text: 'you do not — it stays in the keychain' }]),
    ]);
    const turn1 = def.workflow.nodes[1];
    expect(turn1?.type === 'agent' && turn1.prompt_template).toBe(
      'how do I reference { { secrets.OPENAI_KEY }} here?',
    );
    const yaml1 = serializeWorkflow(def);
    expect(() => parseWorkflow(yaml1)).not.toThrow(); // the neutralized prompt is no longer a secret reference
    expect(serializeWorkflow(parseWorkflow(yaml1))).toBe(yaml1); // still byte-stable
    // the FULL verbatim text is preserved untouched in the metadata transcript (not interpolation-scanned)
    expect(JSON.stringify(def.workflow.metadata)).toContain('{{ secrets.OPENAI_KEY }}');
  });
});
