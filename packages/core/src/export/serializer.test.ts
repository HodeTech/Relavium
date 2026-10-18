import {
  AgentSchema,
  AgentSessionSchema,
  SessionContextSchema,
  type AgentSessionRecord,
  type SessionMessage,
} from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { parseAgent } from '../agent-parser.js';
import { parseWorkflow } from '../parser.js';
import { serializeAgent, serializeWorkflow, sessionToWorkflow } from './serializer.js';

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
  totalConservativeMicrocents: 0,
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

it('faithfully exports a historical agent which needs repair before current authored admission', () => {
  const agentSnapshot = {
    ...AGENT,
    fallback_chain: [
      { model: 'alternate', provider: 'openai' as const, max_attempts: 1 },
      { model: 'alternate', provider: 'openai' as const, max_attempts: 2 },
    ],
  };
  const record = AgentSessionSchema.parse(session({ agentSnapshot }));
  const workflow = sessionToWorkflow(record, []);
  expect(workflow.workflow.agents).toEqual([agentSnapshot]);
  const yaml = serializeWorkflow(workflow);
  expect(() => parseWorkflow(yaml)).toThrowError(/fallback_chain/);
  // Repair is an explicit author decision, never an exporter rewrite of frozen attempt budgets.
  const repaired = {
    ...workflow,
    workflow: {
      ...workflow.workflow,
      agents: [{ ...agentSnapshot, fallback_chain: agentSnapshot.fallback_chain.slice(0, 1) }],
    },
  };
  expect(parseWorkflow(serializeWorkflow(repaired)).workflow.agents).toEqual(
    repaired.workflow.agents,
  );
  expect(record.agentSnapshot?.fallback_chain).toEqual(agentSnapshot.fallback_chain);
});

describe('sessionToWorkflow (1.Z) — linear-chain scaffold', () => {
  it('preserves legacy bare-user prefixes in the next completed export prompt', () => {
    const messages = [
      msg(0, 'user', [{ type: 'text', text: 'legacy {{secrets.example}} context' }]),
      msg(1, 'user', [{ type: 'text', text: 'next question' }]),
      msg(2, 'assistant', [{ type: 'text', text: 'answer' }]),
    ];
    const exported = sessionToWorkflow(session(), messages);
    expect(exported.workflow.nodes).toHaveLength(3);
    const node = exported.workflow.nodes[1];
    expect(node?.type === 'agent' && node.prompt_template).toContain('legacy');
    expect(node?.type === 'agent' && node.prompt_template).toContain('next question');
    expect(node?.type === 'agent' && node.prompt_template).not.toContain('{{secrets.example}}');
    expect(parseWorkflow(serializeWorkflow(exported))).toMatchObject({
      workflow: { nodes: exported.workflow.nodes },
    });
    expect(exported.workflow.metadata).toMatchObject({ relaviumExport: { messages } });
  });

  it('keeps legacy prompt context while excluding an interrupted structural exchange and its grants', () => {
    const exported = sessionToWorkflow(session(), [
      msg(0, 'user', [{ type: 'text', text: 'legacy context' }]),
      msg(1, 'user', [{ type: 'text', text: 'interrupted' }]),
      msg(2, 'assistant', [
        { type: 'tool_call', id: 'session-tool:2:0', name: 'read_file', argsBytes: 2 },
      ]),
      msg(3, 'user', [{ type: 'text', text: 'continued' }]),
      msg(4, 'assistant', [{ type: 'text', text: '' }]),
    ]);
    expect(exported.workflow.nodes).toHaveLength(3);
    expect(exported.workflow.nodes[1]).toMatchObject({
      prompt_template: 'legacy context\n\ncontinued',
    });
    expect(exported.workflow.nodes[1]).not.toHaveProperty('tools');
  });

  it('exports completed empty finals and old compacted tool history, omitting the unresolved marker from grants', () => {
    const def = sessionToWorkflow(session(), [
      msg(0, 'user', [{ type: 'text', text: 'old' }]),
      msg(1, 'assistant', [
        { type: 'tool_call', id: 'session-tool:1:0', name: 'mcp_fs_read', argsBytes: 2 },
      ]),
      msg(2, 'tool', [
        { type: 'tool_result', toolCallId: 'session-tool:1:0', resultBytes: 4, outcome: 'ok' },
      ]),
      msg(3, 'assistant', [{ type: 'text', text: '' }]),
      { ...msg(4, 'system', []), compaction: { droppedThroughSequence: 3 } },
      msg(5, 'user', [{ type: 'text', text: 'current' }]),
      msg(6, 'assistant', [
        { type: 'tool_call', id: 'session-tool:2:0', name: 'unknown_tool', argsBytes: 2 },
      ]),
      msg(7, 'tool', [
        { type: 'tool_result', toolCallId: 'session-tool:2:0', resultBytes: 4, outcome: 'error' },
      ]),
      msg(8, 'assistant', [{ type: 'text', text: '' }]),
    ]);
    expect(def.workflow.nodes.map((node) => node.id)).toEqual([
      'input',
      'turn-1',
      'turn-2',
      'output',
    ]);
    expect(def.workflow.nodes[1]).toMatchObject({ tools: ['mcp_fs_read'] });
    expect(def.workflow.nodes[2]).not.toHaveProperty('tools');
  });
  it('maps assistant turns to a linear agent-node chain (input → turn-n → output) with edges', () => {
    const def = sessionToWorkflow(session(), [
      msg(0, 'user', [{ type: 'text', text: 'hello' }]),
      msg(1, 'assistant', [{ type: 'text', text: 'hi there' }]),
      msg(2, 'user', [{ type: 'text', text: 'use a tool' }]),
      msg(3, 'assistant', [
        { type: 'tool_call', id: 'session-tool:1:0', name: 'read_file', argsBytes: 12 },
      ]),
      msg(4, 'tool', [
        { type: 'tool_result', toolCallId: 'session-tool:1:0', resultBytes: 4, outcome: 'ok' },
      ]),
      msg(5, 'assistant', [{ type: 'text', text: 'done' }]),
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
        { type: 'tool_call', id: 'session-tool:1:0', name: 'read_file', argsBytes: 12 },
      ]),
      msg(2, 'tool', [
        { type: 'tool_result', toolCallId: 'session-tool:1:0', resultBytes: 10, outcome: 'ok' },
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
        { type: 'tool_call', id: 'session-tool:1:0', name: 'read_file', argsBytes: 12 },
        { type: 'tool_call', id: 'session-tool:1:1', name: 'read_file', argsBytes: 12 },
      ]),
      msg(2, 'assistant', [{ type: 'text', text: 'done' }]),
    ]);
    const turn1 = def.workflow.nodes[1];
    expect(turn1?.type === 'agent' && turn1.tools).toEqual(['read_file']); // not ['read_file', 'read_file']
  });

  it('derives a clean kebab workflow id (no leading/trailing/double dashes; fallback when empty)', () => {
    expect(sessionToWorkflow(session({ title: '  Hello -- World!  ' }), []).workflow.id).toBe(
      'hello-world',
    );
    expect(sessionToWorkflow(session({ title: '???' }), []).workflow.id).toBe(
      'exported-session-sess-1',
    );
  });

  it('normalizes supported Unicode title forms into deterministic ASCII IDs that round-trip', () => {
    const examples = [
      ['İstanbul Sohbeti', 'istanbul-sohbeti'],
      ['IŞIK ıslak', 'isik-islak'],
      ['Straße GROẞ', 'strasse-gross'],
      ['Café déjà vu', 'cafe-deja-vu'],
      ['Cafe\u0301 de\u0301ja\u0300 vu', 'cafe-deja-vu'],
      ['Ｆｕｌｌ １２３ ﬃ', 'full-123-ffi'],
      ['  Hello -- World!  ', 'hello-world'],
      ['東京 Launch 🚀', 'launch'],
    ];
    for (const [title, expected] of examples) {
      const record = AgentSessionSchema.parse(session({ title }));
      const def = sessionToWorkflow(record, []);
      expect(def.workflow.id, 'WAVE2_EXPORT_ASCII_NORMALIZATION').toBe(expected);
      expect(def.workflow.name).toBe(title);
      const yaml = serializeWorkflow(def);
      expect(serializeWorkflow(sessionToWorkflow(record, []))).toBe(yaml);
      expect(serializeWorkflow(parseWorkflow(yaml))).toBe(yaml);
    }
  });

  it('uses exact session identity for absent or unusable titles and preserves production UUIDs', () => {
    const ids = ['0195f389-9217-7890-aabc-0123456789ab', '0195f389-9217-7890-aabc-0123456789ac'];
    for (const id of ids) {
      for (const title of [undefined, '???', '東京', '🚀', '\u0301\u0308', '   ']) {
        const record = AgentSessionSchema.parse(session({ id, title }));
        const def = sessionToWorkflow(record, []);
        expect(def.workflow.id, 'WAVE2_EXPORT_IDENTITY_FALLBACK').toBe(`exported-session-${id}`);
        expect(def.workflow.metadata).toMatchObject({ relaviumExport: { sessionId: id } });
        const yaml = serializeWorkflow(def);
        expect(serializeWorkflow(parseWorkflow(yaml))).toBe(yaml);
        expect(serializeWorkflow(sessionToWorkflow(record, []))).toBe(yaml);
      }
    }
  });

  it('bounds odd external session identities with deterministic legal encoding and faithful metadata', () => {
    const examples = [
      ['sess-1', 'exported-session-sess-1'],
      ['a'.repeat(111), `exported-session-${'a'.repeat(111)}`],
      ['a'.repeat(112), `exported-session-id-${'0061'.repeat(24)}`],
      ['A/B', 'exported-session-id-0041002f0042'],
      ['!!!', 'exported-session-id-002100210021'],
      ['東京', 'exported-session-id-67714eac'],
      ['🚀', 'exported-session-id-d83dde80'],
      ['\ud800', 'exported-session-id-d800'],
      ['\u0000', 'exported-session-id-0000'],
      ['x'.repeat(10_000), `exported-session-id-${'0078'.repeat(24)}`],
    ];
    for (const [id, expected] of examples) {
      const record = AgentSessionSchema.parse({ ...session({ title: '???' }), id });
      const def = sessionToWorkflow(record, []);
      expect(def.workflow.id, 'WAVE2_EXPORT_EXTERNAL_ID_FALLBACK').toBe(expected);
      expect(def.workflow.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(def.workflow.id.length).toBeLessThanOrEqual(128);
      expect(def.workflow.metadata).toMatchObject({ relaviumExport: { sessionId: id } });
      const yaml = serializeWorkflow(def);
      expect(serializeWorkflow(parseWorkflow(yaml))).toBe(yaml);
      expect(serializeWorkflow(sessionToWorkflow(record, []))).toBe(yaml);
    }
  });

  it('bounds long normalized titles without a trailing separator and retains the full title', () => {
    for (const title of ['a'.repeat(10_000), `${'a'.repeat(127)} b`, 'ß'.repeat(100)]) {
      const def = sessionToWorkflow(session({ title }), []);
      expect(def.workflow.id.length).toBeLessThanOrEqual(128);
      expect(def.workflow.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(def.workflow.name).toBe(title);
      const yaml = serializeWorkflow(def);
      expect(serializeWorkflow(parseWorkflow(yaml))).toBe(yaml);
    }
    expect(sessionToWorkflow(session({ title: `${'a'.repeat(127)} b` }), []).workflow.id).toBe(
      'a'.repeat(127),
    );
  });

  it('does not promise unique IDs for normalized titles or truncated external identities', () => {
    const first = sessionToWorkflow(session({ id: 'one', title: 'Café' }), []);
    const second = sessionToWorkflow(session({ id: 'two', title: 'Cafe' }), []);
    expect(first.workflow.id).toBe('cafe');
    expect(second.workflow.id).toBe(first.workflow.id);
    expect(first.workflow.metadata).not.toEqual(second.workflow.metadata);
    const prefix = 'X'.repeat(24);
    expect(sessionToWorkflow(session({ id: `${prefix}one`, title: '???' }), []).workflow.id).toBe(
      sessionToWorkflow(session({ id: `${prefix}two`, title: '???' }), []).workflow.id,
    );
  });

  it('omits a trailing interrupted tool-loop turn from the node chain, keeping it in metadata (matches resume)', () => {
    const def = sessionToWorkflow(session(), [
      msg(0, 'user', [{ type: 'text', text: 'q1' }]),
      msg(1, 'assistant', [{ type: 'text', text: 'a1' }]), // a completed exchange
      msg(2, 'user', [{ type: 'text', text: 'q2 use a tool' }]), // interrupted — no final assistant text
      msg(3, 'assistant', [
        { type: 'tool_call', id: 'session-tool:1:0', name: 'read_file', argsBytes: 2 },
      ]),
      msg(4, 'tool', [
        { type: 'tool_result', toolCallId: 'session-tool:1:0', resultBytes: 4, outcome: 'ok' },
      ]),
    ]);
    // only the completed turn becomes a node (consistent with reconstructSessionState's rollback)…
    expect(def.workflow.nodes.map((n) => n.id)).toEqual(['input', 'turn-1', 'output']);
    const turn1 = def.workflow.nodes[1];
    expect(turn1?.type === 'agent' && turn1.prompt_template).toBe('q1');
    // …but the interrupted attempt is still preserved verbatim in the transcript
    expect(JSON.stringify(def.workflow.metadata)).toContain('q2 use a tool');
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

  it('preserves reasoning text literally; structural ephemeral fields are excluded upstream', () => {
    const yaml = serializeWorkflow(
      sessionToWorkflow(session(), [
        msg(0, 'user', [{ type: 'text', text: 'think about it' }]),
        msg(1, 'assistant', [
          { type: 'reasoning', text: 'internal reasoning here; signature: literal; secret: true' },
          { type: 'text', text: 'the answer' },
        ]),
      ]),
    );
    // The serializer faithfully emits a valid durable transcript. SessionMessage's upstream boundary
    // excludes structural signatures/MaskedSecret carriers; this text emitter does not filter keywords.
    const reparsed = parseWorkflow(yaml);
    expect(reparsed.workflow.metadata).toMatchObject({
      relaviumExport: {
        messages: [
          { role: 'user' },
          {
            role: 'assistant',
            content: [
              {
                type: 'reasoning',
                text: 'internal reasoning here; signature: literal; secret: true',
              },
              { type: 'text', text: 'the answer' },
            ],
          },
        ],
      },
    });
    expect(serializeWorkflow(reparsed)).toBe(yaml);
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

describe('serializeAgent (2.J authoring) — deterministic, round-trippable .agent.yaml emitter', () => {
  const AGENT = `# my agent (this comment is dropped on re-serialize)
id: code-reviewer
provider: anthropic
model: claude-sonnet-4-6
system_prompt: You are a precise reviewer.
tools: [read_file]
`;

  it('round-trips: parse → serialize → parse is byte-stable, and the output re-parses', () => {
    const agent = parseAgent(AGENT);
    const yaml1 = serializeAgent(agent);
    const reparsed = parseAgent(yaml1); // must not throw — the emitted agent is valid
    expect(serializeAgent(reparsed)).toBe(yaml1); // byte-stable round-trip
    expect(reparsed.id).toBe('code-reviewer');
  });

  it('is deterministic (sorted keys) and drops authored comments (re-serializing from the validated AST)', () => {
    const yaml = serializeAgent(parseAgent(AGENT));
    expect(serializeAgent(parseAgent(AGENT))).toBe(yaml); // stable across repeated emits
    expect(yaml).not.toContain('this comment is dropped'); // comments are not part of the AST
    // sorted map keys: `id` precedes `model` precedes `provider` precedes `system_prompt`
    expect(yaml.indexOf('id:')).toBeLessThan(yaml.indexOf('model:'));
    expect(yaml.indexOf('model:')).toBeLessThan(yaml.indexOf('provider:'));
  });

  it('preserves a {{secrets.*}} placeholder in an MCP server env (never a resolved value)', () => {
    const yaml = serializeAgent(
      parseAgent(
        `id: gh\nprovider: anthropic\nmodel: claude-sonnet-4-6\nsystem_prompt: go\nmcp_servers:\n  - id: github\n    transport: stdio\n    command: gh-mcp\n    env: { TOKEN: '{{secrets.gh}}' }\n`,
      ),
    );
    expect(yaml).toContain('{{secrets.gh}}'); // the placeholder survives without keychain resolution
  });

  it('faithfully retains sensitive authored literals instead of claiming whole-document scrubbing', () => {
    const literal = 'sk-authored-sensitive-literal-12345678901234567890';
    const agent = parseAgent(`${AGENT}\ndescription: ${literal}\n`);
    agent.system_prompt = `Review this sensitive text: ${literal}`;
    const yaml = serializeAgent(agent);
    expect(yaml).toContain(literal);
    expect(parseAgent(yaml)).toEqual(agent);
  });
});
