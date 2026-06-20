import type { Agent, ContentPart, OutputModality } from '@relavium/shared';
import { LlmProviderError, UnsupportedCapabilityError, makeLlmError } from '@relavium/llm';
import type {
  CapabilityFlags,
  LlmProvider,
  LlmRequest,
  MediaGenRequest,
  MediaGenResult,
  ProviderId,
  StreamChunk,
} from '@relavium/llm';
import { describe, expect, it } from 'vitest';

import type { AgentPlanConfig, PlanVertex } from '../run-plan.js';
import type { ToolCallPart, ToolRegistry, ToolResultPart } from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';
import {
  buildMediaUnitsEstimate,
  createAgentNodeExecutor,
  DEFAULT_MEDIA_UNIT_ESTIMATE,
  type AgentRunnerDeps,
} from './agent-runner.js';
import { BudgetExceededError } from './budget-governor.js';
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

/** A provider that records the request it received (for asserting assembly/precedence). `supports`
 *  defaults to CAPS; pass an override to exercise the capability pre-skip (e.g. output combinations). */
function reqCapturingProvider(supports: CapabilityFlags = CAPS): {
  provider: LlmProvider;
  req: () => LlmRequest | undefined;
} {
  let captured: LlmRequest | undefined;
  const p: LlmProvider = {
    id: 'anthropic',
    supports,
    // A media-output turn routes to generate() (1.AG/ADR-0046); a text turn streams. Capture on both
    // so the request is observable whichever path the node's output_modalities select. Return a media part
    // for a media request so the node COMPLETES (not the no-media → validation failure), keeping these
    // request-assembly tests on the success path.
    generate: (r) => {
      captured = r;
      const wantsMedia = r.outputModalities?.some((m) => m !== 'text') ?? false;
      return Promise.resolve({
        content: wantsMedia
          ? [{ type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'aW1n' } }]
          : [{ type: 'text', text: 'ok' }],
        stopReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
    stream: (r) => {
      captured = r;
      return streamOf([{ type: 'text_delta', text: 'ok' }, STOP]);
    },
  };
  return { provider: p, req: () => captured };
}

/** CAPS that can emit the given output-modality combinations (media-output capable). */
function capsWithOutput(combinations: readonly (readonly OutputModality[])[]): CapabilityFlags {
  return {
    ...CAPS,
    media: { input: CAPS.media.input, outputCombinations: combinations.map((c) => [...c]) },
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

  it('surfaces inline media-out as { text, media } so the engine can de-inline it (1.AG/ADR-0046)', async () => {
    const image: ContentPart = {
      type: 'media',
      mimeType: 'image/png',
      source: { kind: 'base64', data: 'aW1nLWJ5dGVz' },
    };
    // A provider whose generate() returns media; its stream THROWS — proving the media node routed to generate().
    const mediaProvider: LlmProvider = {
      id: 'gemini',
      supports: capsWithOutput([['text', 'image']]),
      generate: () =>
        Promise.resolve({
          content: [{ type: 'text', text: 'here' }, image],
          stopReason: 'stop',
          usage: { inputTokens: 3, outputTokens: 2 },
        }),
      stream: (): AsyncIterable<StreamChunk> => {
        throw new Error('stream must NOT run for an inline media-out turn');
      },
    };
    const exec = createAgentNodeExecutor(deps(mediaProvider));
    const { ctx } = ctxFor(
      vertexFor({
        kind: 'agent',
        node: agentNode({ output_modalities: ['text', 'image'] }),
        resolvedAgent: AGENT,
      }),
    );
    const outcome = await exec.execute(ctx);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      // The in-flight base64 media survives to the node output; the engine de-inlines it at #emitDurable.
      expect(outcome.output).toEqual({ text: 'here', media: [image] });
    }
  });

  it('FAILS visibly when a media node produced no media — never a silent text completion (Opus-fix, ADR-0046)', async () => {
    // A capable model that returns text-only (a refusal, or ignoring the modality) must not pass off the
    // incidental text as a successful media turn — the declared-capability pre-skip cannot catch this.
    const textOnlyProvider: LlmProvider = {
      id: 'gemini',
      supports: capsWithOutput([['text', 'image']]),
      generate: () =>
        Promise.resolve({
          content: [{ type: 'text', text: 'I cannot make an image' }],
          stopReason: 'stop',
          usage: { inputTokens: 3, outputTokens: 2 },
        }),
      stream: (): AsyncIterable<StreamChunk> => {
        throw new Error('stream must NOT run for a media-out turn');
      },
    };
    const exec = createAgentNodeExecutor(deps(textOnlyProvider));
    const { ctx } = ctxFor(
      vertexFor({
        kind: 'agent',
        node: agentNode({ output_modalities: ['text', 'image'] }),
        resolvedAgent: AGENT,
      }),
    );
    const outcome = await exec.execute(ctx);
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'validation', retryable: false },
    });
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

  it('does NOT use node.retry for within-chain primary retry (it is the engine above-chain budget, ADR-0040)', async () => {
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
    // node.retry is the engine's ABOVE-chain budget now (ADR-0040) — the AgentRunner no longer feeds it
    // into the primary chain entry, so the primary still gets a single within-chain attempt. The
    // retryable failure surfaces to the engine, which owns the re-dispatch.
    const { ctx } = ctxFor(
      vertexFor({
        kind: 'agent',
        node: agentNode({ retry: { max: 2, backoff: 'linear' } }),
        resolvedAgent: AGENT,
      }),
    );
    const outcome = await exec.execute(ctx);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error.retryable).toBe(true); // surfaced as retryable for the engine's node-retry budget
    }
    expect(streamCalls).toBe(1); // a single primary attempt — node.retry does NOT drive within-chain retry
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

  it("lowers a node's output_modalities onto the LlmRequest (1.AF/D15 — the FallbackChain pre-skip backstop)", async () => {
    // Without this the request carries no outputModalities and the FallbackChain output-combination
    // pre-skip can never fire, so an incapable model silently returns text (ADR-0044 §2's forbidden drop).
    const { provider, req } = reqCapturingProvider(capsWithOutput([['text', 'image']]));
    const exec = createAgentNodeExecutor(deps(provider));
    const { ctx } = ctxFor(
      vertexFor({
        kind: 'agent',
        node: agentNode({ output_modalities: ['text', 'image'] }),
        resolvedAgent: AGENT,
      }),
    );
    const outcome = await exec.execute(ctx);
    expect(outcome.kind).toBe('completed'); // the media provider returns a media part → success path
    expect(req()?.outputModalities).toEqual(['text', 'image']);
  });

  it('the FallbackChain SKIPS a provider that cannot emit the requested output combination (no silent text drop)', async () => {
    // The backstop in action: a model whose outputCombinations lack the requested set is skipped — the
    // chain exhausts and the turn FAILS, rather than the incapable provider silently returning text.
    const { provider } = reqCapturingProvider(capsWithOutput([['text']])); // text-only model
    const exec = createAgentNodeExecutor(deps(provider));
    const { ctx } = ctxFor(
      vertexFor({
        kind: 'agent',
        node: agentNode({ output_modalities: ['text', 'image'] }),
        resolvedAgent: AGENT,
      }),
    );
    const outcome = await exec.execute(ctx);
    expect(outcome.kind).toBe('failed'); // skipped → chain exhausted → a typed failure, never a text completion
  });

  it('omits outputModalities from the request for a text-only node (no spurious field)', async () => {
    const { provider, req } = reqCapturingProvider();
    const exec = createAgentNodeExecutor(deps(provider));
    const { ctx } = ctxFor(agentVertex());
    await exec.execute(ctx);
    expect(req()?.outputModalities).toBeUndefined();
  });
});

describe('buildMediaUnitsEstimate (1.AF/D17 — media-cost unit estimate)', () => {
  it('returns [] for a text-only node (no output_modalities)', () => {
    expect(buildMediaUnitsEstimate(undefined, undefined)).toEqual([]);
  });

  it('excludes `text` and emits one entry per BILLED modality with the config unit count', () => {
    expect(buildMediaUnitsEstimate(['text', 'image', 'audio'], { image: 2, audio: 30 })).toEqual([
      { modality: 'image', units: 2 },
      { modality: 'audio', units: 30 },
    ]);
  });

  it('falls back to the built-in default count for a modality the config omits', () => {
    expect(buildMediaUnitsEstimate(['video'], { image: 9 })).toEqual([
      { modality: 'video', units: DEFAULT_MEDIA_UNIT_ESTIMATE.video },
    ]);
    expect(buildMediaUnitsEstimate(['image'], undefined)).toEqual([
      { modality: 'image', units: DEFAULT_MEDIA_UNIT_ESTIMATE.image },
    ]);
  });
});

describe('createAgentNodeExecutor — generative media (1.AG Section C, generateMedia)', () => {
  // Typed as the media variant so it satisfies MediaGenResult.media (and a node output) without a cast.
  const image: Extract<ContentPart, { type: 'media' }> = {
    type: 'media',
    mimeType: 'image/png',
    source: { kind: 'base64', data: 'Z2VuLWltYWdl' },
  };

  /** A provider flagged media_surface 'generative' whose generateMedia returns (or throws). generate/stream
   *  THROW — proving a generative node never touches the inline turn path. */
  function generativeProvider(behavior?: { result?: MediaGenResult; throws?: Error }): LlmProvider {
    const base = capsWithOutput([['image']]);
    return {
      id: 'openai',
      supports: { ...base, media: { ...base.media, surface: 'generative' } },
      generate: () => {
        throw new Error('generate must NOT run for a generative node');
      },
      stream: (): AsyncIterable<StreamChunk> => {
        throw new Error('stream must NOT run for a generative node');
      },
      generateMedia: () =>
        behavior?.throws !== undefined
          ? Promise.reject(behavior.throws)
          : Promise.resolve(behavior?.result ?? { media: image, raw: { internal: true } }),
    };
  }
  const genDeps = (p: LlmProvider, over: Partial<AgentRunnerDeps> = {}): AgentRunnerDeps =>
    deps(p, { resolveMediaSurface: () => 'generative', ...over });
  const genVertex = (over: Partial<AgentPlanConfig['node']> = {}): PlanVertex =>
    vertexFor({
      kind: 'agent',
      node: agentNode({ output_modalities: ['image'], ...over }),
      resolvedAgent: AGENT,
    });

  it('routes a generative model to generateMedia and outputs { text:"", media:[part] } + one token-free cost:updated', async () => {
    const exec = createAgentNodeExecutor(genDeps(generativeProvider()));
    const { ctx, events } = ctxFor(genVertex());
    const outcome = await exec.execute(ctx);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.output).toEqual({ text: '', media: [image] }); // raw is NOT placed in the media part
    }
    const cost = events.filter((e) => e.type === 'cost:updated');
    expect(cost).toHaveLength(1); // exactly one realized addend (ADR-0045 §5)
    expect(cost[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      nodeId: 'n1',
      model: 'claude-opus-4-8',
    });
  });

  it('a chat model (default surface, no resolveMediaSurface) keeps the normal turn — never generateMedia', async () => {
    // No resolveMediaSurface dep → default 'chat'. The provider's generateMedia would throw if reached.
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('unused');
      },
      stream: () => streamOf([{ type: 'text_delta', text: 'hi' }, STOP]),
      generateMedia: () => Promise.reject(new Error('generateMedia must NOT run for a chat node')),
    };
    const exec = createAgentNodeExecutor(deps(provider)); // no resolveMediaSurface
    const { ctx } = ctxFor(agentVertex());
    const outcome = await exec.execute(ctx);
    expect(outcome).toMatchObject({ kind: 'completed', output: 'hi' });
  });

  it('fails internal when the model is generative but the provider implements no generateMedia (host-wiring gap)', async () => {
    const base = capsWithOutput([['image']]);
    const provider: LlmProvider = {
      id: 'openai',
      supports: { ...base, media: { ...base.media, surface: 'generative' } },
      generate: () => {
        throw new Error('unused');
      },
      stream: (): AsyncIterable<StreamChunk> => streamOf([STOP]),
      // no generateMedia
    };
    const exec = createAgentNodeExecutor(genDeps(provider));
    const outcome = await exec.execute(ctxFor(genVertex()).ctx);
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'internal' } });
  });

  it('hands a jobId off as a media_job outcome for the engine poll loop (1.AG Section D)', async () => {
    const jobExec = createAgentNodeExecutor(
      genDeps(generativeProvider({ result: { jobId: 'job-1', raw: {} } })),
    );
    const outcome = await jobExec.execute(ctxFor(genVertex({ count: 2 })).ctx);
    expect(outcome).toMatchObject({
      kind: 'media_job',
      job: {
        jobId: 'job-1',
        provider: 'openai',
        model: 'claude-opus-4-8',
        modality: 'image',
        units: 2, // the authored count → the engine's lone realized cost addend at done
      },
    });
  });

  it('fails validation when a generative node does not declare exactly one media modality', async () => {
    const exec = createAgentNodeExecutor(genDeps(generativeProvider()));
    // text+image (has text + two members) is rejected — a generative model emits pure media.
    const outcome = await exec.execute(
      ctxFor(genVertex({ output_modalities: ['text', 'image'] })).ctx,
    );
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'validation' } });
  });

  it('gates pre-egress with maxTokens:0 + the media estimate → budget_exceeded (no generateMedia egress)', async () => {
    let called = false;
    let info: { maxTokens?: number; mediaUnitsEstimate?: unknown } | undefined;
    const provider = generativeProvider();
    const wrapped: LlmProvider = {
      ...provider,
      generateMedia: (req, key) => {
        called = true;
        return provider.generateMedia?.(req, key) ?? Promise.reject(new Error('no'));
      },
    };
    const exec = createAgentNodeExecutor(
      genDeps(wrapped, {
        preEgress: (i) => {
          info = i;
          return Promise.reject(new BudgetExceededError(100, 50, 120));
        },
      }),
    );
    const outcome = await exec.execute(ctxFor(genVertex({ count: 2 })).ctx);
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'budget_exceeded' } });
    expect(called).toBe(false); // gate fails before any provider egress
    // The gate pins the TOKEN estimate to 0 (a generative call emits none) + carries the authored media volume.
    expect(info?.maxTokens).toBe(0);
    expect(info?.mediaUnitsEstimate).toEqual([{ modality: 'image', units: 2 }]);
  });

  it('maps a generateMedia provider error through the chat taxonomy (content_filter stays content_filter)', async () => {
    const exec = createAgentNodeExecutor(
      genDeps(
        generativeProvider({
          throws: new LlmProviderError(
            makeLlmError({ provider: 'openai', kind: 'content_filter', message: 'blocked' }),
          ),
        }),
      ),
    );
    const outcome = await exec.execute(ctxFor(genVertex()).ctx);
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'content_filter' } });
  });

  it('fails validation for an empty resolved prompt (the seam nonEmptyString contract) — no provider egress', async () => {
    let called = false;
    const provider = generativeProvider();
    const wrapped: LlmProvider = {
      ...provider,
      generateMedia: (req, key) => {
        called = true;
        return provider.generateMedia?.(req, key) ?? Promise.reject(new Error('no'));
      },
    };
    // A node with no prompt_template resolves to an empty prompt.
    const exec = createAgentNodeExecutor(genDeps(wrapped));
    const ctx = ctxFor(
      vertexFor({
        kind: 'agent',
        node: { id: 'n1', type: 'agent', agent_ref: 'summarizer', output_modalities: ['image'] },
        resolvedAgent: AGENT,
      }),
    ).ctx;
    expect(await exec.execute(ctx)).toMatchObject({
      kind: 'failed',
      error: { code: 'validation' },
    });
    expect(called).toBe(false);
  });

  it('maps the authored count/duration_seconds onto the MediaGenRequest at dispatch', async () => {
    let captured: MediaGenRequest | undefined;
    const base = capsWithOutput([['image']]);
    const provider: LlmProvider = {
      id: 'openai',
      supports: { ...base, media: { ...base.media, surface: 'generative' } },
      generate: () => {
        throw new Error('unused');
      },
      stream: (): AsyncIterable<StreamChunk> => {
        throw new Error('unused');
      },
      generateMedia: (req) => {
        captured = req;
        return Promise.resolve({ media: image, raw: {} });
      },
    };
    const exec = createAgentNodeExecutor(genDeps(provider));
    await exec.execute(ctxFor(genVertex({ count: 4 })).ctx);
    expect(captured?.count).toBe(4);
    expect(captured?.durationSeconds).toBeUndefined();
    expect(captured?.modality).toBe('image');
    expect(captured?.prompt).toBe('Summarize: hi'); // the resolved prompt_template
  });

  it('forwards duration_seconds → durationSeconds for an audio generative node', async () => {
    let captured: MediaGenRequest | undefined;
    const audio: Extract<ContentPart, { type: 'media' }> = {
      type: 'media',
      mimeType: 'audio/wav',
      source: { kind: 'base64', data: 'YXVkaW8=' },
    };
    const base = capsWithOutput([['audio']]);
    const provider: LlmProvider = {
      id: 'openai',
      supports: { ...base, media: { ...base.media, surface: 'generative' } },
      generate: () => {
        throw new Error('unused');
      },
      stream: (): AsyncIterable<StreamChunk> => {
        throw new Error('unused');
      },
      generateMedia: (req) => {
        captured = req;
        return Promise.resolve({ media: audio, raw: {} });
      },
    };
    const exec = createAgentNodeExecutor(genDeps(provider));
    const outcome = await exec.execute(
      ctxFor(genVertex({ output_modalities: ['audio'], duration_seconds: 8 })).ctx,
    );
    expect(outcome.kind).toBe('completed');
    expect(captured?.durationSeconds).toBe(8);
    expect(captured?.modality).toBe('audio');
    expect(captured?.count).toBeUndefined();
  });

  it('fails internal on a neither-media-nor-jobId result (the unreachable-in-practice guard)', async () => {
    const exec = createAgentNodeExecutor(genDeps(generativeProvider({ result: { raw: {} } })));
    expect(await exec.execute(ctxFor(genVertex()).ctx)).toMatchObject({
      kind: 'failed',
      error: { code: 'internal' },
    });
  });

  it('classifies a seam UnsupportedCapabilityError as validation (not opaque internal)', async () => {
    const exec = createAgentNodeExecutor(
      genDeps(
        generativeProvider({
          throws: new UnsupportedCapabilityError('openai', 'media', 'no audio'),
        }),
      ),
    );
    expect(await exec.execute(ctxFor(genVertex()).ctx)).toMatchObject({
      kind: 'failed',
      error: { code: 'validation' },
    });
  });

  it('redacts a keyFor throw into a fixed provider_auth failure (no secret leak)', async () => {
    const exec = createAgentNodeExecutor(
      genDeps(generativeProvider(), {
        keyFor: () => {
          throw new Error('SECRET-BEARING-KEY-RESOLUTION-DETAIL');
        },
      }),
    );
    const outcome = await exec.execute(ctxFor(genVertex()).ctx);
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'provider_auth' } });
    if (outcome.kind === 'failed') {
      expect(outcome.error.message).not.toContain('SECRET-BEARING-KEY-RESOLUTION-DETAIL');
    }
  });

  it('fails validation when the produced media modality does not match the request (defense-in-depth)', async () => {
    const audio: Extract<ContentPart, { type: 'media' }> = {
      type: 'media',
      mimeType: 'audio/wav',
      source: { kind: 'base64', data: 'YXVkaW8=' },
    };
    const exec = createAgentNodeExecutor(
      genDeps(generativeProvider({ result: { media: audio, raw: {} } })),
    );
    // node requests image, provider returns audio → validation
    expect(await exec.execute(ctxFor(genVertex()).ctx)).toMatchObject({
      kind: 'failed',
      error: { code: 'validation' },
    });
  });

  it('a pre-aborted signal fails cancelled with no generateMedia egress', async () => {
    let called = false;
    const provider = generativeProvider();
    const wrapped: LlmProvider = {
      ...provider,
      generateMedia: (req, key) => {
        called = true;
        return provider.generateMedia?.(req, key) ?? Promise.reject(new Error('no'));
      },
    };
    const { ctx } = ctxFor(genVertex());
    const aborted: NodeExecContext = {
      ...ctx,
      signal: {
        aborted: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    };
    expect(await createAgentNodeExecutor(genDeps(wrapped)).execute(aborted)).toMatchObject({
      kind: 'failed',
      error: { code: 'cancelled' },
    });
    expect(called).toBe(false);
  });
});
