import { describe, expect, it } from 'vitest';
import {
  prepareOutputCapPlan,
  FallbackChain,
  CostTracker,
  LlmProviderError,
  makeLlmError,
  type LlmProvider,
  type LlmResult,
  type StreamChunk,
  type AttemptRecord,
  type ModelPricing,
} from '@relavium/llm';
import { AgentSchema, SessionContextSchema } from '@relavium/shared';
import { AgentSession, type SessionDeps, type SessionStreamEvent } from './agent-session.js';
import {
  AgentTurnError,
  captureAgentTurnOutcome,
  DEFAULT_AGENT_TURN_LIMITS,
  type AgentTurnParams,
} from './agent-turn.js';
import { BudgetPauseError } from './budget-governor.js';
import { MoneyDurability, LedgerDurabilityError } from './money-durability.js';
import { createAbortController, createInMemoryEffectJournalStore } from './execution-host.js';
import { createToolRegistry } from '../tools/registry.js';

const model = 'r10-contract-model';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 10000,
  maxOutputTokens: 100,
  inputPerMtokMicrocents: 1_000_000,
  outputPerMtokMicrocents: 2_000_000,
  cachedInputPerMtokMicrocents: 3_000_000,
  cacheWritePerMtokMicrocents: 4_000_000,
  mediaOutputRates: { image: 5 },
};
const supports: LlmProvider['supports'] = {
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
};
function basicProvider(onCall: () => void = () => undefined): LlmProvider {
  return {
    id: 'openai',
    customEndpoint: true,
    supports,
    generate: async () => {
      await Promise.resolve();
      onCall();
      return {
        content: [{ type: 'text', text: 'summary' }],
        stopReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 4 },
      };
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      onCall();
      yield { type: 'text_delta', text: 'summary' };
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 3, outputTokens: 4 } };
    },
  };
}
const markers = {
  typed: () => new AgentTurnError('provider_unavailable', 'R10_PRIVATE_LIFECYCLE', true),
  pause: () => new BudgetPauseError(100, 90, 13),
  raw: () => new Error('R10_PRIVATE_LIFECYCLE'),
  opaque: () =>
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('R10_PRIVATE_REFLECTION');
        },
      },
    ),
};
type Site = 'start' | 'finish' | 'flush' | 'reserve' | 'controller';
function sessionFixture(site: Site, marker: unknown) {
  let calls = 0,
    key = 0,
    armed = false;
  const events: SessionStreamEvent[] = [];
  const once = () => {
    if (armed) {
      armed = false;
      throw marker;
    }
  };
  const deps: SessionDeps = {
    resolveProvider: () =>
      basicProvider(() => {
        calls++;
      }),
    keyFor: () => 'synthetic',
    sleep: () => Promise.resolve(),
    newAbortController: () => {
      if (site === 'controller') once();
      return createAbortController();
    },
    reserveEffectTurnKey: () => {
      if (site === 'reserve') once();
      return ++key;
    },
    tools: [],
    registry: createToolRegistry({ tools: [], host: {} }),
    autoCompact: false,
    maxTurns: 4,
    resolvePrice: new Map([[model, price]]),
    flushBudgetCommitments: async () => {
      await Promise.resolve();
      if (site === 'flush') once();
    },
    emit: (e) => {
      events.push(e);
      if (
        (site === 'start' && e.type === 'session:turn_started') ||
        (site === 'finish' && e.type === 'session:turn_completed')
      )
        once();
    },
  };
  const session = new AgentSession({
    sessionId: 'r10-life',
    agentRef: 'a',
    agent: AgentSchema.parse({ id: 'a', provider: 'openai', model, system_prompt: 'offline' }),
    context: SessionContextSchema.parse({
      workingDir: '/workspace/offline',
      fsScopeTier: 'sandboxed',
    }),
    deps,
  });
  session.start();
  return {
    session,
    events,
    arm: () => {
      armed = true;
    },
    calls: () => calls,
  };
}
async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('R10 new Session lifecycle challenges', () => {
  for (const site of ['start', 'controller'] as const)
    for (const kind of ['typed', 'raw', 'opaque'] as const)
      it(`${site}/${kind}: refuses pre-provider work and releases running state`, async () => {
        const marker = markers[kind](),
          h = sessionFixture(site, marker);
        h.arm();
        expect(Object.is(await caught(() => h.session.sendMessage('first')), marker)).toBe(true);
        expect(h.calls()).toBe(0);
        const next = await caught(() => h.session.sendMessage('recover'));
        expect.soft(next, 'the next send must not be rejected as already running').toBeUndefined();
        expect.soft(h.calls()).toBe(1);
      });
  for (const site of ['finish', 'flush', 'reserve'] as const)
    for (const kind of ['typed', 'pause', 'raw', 'opaque'] as const)
      it(`${site}/${kind}: post-turn or preparation callback has private-safe presentation`, async () => {
        const marker = markers[kind](),
          h = sessionFixture(site, marker);
        h.arm();
        const error = await caught(() => h.session.sendMessage('first'));
        expect(
          Object.is(
            error,
            site === 'reserve' || kind === 'typed' || kind === 'pause' ? undefined : marker,
          ),
        ).toBe(true);
        const terminal = h.events.filter((e) => e.type === 'session:turn_completed').at(-1);
        expect.soft(terminal).toMatchObject({
          stopReason: 'error',
          error: { code: 'internal', retryable: false },
          tokensUsed: { input: site === 'reserve' ? 0 : 3, output: site === 'reserve' ? 0 : 4 },
        });
        expect.soft(JSON.stringify(h.events)).not.toContain('R10_PRIVATE');
        await h.session.sendMessage('recover');
        expect(h.calls()).toBe(site === 'reserve' ? 1 : 2);
      });
  for (const kind of ['typed', 'raw', 'opaque'] as const)
    it(`compact controller/${kind}: cleanup after controller factory rejection`, async () => {
      const marker = markers[kind](),
        h = sessionFixture('controller', marker);
      await h.session.sendMessage('one');
      await h.session.sendMessage('two');
      h.arm();
      expect(Object.is(await caught(() => h.session.compact()), marker)).toBe(true);
      expect(h.calls()).toBe(2);
      expect
        .soft(await caught(() => h.session.sendMessage('after refused compact')))
        .toBeUndefined();
      expect.soft(h.calls()).toBe(3);
    });
});

function turnParams(p: LlmProvider): AgentTurnParams {
  return {
    nodeId: 'reader',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'offline' }] }],
    planEntries: [{ provider: p, model, maxAttempts: 2 }],
    chainCapabilities: { keyFor: () => 'synthetic', sleep: () => Promise.resolve() },
    emit: () => undefined,
    signal: createAbortController().signal,
    registry: createToolRegistry({ tools: [], host: {} }),
    dispatchContext: {
      nodeId: 'reader',
      grantedToolIds: new Set(),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effectSlot: 0,
      effects: createInMemoryEffectJournalStore().for({
        kind: 'session',
        sessionId: 'r10-turn',
        turn: 1,
      }),
    },
    limits: DEFAULT_AGENT_TURN_LIMITS,
    resolvePrice: new Map([[model, price]]),
  };
}
describe('R10 causal controls: actual B1 and external causes', () => {
  for (const cancelled of [false, true])
    it(`shared writer B1 cancellation=${cancelled}`, async () => {
      let release: () => void = () => {
        throw new Error('unarmed');
      };
      const held = new Promise<void>((r) => {
        release = r;
      });
      const cause = new Error('private durable failure');
      let calls = 0;
      const money = new MoneyDurability({
        emit: async () => {
          await held;
          throw cause;
        },
      });
      money.record(
        {
          nodeId: 'actual-writer',
          model,
          attemptNumber: 1,
          inputTokens: 1,
          outputTokens: 1,
          costMicrocents: 3,
          priced: true,
        },
        3,
      );
      const controller = createAbortController(),
        params = turnParams(
          basicProvider(() => {
            calls++;
          }),
        );
      const flight = captureAgentTurnOutcome({
        ...params,
        signal: controller.signal,
        money: money.turnPort(() => 3),
      });
      await Promise.resolve();
      expect(calls).toBe(0);
      if (cancelled) controller.abort();
      release();
      const out = await flight;
      expect(out.kind).toBe('failed');
      if (out.kind !== 'failed') throw new Error('expected failed');
      expect(out.failureOrigin).toBe('turn');
      expect(calls).toBe(0);
      if (cancelled) expect(out.error).toMatchObject({ code: 'cancelled', retryable: false });
      else {
        expect(out.error).toBeInstanceOf(LedgerDurabilityError);
        expect(out.error).toMatchObject({ nodeId: 'actual-writer', cause });
      }
    });
  for (const origin of ['pricing', 'provider'] as const)
    it(`${origin} cannot reuse budget authority`, async () => {
      const marker = new BudgetPauseError(100, 90, 13);
      let calls = 0;
      let params = turnParams(
        basicProvider(() => {
          calls++;
        }),
      );
      if (origin === 'pricing') {
        class Overlay extends Map<string, ModelPricing> {
          override get(id: string) {
            if (calls > 0) throw marker;
            return super.get(id);
          }
        }
        params = { ...params, resolvePrice: new Overlay([[model, price]]) };
      } else {
        const provider: LlmProvider = {
          ...basicProvider(),
          stream: async function* (): AsyncGenerator<StreamChunk> {
            await Promise.resolve();
            calls++;
            yield {
              type: 'error',
              error: makeLlmError({
                provider: 'openai',
                kind: 'unknown',
                message: 'fixed',
                cause: marker,
              }),
            };
          },
        };
        params = { ...params, planEntries: [{ provider, model, maxAttempts: 2 }] };
      }
      const out = await captureAgentTurnOutcome(params);
      expect(out).toMatchObject({
        kind: 'failed',
        failureOrigin: 'turn',
        error: { code: 'internal', retryable: false },
      });
      expect(calls).toBe(1);
    });
  it('real current preEgress pause still retains original control with zero provider calls', async () => {
    const marker = new BudgetPauseError(100, 90, 13);
    let calls = 0;
    const out = await captureAgentTurnOutcome({
      ...turnParams(
        basicProvider(() => {
          calls++;
        }),
      ),
      preEgress: () => {
        throw marker;
      },
    });
    expect(out).toMatchObject({
      kind: 'failed',
      failureOrigin: 'turn',
      error: marker,
      engaged: false,
    });
    if (out.kind === 'failed') expect(out.error).toBe(marker);
    expect(calls).toBe(0);
  });
});

describe('R10 generated projection and quantities', () => {
  for (const key of ['content', 'stopReason', 'raw'] as const)
    for (const pricingFails of [false, true])
      it(`${key} projection with pricingFails=${pricingFails}`, async () => {
        const marker = markers.typed();
        let calls = 0,
          reads = 0;
        const records: AttemptRecord[] = [];
        const result: LlmResult = {
          content: [{ type: 'text', text: 'returned' }],
          stopReason: 'stop',
          usage: {
            inputTokens: 3,
            outputTokens: 4,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            mediaUnits: [{ modality: 'image', direction: 'output', unit: 'count', units: 2 }],
          },
        };
        Object.defineProperty(result, key, {
          get() {
            reads++;
            throw marker;
          },
        });
        const p: LlmProvider = {
          ...basicProvider(),
          generate: async () => {
            await Promise.resolve();
            calls++;
            return result;
          },
        };
        const tracker = pricingFails
          ? {
              record() {
                throw marker;
              },
            }
          : new CostTracker(new Map([[model, price]]));
        const chain = new FallbackChain([{ provider: p, model, maxAttempts: 3 }], {
          keyFor: () => 'synthetic',
          sleep: () => Promise.resolve(),
          costTracker: tracker,
          onAttempt: (r) => {
            records.push(r);
          },
        });
        const err = await caught(() => chain.generate({ model, messages: [] }));
        expect(err).toBeInstanceOf(LlmProviderError);
        expect(err).toMatchObject({
          llmError: { kind: 'unknown', retryable: false, cause: marker },
        });
        expect(calls).toBe(1);
        expect(reads).toBe(pricingFails ? 0 : 1);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          outcome: 'failed',
          contentReceived: true,
          providerInvoked: true,
          usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 },
        });
        if (pricingFails) expect(records[0]).toMatchObject({ priced: false });
        else expect(records[0]?.cost?.costMicrocents).toBe(31);
      });
  it('genuine pre-content provider timeout still retries', async () => {
    let calls = 0;
    const p: LlmProvider = {
      ...basicProvider(),
      generate: async () => {
        await Promise.resolve();
        calls++;
        if (calls === 1)
          throw new LlmProviderError(
            makeLlmError({ provider: 'openai', kind: 'timeout', message: 'provider timed out' }),
          );
        return { content: [], stopReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const chain = new FallbackChain([{ provider: p, model, maxAttempts: 2 }], {
      keyFor: () => 'synthetic',
      sleep: () => Promise.resolve(),
    });
    await chain.generate({ model, messages: [] });
    expect(calls).toBe(2);
  });
});

import { RunEventBus } from './event-bus.js';
import { createSessionEventSink } from './session-handle.js';
import type { RunOrSessionEvent } from '@relavium/shared';
import { BudgetGovernor } from './budget-governor.js';

describe('R10 actual host event sink path', () => {
  for (const site of ['start', 'finish'] as const)
    for (const active of [false, true])
      it(`real bus clock ${site}/active=${active}`, async () => {
        let calls = 0,
          key = 0,
          stamps = 0;
        const events: RunOrSessionEvent[] = [];
        const marker = new AgentTurnError('provider_unavailable', 'R10_PRIVATE_BUS_CLOCK', true);
        const bus = new RunEventBus({
          now: () => {
            stamps++;
            if (active && stamps === (site === 'start' ? 2 : 5)) throw marker;
            return '2026-10-05T00:00:00.000Z';
          },
        });
        bus.subscribe((e) => {
          events.push(e);
        });
        const session = new AgentSession({
          sessionId: 'r10-bus',
          agentRef: 'a',
          agent: AgentSchema.parse({
            id: 'a',
            provider: 'openai',
            model,
            system_prompt: 'offline',
          }),
          context: SessionContextSchema.parse({
            workingDir: '/workspace/offline',
            fsScopeTier: 'sandboxed',
          }),
          deps: {
            resolveProvider: () =>
              basicProvider(() => {
                calls++;
              }),
            keyFor: () => 'synthetic',
            sleep: () => Promise.resolve(),
            newAbortController: createAbortController,
            reserveEffectTurnKey: () => ++key,
            tools: [],
            registry: createToolRegistry({ tools: [], host: {} }),
            autoCompact: false,
            maxTurns: 1,
            resolvePrice: new Map([[model, price]]),
            emit: createSessionEventSink(bus, 'r10-bus'),
          },
        });
        session.start();
        const failure = await caught(() => session.sendMessage('first'));
        if (site === 'start' && active) {
          expect(Object.is(failure, marker)).toBe(true);
          expect(calls).toBe(0);
          expect
            .soft(await caught(() => session.sendMessage('after refused start')))
            .toBeUndefined();
          expect.soft(calls).toBe(1);
        } else {
          expect(failure).toBeUndefined();
          expect(calls).toBe(1);
          if (active) {
            expect.soft(events.at(-1)).toMatchObject({
              error: { code: 'internal', retryable: false },
              tokensUsed: { input: 3, output: 4 },
            });
            expect.soft(JSON.stringify(events)).not.toContain('R10_PRIVATE');
          }
          await session.sendMessage('cap');
          expect(calls).toBe(1);
          expect(events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
        }
      });
  it('genuine conservative flush fault preserves raw durability exception and paid hard-cap slot', async () => {
    let calls = 0,
      key = 0;
    const events: SessionStreamEvent[] = [];
    const cause = new Error('R10_PRIVATE_STORE');
    const governor = new BudgetGovernor({
      budget: { max_cost_microcents: 100000, on_exceed: 'fail' },
      resolvePrice: new Map([[model, price]]),
      emit: () => {
        throw cause;
      },
    });
    const cap = prepareOutputCapPlan({
      model,
      provider: 'openai',
      endpoint: 'custom',
      maxTokens: 1,
      providerOptions: undefined,
    });
    const lease = await governor.checkPreEgress({
      ...cap,
      outputCapPlan: cap,
      inputTokensEstimate: 1,
      route: 'text',
      maxTokensEstimate: undefined,
    });
    lease?.settleAtReservedEstimate({ nodeId: 'writer' });
    const session = new AgentSession({
      sessionId: 'r10-flush',
      agentRef: 'a',
      agent: AgentSchema.parse({ id: 'a', provider: 'openai', model, system_prompt: 'offline' }),
      context: SessionContextSchema.parse({
        workingDir: '/workspace/offline',
        fsScopeTier: 'sandboxed',
      }),
      deps: {
        resolveProvider: () =>
          basicProvider(() => {
            calls++;
          }),
        keyFor: () => 'synthetic',
        sleep: () => Promise.resolve(),
        newAbortController: createAbortController,
        reserveEffectTurnKey: () => ++key,
        tools: [],
        registry: createToolRegistry({ tools: [], host: {} }),
        autoCompact: false,
        maxTurns: 1,
        resolvePrice: new Map([[model, price]]),
        emit: (e) => {
          events.push(e);
        },
        flushBudgetCommitments: () => governor.flushCommitments(),
      },
    });
    session.start();
    const error = await caught(() => session.sendMessage('first'));
    expect(error).toMatchObject({ name: 'CommitmentDurabilityError', cause });
    expect(events.at(-1)).toMatchObject({
      error: { code: 'internal', retryable: false },
      tokensUsed: { input: 3, output: 4 },
    });
    expect(JSON.stringify(events)).not.toContain('R10_PRIVATE');
    await session.sendMessage('cap');
    expect(calls).toBe(1);
    expect(events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
  });
});
