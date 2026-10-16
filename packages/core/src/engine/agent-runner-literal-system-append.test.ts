import type { Agent } from '@relavium/shared';
import type { LlmProvider, LlmRequest, StreamChunk } from '@relavium/llm';
import { describe, expect, it, vi } from 'vitest';

import {
  createWorkflowContextProjection,
  ownSecretInputNames,
} from '../interpolation/provenance.js';
import type { AgentPlanConfig, PlanVertex } from '../run-plan.js';
import { createAgentNodeExecutor, type AgentRunnerDeps } from './agent-runner.js';
import type { NodeExecContext } from './node-executor.js';

const agent: Agent = {
  id: 'summarizer',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You summarize.',
};
async function* reply(): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  yield { type: 'text_delta', text: 'completed reply' };
  yield {
    type: 'stop',
    stopReason: 'stop',
    usage: { kind: 'complete', usage: { inputTokens: 1, outputTokens: 1 } },
  };
}
function vertexFor(append: string | undefined): PlanVertex {
  const node: AgentPlanConfig['node'] = {
    id: 'agent',
    type: 'agent',
    agent_ref: 'summarizer',
    prompt_template: '{{run.outputs["up"]}}; {{inputs.text}}; {{ctx.topic}}',
    ...(append === undefined ? {} : { system_prompt_append: append }),
  };
  return {
    id: 'agent',
    type: 'agent',
    dependencies: ['up'],
    dependents: [],
    ancestors: ['up'],
    inputSites: [],
    config: { kind: 'agent', node, resolvedAgent: agent },
  };
}
function contextFor(vertex: PlanVertex): NodeExecContext {
  return {
    vertex,
    runOutputs: new Map([['up', 'OUTPUT-CANARY']]),
    inputs: { text: 'INPUT-CANARY' },
    ctx: createWorkflowContextProjection({
      values: { topic: 'CONTEXT-CANARY' },
      deniedKeys: [],
      orderedKeys: ['topic'],
    }),
    secretInputNames: ownSecretInputNames([]).secretInputNames,
    toolPolicy: {},
    emit: () => undefined,
    signal: new AbortController().signal,
    attemptNumber: 1,
  };
}

describe('literal authored system append reaches completed provider dispatch (#87)', () => {
  it.each([
    undefined,
    '',
    'Ctx: {{run.outputs["up"]}}; {{inputs.text}}; {{ctx.topic}}',
    '  first line\n{{inputs.text}}\\literal\nlast line  ',
  ])('preserves exact system separator, braces and whitespace: %j', async (append) => {
    const requests: LlmRequest[] = [];
    const stream = vi.fn((request: LlmRequest) => {
      requests.push(request);
      return reply();
    });
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: {
        tools: false,
        streaming: true,
        parallelToolCalls: false,
        vision: false,
        promptCache: false,
        reasoning: false,
        media: {
          input: { image: false, audio: false, video: false, document: false },
          outputCombinations: [],
        },
      },
      stream,
      generate: () => {
        throw new Error('unexpected generate');
      },
    };
    const deps: AgentRunnerDeps = {
      resolveProvider: () => provider,
      keyFor: () => 'offline-fixture-key',
      sleep: () => Promise.resolve(),
      tools: [],
      registry: {
        has: () => false,
        list: () => [],
        dispatch: () => {
          throw new Error('unexpected tool dispatch');
        },
      },
    };
    const outcome = await createAgentNodeExecutor(deps).execute(contextFor(vertexFor(append)));
    expect(
      outcome,
      'literal append positivity requires completed actual provider dispatch',
    ).toMatchObject({ kind: 'completed', output: 'completed reply' });
    expect(stream).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (request === undefined) throw new Error('completed dispatch omitted actual request');
    expect(request.system, 'system append is exact authored text').toBe(
      'You summarize.' + (append ? '\n\n' + append : ''),
    );
    expect(request.messages).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'text', text: 'OUTPUT-CANARY; INPUT-CANARY; CONTEXT-CANARY' }],
      },
    ]);
    for (const canary of ['OUTPUT-CANARY', 'INPUT-CANARY', 'CONTEXT-CANARY'])
      expect(request.system).not.toContain(canary);
  });
});
