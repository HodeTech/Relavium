import { describe, expect, it } from 'vitest';
import {
  AgentSchema,
  SessionContextSchema,
  type ContentPart,
  type RunEvent,
  type RunOrSessionEvent,
} from '@relavium/shared';
import {
  FallbackChain,
  CostTracker,
  makeLlmError,
  type AttemptRecord,
  type LlmProvider,
  type LlmResult,
  type ModelPricing,
  type StreamChunk,
} from '@relavium/llm';
import { WorkflowEngine } from './engine.js';
import { AgentSession } from './agent-session.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { createDispatchingNodeExecutor } from './node-handlers/dispatcher.js';
import {
  createInMemoryHost,
  InMemoryRunStore,
  createAbortController,
  createInMemoryEffectJournalStore,
} from './execution-host.js';
import { createToolRegistry } from '../tools/registry.js';
import type { ToolDef } from '../tools/types.js';
import { parseWorkflow } from '../parser.js';
import { RunEventBus } from './event-bus.js';
import { createSessionEventSink, createSessionHandle } from './session-handle.js';
import { MoneyDurability, type SettledAttemptDraft } from './money-durability.js';
import { captureAgentTurnOutcome, DEFAULT_AGENT_TURN_LIMITS } from './agent-turn.js';

const model = 'r12-novel-local';
const rate: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 18000,
  maxOutputTokens: 100,
  inputPerMtokMicrocents: 3000000,
  outputPerMtokMicrocents: 5000000,
  cachedInputPerMtokMicrocents: 7000000,
  cacheWritePerMtokMicrocents: 11000000,
  mediaOutputRates: { image: 19 },
};
const amounts = () => ({
  inputTokens: 7,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 1,
  mediaUnits: [
    { modality: 'image' as const, direction: 'output' as const, unit: 'count' as const, units: 2 },
  ],
});
const image = (): ContentPart => ({
  type: 'media',
  mimeType: 'image/png',
  source: { kind: 'handle', ref: 'media://sha256-' + 'd'.repeat(64) },
});
function provider(result: () => LlmResult): LlmProvider {
  return {
    id: 'openai',
    customEndpoint: true,
    supports: {
      streaming: true,
      tools: true,
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
    generate: () => Promise.resolve(result()),
    stream: async function* () {
      await Promise.resolve();
      yield { type: 'text_delta', text: 'safe answer' };
      yield { type: 'stop', stopReason: 'stop', usage: amounts() };
    },
  };
}
function deferred() {
  let release: () => void = () => {
    throw new Error('unarmed deferred');
  };
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
async function workflow(
  p: LlmProvider,
  prices: ReadonlyMap<string, ModelPricing>,
  extras: {
    cleanup?: () => void;
    tools?: readonly ToolDef[];
    store?: InMemoryRunStore;
    stream?: boolean;
  } = {},
) {
  const store = extras.store ?? new InMemoryRunStore();
  const host = createInMemoryHost({ store });
  const tools = extras.tools ?? [];
  const journal = createInMemoryEffectJournalStore();
  const executor = createAgentNodeExecutor({
    resolveProvider: () => p,
    keyFor: () => 'r12-synthetic',
    sleep: () => Promise.resolve(),
    registry: createToolRegistry({ tools, host: {} }),
    tools,
    resolvePrice: prices,
    resolveMediaSurface: () => 'chat',
    ...(extras.cleanup === undefined
      ? {}
      : {
          newAbortController: createAbortController,
          setTimer: () => extras.cleanup ?? (() => {}),
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
    executor: createDispatchingNodeExecutor({ agent: executor }),
    resolvePrice: prices,
    effectJournal: (c) => journal.for(c),
  });
  const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: r12-new
  agents:
    - {id: a, provider: openai, model: r12-novel-local, system_prompt: offline, tools: [write_file]}
  nodes:
    - {id: n, type: agent, agent_ref: a, prompt_template: local, max_tokens: 8, ${extras.stream ? '' : 'output_modalities: [image],'} retry: {max: 2, retry_on: [provider_unavailable], backoff: linear}}
  edges: []
`);
  const h = engine.start({ workflow: wf, inputs: {} });
  const events: RunEvent[] = [];
  for await (const e of h.events) {
    events.push(e);
    if (e.type === 'node:retrying') host.fireTimers();
    if (e.type === 'run:paused') engine.cancel(h.runId);
  }
  return { events, durable: store.eventsFor(h.runId), journal: journal.rows() };
}
describe('R12 novel actual generated result counterfactuals', () => {
  for (const kind of ['paid', 'zero', 'missing-media', 'unknown'] as const)
    it('complete generated workflow price ' + kind, async () => {
      let calls = 0;
      const p = provider(() => {
        calls++;
        return {
          content: [image(), { type: 'text', text: 'answer' }],
          stopReason: 'stop',
          usage: amounts(),
        };
      });
      const price =
        kind === 'zero'
          ? {
              ...rate,
              inputPerMtokMicrocents: 0,
              outputPerMtokMicrocents: 0,
              cachedInputPerMtokMicrocents: 0,
              cacheWritePerMtokMicrocents: 0,
              mediaOutputRates: { image: 0 },
            }
          : kind === 'missing-media'
            ? { ...rate, mediaOutputRates: {} }
            : rate;
      const out = await workflow(p, new Map(kind === 'unknown' ? [] : [[model, price]]));
      expect(calls).toBe(1);
      expect(out.events.at(-1)?.type).toBe('run:completed');
      expect(out.durable.filter((e) => e.type === 'cost:attempt_settled')).toMatchObject([
        {
          inputTokens: 7,
          outputTokens: 2,
          costMicrocents:
            kind === 'zero' || kind === 'unknown' ? 0 : kind === 'missing-media' ? 63 : 101,
          priced: kind !== 'unknown' && kind !== 'missing-media',
        },
      ]);
    });
  for (const mutation of [false, true])
    it(
      'pricing callback cannot rewrite completed generated text, mutation=' + mutation,
      async () => {
        let calls = 0;
        const part: ContentPart = { type: 'text', text: 'provider-owned text' };
        class Overlay extends Map<string, ModelPricing> {
          override get(id: string): ModelPricing | undefined {
            if (mutation && calls > 0 && part.type === 'text')
              part.text = 'pricing callback replacement';
            return super.get(id);
          }
        }
        const out = await workflow(
          provider(() => {
            calls++;
            return { content: [image(), part], stopReason: 'stop', usage: amounts() };
          }),
          new Overlay([[model, rate]]),
        );
        expect(calls).toBe(1);
        expect(out.events.at(-1)?.type).toBe('run:completed');
        const completed = out.events.find((e) => e.type === 'node:completed');
        expect(JSON.stringify(completed)).toContain('provider-owned text');
        expect(JSON.stringify(completed)).not.toContain('pricing callback replacement');
      },
    );
  for (const mutation of [false, true])
    it('generated tool args are owned before timer cleanup mutation=' + mutation, async () => {
      let calls = 0;
      const args = { path: 'provider-path' };
      const dispatched: string[] = [];
      const tool: ToolDef = {
        id: 'write_file',
        source: 'builtin',
        description: 'offline path capture',
        llmVisibleParams: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        parseArgs: (v) => {
          if (typeof v !== 'object' || v === null || !('path' in v) || typeof v.path !== 'string')
            throw new Error('invalid synthetic args');
          return { path: v.path };
        },
        policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
        effect: () => 1,
        dispatch: (_ctx, v) => {
          if (typeof v !== 'object' || v === null || !('path' in v) || typeof v.path !== 'string')
            throw new Error('unexpected parsed args');
          dispatched.push(v.path);
          return Promise.resolve({ saved: true });
        },
      };
      const out = await workflow(
        provider(() => {
          calls++;
          return calls === 1
            ? {
                content: [{ type: 'tool_call', id: 'r12-c', name: 'write_file', args }],
                stopReason: 'tool_use',
                usage: amounts(),
              }
            : {
                content: [image(), { type: 'text', text: 'done' }],
                stopReason: 'stop',
                usage: amounts(),
              };
        }),
        new Map([[model, rate]]),
        {
          tools: [tool],
          cleanup: () => {
            if (mutation) args.path = 'cleanup-rewritten-path';
          },
        },
      );
      // ADR-0046 correctly refuses tools on the generated media route; this is a negative control,
      // not evidence that a generated tool argument can acquire execution authority.
      expect(calls).toBe(1);
      expect(out.events.at(-1)?.type).toBe('run:failed');
      expect(out.journal).toEqual([]);
      expect(dispatched).toEqual([]);
    });
});
describe('R12 new post-provider callback monetary and control contrast', () => {
  for (const barrier of ['B2', 'B3'] as const)
    for (const failure of [false, true])
      it('actual store ' + barrier + ' acknowledgement/failure ' + failure, async () => {
        let calls = 0,
          effects = 0,
          writes = 0;
        class Store extends InMemoryRunStore {
          override async persistEvent(
            ...args: Parameters<InMemoryRunStore['persistEvent']>
          ): Promise<void> {
            if (args[0].type === 'cost:attempt_settled') {
              writes++;
              if (failure) throw new Error('R12 PRIVATE actual durable writer');
            }
            await super.persistEvent(...args);
          }
        }
        const tool: ToolDef = {
          id: 'write_file',
          source: 'builtin',
          description: 'local causal effect',
          llmVisibleParams: { type: 'object' },
          parseArgs: (v) => v,
          policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
          effect: () => 1,
          dispatch: () => {
            effects++;
            return Promise.resolve({ result: 'local only' });
          },
        };
        const p = provider(() => {
          throw new Error('stream route required');
        });
        p.stream = async function* () {
          await Promise.resolve();
          calls++;
          if (barrier === 'B2' && calls === 1) {
            yield { type: 'tool_call_start', id: 'r12-effect', name: 'write_file' };
            yield { type: 'tool_call_delta', id: 'r12-effect', argsJsonDelta: '{}' };
            yield { type: 'tool_call_end', id: 'r12-effect' };
            yield { type: 'stop', stopReason: 'tool_use', usage: amounts() };
          } else {
            yield { type: 'text_delta', text: 'actual stream answer' };
            yield { type: 'stop', stopReason: 'stop', usage: amounts() };
          }
        };
        const out = await workflow(p, new Map([[model, rate]]), {
          tools: [tool],
          stream: true,
          store: new Store(),
        });
        expect(calls).toBe(!failure && barrier === 'B2' ? 2 : 1);
        expect(effects).toBe(!failure && barrier === 'B2' ? 1 : 0);
        expect(writes).toBe(calls);
        expect(out.events.some((e) => e.type === 'node:retrying' || e.type === 'run:paused')).toBe(
          false,
        );
        expect(out.events.at(-1)?.type).toBe(failure ? 'run:failed' : 'run:completed');
        expect(JSON.stringify(out.events)).not.toContain('PRIVATE');
        if (failure)
          expect(out.events.at(-1)).toMatchObject({
            error: { nodeId: 'n', code: 'internal', retryable: false },
            cumulativeCostMicrocents: 101,
          });
      });
  for (const phase of ['held-terminal', 'cleanup', 'observer'] as const)
    it('full cache/media usage remains exactly once at ' + phase, async () => {
      const used = amounts();
      const records: AttemptRecord[] = [];
      let calls = 0;
      const mutate = () => {
        used.inputTokens = 0;
        used.outputTokens = 0;
        used.cacheReadTokens = 0;
        used.cacheWriteTokens = 0;
        used.mediaUnits[0]!.units = 0;
      };
      const p = provider(() => ({ content: [], stopReason: 'stop', usage: used }));
      p.stream = async function* () {
        await Promise.resolve();
        calls++;
        yield { type: 'text_delta', text: 'priced' };
        yield { type: 'stop', stopReason: 'stop', usage: used };
        if (phase === 'held-terminal') mutate();
      };
      const chain = new FallbackChain([{ provider: p, model, maxAttempts: 2 }], {
        keyFor: () => 'synthetic',
        sleep: () => Promise.resolve(),
        costTracker: new CostTracker(new Map([[model, rate]])),
        newAbortController: createAbortController,
        setTimer: () => () => {
          if (phase === 'cleanup') mutate();
        },
        onAttempt: (r) => {
          records.push(r);
          if (phase === 'observer') mutate();
        },
      });
      const chunks: StreamChunk[] = [];
      for await (const c of chain.stream({ model, messages: [] })) chunks.push(c);
      expect(calls).toBe(1);
      expect(records).toMatchObject([
        {
          usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 },
          cost: { costMicrocents: 101 },
          outcome: 'succeeded',
        },
      ]);
      expect(chunks.at(-1)).toMatchObject({
        type: 'stop',
        usage: { inputTokens: 7, outputTokens: 2 },
      });
    });
  it('genuine uncommitted transport retries while committed provider transport never retries', async () => {
    for (const committed of [false, true]) {
      let calls = 0;
      const p = provider(() => ({ content: [], stopReason: 'stop', usage: amounts() }));
      p.stream = async function* () {
        await Promise.resolve();
        calls++;
        if (committed) yield { type: 'text_delta', text: 'charged output' };
        if (calls === 1)
          yield {
            type: 'error',
            error: makeLlmError({
              provider: 'openai',
              kind: 'transport',
              message: 'fixed canonical transport',
            }),
          };
        else yield { type: 'stop', stopReason: 'stop', usage: amounts() };
      };
      const chain = new FallbackChain([{ provider: p, model, maxAttempts: 2 }], {
        keyFor: () => 'synthetic',
        sleep: () => Promise.resolve(),
      });
      const chunks: StreamChunk[] = [];
      for await (const c of chain.stream({ model, messages: [] })) chunks.push(c);
      expect(calls).toBe(committed ? 1 : 2);
      expect(chunks.at(-1)?.type).toBe(committed ? 'error' : 'stop');
    }
  });
  it('B1 genuinely blocks two independently waiting candidate turns behind current shared ledger', async () => {
    const write = deferred(),
      entered = deferred();
    const drafts: SettledAttemptDraft[] = [];
    let calls = 0;
    const money = new MoneyDurability({
      emit: (r) => {
        drafts.push(r);
        entered.release();
        return write.promise;
      },
    });
    money.record(
      {
        nodeId: 'actual-prior',
        model,
        attemptNumber: 1,
        inputTokens: 7,
        outputTokens: 2,
        costMicrocents: 101,
        priced: true,
      },
      101,
    );
    const p = provider(() => ({ content: [], stopReason: 'stop', usage: amounts() }));
    p.stream = async function* () {
      await Promise.resolve();
      calls++;
      yield { type: 'stop', stopReason: 'stop', usage: amounts() };
    };
    const make = (nodeId: string) =>
      captureAgentTurnOutcome({
        nodeId,
        messages: [],
        planEntries: [{ provider: p, model, maxAttempts: 1 }],
        chainCapabilities: { keyFor: () => 'synthetic', sleep: () => Promise.resolve() },
        emit: () => {},
        signal: createAbortController().signal,
        registry: createToolRegistry({ tools: [], host: {} }),
        dispatchContext: {
          nodeId,
          grantedToolIds: new Set(),
          config: {},
          toolPolicy: {},
          fsScope: 'sandboxed',
          gateApproved: false,
          effects: createInMemoryEffectJournalStore().for({
            kind: 'session',
            sessionId: nodeId,
            turn: 1,
          }),
          effectSlot: 0,
        },
        limits: DEFAULT_AGENT_TURN_LIMITS,
        money: money.turnPort(() => 101),
        resolvePrice: new Map([[model, rate]]),
      });
    const a = make('candidate-a'),
      b = make('candidate-b');
    await entered.promise;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(calls).toBe(0);
    write.release();
    const out = await Promise.all([a, b]);
    expect(out.every((x) => x.kind === 'succeeded')).toBe(true);
    expect(calls).toBe(2);
    await money.join();
    expect(drafts.map((x) => x.nodeId)).toEqual(['actual-prior', 'candidate-a', 'candidate-b']);
  });
});
describe('R12 real session primary/passive bus and cancellation', () => {
  for (const cancel of [false, true])
    it('held completion flush cancel=' + cancel, async () => {
      const entered = deferred(),
        flush = deferred();
      let calls = 0;
      const bus = new RunEventBus({ now: () => '2026-10-06T00:00:00.000Z' });
      const passive: RunOrSessionEvent[] = [];
      bus.subscribe((e) => passive.push(e));
      const journal = createInMemoryEffectJournalStore();
      const p = provider(() => ({ content: [], stopReason: 'stop', usage: amounts() }));
      p.stream = async function* () {
        await Promise.resolve();
        calls++;
        yield { type: 'text_delta', text: 'final answer' };
        yield { type: 'stop', stopReason: 'stop', usage: amounts() };
      };
      let turn = 0;
      const session = new AgentSession({
        sessionId: 'r12-session',
        agentRef: 'a',
        agent: AgentSchema.parse({
          id: 'a',
          provider: 'openai',
          model,
          max_tokens: 8,
          system_prompt: 'offline',
        }),
        context: SessionContextSchema.parse({ workingDir: '/offline', fsScopeTier: 'sandboxed' }),
        deps: {
          resolveProvider: () => p,
          keyFor: () => 'synthetic',
          sleep: () => Promise.resolve(),
          newAbortController: createAbortController,
          registry: createToolRegistry({ tools: [], host: {} }),
          tools: [],
          reserveEffectTurnKey: () => ++turn,
          effects: (c) => journal.for(c),
          autoCompact: false,
          resolvePrice: new Map([[model, rate]]),
          emit: createSessionEventSink(bus, 'r12-session'),
          flushBudgetCommitments: () => {
            entered.release();
            return flush.promise;
          },
        },
      });
      const handle = createSessionHandle(bus, 'r12-session', () => session.cancel());
      const primary: RunOrSessionEvent[] = [];
      const consumer = (async () => {
        for await (const e of handle.events) primary.push(e);
      })();
      session.start();
      const pending = session.sendMessage('fresh independent');
      await entered.promise;
      if (cancel) session.cancel();
      flush.release();
      await pending;
      if (!cancel) session.cancel();
      await consumer;
      expect(calls).toBe(1);
      expect(primary).toEqual(passive);
      expect(primary.filter((e) => e.type === 'session:turn_completed')).toHaveLength(
        cancel ? 0 : 1,
      );
      expect(primary.filter((e) => e.type === 'session:cancelled')).toHaveLength(1);
      await expect(session.sendMessage('after terminal')).rejects.toMatchObject({
        code: 'not_active',
      });
      expect(calls).toBe(1);
    });
});
