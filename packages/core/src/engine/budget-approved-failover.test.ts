import { expect, it } from 'vitest';
import { makeLlmError } from '@relavium/llm';
import type { CapabilityFlags, LlmProvider, ModelPricing, StreamChunk } from '@relavium/llm';
import type { RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import { createDispatchingNodeExecutor } from './node-handlers/dispatcher.js';

it('one approved default call covers both primary attempts and successful fallback without another pause (ADR-0097)', async () => {
  const calls: string[] = [];
  const supports: CapabilityFlags = {
    tools: true,
    streaming: true,
    parallelToolCalls: false,
    vision: false,
    promptCache: false,
    reasoning: false,
    media: {
      input: { image: false, audio: false, video: false, document: false },
      outputCombinations: [],
    },
  };
  const primary: LlmProvider = {
    id: 'openai',
    supports,
    generate: () => {
      throw new Error('text workflow must stream');
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      calls.push('primary');
      await Promise.resolve();
      yield {
        type: 'error',
        error: makeLlmError({
          provider: 'openai',
          kind: 'transport',
          message: 'offline primary failure',
        }),
      };
    },
  };
  const fallback: LlmProvider = {
    ...primary,
    id: 'deepseek',
    async *stream(): AsyncGenerator<StreamChunk> {
      calls.push('fallback');
      await Promise.resolve();
      yield { type: 'text_delta', text: 'fallback answer' };
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const price = {
    displayName: 'offline',
    contextWindowTokens: 128_000,
    maxOutputTokens: 1_000,
    inputPerMtokMicrocents: 1_000_000,
    outputPerMtokMicrocents: 1_000_000,
    cachedInputPerMtokMicrocents: 0,
  };
  const prices = new Map<string, ModelPricing>([
    ['gpt-4o', { ...price, provider: 'openai', nativeId: 'gpt-4o' }],
    ['deepseek-chat', { ...price, provider: 'deepseek', nativeId: 'deepseek-chat' }],
  ]);
  const runner = createAgentNodeExecutor({
    resolveProvider: (id) => (id === 'openai' ? primary : fallback),
    keyFor: () => 'offline-test-key',
    sleep: () => Promise.resolve(),
    tools: [],
    resolvePrice: prices,
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => {
        throw new Error('no tools advertised');
      },
    },
  });
  const engine = new WorkflowEngine({
    host: createInMemoryHost(),
    executor: createDispatchingNodeExecutor({ agent: runner }),
    resolvePrice: prices,
  });
  const workflow = parseWorkflow(`schema_version: '1.0'
workflow:
  id: approved-failover
  budget: { max_cost_microcents: 1, on_exceed: pause_for_approval }
  agents:
    - id: a
      model: gpt-4o
      provider: openai
      system_prompt: hi
      fallback_chain:
        - { model: deepseek-chat, provider: deepseek, max_attempts: 1 }
  nodes:
    - { id: n, type: agent, agent_ref: a, prompt_template: go, max_tokens: 10 }
  edges: []
`);
  const handle = engine.start({ workflow, inputs: {} });
  const events: RunEvent[] = [];
  let approvedAmount: number | undefined;
  for await (const event of handle.events) {
    events.push(event);
    if (event.type !== 'budget:paused') continue;
    if (approvedAmount !== undefined) {
      engine.cancel(handle.runId);
      throw new Error('approved dispatch paused again');
    }
    const quote = event.allowanceQuote;
    if (quote?.kind !== 'quoted' || quote.quote.amount.kind !== 'representable') {
      engine.cancel(handle.runId);
      throw new Error('expected frozen representable quote');
    }
    expect(quote.quote.provenance.attempts).toBe(3);
    expect(quote.quote.provenance.calls).toBe(1);
    approvedAmount = quote.quote.amount.microcents;
    await engine.resume(handle.runId, event.gateId, {
      decision: 'approved',
      decidedBy: 'offline-test',
      approvedAmountMicrocents: approvedAmount,
    });
  }
  expect(approvedAmount).toBe(60);
  expect(calls).toEqual(['primary', 'primary', 'fallback']);
  expect(events.filter((event) => event.type === 'budget:paused')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'budget:estimate_committed')).toHaveLength(2);
  expect(
    events.some((event) => event.type === 'node:completed' && event.output === 'fallback answer'),
  ).toBe(true);
  expect(events.at(-1)?.type).toBe('run:completed');
});

it('WorkflowEngine durably records aggregated cost when the transient cost timestamp throws (ADR-0076/0077)', async () => {
  const store = new InMemoryRunStore();
  const host = createInMemoryHost({ store });
  let costStampPending = false;
  let calls = 0;
  const marker = new Error('private clock callback failure');
  const wrappedHost = {
    ...host,
    clock: {
      now: () => {
        if (costStampPending) {
          costStampPending = false;
          throw marker;
        }
        return host.clock.now();
      },
    },
  };
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
      throw new Error('unused');
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      calls += 1;
      costStampPending = true;
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 7, outputTokens: 10 } };
    },
  };
  const prices = new Map<string, ModelPricing>([
    [
      'gpt-4o',
      {
        provider: 'openai',
        nativeId: 'gpt-4o',
        displayName: 'offline',
        contextWindowTokens: 128000,
        maxOutputTokens: 1000,
        inputPerMtokMicrocents: 1000000,
        outputPerMtokMicrocents: 1000000,
        cachedInputPerMtokMicrocents: 0,
      },
    ],
  ]);
  const runner = createAgentNodeExecutor({
    resolveProvider: () => provider,
    keyFor: () => 'synthetic-offline-key',
    sleep: () => Promise.resolve(),
    tools: [],
    resolvePrice: prices,
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => {
        throw new Error('unused');
      },
    },
  });
  const engine = new WorkflowEngine({
    host: wrappedHost,
    executor: createDispatchingNodeExecutor({ agent: runner }),
    resolvePrice: prices,
  });
  const workflow = parseWorkflow(`schema_version: '1.0'
workflow:
  id: paid-clock-fault
  budget: { max_cost_microcents: 1000, on_exceed: fail }
  agents:
    - { id: a, model: gpt-4o, provider: openai, system_prompt: hi }
  nodes:
    - { id: n, type: agent, agent_ref: a, prompt_template: go, max_tokens: 10 }
  edges: []
`);
  const handle = engine.start({ workflow, inputs: {} });
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  expect(calls).toBe(1);
  const ledger = events.filter((event) => event.type === 'cost:attempt_settled');
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({
    nodeId: 'n',
    attemptNumber: 1,
    inputTokens: 7,
    outputTokens: 10,
    costMicrocents: 17,
    cumulativeCostMicrocents: 17,
  });
  expect(events.at(-1)).toMatchObject({ type: 'run:failed', cumulativeCostMicrocents: 17 });
  expect(JSON.stringify(events)).not.toContain(marker.message);
  const persisted = store.eventsFor(handle.runId);
  expect(persisted.filter((event) => event.type === 'cost:attempt_settled')).toHaveLength(1);
});
