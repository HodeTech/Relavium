import type { Agent } from '@relavium/shared';
import type { CapabilityFlags, LlmProvider, ProviderId, StreamChunk } from '@relavium/llm';
import { describe, expect, it } from 'vitest';

import type { AgentPlanConfig, PlanVertex } from '../run-plan.js';
import type { ToolCallPart, ToolRegistry, ToolResultPart } from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';
import { createAgentNodeExecutor, type AgentRunnerDeps } from './agent-runner.js';
import type { NodeExecContext, NodeStreamEvent } from './node-executor.js';

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

const STOP: StreamChunk = {
  type: 'stop',
  stopReason: 'stop',
  usage: { inputTokens: 3, outputTokens: 2 },
};

const AGENT: Agent = {
  id: 'summarizer',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You summarize.',
};

function stubRegistry(): ToolRegistry {
  return {
    has: () => true,
    list: () => [],
    dispatch: (call: ToolCallPart) => {
      const result: ToolResultPart = { type: 'tool_result', toolCallId: call.id, result: 'OK' };
      return Promise.resolve({
        output: 'OK',
        toolResult: markUntrusted(result),
        truncated: false,
        events: {
          call: { toolId: call.name, toolInput: {} },
          result: { toolId: call.name, success: true, outputSummary: 'OK' },
        },
      });
    },
  };
}

function deps(p: LlmProvider, overrides: Partial<AgentRunnerDeps> = {}): AgentRunnerDeps {
  return {
    resolveProvider: (id) => (id === 'anthropic' ? p : undefined),
    registry: stubRegistry(),
    tools: [],
    keyFor: () => 'k',
    sleep: () => Promise.resolve(),
    now: () => 1,
    ...overrides,
  };
}

type AgentNodeT = AgentPlanConfig['node'];

function agentNode(overrides: Partial<AgentNodeT> = {}): AgentNodeT {
  return {
    id: 'n1',
    type: 'agent',
    agent_ref: 'summarizer',
    prompt_template: 'Summarize: {{inputs.text}}',
    ...overrides,
  };
}

function vertexFor(config: AgentPlanConfig): PlanVertex {
  return { id: 'n1', type: 'agent', dependencies: [], dependents: [], inputSites: [], config };
}

/** The common vertex: a resolved agent + a prompt referencing `{{inputs.text}}`. */
function agentVertex(): PlanVertex {
  return vertexFor({ kind: 'agent', node: agentNode(), resolvedAgent: AGENT });
}

function ctxFor(
  vertex: PlanVertex,
  inputs: Record<string, unknown> = { text: 'hi' },
): {
  ctx: NodeExecContext;
  events: NodeStreamEvent[];
} {
  const events: NodeStreamEvent[] = [];
  return {
    events,
    ctx: {
      vertex,
      runOutputs: new Map(),
      inputs,
      toolPolicy: {},
      emit: (e) => events.push(e),
      signal: {
        aborted: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      attemptNumber: 1,
    },
  };
}

describe('createAgentNodeExecutor — dispatch', () => {
  it('runs an agent vertex and completes with the assistant text + tokensUsed', async () => {
    const exec = createAgentNodeExecutor(
      deps(provider([{ type: 'text_delta', text: 'sum' }, STOP])),
    );
    const { ctx } = ctxFor(agentVertex());
    const outcome = await exec.execute(ctx);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.output).toBe('sum');
      expect(outcome.tokensUsed).toEqual({ input: 3, output: 2, model: 'claude-opus-4-8' });
    }
  });

  it('returns a loud typed failure for a non-agent node type (1.P not yet landed)', async () => {
    const exec = createAgentNodeExecutor(deps(provider([STOP])));
    const { ctx } = ctxFor({ ...agentVertex(), type: 'transform' });
    const outcome = await exec.execute(ctx);
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'internal' } });
  });

  it('fails with validation when the agent_ref did not resolve', async () => {
    const exec = createAgentNodeExecutor(deps(provider([STOP])));
    const { ctx } = ctxFor(vertexFor({ kind: 'agent', node: agentNode() }));
    const outcome = await exec.execute(ctx);
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'validation', retryable: false },
    });
  });

  it('fails with internal when no provider is wired for the agent', async () => {
    const exec = createAgentNodeExecutor(
      deps(provider([STOP]), { resolveProvider: () => undefined }),
    );
    const { ctx } = ctxFor(agentVertex());
    const outcome = await exec.execute(ctx);
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'internal' } });
  });
});

describe('createAgentNodeExecutor — output_schema + grant', () => {
  const SCHEMA = { type: 'object', properties: { n: { type: 'number' } } };

  it('parses a JSON output when output_schema is set', async () => {
    const exec = createAgentNodeExecutor(
      deps(provider([{ type: 'text_delta', text: '{"n":1}' }, STOP])),
    );
    const { ctx } = ctxFor(
      vertexFor({
        kind: 'agent',
        node: agentNode({ output_schema: SCHEMA }),
        resolvedAgent: AGENT,
      }),
    );
    const outcome = await exec.execute(ctx);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') expect(outcome.output).toEqual({ n: 1 });
  });

  it('fails with validation when output_schema is set but the output is not JSON', async () => {
    const exec = createAgentNodeExecutor(
      deps(provider([{ type: 'text_delta', text: 'not json' }, STOP])),
    );
    const { ctx } = ctxFor(
      vertexFor({
        kind: 'agent',
        node: agentNode({ output_schema: SCHEMA }),
        resolvedAgent: AGENT,
      }),
    );
    const outcome = await exec.execute(ctx);
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'validation' } });
  });

  it('rejects a node tools[] entry that widens the agent grant (ADR-0029)', async () => {
    const agentWithTools: Agent = { ...AGENT, tools: ['read_file'] };
    const exec = createAgentNodeExecutor(deps(provider([STOP])));
    const { ctx } = ctxFor(
      vertexFor({
        kind: 'agent',
        node: agentNode({ tools: ['write_file'] }),
        resolvedAgent: agentWithTools,
      }),
    );
    const outcome = await exec.execute(ctx);
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'validation' } });
  });

  it('resolves {{inputs.x}} into a user message, leaving system as the authored prompt', async () => {
    let capturedSystem: string | undefined;
    let capturedUser: string | undefined;
    const p: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('unused');
      },
      stream: (req) => {
        capturedSystem = req.system;
        const userMsg = req.messages.find((m) => m.role === 'user');
        const part = userMsg?.content[0];
        capturedUser = part?.type === 'text' ? part.text : undefined;
        return streamOf([{ type: 'text_delta', text: 'ok' }, STOP]);
      },
    };
    const exec = createAgentNodeExecutor(deps(p));
    const { ctx } = ctxFor(agentVertex(), { text: 'the body' });
    await exec.execute(ctx);
    expect(capturedSystem).toBe('You summarize.');
    expect(capturedUser).toBe('Summarize: the body');
  });
});
