import { describe, expect, it } from 'vitest';
import { setImmediate } from 'node:timers';
import type { ContentPart, DurableWriteContext, RunEvent } from '@relavium/shared';
import {
  CostTracker,
  FallbackChain,
  type AttemptRecord,
  type LlmProvider,
  type LlmResult,
  type ModelPricing,
  type StreamChunk,
  type Usage,
} from '@relavium/llm';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, createAbortController, InMemoryRunStore } from './execution-host.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { createDispatchingNodeExecutor } from './node-handlers/dispatcher.js';
import { parseWorkflow } from '../parser.js';
import { createToolRegistry } from '../tools/registry.js';
import type { ToolDef } from '../tools/types.js';
import { LedgerDurabilityError } from './money-durability.js';
import { AgentTurnError } from './agent-turn.js';
import { BudgetPauseError } from './budget-governor.js';

const model = 'r11-money-model';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 16000,
  maxOutputTokens: 200,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 2000000,
  cachedInputPerMtokMicrocents: 3000000,
  cacheWritePerMtokMicrocents: 4000000,
  mediaOutputRates: { image: 9 },
};
const prices = new Map([[model, price]]);
function generatedUsage(): Usage {
  return {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 2,
    cacheWriteTokens: 3,
    mediaUnits: [{ modality: 'image', direction: 'output', unit: 'count', units: 2 }],
  };
}
const media: ContentPart = {
  type: 'media',
  mimeType: 'image/png',
  source: { kind: 'handle', ref: 'media://sha256-' + 'd'.repeat(64) },
};
function provider(onGenerate: () => LlmResult, tool = false, count = { calls: 0 }): LlmProvider {
  return {
    id: 'openai',
    customEndpoint: true,
    supports: {
      tools: tool,
      streaming: true,
      parallelToolCalls: false,
      vision: false,
      promptCache: true,
      reasoning: true,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [['image'], ['text', 'image']],
        surface: 'chat',
      },
    },
    generate: () => {
      count.calls++;
      return Promise.resolve(onGenerate());
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      count.calls++;
      if (tool && count.calls === 1) {
        yield { type: 'tool_call_start', id: 'fresh-call', name: 'r11_echo' };
        yield { type: 'tool_call_end', id: 'fresh-call' };
        yield { type: 'stop', stopReason: 'tool_use', usage: { inputTokens: 2, outputTokens: 3 } };
      } else {
        yield { type: 'text_delta', text: 'fresh answer' };
        yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 } };
      }
    },
  };
}
function deferred() {
  let resolve: () => void = () => {
    throw new Error('unarmed');
  };
  let reject: (e: Error) => void = () => {
    throw new Error('unarmed');
  };
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function workflow(
  p: LlmProvider,
  options: { generated: boolean; tool?: boolean; store?: InMemoryRunStore; cleanupFault?: unknown },
) {
  const store = options.store ?? new InMemoryRunStore(),
    host = createInMemoryHost({ store });
  let toolsRun = 0;
  const tool: ToolDef = {
    id: 'r11_echo',
    source: 'builtin',
    description: 'Fresh pure offline control',
    llmVisibleParams: { type: 'object' },
    parseArgs: (x) => x,
    policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
    effect: () => undefined,
    dispatch: () => {
      toolsRun++;
      return Promise.resolve('offline effect-free echo');
    },
  };
  const tools = options.tool ? [tool] : [];
  let cleanupArmed = options.cleanupFault !== undefined;
  const runner = createAgentNodeExecutor({
    ...(options.cleanupFault === undefined
      ? {}
      : {
          newAbortController: createAbortController,
          setTimer: () => () => {
            if (cleanupArmed) {
              cleanupArmed = false;
              throw options.cleanupFault;
            }
          },
        }),
    resolveProvider: () => p,
    keyFor: () => 'offline-synthetic',
    sleep: () => Promise.resolve(),
    tools,
    registry: createToolRegistry({ tools, host: {} }),
    resolvePrice: prices,
    resolveMediaSurface: () => 'chat',
  });
  const engine = new WorkflowEngine({
    host,
    executor: createDispatchingNodeExecutor({ agent: runner }),
    resolvePrice: prices,
  });
  const definition = parseWorkflow(`schema_version: '1.0'
workflow:
  id: r11-runtime-money
  agents:
    - { id: a, provider: openai, model: r11-money-model, system_prompt: offline${options.tool ? ', tools: [r11_echo]' : ''} }
  nodes:
    - { id: n, type: agent, agent_ref: a, prompt_template: offline, max_tokens: 8${options.generated ? ', output_modalities: [image]' : ''}, retry: { max: 2, backoff: linear, retry_on: [provider_unavailable] } }
  edges: []
`);
  const handle = engine.start({ workflow: definition, inputs: {} }),
    events: RunEvent[] = [];
  const consumed = (async () => {
    for await (const e of handle.events) {
      events.push(e);
      if (e.type === 'node:retrying') setImmediate(() => host.fireTimers());
      if (e.type === 'run:paused') engine.cancel(handle.runId);
    }
  })();
  return {
    consumed,
    events,
    store,
    toolsRun: () => toolsRun,
    rows: () => store.eventsFor(handle.runId),
  };
}

describe('R11 fresh downstream generated semantic projection in actual WorkflowEngine', () => {
  for (const kind of ['plain', 'typed', 'pause', 'false-writer'] as const)
    it(`nested typed source ${kind} cannot counterfeit control or money writer`, async () => {
      const count = { calls: 0 };
      const fault =
        kind === 'typed'
          ? new AgentTurnError('provider_unavailable', 'PRIVATE fresh generated trap', true)
          : kind === 'pause'
            ? new BudgetPauseError(0, 9, 10)
            : new LedgerDurabilityError(new Error('PRIVATE fresh false writer'), 'not-real-writer');
      const source = {
        kind: 'handle' as const,
        get ref() {
          if (kind !== 'plain') throw fault;
          return 'media://sha256-' + 'd'.repeat(64);
        },
      };
      const p = provider(
        () => ({
          content: [{ type: 'media', mimeType: 'image/png', source }],
          stopReason: 'stop',
          usage: generatedUsage(),
        }),
        false,
        count,
      );
      const h = workflow(p, { generated: true });
      await h.consumed;
      expect(count.calls).toBe(1);
      expect(h.rows().filter((e) => e.type === 'cost:attempt_settled')).toMatchObject([
        { nodeId: 'n', inputTokens: 3, outputTokens: 2, costMicrocents: 43, priced: true },
      ]);
      expect(
        h.events.some(
          (e) =>
            e.type === 'node:retrying' || e.type === 'run:paused' || e.type === 'human_gate:paused',
        ),
      ).toBe(false);
      if (kind === 'plain')
        expect(h.events.at(-1)).toMatchObject({ type: 'run:completed', totalCostMicrocents: 43 });
      else
        expect(h.events.at(-1)).toMatchObject({
          type: 'run:failed',
          error: { code: 'internal', nodeId: 'n', retryable: false },
          cumulativeCostMicrocents: 43,
        });
      expect(JSON.stringify(h.rows())).not.toContain('PRIVATE');
      expect(JSON.stringify(h.rows())).not.toContain('not-real-writer');
    });
});

describe('R11 real ordered-store B2/B3 controls', () => {
  for (const boundary of ['tools-B2', 'completion-B3'] as const)
    for (const decision of ['ack', 'fail'] as const)
      it(`${boundary} waits for actual ordered realized store ${decision}`, async () => {
        const wait = deferred(),
          entered = deferred();
        let held = false;
        class HeldStore extends InMemoryRunStore {
          override async persistEvent(e: RunEvent, ctx?: DurableWriteContext): Promise<void> {
            if (e.type === 'cost:attempt_settled' && !held) {
              held = true;
              entered.resolve();
              await wait.promise;
            }
            await super.persistEvent(e, ctx);
          }
        }
        const count = { calls: 0 };
        const h = workflow(
          provider(
            () => ({ content: [media], stopReason: 'stop', usage: generatedUsage() }),
            boundary === 'tools-B2',
            count,
          ),
          {
            generated: boundary === 'completion-B3',
            tool: boundary === 'tools-B2',
            store: new HeldStore(),
          },
        );
        await entered.promise;
        expect(count.calls).toBe(1);
        expect(h.toolsRun()).toBe(0);
        expect(h.events.some((e) => e.type === 'run:completed' || e.type === 'run:failed')).toBe(
          false,
        );
        if (decision === 'ack') wait.resolve();
        else wait.reject(new Error('PRIVATE actual ordered store failure'));
        await h.consumed;
        if (decision === 'ack') {
          expect(h.events.at(-1)?.type).toBe('run:completed');
          expect(count.calls).toBe(boundary === 'tools-B2' ? 2 : 1);
          expect(h.toolsRun()).toBe(boundary === 'tools-B2' ? 1 : 0);
          expect(h.rows().filter((e) => e.type === 'cost:attempt_settled')).toHaveLength(
            boundary === 'tools-B2' ? 2 : 1,
          );
        } else {
          expect(h.events.at(-1)).toMatchObject({
            type: 'run:failed',
            error: { code: 'internal', nodeId: 'n', retryable: false },
          });
          expect(count.calls).toBe(1);
          expect(h.toolsRun()).toBe(0);
          expect(h.rows().filter((e) => e.type === 'cost:attempt_settled')).toHaveLength(0);
        }
        expect(JSON.stringify(h.rows())).not.toContain('PRIVATE');
        expect(h.events.some((e) => e.type === 'node:retrying' || e.type === 'run:paused')).toBe(
          false,
        );
      });
});

describe('R11 generated observer mutations and truthful quantity combinations', () => {
  for (const pricing of ['known', 'missing-media', 'zero'] as const)
    it(`observer modifies original owned fields after projection: ${pricing}`, async () => {
      const raw = generatedUsage();
      if (pricing === 'zero') {
        raw.inputTokens = 0;
        raw.outputTokens = 0;
        raw.cacheReadTokens = 0;
        raw.cacheWriteTokens = 0;
        raw.mediaUnits = [];
      }
      const original: ContentPart = { type: 'text', text: 'owned original' };
      const opaque = { unowned: 'allowed' };
      const records: AttemptRecord[] = [];
      const selected =
        pricing === 'missing-media'
          ? new Map([[model, { ...price, mediaOutputRates: {} }]])
          : prices;
      const chain = new FallbackChain(
        [
          {
            provider: provider(() => ({
              content: [media, original],
              stopReason: 'stop',
              usage: raw,
              raw: opaque,
            })),
            model,
            maxAttempts: 2,
          },
        ],
        {
          keyFor: () => 'synthetic',
          sleep: () => Promise.resolve(),
          costTracker: new CostTracker(selected),
          onAttempt: (r) => {
            records.push(r);
            Object.defineProperty(original, 'text', {
              get() {
                throw new AgentTurnError(
                  'provider_unavailable',
                  'PRIVATE late original getter',
                  true,
                );
              },
              enumerable: true,
            });
            raw.inputTokens = 99;
          },
        },
      );
      const result = await chain.generate({ model, messages: [] });
      expect(result.content[1]).toEqual({ type: 'text', text: 'owned original' });
      expect(result.usage).toBe(records[0]?.usage);
      expect(result.raw).toBe(opaque);
      expect(result.usage?.inputTokens).toBe(pricing === 'zero' ? 0 : 3);
      expect(records[0]?.cost?.costMicrocents).toBe(
        pricing === 'zero' ? 0 : pricing === 'missing-media' ? 25 : 43,
      );
      expect(records[0]?.priced).toBe(pricing === 'missing-media' ? false : undefined);
    });
});

describe('R11 actual stream deadline cleanup provenance and settled money', () => {
  for (const kind of ['raw', 'turn', 'pause', 'false-writer'] as const)
    it(`successful streamed stop then deadline disarm ${kind} cannot replace settlement`, async () => {
      const fault =
        kind === 'turn'
          ? new AgentTurnError('provider_unavailable', 'PRIVATE R11 disarm', true)
          : kind === 'pause'
            ? new BudgetPauseError(0, 12, 13)
            : kind === 'false-writer'
              ? new LedgerDurabilityError(
                  new Error('PRIVATE R11 disarm'),
                  'counterfeit-disarm-writer',
                )
              : new Error('PRIVATE R11 disarm');
      const count = { calls: 0 };
      const h = workflow(
        provider(
          () => ({ content: [media], stopReason: 'stop', usage: generatedUsage() }),
          false,
          count,
        ),
        { generated: false, cleanupFault: fault },
      );
      await h.consumed;
      expect.soft(count.calls).toBe(1);
      expect
        .soft(h.rows().filter((e) => e.type === 'cost:attempt_settled'))
        .toMatchObject([
          { nodeId: 'n', inputTokens: 2, outputTokens: 3, costMicrocents: 8, priced: true },
        ]);
      expect
        .soft(h.events.some((e) => e.type === 'node:retrying' || e.type === 'run:paused'))
        .toBe(false);
      expect.soft(JSON.stringify(h.rows())).not.toContain('PRIVATE');
      expect.soft(JSON.stringify(h.rows())).not.toContain('counterfeit-disarm-writer');
    });
});
