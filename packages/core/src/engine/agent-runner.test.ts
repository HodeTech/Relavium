import type { Agent } from '@relavium/shared';
import type {
  CapabilityFlags,
  LlmProvider,
  LlmRequest,
  ProviderId,
  StreamChunk,
} from '@relavium/llm';
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

const DEFAULT_INPUTS: Record<string, unknown> = { text: 'hi' };

const NO_OUTPUTS: ReadonlyMap<string, unknown> = new Map();

function ctxFor(
  vertex: PlanVertex,
  inputs: Record<string, unknown> = DEFAULT_INPUTS,
  runOutputs: ReadonlyMap<string, unknown> = NO_OUTPUTS,
  ctxValues: Record<string, string> = {},
): {
  ctx: NodeExecContext;
  events: NodeStreamEvent[];
} {
  const events: NodeStreamEvent[] = [];
  return {
    events,
    ctx: {
      vertex,
      runOutputs,
      inputs,
      ctx: ctxValues,
      secretInputNames: new Set(),
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

/** A provider that records the request it received (for asserting assembly/precedence). */
function reqCapturingProvider(): { provider: LlmProvider; req: () => LlmRequest | undefined } {
  let captured: LlmRequest | undefined;
  const p: LlmProvider = {
    id: 'anthropic',
    supports: CAPS,
    generate: () => {
      throw new Error('unused');
    },
    stream: (r) => {
      captured = r;
      return streamOf([{ type: 'text_delta', text: 'ok' }, STOP]);
    },
  };
  return { provider: p, req: () => captured };
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

  it('tolerates a ```json markdown fence around the structured output', async () => {
    const exec = createAgentNodeExecutor(
      deps(provider([{ type: 'text_delta', text: '```json\n{"n":2}\n```' }, STOP])),
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
    if (outcome.kind === 'completed') expect(outcome.output).toEqual({ n: 2 });
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

  it('uses node.retry over the agent default for the primary attempt budget', async () => {
    let streamCalls = 0;
    const failing: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('unused');
      },
      stream: () => {
        streamCalls += 1;
        return streamOf([
          {
            type: 'error',
            error: { kind: 'overloaded', retryable: true, provider: 'anthropic', message: 'busy' },
          },
        ]);
      },
    };
    const exec = createAgentNodeExecutor(deps(failing));
    // AGENT has no retry (default max 1); the node override raises the primary budget to 2.
    const { ctx } = ctxFor(
      vertexFor({
        kind: 'agent',
        node: agentNode({ retry: { max: 2, backoff: 'linear' } }),
        resolvedAgent: AGENT,
      }),
    );
    const outcome = await exec.execute(ctx);
    expect(outcome.kind).toBe('failed');
    expect(streamCalls).toBe(2); // node.retry.max, not the agent default of 1
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

  it('interpolates {{ctx.*}} alongside {{inputs.*}} in the prompt (the threaded workflow context)', async () => {
    let capturedUser: string | undefined;
    const p: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('unused');
      },
      stream: (req) => {
        const userMsg = req.messages.find((m) => m.role === 'user');
        const part = userMsg?.content[0];
        capturedUser = part?.type === 'text' ? part.text : undefined;
        return streamOf([{ type: 'text_delta', text: 'ok' }, STOP]);
      },
    };
    const exec = createAgentNodeExecutor(deps(p));
    const vertex = vertexFor({
      kind: 'agent',
      node: agentNode({ prompt_template: 'Summarize {{ctx.topic}}: {{inputs.text}}' }),
      resolvedAgent: AGENT,
    });
    const { ctx } = ctxFor(vertex, { text: 'the body' }, NO_OUTPUTS, { topic: 'weather' });
    await exec.execute(ctx);
    expect(capturedUser).toBe('Summarize weather: the body');
  });

  it('applies node-over-agent precedence for model / temperature / max_tokens (ADR-0038)', async () => {
    const { provider, req } = reqCapturingProvider();
    const agent: Agent = {
      ...AGENT,
      model: 'claude-sonnet-4-6',
      temperature: 0.1,
      max_tokens: 100,
    };
    const exec = createAgentNodeExecutor(deps(provider));
    const { ctx } = ctxFor(
      vertexFor({
        kind: 'agent',
        node: agentNode({ model: 'claude-opus-4-8', temperature: 0.9, max_tokens: 500 }),
        resolvedAgent: agent,
      }),
    );
    await exec.execute(ctx);
    expect(req()?.model).toBe('claude-opus-4-8'); // node model wins (planEntries[0])
    expect(req()?.temperature).toBe(0.9); // node temperature wins
    expect(req()?.maxTokens).toBe(500); // node max_tokens wins
  });

  it('never resolves an untrusted run.outputs reference into the system role (ADR-0038)', async () => {
    const { provider, req } = reqCapturingProvider();
    const exec = createAgentNodeExecutor(deps(provider));
    const { ctx } = ctxFor(
      vertexFor({
        kind: 'agent',
        node: agentNode({ system_prompt_append: 'Ctx: {{run.outputs["up"]}}' }),
        resolvedAgent: AGENT,
      }),
      { text: 'hi' },
      new Map([['up', 'SENTINEL-UNTRUSTED-VALUE']]),
    );
    await exec.execute(ctx);
    // System is authored-only — an untrusted run.outputs value must NEVER appear resolved in `system`.
    expect(req()?.system).not.toContain('SENTINEL-UNTRUSTED-VALUE');
  });
});
