import { describe, expect, it } from 'vitest';
import {
  LlmProviderError,
  makeLlmError,
  type LlmProvider,
  type ModelPricing,
  type StreamChunk,
} from '@relavium/llm';
import { AgentSchema, SessionContextSchema, type RunEvent } from '@relavium/shared';
import { AgentSession, type SessionStreamEvent } from './agent-session.js';
import { createAbortController } from './execution-host.js';
import { WorkflowEngine } from './engine.js';
import { AgentTurnError } from './agent-turn.js';
import { BudgetPauseError, CommitmentDurabilityError } from './budget-governor.js';
import { LedgerDurabilityError } from './money-durability.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { createDispatchingNodeExecutor } from './node-handlers/dispatcher.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import { createToolRegistry } from '../tools/registry.js';
import { parseWorkflow } from '../parser.js';
const MODEL = 'r9-independent-price';
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
async function actualWorkflow(
  path: 'stream' | 'generate',
  kind: 'none' | 'raw' | 'turn' | 'pause' | 'ledger' | 'commitment',
  origin: 'map' | 'rate-getter' | 'provider-cause' | 'result-getter' | 'clock' = 'map',
) {
  const marker =
    kind === 'turn'
      ? new AgentTurnError('provider_unavailable', 'private r9 pricing canary', true)
      : kind === 'pause'
        ? new BudgetPauseError(1, 7, 100)
        : kind === 'ledger'
          ? new LedgerDurabilityError(new Error('private r9 writer canary'), 'wrong-writer')
          : kind === 'commitment'
            ? new CommitmentDurabilityError(new Error('private r9 writer canary'), 'wrong-writer')
            : new Error('private r9 pricing canary');
  let calls = 0;
  let pending = false;
  class Overlay extends Map<string, ModelPricing> {
    override get(model: string): ModelPricing | undefined {
      if (calls > 0 && kind !== 'none' && origin === 'map') throw marker;
      return super.get(model);
    }
  }
  const price = { ...PRICE };
  Object.defineProperty(price, 'outputPerMtokMicrocents', {
    get: () => {
      if (calls > 0 && kind !== 'none' && origin === 'rate-getter') throw marker;
      return PRICE.outputPerMtokMicrocents;
    },
  });
  const prices = new Overlay([[MODEL, price]]);
  const provider: LlmProvider = {
    id: 'openai',
    customEndpoint: true,
    supports: {
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
    },
    generate: () => {
      calls++;
      if (origin === 'clock' && kind !== 'none') pending = true;
      if (origin === 'provider-cause' && kind !== 'none')
        throw new LlmProviderError(
          makeLlmError({
            provider: 'openai',
            kind: 'unknown',
            message: 'fixed provider diagnostic',
            cause: marker,
          }),
        );
      const result: Awaited<ReturnType<LlmProvider['generate']>> = {
        content: [
          {
            type: 'media',
            mimeType: 'image/png',
            source: { kind: 'handle', ref: 'media://sha256-' + 'a'.repeat(64) },
          },
        ],
        stopReason: 'stop',
        usage: { inputTokens: 7, outputTokens: 11 },
      };
      if (origin === 'result-getter' && kind !== 'none')
        Object.defineProperty(result, 'content', {
          get: () => {
            throw marker;
          },
        });
      return Promise.resolve(result);
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      calls++;
      yield { type: 'text_delta', text: 'paid response' };
      if (origin === 'provider-cause' && kind !== 'none') {
        yield {
          type: 'error',
          error: makeLlmError({
            provider: 'openai',
            kind: 'unknown',
            message: 'fixed provider diagnostic',
            cause: marker,
          }),
        };
        return;
      }
      if (origin === 'clock' && kind !== 'none') pending = true;
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 7, outputTokens: 11 } };
    },
  };
  const store = new InMemoryRunStore(),
    host = createInMemoryHost({ store });
  const activeHost = {
    ...host,
    clock: {
      now: () => {
        if (pending) {
          pending = false;
          throw marker;
        }
        return host.clock.now();
      },
    },
    setTimer: (...args: Parameters<typeof host.setTimer>) => {
      const stop = host.setTimer(...args);
      if (args[2] === undefined || args[2] === 'work') queueMicrotask(() => host.fireTimers());
      return stop;
    },
  };
  const runner = createAgentNodeExecutor({
    resolveProvider: () => provider,
    keyFor: () => 'synthetic-key',
    sleep: () => Promise.resolve(),
    tools: [],
    registry: createToolRegistry({ tools: [], host: {} }),
    resolvePrice: prices,
    resolveMediaSurface: () => 'chat',
  });
  const engine = new WorkflowEngine({
    host: activeHost,
    executor: createDispatchingNodeExecutor({ agent: runner }),
  });
  const workflow = parseWorkflow(
    [
      "schema_version: '1.0'",
      'workflow:',
      '  id: r9-pricing-provenance',
      '  agents:',
      '    - { id: a, model: r9-independent-price, provider: openai, system_prompt: hi }',
      '  nodes:',
      '    - { id: n, type: agent, agent_ref: a, prompt_template: go, max_tokens: 10' +
        (path === 'generate' ? ', output_modalities: [image]' : '') +
        ', retry: { max: 2, backoff: linear, retry_on: [provider_unavailable] } }',
      '  edges: []',
    ].join('\n'),
  );
  const handle = engine.start({ workflow, inputs: {} }),
    events: RunEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
    if (event.type === 'run:paused') engine.cancel(handle.runId);
  }
  const rows = store.eventsFor(handle.runId).filter((e) => e.type === 'cost:attempt_settled');
  return { calls, rows, events };
}
describe('independent observer money-class provenance', () => {
  for (const path of ['stream', 'generate'] as const)
    for (const kind of ['none', 'raw', 'ledger', 'commitment'] as const)
      it(path + '/' + kind + ' preserves actual writer attribution', async () => {
        const h = await actualWorkflow(path, kind, 'clock');
        expect.soft(h.calls).toBe(1);
        expect.soft(h.rows).toHaveLength(1);
        expect
          .soft(h.rows)
          .toMatchObject([
            { nodeId: 'n', inputTokens: 7, outputTokens: 11, costMicrocents: 18, priced: true },
          ]);
        expect.soft(JSON.stringify(h.events)).not.toContain('wrong-writer');
        expect.soft(JSON.stringify(h.events)).not.toContain('private r9');
        if (kind !== 'none')
          expect.soft(h.events.at(-1)).toMatchObject({
            type: 'run:failed',
            error: {
              code: 'internal',
              message: 'the agent turn failed with an unexpected observer error',
              retryable: false,
            },
          });
      });
});

describe('independent actual pricing callback provenance', () => {
  for (const path of ['stream', 'generate'] as const) {
    for (const kind of ['none', 'raw'] as const)
      it(path + '/' + kind + ' causal negative', async () => {
        const h = await actualWorkflow(path, kind);
        expect(h.calls).toBe(1);
        expect(h.rows).toHaveLength(1);
        expect(h.events.some((e) => e.type === 'run:paused' || e.type === 'node:retrying')).toBe(
          false,
        );
        expect(JSON.stringify(h.events)).not.toContain('private r9');
      });
    for (const kind of ['turn', 'pause'] as const)
      it(
        path + '/' + kind + ' paid callback must not acquire retry or pause authority',
        async () => {
          const h = await actualWorkflow(path, kind);
          expect.soft(h.calls).toBe(1);
          expect.soft(h.rows).toHaveLength(1);
          expect
            .soft(
              h.events.some(
                (e) =>
                  e.type === 'run:paused' ||
                  e.type === 'human_gate:paused' ||
                  e.type === 'node:retrying',
              ),
            )
            .toBe(false);
          expect.soft(JSON.stringify(h.events)).not.toContain('private r9');
        },
      );
  }
});

async function actualSession(kind: 'none' | 'raw' | 'turn' | 'pause') {
  let calls = 0,
    key = 0;
  const events: SessionStreamEvent[] = [];
  const marker =
    kind === 'turn'
      ? new AgentTurnError('provider_unavailable', 'private r9 session pricing canary', true)
      : kind === 'pause'
        ? new BudgetPauseError(1, 7, 100)
        : new Error('private r9 session pricing canary');
  class Overlay extends Map<string, ModelPricing> {
    override get(model: string): ModelPricing | undefined {
      if (calls > 0 && kind !== 'none') throw marker;
      return super.get(model);
    }
  }
  const prices = new Overlay([[MODEL, PRICE]]);
  const provider: LlmProvider = {
    id: 'openai',
    customEndpoint: true,
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
      calls++;
      yield { type: 'text_delta', text: 'paid' };
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 7, outputTokens: 11 } };
    },
  };
  const session = new AgentSession({
    sessionId: 'r9-session',
    agentRef: 'a',
    agent: AgentSchema.parse({
      id: 'a',
      provider: 'openai',
      model: MODEL,
      system_prompt: 'offline',
    }),
    context: SessionContextSchema.parse({ workingDir: '/workspace/r9', fsScopeTier: 'sandboxed' }),
    deps: {
      resolveProvider: () => provider,
      tools: [],
      registry: createToolRegistry({ tools: [], host: {} }),
      maxTurns: 1,
      reserveEffectTurnKey: () => ++key,
      keyFor: () => 'synthetic-key',
      sleep: () => Promise.resolve(),
      now: () => 0,
      newAbortController: createAbortController,
      resolvePrice: prices,
      emit: (event) => events.push(event),
    },
  });
  session.start();
  await session.sendMessage('first');
  const completed = events.filter((e) => e.type === 'session:turn_completed');
  await session.sendMessage('cap');
  return { calls, events, completed };
}
describe('independent actual session pricing origin', () => {
  for (const kind of ['none', 'raw', 'turn', 'pause'] as const)
    it(kind + ' keeps canonical usage/cap and truthful private presentation', async () => {
      const h = await actualSession(kind);
      expect(h.calls).toBe(1);
      expect(h.completed).toHaveLength(1);
      expect(h.completed[0]).toMatchObject({ tokensUsed: { input: 7, output: 11 } });
      expect(h.events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
      if (kind !== 'none')
        expect
          .soft(h.completed[0])
          .toMatchObject({ error: { code: 'internal', retryable: false } });
      expect.soft(JSON.stringify(h.events)).not.toContain('private r9');
    });
});

describe('independent source-origin variants through actual workflow', () => {
  for (const path of ['stream', 'generate'] as const)
    for (const origin of ['rate-getter', 'provider-cause'] as const)
      for (const kind of ['none', 'turn', 'pause'] as const)
        it(path + '/' + origin + '/' + kind, async () => {
          const h = await actualWorkflow(path, kind, origin);
          expect.soft(h.calls).toBe(1);
          expect
            .soft(
              h.events.some(
                (e) =>
                  e.type === 'node:retrying' ||
                  e.type === 'run:paused' ||
                  e.type === 'human_gate:paused',
              ),
            )
            .toBe(false);
          expect.soft(JSON.stringify(h.events)).not.toContain('private r9');
        });
  for (const kind of ['none', 'turn', 'pause'] as const)
    it('generate/result-getter/' + kind, async () => {
      const h = await actualWorkflow('generate', kind, 'result-getter');
      expect.soft(h.calls).toBe(1);
      expect.soft(h.rows).toHaveLength(1);
      expect
        .soft(
          h.events.some(
            (e) =>
              e.type === 'node:retrying' ||
              e.type === 'run:paused' ||
              e.type === 'human_gate:paused',
          ),
        )
        .toBe(false);
      expect.soft(JSON.stringify(h.events)).not.toContain('private r9');
    });
});
