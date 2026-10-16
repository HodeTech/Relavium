/** ADR-0113 / review R3: optional public text cannot make provenance optional. */
import type { LlmProvider, LlmRequest, ModelPricing, StreamChunk } from '@relavium/llm';
import type { RunEvent } from '@relavium/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { createExpressionSandbox, type ExpressionSandbox } from '../expression/sandbox.js';
import {
  createWorkflowContextProjection,
  ownSecretInputNames,
} from '../interpolation/provenance.js';
import { parseWorkflow } from '../parser.js';
import type { PlanVertex } from '../run-plan.js';
import { createAgentNodeExecutor, type AgentRunnerDeps } from './agent-runner.js';
import { WorkflowEngine } from './engine.js';
import { createAbortController, createInMemoryHost } from './execution-host.js';
import type { NodeExecContext, NodeExecutor } from './node-executor.js';
import { createStandardNodeExecutor } from './node-handlers/dispatcher.js';

const PRIVATE = 'EMPTY-TEMPLATE-MALFORMED-PRIVATE-CANARY';
const MODEL = 'offline-empty-template';
const VALIDATION = {
  kind: 'failed',
  error: {
    code: 'validation',
    message: 'workflow context provenance is missing or invalid',
    retryable: false,
  },
};
const PRICES = new Map<string, ModelPricing>([
  [
    MODEL,
    {
      provider: 'openai',
      nativeId: MODEL,
      displayName: MODEL,
      contextWindowTokens: 128_000,
      maxOutputTokens: 1000,
      inputPerMtokMicrocents: 1_000_000,
      outputPerMtokMicrocents: 1_000_000,
      cachedInputPerMtokMicrocents: 0,
    },
  ],
]);

let sandbox: ExpressionSandbox;
beforeAll(async () => {
  sandbox = await createExpressionSandbox();
});

function vertex(kind: 'agent' | 'gate', explicitEmpty = false): PlanVertex {
  return {
    id: kind,
    type: kind === 'agent' ? 'agent' : 'human_in_the_loop',
    dependencies: [],
    dependents: [],
    ancestors: [],
    inputSites: [],
    config:
      kind === 'agent'
        ? {
            kind: 'agent',
            node: {
              id: kind,
              type: 'agent',
              agent_ref: 'offline',
              max_tokens: 16,
              ...(explicitEmpty ? { prompt_template: '' } : {}),
            },
            resolvedAgent: {
              id: 'offline',
              provider: 'openai',
              model: MODEL,
              system_prompt: 'Public system instruction',
            },
          }
        : {
            kind: 'human_in_the_loop',
            node: {
              id: kind,
              type: 'human_gate',
              gate_type: 'approval',
              ...(explicitEmpty ? { message_template: '' } : {}),
            },
          },
  };
}

function context(planVertex: PlanVertex): NodeExecContext {
  return {
    vertex: planVertex,
    inputs: {},
    runOutputs: new Map(),
    ctx: createWorkflowContextProjection({ values: {}, deniedKeys: [], orderedKeys: [] }),
    secretInputNames: ownSecretInputNames([]).secretInputNames,
    toolPolicy: {},
    emit: () => undefined,
    signal: createAbortController().signal,
    attemptNumber: 1,
  };
}

// These are unmigrated runtime embeddings, not valid TypeScript producers. Mutate only the
// embedding's own context copy so the actual public consumer has to validate the boundary.
const INVALID_METADATA = [
  {
    name: 'missing context projection',
    corrupt: (ctx: NodeExecContext) => Reflect.deleteProperty(ctx, 'ctx'),
  },
  {
    name: 'malformed context projection',
    corrupt: (ctx: NodeExecContext) =>
      Reflect.set(ctx, 'ctx', { values: { private: PRIVATE }, deniedKeys: [], orderedKeys: [] }),
  },
  {
    name: 'missing secret-input membership',
    corrupt: (ctx: NodeExecContext) => Reflect.deleteProperty(ctx, 'secretInputNames'),
  },
];

function fixture() {
  const requests: LlmRequest[] = [];
  let keyReads = 0;
  const provider: LlmProvider = {
    id: 'openai',
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
    generate: () => {
      throw new Error('offline fixture expects streaming');
    },
    async *stream(request): AsyncGenerator<StreamChunk> {
      requests.push(request);
      await Promise.resolve();
      yield { type: 'text_delta', text: 'public answer' };
      yield {
        type: 'stop',
        stopReason: 'stop',
        usage: { kind: 'complete', usage: { inputTokens: 1, outputTokens: 1 } },
      };
    },
  };
  const deps: AgentRunnerDeps = {
    resolveProvider: () => provider,
    keyFor: () => {
      keyReads += 1;
      return 'synthetic-offline-key';
    },
    sleep: () => Promise.resolve(),
    tools: [],
    resolvePrice: PRICES,
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => Promise.reject(new Error('offline fixture advertises no tools')),
    },
  };
  return {
    standard: createStandardNodeExecutor({ sandbox, agent: deps }),
    agent: createAgentNodeExecutor(deps),
    requests,
    keyReads: () => keyReads,
  };
}

describe('empty public templates retain the required provenance boundary (ADR-0113 / R3)', () => {
  for (const explicitEmpty of [false, true]) {
    const text = explicitEmpty ? 'explicit empty text' : 'absent optional text';

    it.each(INVALID_METADATA)(
      `standard human gate refuses $name with ${text}`,
      async ({ corrupt }) => {
        const run = fixture();
        const ctx = context(vertex('gate', explicitEmpty));
        expect(corrupt(ctx)).toBe(true);
        expect(await run.standard.execute(ctx)).toEqual(VALIDATION);
        expect(run.requests).toEqual([]);
        expect(run.keyReads()).toBe(0);
      },
    );

    for (const executorName of ['agent', 'standard'] as const) {
      it.each(INVALID_METADATA)(
        `${executorName} execution refuses $name with ${text} before provider invocation`,
        async ({ corrupt }) => {
          const run = fixture();
          const ctx = context(vertex('agent', explicitEmpty));
          expect(corrupt(ctx)).toBe(true);
          expect(await run[executorName].execute(ctx)).toEqual(VALIDATION);
          expect(run.requests).toEqual([]);
          expect(run.keyReads()).toBe(0);
        },
      );

      it.each(INVALID_METADATA)(
        `${executorName} preparation refuses $name with ${text} without producing a quotable dispatch`,
        async ({ corrupt }) => {
          const run = fixture();
          const ctx = context(vertex('agent', explicitEmpty));
          expect(corrupt(ctx)).toBe(true);
          const prepare = run[executorName].prepareBudgetDispatch?.bind(run[executorName]);
          if (prepare === undefined) throw new Error('agent preparation is required');
          expect(await prepare(ctx)).toEqual(VALIDATION);
          expect(run.requests).toEqual([]);
          expect(run.keyReads()).toBe(0);
        },
      );
    }

    it(`valid explicit empty projection permits a standard human gate with ${text}`, async () => {
      const run = fixture();
      const outcome = await run.standard.execute(context(vertex('gate', explicitEmpty)));
      expect(outcome).toEqual({ kind: 'paused', gate: { gateType: 'approval', message: '' } });
      if (outcome.kind !== 'paused') throw new Error('expected human gate');
      expect(Object.hasOwn(outcome.gate, 'assignee')).toBe(false);
    });

    it(`valid explicit empty projection permits execution and preparation with ${text}`, async () => {
      const run = fixture();
      const ctx = context(vertex('agent', explicitEmpty));
      const prepare = run.standard.prepareBudgetDispatch?.bind(run.standard);
      if (prepare === undefined) throw new Error('standard preparation is required');
      const prepared = await prepare(ctx);
      if (prepared.kind !== 'prepared') throw new Error('expected empty-text preparation');
      expect(prepared.preparation.quote({ strictCostCap: false, resolvePrice: PRICES }).kind).toBe(
        'quoted',
      );
      expect(run.requests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      expect(await prepared.preparation.execute(ctx)).toMatchObject({
        kind: 'completed',
        output: 'public answer',
      });
      expect(await run.agent.execute(context(vertex('agent', explicitEmpty)))).toMatchObject({
        kind: 'completed',
        output: 'public answer',
      });
      expect(run.requests).toHaveLength(2);
      expect(run.requests.map((request) => request.messages)).toEqual([[], []]);
    });
  }

  it('retains an explicitly authored empty assignee', async () => {
    const planVertex = vertex('gate');
    if (planVertex.config.kind !== 'human_in_the_loop') throw new Error('expected gate vertex');
    const withAssignee: PlanVertex = {
      ...planVertex,
      config: {
        ...planVertex.config,
        node: { ...planVertex.config.node, assignee: '' },
      },
    };
    expect(await fixture().standard.execute(context(withAssignee))).toEqual({
      kind: 'paused',
      gate: { gateType: 'approval', message: '', assignee: '' },
    });
  });

  it('preserves pre-aborted gate cancellation even when provenance is missing', async () => {
    const run = fixture();
    const ctx = context(vertex('gate'));
    const abort = createAbortController();
    abort.abort();
    Reflect.set(ctx, 'signal', abort.signal);
    Reflect.deleteProperty(ctx, 'ctx');
    expect(await run.standard.execute(ctx)).toMatchObject({
      kind: 'failed',
      error: { code: 'cancelled', retryable: false },
    });
    expect(run.requests).toEqual([]);
    expect(run.keyReads()).toBe(0);
  });

  it('preserves pre-aborted agent execution after preparation without quoting or provider invocation', async () => {
    const run = fixture();
    const ctx = context(vertex('agent'));
    const abort = createAbortController();
    abort.abort();
    Reflect.set(ctx, 'signal', abort.signal);
    const prepare = run.agent.prepareBudgetDispatch?.bind(run.agent);
    if (prepare === undefined) throw new Error('agent preparation is required');
    // Preparation historically lowers a request even when already aborted. This correction
    // preserves that contract; cancellation is enforced when executing, without calling quote.
    const prepared = await prepare(ctx);
    if (prepared.kind !== 'prepared') throw new Error('expected existing preparation behavior');
    expect(await prepared.preparation.execute(ctx)).toMatchObject({
      kind: 'failed',
      error: { code: 'cancelled', retryable: false },
    });
    expect(await run.agent.execute(ctx)).toMatchObject({
      kind: 'failed',
      error: { code: 'cancelled', retryable: false },
    });
    expect(run.requests).toEqual([]);
    expect(run.keyReads()).toBe(0);
  });

  it('fails the real engine instead of publishing a template-free gate when an embedding drops ctx', async () => {
    const run = fixture();
    const executor: NodeExecutor = {
      execute: (ctx) => {
        const missing = { ...ctx };
        expect(Reflect.deleteProperty(missing, 'ctx')).toBe(true);
        return run.standard.execute(missing);
      },
    };
    const engine = new WorkflowEngine({ host: createInMemoryHost(), executor });
    const workflow = parseWorkflow(
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'empty-template-provenance',
          nodes: [{ id: 'gate', type: 'human_gate', gate_type: 'approval' }],
          edges: [],
        },
      }),
    );
    const handle = engine.start({ workflow });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      // A regressed implementation parks indefinitely; cancellation is cleanup only.
      if (event.type === 'human_gate:paused') handle.cancel();
    }
    expect(events.some((event) => event.type === 'human_gate:paused')).toBe(false);
    const failure = events.find((event) => event.type === 'node:failed');
    expect(failure?.type === 'node:failed' && failure.error).toMatchObject(VALIDATION.error);
    expect(events.at(-1)?.type).toBe('run:failed');
    expect(run.requests).toEqual([]);
  });
});
