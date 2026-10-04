import { describe, expect, it } from 'vitest';
import type { LlmProvider, StreamChunk } from '@relavium/llm';
import { LlmProviderError, makeLlmError, type LlmResult, type ModelPricing } from '@relavium/llm';
import { AgentSchema, SessionContextSchema } from '@relavium/shared';
import {
  captureAgentTurnOutcome,
  DEFAULT_AGENT_TURN_LIMITS,
  AgentTurnError,
  type AgentTurnParams,
} from './agent-turn.js';
import { BudgetPauseError, CommitmentDurabilityError } from './budget-governor.js';
import { LedgerDurabilityError, MoneyDurability } from './money-durability.js';
import { AgentSession, type SessionStreamEvent } from './agent-session.js';
import { createAbortController, createInMemoryEffectJournalStore } from './execution-host.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import { WorkflowEngine } from './engine.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { createDispatchingNodeExecutor } from './node-handlers/dispatcher.js';
import { parseWorkflow } from '../parser.js';
import type { RunEvent } from '@relavium/shared';
import { createToolRegistry } from '../tools/registry.js';
import type { ToolDef } from '../tools/types.js';

const tool: ToolDef = {
  id: 'probe',
  source: 'builtin',
  description: 'offline',
  parseArgs: (v) => v,
  llmVisibleParams: { type: 'object' },
  policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
  effect: () => 3,
  dispatch: () => Promise.resolve('safe'),
};
const supports: LlmProvider['supports'] = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: false,
  promptCache: false,
  reasoning: false,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
  },
};

function turnFixture(second: boolean, site: 'ready' | 'token' | 'admission', marker: unknown) {
  let calls = 0,
    tools = 0,
    phase = '';
  const p: LlmProvider = {
    id: 'anthropic',
    supports,
    generate: () => {
      throw new Error('unused');
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      calls++;
      await Promise.resolve();
      if (second && calls === 1) {
        yield { type: 'tool_call_start', id: 'call', name: 'probe' };
        yield { type: 'tool_call_end', id: 'call' };
        yield { type: 'stop', stopReason: 'tool_use', usage: { inputTokens: 2, outputTokens: 3 } };
        return;
      }
      phase = 'text';
      yield { type: 'text_delta', text: 'safe' };
      phase = 'stop';
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 5, outputTokens: 7 } };
    },
  };
  const actualTool: ToolDef = {
    ...tool,
    dispatch: () => {
      tools++;
      return Promise.resolve('safe');
    },
  };
  const registry = createToolRegistry({ tools: [actualTool], host: {} });
  const params: AgentTurnParams = {
    messages: [],
    nodeId: 'node',
    planEntries: [{ provider: p, model: 'claude-opus-4-8', maxAttempts: 1 }],
    chainCapabilities: { keyFor: () => 'offline', sleep: () => Promise.resolve() },
    signal: createAbortController().signal,
    registry,
    dispatchContext: {
      nodeId: 'node',
      grantedToolIds: new Set(['probe']),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effects: createInMemoryEffectJournalStore().for({
        kind: 'session',
        sessionId: 'round9-turn',
        turn: 1,
      }),
      effectSlot: 0,
    },
    limits: DEFAULT_AGENT_TURN_LIMITS,
    emit: (e) => {
      if (site === 'token' && e.type === 'agent:token') throw marker;
    },
    whenReady: () => {
      if (site === 'ready' && phase === 'stop') throw marker;
      return Promise.resolve();
    },
    ...(site === 'admission'
      ? {
          preEgress: () => {
            if (calls === (second ? 1 : 0)) throw marker;
          },
        }
      : {}),
  };
  return {
    params,
    provider: p,
    tool: actualTool,
    phase: () => phase,
    counts: () => ({ calls, tools }),
  };
}

describe('independent second round origin challenge', () => {
  for (const second of [false, true])
    for (const site of ['ready', 'token'] as const)
      it(`${site} second=${second} preserves BudgetPause callback identity and origin`, async () => {
        const marker = new BudgetPauseError(17, 23, 100);
        const h = turnFixture(second, site, marker);
        const out = await captureAgentTurnOutcome(h.params);
        expect.soft(out.kind).toBe('failed');
        if (out.kind !== 'failed') throw new Error('expected failure');
        expect.soft(out.error === marker, 'original callback identity').toBe(true);
        expect.soft(out.failureOrigin).toBe('observer');
        expect
          .soft(out.usage)
          .toEqual(
            site === 'ready'
              ? { input: second ? 7 : 5, output: second ? 10 : 7 }
              : { input: second ? 2 : 0, output: second ? 3 : 0 },
          );
        expect(h.counts()).toEqual({ calls: second ? 2 : 1, tools: second ? 1 : 0 });
      });
  it('causal negative: genuine admission still becomes budget failure after tools', async () => {
    const marker = new BudgetPauseError(17, 23, 100);
    const h = turnFixture(true, 'admission', marker);
    const out = await captureAgentTurnOutcome(h.params);
    expect(out).toMatchObject({
      kind: 'failed',
      failureOrigin: 'turn',
      usage: { input: 2, output: 3 },
    });
    if (out.kind !== 'failed') throw new Error('expected failure');
    expect(out.error).toBeInstanceOf(AgentTurnError);
    expect(out.error).toMatchObject({ code: 'budget_exceeded', retryable: false });
    expect(h.counts()).toEqual({ calls: 1, tools: 1 });
  });
});

describe('actual callers retain later-round observer boundary', () => {
  for (const site of ['ready', 'token'] as const)
    it(`Session later ${site} callback cannot manufacture a budget diagnostic`, async () => {
      const marker = new BudgetPauseError(17, 23, 100);
      Object.defineProperty(marker, 'limitMicrocents', { get: () => 'private-budget-property' });
      const h = turnFixture(true, site, marker);
      const events: SessionStreamEvent[] = [];
      let key = 0;
      const journal = createInMemoryEffectJournalStore();
      const session = new AgentSession({
        sessionId: 'later-origin',
        agentRef: 'agent',
        agent: AgentSchema.parse({
          id: 'agent',
          provider: 'anthropic',
          model: 'claude-opus-4-8',
          system_prompt: 'offline',
          tools: ['probe'],
        }),
        context: SessionContextSchema.parse({
          workingDir: '/workspace/offline',
          fsScopeTier: 'sandboxed',
        }),
        deps: {
          resolveProvider: () => h.provider,
          tools: [h.tool],
          registry: h.params.registry,
          keyFor: () => 'offline',
          sleep: () => Promise.resolve(),
          now: () => 0,
          newAbortController: createAbortController,
          reserveEffectTurnKey: () => ++key,
          effects: (c) => journal.for(c),
          autoCompact: false,
          maxTurns: 1,
          whenReady: () => {
            if (site === 'ready' && h.phase() === 'stop') throw marker;
            return Promise.resolve();
          },
          emit: (e) => {
            events.push(e);
            if (site === 'token' && e.type === 'agent:token') throw marker;
          },
        },
      });
      session.start();
      await session.sendMessage('go');
      expect.soft(h.counts()).toEqual({ calls: 2, tools: 1 });
      expect.soft(events.find((e) => e.type === 'session:turn_completed')).toMatchObject({
        stopReason: 'error',
        error: { code: 'internal', retryable: false },
        tokensUsed: site === 'ready' ? { input: 7, output: 10 } : { input: 2, output: 3 },
      });
      expect.soft(JSON.stringify(events)).not.toContain('private-budget-property');
      await session.sendMessage('must be capped');
      expect(h.counts().calls).toBe(2);
      expect(events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
    });
  for (const active of [false, true])
    it(`Workflow later token observer source remains private active=${active}`, async () => {
      const marker = new BudgetPauseError(17, 23, 100);
      Object.defineProperty(marker, 'limitMicrocents', { get: () => 'private-workflow-property' });
      const h = turnFixture(true, 'token', marker);
      const store = new InMemoryRunStore();
      const host = createInMemoryHost({ store });
      const runner = createAgentNodeExecutor({
        resolveProvider: () => h.provider,
        keyFor: () => 'offline',
        sleep: () => Promise.resolve(),
        registry: h.params.registry,
        tools: [h.tool],
      });
      const runJournal = createInMemoryEffectJournalStore();
      const engine = new WorkflowEngine({
        host,
        effectJournal: (c) => runJournal.for(c),
        executor: createDispatchingNodeExecutor({
          agent: {
            execute: (ctx) =>
              runner.execute({
                ...ctx,
                emit: (e) => {
                  if (active && e.type === 'agent:token') throw marker;
                  ctx.emit(e);
                },
              }),
          },
        }),
      });
      const workflow = parseWorkflow(`schema_version: '1.0'
workflow:
  id: round-nine-observer
  agents:
    - { id: a, model: claude-opus-4-8, provider: anthropic, system_prompt: hi, tools: [probe] }
  nodes:
    - { id: n, type: agent, agent_ref: a, prompt_template: go, max_tokens: 10 }
  edges: []
`);
      const handle = engine.start({ workflow, inputs: {} });
      const events: RunEvent[] = [];
      for await (const e of handle.events) {
        events.push(e);
        if (e.type === 'run:paused') engine.cancel(handle.runId);
      }
      expect.soft(h.counts()).toEqual({ calls: 2, tools: 1 });
      expect
        .soft(events.at(-1))
        .toMatchObject(
          active
            ? { type: 'run:failed', error: { code: 'internal', retryable: false } }
            : { type: 'run:completed' },
        );
      expect.soft(JSON.stringify(events)).not.toContain('private-workflow-property');
      expect(events.some((e) => e.type === 'human_gate:paused' || e.type === 'node:retrying')).toBe(
        false,
      );
      expect(
        store.eventsFor(handle.runId).filter((e) => e.type === 'cost:attempt_settled'),
      ).toHaveLength(active ? 1 : 2);
    });
});

function compactFixture(
  marker: unknown,
  active: boolean,
  origin: 'observer' | 'admission' = 'observer',
  site: 'cost' | 'start' | 'finish' | 'ready' = 'cost',
) {
  let calls = 0,
    key = 0,
    fail = false;
  let phase = '';
  const events: SessionStreamEvent[] = [];
  const provider: LlmProvider = {
    id: 'anthropic',
    supports,
    generate: () => {
      throw new Error('unused');
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      calls++;
      await Promise.resolve();
      phase = 'text';
      yield { type: 'text_delta', text: 'summary safe' };
      phase = 'stop';
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 5, outputTokens: 7 } };
    },
  };
  const journal = createInMemoryEffectJournalStore();
  const session = new AgentSession({
    sessionId: 'round9-compact',
    agentRef: 'agent',
    agent: AgentSchema.parse({
      id: 'agent',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      system_prompt: 'offline',
    }),
    context: SessionContextSchema.parse({
      workingDir: '/workspace/offline',
      fsScopeTier: 'sandboxed',
    }),
    deps: {
      resolveProvider: () => provider,
      tools: [],
      registry: createToolRegistry({ tools: [], host: {} }),
      keyFor: () => 'offline',
      sleep: () => Promise.resolve(),
      now: () => 0,
      newAbortController: createAbortController,
      reserveEffectTurnKey: () => ++key,
      effects: (c) => journal.for(c),
      autoCompact: false,
      whenReady: () => {
        if (fail && site === 'ready' && phase === 'stop') throw marker;
        return Promise.resolve();
      },
      preEgress: () => {
        if (fail && origin === 'admission') throw marker;
      },
      emit: (e) => {
        events.push(e);
        if (
          fail &&
          origin === 'observer' &&
          ((site === 'cost' && e.type === 'cost:updated') ||
            (site === 'start' && e.type === 'session:compacting') ||
            (site === 'finish' && e.type === 'session:compacted'))
        )
          throw marker;
      },
    },
  });
  session.start();
  return {
    session,
    events,
    prepare: async () => {
      await session.sendMessage('first');
      await session.sendMessage('second');
      fail = active;
    },
    calls: () => calls,
    disarm: () => {
      fail = false;
    },
  };
}
describe('independent compaction caller challenge', () => {
  for (const site of ['start', 'finish', 'ready'] as const)
    for (const kind of ['turn', 'budget', 'opaque'] as const)
      it(`${site}/${kind}: compaction lifecycle observers retain private presentation and cleanup`, async () => {
        const reflection = new Error('private compaction reflection');
        const marker =
          kind === 'turn'
            ? new AgentTurnError('provider_unavailable', 'private compaction lifecycle', true)
            : kind === 'budget'
              ? new BudgetPauseError(1, 2, 3)
              : new Proxy(new Error('private compaction lifecycle'), {
                  getPrototypeOf() {
                    throw reflection;
                  },
                });
        const h = compactFixture(marker, true, 'observer', site);
        await h.prepare();
        if (kind === 'opaque') {
          const escaped = await h.session.compact().then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(escaped === marker).toBe(true);
        } else {
          expect(await h.session.compact()).toEqual({
            kind: 'failed',
            message: 'the compaction failed with an unexpected observer error',
          });
        }
        expect(h.calls()).toBe(site === 'start' ? 2 : 3);
        expect(JSON.stringify(h.events)).not.toContain('private');
        h.disarm();
        await h.session.sendMessage('still usable');
        expect(h.calls()).toBe(site === 'start' ? 3 : 4);
      });
  it('genuine compaction admission still returns a failed result without another provider call', async () => {
    const marker = new BudgetPauseError(17, 23, 100);
    const h = compactFixture(marker, true, 'admission');
    await h.prepare();
    expect(await h.session.compact()).toMatchObject({ kind: 'failed', message: marker.message });
    expect(h.calls()).toBe(2);
  });
  it('ordinary unclassified compaction observer still rejects the exact error', async () => {
    const marker = new Error('ordinary observer');
    const h = compactFixture(marker, true);
    await h.prepare();
    let escaped: unknown;
    try {
      await h.session.compact();
    } catch (e) {
      escaped = e;
    }
    expect(escaped === marker).toBe(true);
    expect(h.calls()).toBe(3);
  });
  for (const active of [false, true])
    it(`typed cost observer privacy active=${active}`, async () => {
      const marker = new AgentTurnError(
        'provider_unavailable',
        'private-compaction-observer-payload',
        true,
      );
      const h = compactFixture(marker, active);
      await h.prepare();
      const result = await h.session.compact();
      expect.soft(h.calls()).toBe(3);
      if (active) {
        expect.soft(result).toMatchObject({ kind: 'failed' });
        expect
          .soft(JSON.stringify(result), 'public compaction outcome')
          .not.toContain('private-compaction-observer-payload');
      } else expect(result).toMatchObject({ kind: 'compacted' });
    });
  it('opaque callback exception remains the exact original through compaction caller', async () => {
    const replacement = new Error('reflection replaced raw callback');
    const marker = new Proxy(new Error('original callback'), {
      getPrototypeOf() {
        throw replacement;
      },
    });
    const h = compactFixture(marker, true);
    await h.prepare();
    let escaped: unknown;
    try {
      await h.session.compact();
    } catch (e) {
      escaped = e;
    }
    expect(escaped === marker, 'exact opaque exception identity').toBe(true);
    expect(h.calls()).toBe(3);
  });
});

describe('post-return private result accessor provenance', () => {
  for (const field of ['raw', 'content', 'stopReason'] as const)
    for (const usagePresent of [false, true])
      for (const active of [false, true])
        it(`actual Workflow paid generate ${field} getter usage=${usagePresent} active=${active}`, async () => {
          let calls = 0,
            reads = 0;
          const model = 'round9-result-accessor';
          const marker = new LlmProviderError(
            makeLlmError({
              provider: 'openai',
              kind: 'timeout',
              message: 'private-result-accessor',
            }),
          );
          const pricing: ModelPricing = {
            provider: 'openai',
            nativeId: model,
            displayName: model,
            contextWindowTokens: 10000,
            maxOutputTokens: 1000,
            inputPerMtokMicrocents: 1000000,
            outputPerMtokMicrocents: 1000000,
            cachedInputPerMtokMicrocents: 1000000,
          };
          const prices = new Map([[model, pricing]]);
          const p: LlmProvider = {
            id: 'openai',
            customEndpoint: true,
            supports: {
              ...supports,
              media: {
                input: { image: false, audio: false, video: false, document: false },
                outputCombinations: [['image']],
                surface: 'chat',
              },
            },
            stream: () => {
              throw new Error('unused');
            },
            generate: () => {
              calls++;
              const result: LlmResult = {
                content: [
                  {
                    type: 'media',
                    mimeType: 'image/png',
                    source: { kind: 'handle', ref: `media://sha256-${'a'.repeat(64)}` },
                  },
                ],
                stopReason: 'stop',
                usage: { inputTokens: 5, outputTokens: 7 },
              };
              if (!usagePresent) Object.defineProperty(result, 'usage', { value: undefined });
              const prior = result[field];
              Object.defineProperty(result, field, {
                get: () => {
                  reads++;
                  if (active) throw marker;
                  return prior;
                },
              });
              return Promise.resolve(result);
            },
          };
          const store = new InMemoryRunStore();
          const host = createInMemoryHost({ store });
          const wrappedHost = {
            ...host,
            setTimer: (...args: Parameters<typeof host.setTimer>) => {
              const disarm = host.setTimer(...args);
              if (args[2] === undefined || args[2] === 'work')
                queueMicrotask(() => host.fireTimers());
              return disarm;
            },
          };
          const runner = createAgentNodeExecutor({
            resolveProvider: () => p,
            keyFor: () => 'offline',
            sleep: () => Promise.resolve(),
            registry: createToolRegistry({ tools: [], host: {} }),
            tools: [],
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
  id: round-nine-result
  agents:
    - { id: a, model: round9-result-accessor, provider: openai, system_prompt: hi }
  nodes:
    - { id: n, type: agent, agent_ref: a, prompt_template: go, max_tokens: 10, output_modalities: [image], retry: { max: 2, backoff: linear, retry_on: [provider_unavailable] } }
  edges: []
`);
          const handle = engine.start({ workflow, inputs: {} });
          const events: RunEvent[] = [];
          for await (const e of handle.events) events.push(e);
          expect.soft(calls, 'no duplicate paid generation').toBe(1);
          expect
            .soft(store.eventsFor(handle.runId).filter((e) => e.type === 'cost:attempt_settled'))
            .toHaveLength(usagePresent ? 1 : 0);
          expect.soft(events.some((e) => e.type === 'node:retrying')).toBe(false);
          expect.soft(JSON.stringify(events)).not.toContain('private-result-accessor');
          expect.soft(reads).toBe(calls);
          const settled = store
            .eventsFor(handle.runId)
            .filter((e) => e.type === 'cost:attempt_settled');
          if (usagePresent)
            expect
              .soft(
                settled.reduce((sum, e) => sum + e.costMicrocents, 0),
                'one known paid usage amount',
              )
              .toBe(12);
        });
});

describe('money durability authority belongs to the failing writer', () => {
  for (const family of ['ordinary', 'ledger', 'commitment'] as const)
    it(`external cost observer ${family} class cannot nominate another writer`, async () => {
      const marker =
        family === 'ordinary'
          ? new Error('ordinary observer')
          : family === 'ledger'
            ? new LedgerDurabilityError(new Error('external notification'), 'private-false-writer')
            : new CommitmentDurabilityError(
                new Error('external notification'),
                'private-false-writer',
              );
      const h = turnFixture(false, 'token', marker);
      const store = new InMemoryRunStore();
      const host = createInMemoryHost({ store });
      const runner = createAgentNodeExecutor({
        resolveProvider: () => h.provider,
        keyFor: () => 'offline',
        sleep: () => Promise.resolve(),
        registry: createToolRegistry({ tools: [], host: {} }),
        tools: [],
      });
      const engine = new WorkflowEngine({
        host,
        executor: createDispatchingNodeExecutor({
          agent: {
            execute: (ctx) =>
              runner.execute({
                ...ctx,
                emit: (e) => {
                  ctx.emit(e);
                  if (e.type === 'cost:updated') throw marker;
                },
              }),
          },
        }),
      });
      const workflow = parseWorkflow(`schema_version: '1.0'
workflow:
  id: round-nine-false-money-owner
  agents:
    - { id: a, model: claude-opus-4-8, provider: anthropic, system_prompt: hi }
  nodes:
    - { id: n, type: agent, agent_ref: a, prompt_template: go, max_tokens: 10 }
  edges: []
`);
      const handle = engine.start({ workflow, inputs: {} });
      const events: RunEvent[] = [];
      for await (const e of handle.events) events.push(e);
      expect.soft(events.at(-1)).toMatchObject({
        type: 'run:failed',
        error: { code: 'internal', nodeId: 'n', retryable: false },
      });
      expect.soft(JSON.stringify(events)).not.toContain('private-false-writer');
      expect(h.counts().calls).toBe(1);
      expect(
        store.eventsFor(handle.runId).filter((e) => e.type === 'cost:attempt_settled'),
      ).toHaveLength(1);
    });
  it('genuine shared ledger failure preserves actual writer at B1 and performs no new provider call', async () => {
    const cause = new Error('actual writer rejection');
    const money = new MoneyDurability({ emit: () => Promise.reject(cause) });
    money.record(
      {
        nodeId: 'real-earlier-writer',
        model: 'offline',
        attemptNumber: 1,
        inputTokens: 2,
        outputTokens: 3,
        costMicrocents: 5,
        priced: true,
      },
      5,
    );
    const h = turnFixture(false, 'token', new Error('unused'));
    const out = await captureAgentTurnOutcome({
      ...h.params,
      money: money.turnPort(() => 5),
      emit: () => {},
    });
    expect(out).toMatchObject({
      kind: 'failed',
      failureOrigin: 'turn',
      engaged: false,
      usage: { input: 0, output: 0 },
    });
    if (out.kind !== 'failed') throw new Error('expected failure');
    expect(out.error).toBeInstanceOf(LedgerDurabilityError);
    expect(out.error).toMatchObject({ nodeId: 'real-earlier-writer', cause });
    expect(h.counts().calls).toBe(0);
  });
});
