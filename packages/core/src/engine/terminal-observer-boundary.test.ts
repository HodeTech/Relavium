import { describe, expect, it } from 'vitest';
import {
  CostTracker,
  InvalidOutputCapPlanError,
  FallbackChain,
  LlmProviderError,
  makeLlmError,
  type LlmProvider,
  type StreamChunk,
  type Usage,
  type ModelPricing,
  type AttemptRecord,
} from '@relavium/llm';
import {
  AgentSchema,
  BudgetSchema,
  SessionContextSchema,
  unwiredEffectJournal,
} from '@relavium/shared';
import { AgentSession, type SessionStreamEvent, type SessionDeps } from './agent-session.js';
import {
  captureAgentTurnOutcome,
  DEFAULT_AGENT_TURN_LIMITS,
  type AgentTurnParams,
} from './agent-turn.js';
import { BudgetGovernor } from './budget-governor.js';
import { MoneyDurability, type SettledAttemptDraft } from './money-durability.js';
import { createAbortController, createInMemoryEffectJournalStore } from './execution-host.js';
import { createToolRegistry } from '../tools/registry.js';
import type { ToolDef } from '../tools/types.js';
import type { NodeStreamEvent } from './node-executor.js';

const MODEL = 'terminal-observer-boundary';
const PRICE: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 20000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 2000000,
  cachedInputPerMtokMicrocents: 3000000,
  cacheWritePerMtokMicrocents: 4000000,
  mediaOutputRates: { image: 13 },
};
const prices = new Map([[MODEL, PRICE]]);
const supports: LlmProvider['supports'] = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: false,
  promptCache: true,
  reasoning: true,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [['image']],
    surface: 'chat',
  },
};
const usage = (): Usage => ({
  inputTokens: 7,
  outputTokens: 11,
  cacheReadTokens: 2,
  cacheWriteTokens: 3,
  mediaUnits: [{ modality: 'image', direction: 'output', unit: 'count', units: 2 }],
});
const CHARGE = 73;
function providerFor(raw: Usage, afterStop?: () => void, bare = false): LlmProvider {
  return {
    id: 'openai',
    customEndpoint: true,
    supports,
    generate: () =>
      Promise.resolve({
        content: [{ type: 'text', text: 'synthetic' }],
        stopReason: 'stop',
        usage: raw,
      }),
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      if (!bare) yield { type: 'text_delta', text: 'synthetic' };
      yield { type: 'stop', stopReason: 'stop', usage: raw };
      afterStop?.();
    },
  };
}
function params(p: LlmProvider, overrides: Partial<AgentTurnParams> = {}): AgentTurnParams {
  return {
    nodeId: 'boundary-node',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'offline' }] }],
    planEntries: [{ provider: p, model: MODEL, maxAttempts: 1 }],
    chainCapabilities: { keyFor: () => 'offline-placeholder', sleep: () => Promise.resolve() },
    signal: new AbortController().signal,
    emit: () => {},
    registry: createToolRegistry({ tools: [], host: {} }),
    dispatchContext: {
      nodeId: 'boundary-node',
      grantedToolIds: new Set(),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effects: unwiredEffectJournal(),
      effectSlot: 0,
    },
    limits: DEFAULT_AGENT_TURN_LIMITS,
    resolvePrice: prices,
    maxTokens: 10,
    ...overrides,
  };
}
function sessionFor(
  p: LlmProvider,
  overrides: Partial<SessionDeps> = {},
  tools: readonly ToolDef[] = [],
) {
  const events: SessionStreamEvent[] = [];
  const journal = createInMemoryEffectJournalStore();
  let key = 0;
  const s = new AgentSession({
    sessionId: 'terminal-observer-session',
    agentRef: 'boundary-agent',
    agent: AgentSchema.parse({
      id: 'boundary-agent',
      model: MODEL,
      provider: 'openai',
      system_prompt: 'offline',
      max_tokens: 10,
      tools: tools.map((t) => t.id),
    }),
    context: SessionContextSchema.parse({
      workingDir: '/workspace/offline',
      fsScopeTier: 'sandboxed',
    }),
    deps: {
      resolveProvider: () => p,
      tools,
      registry: createToolRegistry({ tools, host: {} }),
      keyFor: () => 'offline-placeholder',
      sleep: () => Promise.resolve(),
      now: () => 0,
      newAbortController: createAbortController,
      reserveEffectTurnKey: () => ++key,
      effects: (c) => journal.for(c),
      emit: (e) => events.push(e),
      maxTurns: 1,
      resolvePrice: prices,
      autoCompact: false,
      ...overrides,
    },
  });
  s.start();
  return { s, events };
}
describe('held terminal ownership', () => {
  for (const bare of [false, true])
    for (const exit of ['eof', 'throw'] as const)
      for (const mutate of ['zero', 'invalid'] as const)
        it(
          'provider confirming read cannot revise prior Usage ' + bare + '/' + exit + '/' + mutate,
          async () => {
            const raw = usage();
            let calls = 0;
            const p = providerFor(
              raw,
              () => {
                raw.inputTokens = mutate === 'zero' ? 0 : Number.NaN;
                raw.outputTokens = 0;
                raw.cacheReadTokens = 0;
                raw.cacheWriteTokens = 0;
                if (raw.mediaUnits?.[0] !== undefined) raw.mediaUnits[0].units = 0;
                if (exit === 'throw') throw new Error('private teardown');
              },
              bare,
            );
            const stream = p.stream.bind(p);
            const counted: LlmProvider = {
              ...p,
              stream: (r) => {
                calls++;
                return stream(r, 'offline-placeholder');
              },
            };
            const h = sessionFor(counted);
            await h.s.sendMessage('one');
            expect.soft(h.events.find((e) => e.type === 'cost:updated')).toMatchObject({
              inputTokens: 7,
              outputTokens: 11,
              costMicrocents: CHARGE,
              priced: true,
            });
            expect
              .soft(h.events.find((e) => e.type === 'session:turn_completed'))
              .toMatchObject({ stopReason: 'stop', tokensUsed: { input: 7, output: 11 } });
            await h.s.sendMessage('two');
            expect(calls).toBe(1);
            expect(h.events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
          },
        );
  it('actual governor and ledger retain original charge across terminal confirmation', async () => {
    const raw = usage();
    const rows: SettledAttemptDraft[] = [];
    let total = 0;
    const governor = new BudgetGovernor({
      budget: BudgetSchema.parse({ max_cost_microcents: 1000, on_exceed: 'fail' }),
      resolvePrice: prices,
      emit: () => Promise.resolve(),
    });
    const money = new MoneyDurability({
      emit: (d) => {
        rows.push(d);
      },
      flushConservative: () => governor.flushCommitments(),
    });
    const events: NodeStreamEvent[] = [];
    const outcome = await captureAgentTurnOutcome(
      params(
        providerFor(raw, () => {
          raw.inputTokens = 0;
          raw.outputTokens = 0;
          raw.cacheReadTokens = 0;
          raw.cacheWriteTokens = 0;
          if (raw.mediaUnits?.[0] !== undefined) raw.mediaUnits[0].units = 0;
        }),
        {
          preEgress: (i) => governor.checkPreEgress(i),
          money: money.turnPort(() => total),
          emit: (e) => {
            events.push(e);
            if (e.type === 'cost:updated') {
              total += e.costMicrocents;
              governor.updateCost(total);
            }
          },
        },
      ),
    );
    await money.join();
    expect
      .soft(outcome)
      .toMatchObject({ kind: 'succeeded', result: { usage: { input: 7, output: 11 } } });
    expect.soft(rows).toEqual([
      expect.objectContaining({
        costMicrocents: CHARGE,
        inputTokens: 7,
        outputTokens: 11,
        priced: true,
      }),
    ]);
    expect.soft(total).toBe(CHARGE);
  });
  for (const exit of ['eof', 'throw'] as const)
    it('stable raw stop control ' + exit, async () => {
      const raw = usage();
      const records: AttemptRecord[] = [];
      const tracker = new CostTracker(prices);
      const p = providerFor(raw, () => {
        if (exit === 'throw') throw new Error('private teardown');
      });
      for await (const chunk of new FallbackChain([{ provider: p, model: MODEL, maxAttempts: 1 }], {
        keyFor: () => 'offline-placeholder',
        sleep: () => Promise.resolve(),
        costTracker: tracker,
        onAttempt: (r) => records.push(r),
      }).stream({ model: MODEL, messages: [] }))
        void chunk;
      expect(records).toHaveLength(1);
      expect(records[0]?.usage).toEqual(usage());
      expect(tracker.cumulativeCostMicrocents).toBe(CHARGE);
    });
});
describe('attempt diagnostic ownership', () => {
  for (const path of ['generate', 'stream'] as const)
    for (const committed of [false, true])
      for (const change of ['ordinary', 'mutation', 'getter'] as const)
        it('direct chain frozen diagnostic ' + path + '/' + committed + '/' + change, async () => {
          let calls = 0;
          const records: AttemptRecord[] = [];
          let modified = false;
          const marker = new Error('private observer-installed getter');
          const diagnostic = makeLlmError({
            provider: 'openai',
            kind: 'auth',
            message: 'safe auth',
          });
          if (committed) diagnostic.contentCommitted = true;
          const p: LlmProvider = {
            id: 'openai',
            customEndpoint: true,
            supports,
            generate: () => {
              calls++;
              throw new LlmProviderError(diagnostic);
            },
            stream: () => {
              calls++;
              throw new LlmProviderError(diagnostic);
            },
          };
          const chain = new FallbackChain([{ provider: p, model: MODEL, maxAttempts: 2 }], {
            keyFor: () => 'offline-placeholder',
            sleep: () => Promise.resolve(),
            onAttempt: (r) => {
              records.push(r);
              if (r.error === undefined || change === 'ordinary') return;
              if (change === 'getter')
                modified = Reflect.defineProperty(r.error, 'kind', {
                  get: () => {
                    throw marker;
                  },
                });
              else {
                modified = Reflect.defineProperty(r.error, 'kind', { value: 'timeout' });
                Reflect.defineProperty(r.error, 'retryable', { value: true });
                Reflect.defineProperty(r.error, 'message', { value: 'private observer mutation' });
              }
            },
          });
          const chunks: StreamChunk[] = [];
          let escaped: unknown;
          try {
            if (path === 'generate') await chain.generate({ model: MODEL, messages: [] });
            else for await (const c of chain.stream({ model: MODEL, messages: [] })) chunks.push(c);
          } catch (e) {
            escaped = e;
          }
          expect.soft(calls).toBe(1);
          expect.soft(records).toHaveLength(1);
          expect.soft(modified).toBe(false);
          if (path === 'stream')
            expect
              .soft(chunks.at(-1))
              .toMatchObject({ type: 'error', error: { kind: 'auth', message: 'safe auth' } });
          else expect.soft(escaped).toBeInstanceOf(LlmProviderError);
        });
});

describe('held terminal root and error ownership', () => {
  for (const exit of ['eof', 'throw'] as const) {
    it('Session retains prior stopReason during confirmation/' + exit, async () => {
      const stop: Extract<StreamChunk, { type: 'stop' }> = {
        type: 'stop',
        stopReason: 'stop',
        usage: usage(),
      };
      const p: LlmProvider = {
        id: 'openai',
        customEndpoint: true,
        supports,
        generate: () => {
          throw new Error('unused');
        },
        stream: async function* (): AsyncGenerator<StreamChunk> {
          await Promise.resolve();
          yield { type: 'text_delta', text: 'safe' };
          yield stop;
          stop.stopReason = 'tool_use';
          if (exit === 'throw') throw new Error('private teardown');
        },
      };
      const h = sessionFor(p);
      await h.s.sendMessage('one');
      expect(h.events.find((e) => e.type === 'session:turn_completed')).toMatchObject({
        stopReason: 'stop',
        tokensUsed: { input: 7, output: 11 },
      });
    });
    for (const bare of [true, false])
      for (const change of [false, true])
        it('held error snapshot/' + exit + '/' + bare + '/' + change, async () => {
          const diagnostic = makeLlmError({
            provider: 'openai',
            kind: 'auth',
            message: 'safe auth',
          });
          let calls = 0;
          const records: AttemptRecord[] = [];
          const p: LlmProvider = {
            id: 'openai',
            customEndpoint: true,
            supports,
            generate: () => {
              throw new Error('unused');
            },
            stream: async function* (): AsyncGenerator<StreamChunk> {
              calls++;
              await Promise.resolve();
              if (!bare) yield { type: 'text_delta', text: 'safe' };
              yield { type: 'error', error: diagnostic };
              if (change) {
                diagnostic.kind = 'timeout';
                diagnostic.retryable = true;
                diagnostic.message = 'private later mutation';
              }
              if (exit === 'throw') throw new Error('private teardown');
            },
          };
          const chunks: StreamChunk[] = [];
          for await (const chunk of new FallbackChain(
            [{ provider: p, model: MODEL, maxAttempts: 2 }],
            {
              keyFor: () => 'offline-placeholder',
              sleep: () => Promise.resolve(),
              onAttempt: (r) => records.push(r),
            },
          ).stream({ model: MODEL, messages: [] }))
            chunks.push(chunk);
          expect.soft(calls).toBe(1);
          expect.soft(records).toHaveLength(1);
          expect
            .soft(chunks.at(-1))
            .toMatchObject({ type: 'error', error: { kind: 'auth', message: 'safe auth' } });
        });
  }
});
describe('synthesized diagnostic ownership', () => {
  for (const path of ['generate', 'stream'] as const)
    for (const family of ['unknown', 'cap', 'cancelled'] as const)
      for (const change of ['ordinary', 'mutation', 'getter'] as const)
        it(path + '/' + family + '/' + change, async () => {
          const controller = new AbortController();
          let calls = 0;
          let modified = false;
          const records: AttemptRecord[] = [];
          const trap = new Error('private synthesized diagnostic getter');
          const failure = () => {
            calls++;
            if (family === 'cancelled') controller.abort();
            throw family === 'cap'
              ? new InvalidOutputCapPlanError()
              : new Error('private raw provider');
          };
          const p: LlmProvider = {
            id: 'openai',
            customEndpoint: true,
            supports,
            generate: failure,
            stream: failure,
          };
          const chain = new FallbackChain([{ provider: p, model: MODEL, maxAttempts: 2 }], {
            keyFor: () => 'offline-placeholder',
            sleep: () => Promise.resolve(),
            onAttempt: (r) => {
              records.push(r);
              if (r.error === undefined || change === 'ordinary') return;
              modified = Reflect.defineProperty(
                r.error,
                'kind',
                change === 'getter'
                  ? {
                      get: () => {
                        throw trap;
                      },
                    }
                  : { value: 'timeout' },
              );
              if (change === 'mutation')
                Reflect.defineProperty(r.error, 'retryable', { value: true });
            },
          });
          const chunks: StreamChunk[] = [];
          let escaped: unknown;
          try {
            if (path === 'generate')
              await chain.generate({ model: MODEL, messages: [], signal: controller.signal });
            else
              for await (const c of chain.stream({
                model: MODEL,
                messages: [],
                signal: controller.signal,
              }))
                chunks.push(c);
          } catch (e) {
            escaped = e;
          }
          expect.soft(modified).toBe(false);
          expect.soft(calls).toBe(1);
          expect.soft(records).toHaveLength(1);
          if (path === 'stream')
            expect.soft(chunks.at(-1)).toMatchObject({
              type: 'error',
              error: {
                kind:
                  family === 'cap'
                    ? 'bad_request'
                    : family === 'cancelled'
                      ? 'cancelled'
                      : 'unknown',
              },
            });
          else expect.soft(escaped).toBeInstanceOf(LlmProviderError);
        });
});
