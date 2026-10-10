import { describe, expect, it } from 'vitest';
import type { ContentPart, RunEvent } from '@relavium/shared';
import type { LlmProvider, LlmResult, ModelPricing } from '@relavium/llm';
import { WorkflowEngine } from './engine.js';
import { InMemoryRunStore, createInMemoryHost, createAbortController } from './execution-host.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { createDispatchingNodeExecutor } from './node-handlers/dispatcher.js';
import { parseWorkflow } from '../parser.js';
import { createToolRegistry } from '../tools/registry.js';
import { BudgetPauseError } from './budget-governor.js';
import { LedgerDurabilityError } from './money-durability.js';
import { AgentTurnError } from './agent-turn.js';

const model = 'r11-generated';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 20000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 2000000,
  outputPerMtokMicrocents: 5000000,
  cachedInputPerMtokMicrocents: 3000000,
  cacheWritePerMtokMicrocents: 7000000,
  mediaOutputRates: { image: 13 },
};
function gate() {
  let release = () => {};
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
const media = (): ContentPart => ({
  type: 'media',
  mimeType: 'image/png',
  source: { kind: 'handle', ref: 'media://sha256-' + 'c'.repeat(64) },
});
const used = () => ({
  inputTokens: 11,
  outputTokens: 2,
  cacheReadTokens: 5,
  cacheWriteTokens: 1,
  mediaUnits: [
    { modality: 'image' as const, direction: 'output' as const, unit: 'count' as const, units: 2 },
  ],
});
function build(
  kind:
    | 'paid'
    | 'free'
    | 'media-unpriced'
    | 'unknown'
    | 'budget-getter'
    | 'writer-getter'
    | 'raw-mutation',
  store = new InMemoryRunStore(),
  deadlineThrow?: Error,
) {
  let calls = 0;
  const original = media();
  const provider: LlmProvider = {
    id: 'openai',
    customEndpoint: true,
    supports: {
      streaming: true,
      tools: false,
      parallelToolCalls: false,
      vision: false,
      promptCache: true,
      reasoning: false,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [['image']],
        surface: 'chat',
      },
    },
    stream: () => {
      throw new Error('generate required');
    },
    generate: () => {
      calls++;
      const result: LlmResult = {
        content: [original, { type: 'text', text: 'detached answer' }],
        stopReason: 'stop',
        usage: used(),
      };
      if (kind === 'budget-getter' || kind === 'writer-getter')
        result.content = [
          original,
          {
            type: 'text',
            get text(): string {
              throw kind === 'budget-getter'
                ? new BudgetPauseError(1, 2, 3)
                : new LedgerDurabilityError(new Error('private cause'), 'false-writer');
            },
          },
        ];
      if (kind === 'raw-mutation')
        Object.defineProperty(result, 'raw', {
          get: () => {
            Object.defineProperty(original, 'mimeType', {
              get: () => {
                throw new BudgetPauseError(1, 2, 3);
              },
            });
            return { opaque: true };
          },
        });
      return Promise.resolve(result);
    },
  };
  const selected =
    kind === 'free'
      ? {
          ...price,
          inputPerMtokMicrocents: 0,
          outputPerMtokMicrocents: 0,
          cachedInputPerMtokMicrocents: 0,
          cacheWritePerMtokMicrocents: 0,
          mediaOutputRates: { image: 0 },
        }
      : kind === 'media-unpriced'
        ? { ...price, mediaOutputRates: {} }
        : price;
  const prices = new Map<string, ModelPricing>(kind === 'unknown' ? [] : [[model, selected]]);
  const host = createInMemoryHost({ store });
  const runner = createAgentNodeExecutor({
    resolveProvider: () => provider,
    keyFor: () => 'synthetic',
    sleep: () => Promise.resolve(),
    tools: [],
    registry: createToolRegistry({ tools: [], host: {} }),
    resolvePrice: prices,
    resolveMediaSurface: () => 'chat',
    ...(deadlineThrow === undefined
      ? {}
      : {
          newAbortController: createAbortController,
          setTimer: () => () => {
            throw deadlineThrow;
          },
        }),
  });
  const engine = new WorkflowEngine({
    host: {
      ...host,
      setTimer: (...args: Parameters<typeof host.setTimer>) => {
        const disarm = host.setTimer(...args);
        if (args[2] === undefined || args[2] === 'work') queueMicrotask(() => host.fireTimers());
        return disarm;
      },
    },
    executor: createDispatchingNodeExecutor({ agent: runner }),
    resolvePrice: prices,
  });
  const workflow = parseWorkflow(`schema_version: '1.0'
workflow:
  id: r11-workflow
  agents:
    - { id: a, provider: openai, model: r11-generated, system_prompt: offline }
  nodes:
    - { id: actual-writer, type: agent, agent_ref: a, prompt_template: answer, max_tokens: 4, output_modalities: [image], retry: { max: 2, retry_on: [provider_unavailable], backoff: linear } }
  edges: []
`);
  const handle = engine.start({ workflow, inputs: {} });
  const events: RunEvent[] = [];
  const done = (async () => {
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'node:retrying') host.fireTimers();
      if (event.type === 'run:paused') engine.cancel(handle.runId);
    }
  })();
  return { engine, host, store, handle, events, done, calls: () => calls };
}
describe('R11 independent real generated workflow and durable accounting', () => {
  for (const family of ['retry', 'pause', 'writer', 'raw'] as const)
    it(`generated attempt timer cleanup fault ${family}`, async () => {
      const marker =
        family === 'retry'
          ? new AgentTurnError('provider_unavailable', 'private cleanup', true)
          : family === 'pause'
            ? new BudgetPauseError(1, 2, 3)
            : family === 'writer'
              ? new LedgerDurabilityError(new Error('private cleanup'), 'false-cleanup-writer')
              : new Error('private cleanup');
      const h = build('paid', new InMemoryRunStore(), marker);
      await h.done;
      expect.soft(h.calls()).toBe(1);
      expect
        .soft(
          h.events.some(
            (e) =>
              e.type === 'node:retrying' || e.type === 'run:paused' || e.type === 'budget:paused',
          ),
        )
        .toBe(false);
      expect
        .soft(h.store.eventsFor(h.handle.runId).filter((e) => e.type === 'cost:attempt_settled'))
        .toMatchObject([
          { nodeId: 'actual-writer', costMicrocents: 80, inputTokens: 11, outputTokens: 2 },
        ]);
      expect.soft(JSON.stringify(h.events)).not.toContain('private cleanup');
      expect.soft(JSON.stringify(h.events)).not.toContain('false-cleanup-writer');
    });
  for (const kind of [
    'paid',
    'free',
    'media-unpriced',
    'unknown',
    'budget-getter',
    'writer-getter',
    'raw-mutation',
  ] as const)
    it(kind, async () => {
      const h = build(kind);
      await h.done;
      expect(h.calls()).toBe(1);
      expect(
        h.events.some(
          (e) =>
            e.type === 'node:retrying' || e.type === 'run:paused' || e.type === 'budget:paused',
        ),
      ).toBe(false);
      const rows = h.store
        .eventsFor(h.handle.runId)
        .filter((e) => e.type === 'cost:attempt_settled');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        nodeId: 'actual-writer',
        inputTokens: 11,
        outputTokens: 2,
        costMicrocents:
          kind === 'free' || kind === 'unknown' ? 0 : kind === 'media-unpriced' ? 54 : 80,
        priced: kind !== 'media-unpriced' && kind !== 'unknown',
      });
      const terminal = h.events.at(-1);
      expect(terminal?.type).toBe(
        kind === 'budget-getter' || kind === 'writer-getter' ? 'run:failed' : 'run:completed',
      );
      if (kind === 'budget-getter' || kind === 'writer-getter') {
        expect(terminal).toMatchObject({
          error: { code: 'internal', retryable: false },
          cumulativeCostMicrocents: 80,
        });
        expect(h.events.filter((e) => e.type === 'node:failed')).toMatchObject([
          { nodeId: 'actual-writer', error: { code: 'internal', retryable: false } },
        ]);
      }
      expect(JSON.stringify(h.events)).not.toContain('false-writer');
      expect(JSON.stringify(h.events)).not.toContain('private cause');
    });
  for (const cancelled of [false, true])
    for (const fail of [false, true])
      it(`actual paid ledger write pending, cancel=${cancelled}, fail=${fail}`, async () => {
        const entered = gate(),
          release = gate();
        class PendingStore extends InMemoryRunStore {
          override async persistEvent(
            ...args: Parameters<InMemoryRunStore['persistEvent']>
          ): Promise<void> {
            if (args[0].type === 'cost:attempt_settled') {
              entered.release();
              await release.promise;
              if (fail) throw new Error('private store failure');
            }
            await super.persistEvent(...args);
          }
        }
        const h = build('paid', new PendingStore());
        await entered.promise;
        if (cancelled) h.engine.cancel(h.handle.runId);
        release.release();
        await h.done;
        expect(h.calls()).toBe(1);
        expect(h.events.some((e) => e.type === 'node:retrying' || e.type === 'run:paused')).toBe(
          false,
        );
        expect(h.events.at(-1)?.type).toBe(
          cancelled ? 'run:cancelled' : fail ? 'run:failed' : 'run:completed',
        );
        expect(
          h.store.eventsFor(h.handle.runId).filter((e) => e.type === 'cost:attempt_settled'),
        ).toHaveLength(fail ? 0 : 1);
        expect(JSON.stringify(h.events)).not.toContain('private store failure');
      });
});
