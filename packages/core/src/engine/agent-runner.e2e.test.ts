import type { CapabilityFlags, LlmProvider, ProviderId, StreamChunk } from '@relavium/llm';
import type { RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { parseWorkflow } from '../parser.js';
import type { ToolRegistry } from '../tools/types.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';
import type { RunHandle } from './run-handle.js';

const CAPS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: false,
  promptCache: false,
  reasoning: true,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
  },
};

async function* streamOf(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  for (const c of chunks) yield c;
}

function provider(chunks: StreamChunk[], id: ProviderId = 'anthropic'): LlmProvider {
  return {
    id,
    supports: CAPS,
    generate: () => {
      throw new Error('unused');
    },
    stream: () => streamOf(chunks),
  };
}

/** A registry that is never dispatched (the e2e agent uses no tools). */
const noToolRegistry: ToolRegistry = {
  has: () => false,
  list: () => [],
  dispatch: () => Promise.reject(new Error('no tool dispatch expected')),
};

const WORKFLOW = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: e2e-agent
  inputs:
    - name: text
      type: string
  agents:
    - id: summarizer
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: You summarize.
  nodes:
    - id: sum
      type: agent
      agent_ref: summarizer
      prompt_template: 'Summarize: {{inputs.text}}'
  edges: []
`,
);

async function drain(handle: RunHandle): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

function assertGapFreeSeq(events: readonly RunEvent[]): void {
  const seqs = events.map((e) => e.sequenceNumber).sort((a, b) => a - b);
  seqs.forEach((seq, index) => expect(seq).toBe(index));
}

describe('AgentRunner end-to-end through the WorkflowEngine', () => {
  it('runs an agent node, streaming tokens + cost, to run:completed', async () => {
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: createAgentNodeExecutor({
        resolveProvider: () =>
          provider([
            { type: 'text_delta', text: 'a summary' },
            { type: 'stop', stopReason: 'stop', usage: { inputTokens: 8, outputTokens: 4 } },
          ]),
        registry: noToolRegistry,
        tools: [],
        keyFor: () => 'key',
        sleep: () => Promise.resolve(),
        now: () => 1,
      }),
    });

    const events = await drain(
      engine.start({ workflow: WORKFLOW, inputs: { text: 'the report' } }),
    );
    const types = events.map((e) => e.type);

    // The canonical sequence by colon name, gap-free.
    expect(types).toContain('run:started');
    expect(types).toContain('node:started');
    expect(types).toContain('agent:token');
    expect(types).toContain('cost:updated');
    expect(types.at(-1)).toBe('run:completed');
    assertGapFreeSeq(events);

    // The agent's streamed token + the node output.
    const token = events.find((e) => e.type === 'agent:token');
    expect(token?.type === 'agent:token' && token.token).toBe('a summary');
    const completed = events.find((e) => e.type === 'node:completed');
    expect(completed?.type === 'node:completed' && completed.output).toBe('a summary');
  });

  it('drives the fallback chain and still completes when the primary errors pre-content', async () => {
    const primary = provider([
      {
        type: 'error',
        error: { kind: 'overloaded', retryable: true, provider: 'anthropic', message: 'busy' },
      },
    ]);
    const fallback = provider(
      [
        { type: 'text_delta', text: 'fallback wins' },
        { type: 'stop', stopReason: 'stop', usage: { inputTokens: 2, outputTokens: 2 } },
      ],
      'openai',
    );
    // The agent's fallback_chain adds a second provider id; resolveProvider maps both to stubs.
    const wf = parseWorkflow(
      `schema_version: '1.0'
workflow:
  id: e2e-fallback
  agents:
    - id: a
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
      fallback_chain:
        - model: claude-sonnet-4-6
          provider: openai
          max_attempts: 1
  nodes:
    - id: n
      type: agent
      agent_ref: a
      prompt_template: 'go'
  edges: []
`,
    );
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: createAgentNodeExecutor({
        resolveProvider: (id) => (id === 'anthropic' ? primary : fallback),
        registry: noToolRegistry,
        tools: [],
        keyFor: () => 'key',
        sleep: () => Promise.resolve(),
        now: () => 1,
      }),
    });

    const events = await drain(engine.start({ workflow: wf }));
    expect(events.map((e) => e.type).at(-1)).toBe('run:completed');
    const completed = events.find((e) => e.type === 'node:completed');
    expect(completed?.type === 'node:completed' && completed.output).toBe('fallback wins');
  });
});
