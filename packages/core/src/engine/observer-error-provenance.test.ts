import { describe, expect, it } from 'vitest';
import { LlmProviderError, makeLlmError } from '@relavium/llm';
import type { CapabilityFlags, LlmProvider, ModelPricing, StreamChunk } from '@relavium/llm';
import { unwiredEffectJournal } from '@relavium/shared';
import type { RunEvent } from '@relavium/shared';
import {
  captureAgentTurnOutcome,
  AgentTurnError,
  DEFAULT_AGENT_TURN_LIMITS,
} from './agent-turn.js';
import type { AgentTurnParams } from './agent-turn.js';
import { createToolRegistry } from '../tools/registry.js';
import { MoneyDurability } from './money-durability.js';
import type { SettledAttemptDraft } from './money-durability.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import { createDispatchingNodeExecutor } from './node-handlers/dispatcher.js';
import { parseWorkflow } from '../parser.js';

const MODEL = 'offline-observer-provenance';
const PRICE: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 20000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
  cacheWritePerMtokMicrocents: 1000000,
  mediaOutputRates: { image: 13 },
};
const CAPS: CapabilityFlags = {
  tools: false,
  streaming: true,
  parallelToolCalls: false,
  vision: false,
  promptCache: false,
  reasoning: false,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [['image']],
    surface: 'chat',
  },
};
function providerFor(calls: { count: number }, bodyFault?: LlmProviderError): LlmProvider {
  return {
    id: 'openai',
    customEndpoint: true,
    supports: CAPS,
    generate: () => {
      calls.count++;
      if (bodyFault !== undefined) throw bodyFault;
      return Promise.resolve({
        content: [
          {
            type: 'media',
            mimeType: 'image/png',
            source: { kind: 'handle', ref: `media://sha256-${'a'.repeat(64)}` },
          },
        ],
        stopReason: 'stop',
        usage: { inputTokens: 7, outputTokens: 11 },
      });
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      calls.count++;
      await Promise.resolve();
      if (bodyFault !== undefined) throw bodyFault;
      yield { type: 'text_delta', text: 'paid' };
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 7, outputTokens: 11 } };
    },
  };
}
function paramsFor(
  provider: LlmProvider,
  overrides: Partial<AgentTurnParams> = {},
): AgentTurnParams {
  return {
    nodeId: 'review-node',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    planEntries: [{ provider, model: MODEL, maxAttempts: 1 }],
    chainCapabilities: { keyFor: () => 'synthetic-no-key', sleep: () => Promise.resolve() },
    signal: new AbortController().signal,
    emit: () => {},
    registry: createToolRegistry({ tools: [], host: {} }),
    dispatchContext: {
      nodeId: 'review-node',
      grantedToolIds: new Set(),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effects: unwiredEffectJournal(),
      effectSlot: 0,
    },
    limits: DEFAULT_AGENT_TURN_LIMITS,
    resolvePrice: new Map([[MODEL, PRICE]]),
    ...overrides,
  };
}
function diagnostic() {
  return new LlmProviderError(
    makeLlmError({
      provider: 'openai',
      kind: 'timeout',
      message: 'observer private token eyReviewSecret',
    }),
  );
}

describe('observer error provenance', () => {
  for (const path of ['generate', 'stream'] as const)
    for (const site of ['cost', 'ledger'] as const) {
      it(`consumer typed error stays raw ${path}/${site}`, async () => {
        const calls = { count: 0 };
        const marker = diagnostic();
        const rows: SettledAttemptDraft[] = [];
        let total = 0;
        const money = new MoneyDurability({
          emit: (draft) => {
            rows.push(draft);
          },
        });
        const port = money.turnPort(() => total);
        const outcome = await captureAgentTurnOutcome(
          paramsFor(providerFor(calls), {
            ...(path === 'generate' ? { outputModalities: ['image'] } : {}),
            money:
              site === 'ledger'
                ? {
                    join: port.join,
                    record: () => {
                      throw marker;
                    },
                  }
                : port,
            emit: (event) => {
              if (event.type === 'cost:updated') {
                total += event.costMicrocents;
                if (site === 'cost') throw marker;
              }
            },
          }),
        );
        await money.join();
        expect(calls.count).toBe(1);
        expect(outcome.kind).toBe('failed');
        if (outcome.kind !== 'failed') throw new Error('unexpected success');
        expect(outcome.engaged).toBe(true);
        expect(outcome.usage).toEqual({ input: 7, output: 11 });
        if (site === 'cost') expect(rows).toHaveLength(1);
        expect(outcome.error === marker).toBe(true);
      });
    }
  it('genuine generated provider errors retain normal typed mapping', async () => {
    const calls = { count: 0 };
    const marker = diagnostic();
    const outcome = await captureAgentTurnOutcome(
      paramsFor(providerFor(calls, marker), { outputModalities: ['image'] }),
    );
    expect(calls.count).toBe(1);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') throw new Error('unexpected success');
    expect(outcome.error).toBeInstanceOf(AgentTurnError);
    expect(outcome.error).toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(outcome.engaged).toBe(true);
    expect(outcome.usage).toEqual({ input: 0, output: 0 });
  });
  it('typed consumer cause accessor cannot replace original exception', async () => {
    const calls = { count: 0 };
    const marker = diagnostic();
    const replacement = new Error('private cause getter');
    Object.defineProperty(marker.llmError, 'cause', {
      get: () => {
        throw replacement;
      },
      enumerable: true,
    });
    const outcome = await captureAgentTurnOutcome(
      paramsFor(providerFor(calls), {
        outputModalities: ['image'],
        emit: (event) => {
          if (event.type === 'cost:updated') throw marker;
        },
      }),
    );
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') throw new Error('unexpected success');
    expect(outcome.usage).toEqual({ input: 7, output: 11 });
    expect(outcome.error === marker).toBe(true);
  });
  it('actual WorkflowEngine never redispatches a paid generation for a typed clock observer failure', async () => {
    const store = new InMemoryRunStore();
    const host = createInMemoryHost({ store });
    const marker = diagnostic();
    const calls = { count: 0 };
    let pending = false;
    const provider = providerFor(calls);
    const originalGenerate = provider.generate.bind(provider);
    const wrappedProvider: LlmProvider = {
      ...provider,
      generate: (request, key) => {
        pending = true;
        return originalGenerate(request, key);
      },
    };
    const wrappedHost = {
      ...host,
      setTimer: (...args: Parameters<typeof host.setTimer>) => {
        const disarm = host.setTimer(...args);
        if (args[2] === undefined || args[2] === 'work') queueMicrotask(() => host.fireTimers());
        return disarm;
      },
      clock: {
        now: () => {
          if (pending) {
            pending = false;
            throw marker;
          }
          return host.clock.now();
        },
      },
    };
    const prices = new Map([[MODEL, PRICE]]);
    const registry = createToolRegistry({ tools: [], host: {} });
    const runner = createAgentNodeExecutor({
      resolveProvider: () => wrappedProvider,
      keyFor: () => 'synthetic-no-key',
      sleep: () => Promise.resolve(),
      tools: [],
      registry,
      resolvePrice: prices,
      resolveMediaSurface: () => 'chat',
    });
    const engine = new WorkflowEngine({
      host: wrappedHost,
      executor: createDispatchingNodeExecutor({ agent: runner }),
      resolvePrice: prices,
    });
    const workflow = parseWorkflow(`schema_version: '1.0'
workflow:
  id: reviewer-typed-clock
  agents:
    - { id: a, model: offline-observer-provenance, provider: openai, system_prompt: hi }
  nodes:
    - { id: n, type: agent, agent_ref: a, prompt_template: go, max_tokens: 10, output_modalities: [image], retry: { max: 2, backoff: linear, retry_on: [provider_unavailable] } }
  edges: []
`);
    const handle = engine.start({ workflow, inputs: {} });
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: 'run:failed',
      error: { code: 'internal', retryable: false },
      cumulativeCostMicrocents: 18,
    });
    expect
      .soft(store.eventsFor(handle.runId).filter((e) => e.type === 'cost:attempt_settled'))
      .toHaveLength(1);
    expect.soft(calls.count).toBe(1);
    expect.soft(events.some((e) => e.type === 'node:retrying')).toBe(false);
    expect.soft(JSON.stringify(events)).not.toContain('eyReviewSecret');
  });
});
