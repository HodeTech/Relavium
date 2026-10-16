/** ADR-0113: actual execution and passive approval preparation share one owned authority. */
import type { LlmProvider, LlmRequest, ModelPricing, StreamChunk } from '@relavium/llm';
import type { RunEvent } from '@relavium/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { createExpressionSandbox, type ExpressionSandbox } from '../expression/sandbox.js';
import { ownSecretInputNames } from '../interpolation/provenance.js';
import { resolveContext } from '../interpolation/resolve.js';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createAbortController, createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import type { NodeExecContext, NodeExecutor, NodePreparationContext } from './node-executor.js';
import { createStandardNodeExecutor } from './node-handlers/dispatcher.js';
import type { RunHandle } from './run-handle.js';

const CANARY = 'ADR0113-PRODUCER-PRIVATE-CANARY';
const INPUTS = { token: CANARY, topic: 'public-topic' };
const MODEL = 'offline-provenance';
const PRICES = new Map<string, ModelPricing>([
  [
    MODEL,
    {
      provider: 'openai',
      nativeId: MODEL,
      displayName: 'offline',
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

function workflow(budgeted: boolean, transform = 'ctx.clean + ":" + inputs.topic') {
  return parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'secret-provenance-producers',
        inputs: [
          { name: 'token', type: 'secret' },
          { name: 'topic', type: 'string' },
        ],
        context: [
          { key: 'clean', value: 'public-context' },
          { key: 'alias', value: '{{ inputs.token }}' },
          { key: 'nested', value: '{{ ctx.alias }}' },
        ],
        ...(budgeted
          ? { budget: { max_cost_microcents: 1, on_exceed: 'pause_for_approval' } }
          : {}),
        agents: [
          { id: 'a', provider: 'openai', model: MODEL, system_prompt: 'System public instruction' },
        ],
        nodes: [
          ...(budgeted
            ? [
                {
                  id: 'agent',
                  type: 'agent',
                  agent_ref: 'a',
                  prompt_template: 'Topic {{ inputs.topic }} / {{ ctx.clean }}',
                  max_tokens: 16,
                },
              ]
            : []),
          {
            id: 'human',
            type: 'human_gate',
            gate_type: 'approval',
            message_template: 'Review {{ ctx.clean }} / {{ inputs.topic }}',
          },
          { id: 'result', type: 'transform', transform },
        ],
        edges: [
          ...(budgeted ? [{ from: 'agent', to: 'human' }] : []),
          { from: 'human', to: 'result' },
        ],
      },
    }),
  );
}

function assertOwned(ctx: NodePreparationContext): void {
  expect(ctx.ctx).toEqual({
    values: { clean: 'public-context' },
    deniedKeys: ['alias', 'nested'],
    orderedKeys: ['clean', 'alias', 'nested'],
  });
  expect(JSON.stringify(ctx.ctx)).not.toContain(CANARY);
  expect(Object.isFrozen(ctx.ctx)).toBe(true);
  expect(Object.isFrozen(ctx.ctx.values)).toBe(true);
  expect(Object.isFrozen(ctx.ctx.deniedKeys)).toBe(true);
  expect(Object.isFrozen(ctx.ctx.orderedKeys)).toBe(true);
  expect([...ctx.secretInputNames]).toEqual(['token']);
  expect(Object.isFrozen(ctx.secretInputNames)).toBe(true);
  expect(Reflect.get(ctx.secretInputNames, 'clear')).toBeUndefined();
  expect(() => Set.prototype.clear.call(ctx.secretInputNames)).toThrow(TypeError);
  ctx.secretInputNames.forEach((name, key, receiver) => {
    expect([name, key]).toEqual(['token', 'token']);
    expect(receiver).toBe(ctx.secretInputNames);
    expect(Reflect.get(receiver, 'clear')).toBeUndefined();
  });
}

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
      throw new Error('text fixture must stream');
    },
    async *stream(request): AsyncGenerator<StreamChunk> {
      requests.push(request);
      await Promise.resolve();
      yield { type: 'text_delta', text: 'public-answer' };
      yield {
        type: 'stop',
        stopReason: 'stop',
        usage: { kind: 'complete', usage: { inputTokens: 1, outputTokens: 1 } },
      };
    },
  };
  const standard = createStandardNodeExecutor({
    sandbox,
    agent: {
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
        dispatch: () => Promise.reject(new Error('no tools advertised')),
      },
    },
  });
  const executions: NodeExecContext[] = [];
  const preparations: NodePreparationContext[] = [];
  const preparedExecutions: NodeExecContext[] = [];
  const executor: NodeExecutor = {
    execute: (ctx) => {
      assertOwned(ctx);
      executions.push(ctx);
      return standard.execute(ctx);
    },
    prepareBudgetDispatch: async (ctx) => {
      assertOwned(ctx);
      preparations.push(ctx);
      const prepare = standard.prepareBudgetDispatch?.bind(standard);
      if (prepare === undefined) throw new Error('standard preparation missing');
      const result = await prepare(ctx);
      if (result.kind !== 'prepared') return result;
      return {
        kind: 'prepared',
        preparation: {
          quote: (options) => result.preparation.quote(options),
          execute: (execution) => {
            assertOwned(execution);
            expect(execution.ctx).toBe(ctx.ctx);
            expect(execution.secretInputNames).toBe(ctx.secretInputNames);
            preparedExecutions.push(execution);
            return result.preparation.execute(execution);
          },
        },
      };
    },
  };
  return {
    standard,
    executor,
    requests,
    keyReads: () => keyReads,
    executions,
    preparations,
    preparedExecutions,
  };
}

async function drainAndApproveHumans(handle: RunHandle, engine: WorkflowEngine) {
  const events: RunEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
    if (event.type === 'human_gate:paused' && event.nodeId === 'human') {
      expect(event.message).toBe('Review public-context / public-topic');
      await engine.resume(handle.runId, event.gateId, {
        decision: 'approved',
        decidedBy: 'offline-provenance-test',
      });
    }
  }
  return events;
}

function assertShared(contexts: readonly NodePreparationContext[]): void {
  expect(contexts.length).toBeGreaterThan(1);
  for (const ctx of contexts) {
    expect(ctx.ctx).toBe(contexts[0]?.ctx);
    expect(ctx.secretInputNames).toBe(contexts[0]?.secretInputNames);
  }
}

describe('owned secret provenance at actual engine producers (ADR-0113)', () => {
  it('fresh execution and same-process human resume preserve clean VM/template behavior and identity', async () => {
    const run = fixture();
    const wf = workflow(false);
    // The trusted exported resolver retains raw intermediate values; the engine must qualify them.
    expect(await resolveContext(wf, INPUTS)).toEqual({
      clean: 'public-context',
      alias: CANARY,
      nested: CANARY,
    });
    const engine = new WorkflowEngine({ host: createInMemoryHost(), executor: run.executor });
    const events = await drainAndApproveHumans(
      engine.start({ workflow: wf, inputs: INPUTS }),
      engine,
    );
    expect(events.at(-1)?.type).toBe('run:completed');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'node:completed',
        nodeId: 'result',
        output: 'public-context:public-topic',
      }),
    );
    assertShared(run.executions);
    expect(JSON.stringify(events)).not.toContain(CANARY);
    expect(run.requests).toEqual([]);
  });

  it.each(['ctx.nested', 'inputs.token'])(
    'a same-process human resume still denies a caught %s read in the actual VM',
    async (read) => {
      const run = fixture();
      const engine = new WorkflowEngine({ host: createInMemoryHost(), executor: run.executor });
      const wf = workflow(
        false,
        `(() => { try { return ${read}; } catch { return 'escaped'; } })()`,
      );
      const events = await drainAndApproveHumans(
        engine.start({ workflow: wf, inputs: INPUTS }),
        engine,
      );
      expect(
        events.find((event) => event.type === 'node:failed' && event.nodeId === 'result'),
      ).toMatchObject({
        type: 'node:failed',
        nodeId: 'result',
        error: { code: 'sandbox_error', retryable: false },
      });
      expect(
        events.some((event) => event.type === 'node:completed' && event.nodeId === 'result'),
      ).toBe(false);
      expect(events.at(-1)?.type).toBe('run:failed');
      assertShared(run.executions);
      expect(JSON.stringify(events)).not.toContain(CANARY);
    },
  );

  it.each(['same-process', 'cross-process'])(
    '%s quoted budget preparation passes its exact owned authority into execution and later consumers',
    async (mode) => {
      const wf = workflow(true);
      const run = fixture();
      const store = new InMemoryRunStore(JSON.stringify(wf));
      const engine = new WorkflowEngine({
        host: createInMemoryHost({ store }),
        executor: run.executor,
        resolvePrice: PRICES,
      });
      const handle = engine.start({ workflow: wf, inputs: INPUTS });
      const prefix: RunEvent[] = [];
      const iterator = handle.events[Symbol.asyncIterator]();
      let pause: Extract<RunEvent, { type: 'budget:paused' }> | undefined;
      while (true) {
        const next = await iterator.next();
        if (next.done) throw new Error('budget fixture terminated before pausing');
        prefix.push(next.value);
        if (next.value.type === 'budget:paused') pause = next.value;
        if (next.value.type === 'run:paused') break;
      }
      if (
        pause?.allowanceQuote?.kind !== 'quoted' ||
        pause.allowanceQuote.quote.amount.kind !== 'representable'
      ) {
        handle.cancel();
        throw new Error('expected actual representable budget quote');
      }
      expect(run.requests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      const decision = {
        decision: 'approved' as const,
        decidedBy: 'offline-provenance-test',
        approvedAmountMicrocents: pause.allowanceQuote.quote.amount.microcents,
      };
      let active = run;
      let resumed: RunHandle;
      let activeEngine: WorkflowEngine;
      if (mode === 'same-process') {
        await engine.resume(handle.runId, pause.gateId, decision);
        resumed = handle;
        activeEngine = engine;
      } else {
        // Copy the real durable parked prefix; a separate engine/store models process replacement.
        const restored = new InMemoryRunStore(JSON.stringify(wf));
        for (const event of store.eventsFor(handle.runId)) await restored.persistEvent(event);
        expect(await restored.readWorkflowSnapshot(handle.runId)).toBe(JSON.stringify(wf));
        handle.cancel();
        while (!(await iterator.next()).done) {
          /* join original engine retirement */
        }
        active = fixture();
        activeEngine = new WorkflowEngine({
          host: createInMemoryHost({ store: restored }),
          executor: active.executor,
          resolvePrice: PRICES,
        });
        resumed = await activeEngine.resumeFromCheckpoint({
          runId: handle.runId,
          workflow: wf,
          inputs: INPUTS,
          gateId: pause.gateId,
          decision,
        });
      }
      const events = await drainAndApproveHumans(resumed, activeEngine);
      expect(active.preparations).toHaveLength(1);
      expect(active.preparedExecutions).toHaveLength(1);
      assertShared([...active.preparations, ...active.preparedExecutions, ...active.executions]);
      expect(active.requests).toHaveLength(1);
      expect(active.keyReads()).toBeGreaterThan(0);
      const publicRequest = JSON.stringify(active.requests);
      expect(publicRequest).toContain('Topic public-topic / public-context');
      expect(publicRequest).toContain('System public instruction');
      expect(publicRequest).not.toContain(CANARY);
      expect(events.at(-1)?.type).toBe('run:completed');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'node:completed',
          nodeId: 'result',
          output: 'public-context:public-topic',
        }),
      );
      expect(JSON.stringify([...prefix, ...events])).not.toContain(CANARY);
    },
  );

  it('missing metadata and caller-Set mutation refuse at actual VM and public-template consumers', async () => {
    const run = fixture();
    const original = workflow(true);
    const wf = parseWorkflow(
      JSON.stringify({
        ...original,
        workflow: {
          ...original.workflow,
          budget: { max_cost_microcents: 100_000, on_exceed: 'pause_for_approval' },
        },
      }),
    );
    const engine = new WorkflowEngine({ host: createInMemoryHost(), executor: run.executor });
    const events = await drainAndApproveHumans(
      engine.start({ workflow: wf, inputs: INPUTS }),
      engine,
    );
    expect(events.at(-1)?.type).toBe('run:completed');
    const freshSignal = createAbortController().signal;
    const result = run.executions.find((ctx) => ctx.vertex.id === 'result');
    const human = run.executions.find((ctx) => ctx.vertex.id === 'human');
    const agent = run.executions.find((ctx) => ctx.vertex.id === 'agent');
    const prepare = run.standard.prepareBudgetDispatch?.bind(run.standard);
    if (result === undefined || human === undefined || agent === undefined || prepare === undefined)
      throw new Error('actual standard contexts were not captured');
    const expectedMissing = {
      kind: 'failed',
      error: {
        code: 'validation',
        message: 'workflow context provenance is missing or invalid',
        retryable: false,
      },
    };
    for (const captured of [result, human, agent]) {
      const missing = { ...captured, signal: freshSignal };
      // Deliberately model an unmigrated JavaScript embedding without weakening the TypeScript seam.
      Reflect.deleteProperty(missing, 'ctx');
      const outcome = await run.standard.execute(missing);
      expect(outcome).toEqual(expectedMissing);
      expect(JSON.stringify(outcome)).not.toContain(CANARY);
      if (captured === agent) expect(await prepare(missing)).toEqual(expectedMissing);
    }

    const callerSet = new Set(['token']);
    const names = ownSecretInputNames(callerSet).secretInputNames;
    callerSet.clear();
    names.forEach((_name, _key, receiver) => {
      expect(receiver).toBe(names);
      expect(() => Set.prototype.clear.call(receiver)).toThrow(TypeError);
    });
    expect([...names]).toEqual(['token']);
    if (
      result.vertex.config.kind !== 'transform' ||
      human.vertex.config.kind !== 'human_in_the_loop' ||
      agent.vertex.config.kind !== 'agent'
    )
      throw new Error('unexpected actual vertex configuration');
    const deniedVm = await run.standard.execute({
      ...result,
      signal: freshSignal,
      secretInputNames: names,
      vertex: {
        ...result.vertex,
        config: {
          ...result.vertex.config,
          node: { ...result.vertex.config.node, transform: 'inputs.token' },
        },
      },
    });
    expect(deniedVm).toMatchObject({
      kind: 'failed',
      error: { code: 'sandbox_error', retryable: false },
    });
    for (const template of ['{{ inputs.token }}', '{{ ctx.nested }}']) {
      const deniedHuman = await run.standard.execute({
        ...human,
        signal: freshSignal,
        secretInputNames: names,
        vertex: {
          ...human.vertex,
          config: {
            ...human.vertex.config,
            node: { ...human.vertex.config.node, message_template: template },
          },
        },
      });
      const deniedPreparation = await prepare({
        ...agent,
        signal: freshSignal,
        secretInputNames: names,
        vertex: {
          ...agent.vertex,
          config: {
            ...agent.vertex.config,
            node: { ...agent.vertex.config.node, prompt_template: template },
          },
        },
      });
      expect(deniedHuman).toMatchObject({
        kind: 'failed',
        error: { code: 'validation', retryable: false },
      });
      expect(deniedPreparation).toMatchObject({
        kind: 'failed',
        error: { code: 'validation', retryable: false },
      });
      expect(JSON.stringify([deniedHuman, deniedPreparation])).not.toContain(CANARY);
    }
    // Only the clean positive run reached credentials/provider; denied low-level calls add no egress.
    expect(run.requests).toHaveLength(1);
  });
});
