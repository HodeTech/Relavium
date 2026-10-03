import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@relavium/shared';
import { MEDIA_JOB_POLL_DEFAULTS } from '@relavium/shared';
import type {
  LlmProvider,
  LlmRequest,
  MediaGenRequest,
  ModelPricing,
  PricingOverlay,
} from '@relavium/llm';
import { LlmProviderError, makeLlmError } from '@relavium/llm';
import { parseWorkflow } from '../parser.js';
import { BUILTIN_TOOLS } from '../tools/builtins.js';
import { markUntrusted } from '../tools/untrusted.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { DEFAULT_AGENT_TURN_LIMITS } from './agent-turn.js';
import { createDispatchingNodeExecutor } from './node-handlers/dispatcher.js';
import { createHumanGateNodeExecutor } from './node-handlers/human-gate.js';
import { reconstructCheckpointState } from './checkpoint.js';
import type { NodeOutcome } from './node-executor.js';
import { WorkflowEngine } from './engine.js';
import {
  createInMemoryEffectJournalStore,
  createInMemoryHost,
  createInMemoryRunLeases,
  InMemoryRunStore,
  type TimerKind,
} from './execution-host.js';

const MODEL = 'offline-budget';
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('uninitialized deferred');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function hostFromLog(events: readonly RunEvent[]) {
  const store = new InMemoryRunStore();
  for (const event of events) await store.persistEvent(event);
  return { host: createInMemoryHost({ store }), store };
}

function expectUnknownRun(engine: WorkflowEngine, runId: string): void {
  let failure: unknown;
  try {
    engine.cancel(runId);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: 'unknown_run' });
}

function startRun(
  options: {
    readonly beforePersist?: (event: RunEvent) => Promise<void>;
    readonly afterPersist?: (event: RunEvent) => Promise<void>;
    readonly cap?: number;
    readonly inputRate?: number;
    readonly toolOutput?: string;
    readonly failProvider?: boolean;
    readonly onEvent?: (event: RunEvent) => void;
    readonly onTimer?: (ms: number, kind: TimerKind) => void;
    readonly freeFollowup?: boolean;
    readonly siblingGate?: boolean;
    readonly siblingBudget?: boolean;
    readonly siblingFailure?: Promise<NodeOutcome>;
    readonly onSiblingAbort?: () => void;
    readonly omitPreparation?: boolean;
    readonly mediaJob?: boolean;
    readonly gateDeadline?: {
      readonly timeoutMs: number;
      readonly timeoutAction: 'approve' | 'reject';
    };
  } = {},
) {
  const store = new InMemoryRunStore();
  const base = createInMemoryHost({ store });
  const host = {
    ...base,
    setTimer: (ms: number, fire: () => void, kind: TimerKind = 'work') => {
      const disarm = base.setTimer(ms, fire, kind);
      options.onTimer?.(ms, kind);
      return disarm;
    },
    store: {
      resolveWorkflowId: (slug: string) => store.resolveWorkflowId(slug),
      persistEvent: async (...args: Parameters<typeof store.persistEvent>) => {
        await options.beforePersist?.(args[0]);
        await store.persistEvent(...args);
        await options.afterPersist?.(args[0]);
      },
      listInterruptedRuns: () => store.listInterruptedRuns(),
      readWorkflowSnapshot: (runId: string) => store.readWorkflowSnapshot(runId),
    },
  };
  const requests: LlmRequest[] = [];
  const mediaRequests: MediaGenRequest[] = [];
  let polls = 0;
  let toolCalls = 0;
  const tools =
    options.toolOutput === undefined ? [] : BUILTIN_TOOLS.filter((tool) => tool.id === 'read_file');
  let keyReads = 0;
  const price = {
    provider: 'openai' as const,
    nativeId: MODEL,
    displayName: MODEL,
    contextWindowTokens: 100000,
    maxOutputTokens: 1000,
    inputPerMtokMicrocents: options.inputRate ?? 1000000,
    outputPerMtokMicrocents: 1000000,
    cachedInputPerMtokMicrocents: 1000000,
    ...(options.mediaJob ? { mediaOutputRates: { image: 1000 } } : {}),
  };
  const resolvePrice: PricingOverlay = new Map([
    [MODEL, price],
    [
      `${MODEL}-free`,
      {
        ...price,
        nativeId: `${MODEL}-free`,
        inputPerMtokMicrocents: 0,
        outputPerMtokMicrocents: 0,
        cachedInputPerMtokMicrocents: 0,
      },
    ],
  ]);
  const provider: LlmProvider = {
    id: 'openai',
    customEndpoint: true,
    supports: {
      tools: tools.length > 0,
      streaming: true,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
      reasoning: false,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: options.mediaJob ? [['image']] : [],
        ...(options.mediaJob ? { surface: 'generative' as const } : {}),
      },
    },
    generate: () => {
      throw new Error('unexpected offline generate');
    },
    ...(options.mediaJob
      ? {
          generateMedia: (request: MediaGenRequest) => {
            mediaRequests.push(request);
            return Promise.resolve({ jobId: 'offline-job', raw: {} });
          },
          pollMediaJob: () => {
            polls += 1;
            return Promise.resolve({
              state: 'done' as const,
              media: {
                type: 'media' as const,
                mimeType: 'image/png',
                source: { kind: 'handle' as const, ref: `media://sha256-${'a'.repeat(64)}` },
              },
            });
          },
        }
      : {}),
    stream: async function* (request) {
      await Promise.resolve();
      requests.push(request);
      if (options.failProvider)
        throw new LlmProviderError(
          makeLlmError({ kind: 'transport', provider: 'openai', message: 'offline failure' }),
        );
      if (tools.length > 0 && requests.length === 1) {
        yield { type: 'tool_call_start', id: 'read-1', name: 'read_file' };
        yield { type: 'tool_call_delta', id: 'read-1', argsJsonDelta: '{"path":"fixture"}' };
        yield { type: 'tool_call_end', id: 'read-1' };
        yield { type: 'stop', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      yield { type: 'text_delta', text: 'ANSWER' };
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const runner = createAgentNodeExecutor({
    resolveProvider: () => provider,
    keyFor: () => {
      keyReads += 1;
      return 'offline-key';
    },
    sleep: () => Promise.resolve(),
    tools,
    limits: { ...DEFAULT_AGENT_TURN_LIMITS, maxToolTurns: 1 },
    resolvePrice,
    ...(options.mediaJob ? { resolveMediaSurface: () => 'generative' as const } : {}),
    registry: {
      has: (id) => tools.some((tool) => tool.id === id),
      list: () => tools.map((tool) => tool.id),
      dispatch: (call) => {
        if (options.toolOutput === undefined) throw new Error('unexpected tool dispatch');
        toolCalls += 1;
        return Promise.resolve({
          output: options.toolOutput,
          mediaAttachments: markUntrusted([]),
          toolResult: markUntrusted({
            type: 'tool_result' as const,
            toolCallId: call.id,
            result: options.toolOutput,
          }),
          truncated: false,
          events: {
            call: { toolId: call.name, toolInput: {} },
            result: { toolId: call.name, success: true, outputSummary: 'offline result' },
          },
        });
      },
    },
  });
  const dispatcher = createDispatchingNodeExecutor({
    agent: runner,
    human_in_the_loop:
      options.siblingFailure === undefined
        ? createHumanGateNodeExecutor({})
        : {
            execute: (ctx) => {
              ctx.signal.addEventListener('abort', () => options.onSiblingAbort?.());
              return (
                options.siblingFailure ??
                Promise.resolve({
                  kind: 'failed',
                  error: { code: 'internal', message: 'missing fixture failure', retryable: false },
                })
              );
            },
          },
  });
  const prepareBudgetDispatch = dispatcher.prepareBudgetDispatch?.bind(dispatcher);
  if (prepareBudgetDispatch === undefined)
    throw new Error('standard dispatcher dropped preparation capability');
  const executor =
    options.gateDeadline === undefined
      ? options.omitPreparation
        ? { execute: dispatcher.execute.bind(dispatcher) }
        : dispatcher
      : {
          ...(options.omitPreparation ? {} : { prepareBudgetDispatch }),
          execute: async (...args: Parameters<typeof dispatcher.execute>) => {
            const outcome = await dispatcher.execute(...args);
            return outcome.kind === 'paused' && outcome.gate.isBudgetGate
              ? { ...outcome, gate: { ...outcome.gate, ...options.gateDeadline } }
              : outcome;
          },
        };
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'offline-budget-run',
        budget: {
          max_cost_microcents: options.cap ?? 1,
          on_exceed: 'pause_for_approval',
          strict_cost_cap: true,
        },
        agents: [
          {
            id: 'a',
            provider: 'openai',
            model: MODEL,
            system_prompt: 's',
            ...(tools.length === 0 ? {} : { tools: ['read_file'] }),
          },
        ],
        nodes: [
          {
            id: 'agent',
            type: 'agent',
            agent_ref: 'a',
            prompt_template: 'hi',
            max_tokens: 64,
            ...(options.mediaJob ? { output_modalities: ['image'], count: 2 } : {}),
            ...(options.failProvider
              ? { retry: { max: 2, backoff: 'linear', backoff_ms: 1 } }
              : {}),
          },
          ...(options.freeFollowup
            ? [
                {
                  id: 'free',
                  type: 'agent',
                  agent_ref: 'a',
                  model: `${MODEL}-free`,
                  prompt_template: 'hi',
                  max_tokens: 64,
                },
              ]
            : []),
          ...(options.siblingGate
            ? [{ id: 'human', type: 'human_gate', gate_type: 'approval' }]
            : []),
          ...(options.siblingBudget
            ? [
                {
                  id: 'second',
                  type: 'agent',
                  agent_ref: 'a',
                  prompt_template: 'second',
                  max_tokens: 64,
                },
              ]
            : []),
        ],
        edges: options.freeFollowup ? [{ from: 'agent', to: 'free' }] : [],
      },
    }),
  );
  const engine = new WorkflowEngine({ host, executor, resolvePrice });
  const events: RunEvent[] = [];
  let paused: (() => void) | undefined;
  const atPause = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const handle = engine.start({ workflow });
  const drained = (async () => {
    for await (const event of handle.events) {
      events.push(event);
      options.onEvent?.(event);
      if (event.type === 'run:paused') paused?.();
    }
  })();
  return {
    host,
    store,
    engine,
    events,
    handle,
    drained,
    atPause,
    requests,
    mediaRequests,
    polls: () => polls,
    price,
    executor,
    workflow,
    keyReads: () => keyReads,
    toolCalls: () => toolCalls,
  };
}

async function parkedRun(options: Parameters<typeof startRun>[0] = {}) {
  const run = startRun(options);
  await Promise.race([run.atPause, run.drained]);
  const authority = run.events.find((event) => event.type === 'budget:authorization');
  expect(authority?.type).toBe('budget:authorization');
  if (
    authority?.type !== 'budget:authorization' ||
    authority.authorization.state !== 'paused' ||
    authority.authorization.allowance.kind !== 'frozen'
  )
    throw new Error('missing frozen pause authority');
  const result = authority.authorization.allowance.quote;
  if (result.kind !== 'quoted' || result.quote.amount.kind !== 'representable')
    throw new Error('expected representable quote');
  return { ...run, authority, quote: result.quote, amount: result.quote.amount.microcents };
}

async function parallelParkedRun(options: Parameters<typeof startRun>[0] = {}) {
  const companions = deferred<void>();
  const run = await parkedRun({
    ...options,
    siblingBudget: true,
    siblingGate: true,
    onEvent: (event) => {
      options?.onEvent?.(event);
      if (event.type === 'human_gate:paused' && event.nodeId === 'second') companions.resolve();
    },
  });
  await companions.promise;
  return run;
}

async function fundedMediaPrefix() {
  const parked = deferred<void>();
  let pauses = 0;
  const run = await parkedRun({
    mediaJob: true,
    onEvent: (event) => {
      if (event.type === 'run:paused' && ++pauses === 2) parked.resolve();
    },
  });
  await run.engine.resume(run.handle.runId, run.authority.gateId, {
    decision: 'approved',
    decidedBy: 'offline',
    approvedAmountMicrocents: run.amount,
  });
  await parked.promise;
  const prefix = [...run.store.eventsFor(run.handle.runId)];
  expect(reconstructCheckpointState(prefix)?.pendingMediaJobs).toMatchObject([
    { acceptedCostMicrocents: 2000 },
  ]);
  expect(run.keyReads()).toBe(1);
  expect(run.polls()).toBe(0);
  run.handle.cancel();
  await run.drained;
  return { run, prefix };
}

describe('durable budget authorization through the actual runner', () => {
  it.each([
    ['media_only', 'takeover'],
    ['media_only', 'expired_same_fence'],
    ['media_only', 'renewed'],
    ['resolved_budget_gate', 'takeover'],
    ['resolved_budget_gate', 'expired_same_fence'],
    ['resolved_budget_gate', 'renewed'],
  ] as const)(
    '%s validates the exact fence after slow passive admission (%s)',
    async (kind, ownership) => {
      const { run, prefix } = await fundedMediaPrefix();
      let now = 1000;
      const leases = createInMemoryRunLeases(() => now);
      const store = new InMemoryRunStore();
      for (const event of prefix) await store.persistEvent(event);
      const host = createInMemoryHost({ store, runLeases: leases });
      const entered = deferred<void>();
      const release = deferred<void>();
      const engine = new WorkflowEngine({
        host,
        executor: run.executor,
        resolvePrice: new Map([[MODEL, run.price]]),
        effectResume: {
          unresolvedForRun: async () => {
            entered.resolve();
            await release.promise;
            return [];
          },
        },
      });
      const resumed = engine.resumeFromCheckpoint({
        runId: run.handle.runId,
        workflow: run.workflow,
        ...(kind === 'media_only'
          ? {}
          : {
              gateId: run.authority.gateId,
              decision: { decision: 'rejected' as const, decidedBy: 'duplicate' },
            }),
      });
      await entered.promise;
      const original = await leases.read(run.handle.runId);
      if (original === undefined) throw new Error('missing admission fence');
      expectUnknownRun(engine, run.handle.runId);
      expect(host.armedCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
      expect(host.deadlineCount()).toBe(0);
      now += 40_000;
      host.fireLiveness();
      if (ownership === 'renewed')
        expect(await leases.heartbeat(run.handle.runId, original, 60_000)).toBe(true);
      now += 40_000;
      const successor =
        ownership === 'expired_same_fence'
          ? undefined
          : await leases.acquire(run.handle.runId, 'successor', 60_000);
      if (ownership === 'takeover') expect(successor).toBeDefined();
      else expect(successor).toBeUndefined();
      const successorLease = await leases.read(run.handle.runId);
      release.resolve();
      if (successor !== undefined) {
        await expect(resumed).rejects.toMatchObject({ code: 'run_owned_elsewhere' });
        expectUnknownRun(engine, run.handle.runId);
        host.fireTimers();
        host.fireLiveness();
        expect(store.eventsFor(run.handle.runId)).toEqual(prefix);
        expect(run.keyReads()).toBe(1);
        expect(run.polls()).toBe(0);
        expect(await leases.read(run.handle.runId)).toEqual(successorLease);
        await leases.release(run.handle.runId, successor);
      } else {
        const handle = await resumed;
        expect(await leases.read(run.handle.runId)).toEqual({
          ...original,
          expiresAt: now + 60_000,
        });
        const events: RunEvent[] = [];
        const drained = (async () => {
          for await (const event of handle.events) events.push(event);
        })();
        host.fireTimers();
        await drained;
        expect(events.at(-1)).toMatchObject({
          type: 'run:completed',
          totalCostMicrocents: 2000,
        });
        expect(run.keyReads()).toBe(2);
        expect(run.polls()).toBe(1);
        let cleanupWaits = 0;
        while ((await leases.read(run.handle.runId)) !== undefined)
          if (++cleanupWaits > 1000) throw new Error('terminal run retained its lease');
      }
      expect(run.mediaRequests).toHaveLength(1);
      expect(run.requests).toEqual([]);
      expect(host.armedCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
      expect(host.deadlineCount()).toBe(0);
      expect(await leases.read(run.handle.runId)).toBeUndefined();
    },
  );

  it.each([false, true])(
    'slow failed effect admission checks ownership before settlement (takeover %s)',
    async (takeover) => {
      const { run, prefix } = await fundedMediaPrefix();
      let now = 1000;
      const leases = createInMemoryRunLeases(() => now);
      const store = new InMemoryRunStore();
      for (const event of prefix) await store.persistEvent(event);
      const host = createInMemoryHost({ store, runLeases: leases });
      const entered = deferred<void>();
      const release = deferred<void>();
      const engine = new WorkflowEngine({
        host,
        executor: run.executor,
        resolvePrice: new Map([[MODEL, run.price]]),
        effectResume: {
          unresolvedForRun: async () => {
            entered.resolve();
            await release.promise;
            throw new Error('PRIVATE effect storage path');
          },
        },
      });
      const resumed = engine.resumeFromCheckpoint({
        runId: run.handle.runId,
        workflow: run.workflow,
      });
      await entered.promise;
      now += 80_000;
      const successor = takeover
        ? await leases.acquire(run.handle.runId, 'successor', 60_000)
        : undefined;
      const successorLease = await leases.read(run.handle.runId);
      release.resolve();
      if (takeover) {
        expect(successor).toBeDefined();
        await expect(resumed).rejects.toMatchObject({ code: 'run_owned_elsewhere' });
        expectUnknownRun(engine, run.handle.runId);
        expect(store.eventsFor(run.handle.runId)).toEqual(prefix);
        expect(await leases.read(run.handle.runId)).toEqual(successorLease);
        if (successor !== undefined) await leases.release(run.handle.runId, successor);
      } else {
        const handle = await resumed;
        const events: RunEvent[] = [];
        for await (const event of handle.events) events.push(event);
        expect(events.at(-1)).toMatchObject({
          type: 'run:failed',
          error: { code: 'effect_needs_attention' },
          cumulativeCostMicrocents: 2000,
        });
        expect(JSON.stringify(events)).not.toContain('PRIVATE');
      }
      expect(run.keyReads()).toBe(1);
      expect(run.polls()).toBe(0);
      expect(run.mediaRequests).toHaveLength(1);
      expect(host.armedCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
      expect(host.deadlineCount()).toBe(0);
      expect(await leases.read(run.handle.runId)).toBeUndefined();
    },
  );

  it.each([false, true])(
    'an admission heartbeat fault stays private and never activates work (release fault %s)',
    async (releaseFault) => {
      const run = await parkedRun();
      const { host, store } = await hostFromLog(run.store.eventsFor(run.handle.runId));
      run.handle.cancel();
      await run.drained;
      const prefix = [...store.eventsFor(run.handle.runId)];
      const engine = new WorkflowEngine({
        host: {
          ...host,
          runLeases: {
            ...host.runLeases,
            heartbeat: () => Promise.reject(new Error('PRIVATE lease storage path')),
            release: (runId, fence) =>
              releaseFault
                ? Promise.reject(new Error('PRIVATE release storage path'))
                : host.runLeases.release(runId, fence),
          },
        },
        executor: run.executor,
        resolvePrice: new Map([[MODEL, run.price]]),
      });
      let refusal: unknown;
      try {
        await engine.resumeFromCheckpoint({
          runId: run.handle.runId,
          workflow: run.workflow,
          gateId: run.authority.gateId,
          decision: {
            decision: 'approved',
            decidedBy: 'offline',
            approvedAmountMicrocents: run.amount,
          },
        });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({ code: 'run_owned_elsewhere' });
      expect(refusal instanceof Error && refusal.message).not.toContain('PRIVATE');
      expectUnknownRun(engine, run.handle.runId);
      expect(store.eventsFor(run.handle.runId)).toEqual(prefix);
      expect(run.keyReads()).toBe(0);
      expect(run.requests).toEqual([]);
      expect(host.armedCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
      expect(host.deadlineCount()).toBe(0);
      const held = await host.runLeases.read(run.handle.runId);
      if (releaseFault) {
        expect(held).toBeDefined(); // cleanup failure leaves the original bounded TTL, never work
        if (held !== undefined) await host.runLeases.release(run.handle.runId, held);
      } else expect(held).toBeUndefined();
    },
  );

  it.each([
    ['agent', 'budget:authorization'],
    ['agent', 'budget:paused'],
    ['agent', 'human_gate:paused'],
    ['second', 'budget:authorization'],
    ['second', 'budget:paused'],
    ['second', 'human_gate:paused'],
  ] as const)(
    'an actual crash prefix at %s / %s keeps both budget identities and the ordinary sibling distinct',
    async (nodeId, type) => {
      const run = await parallelParkedRun();
      const all = run.store.eventsFor(run.handle.runId);
      const cut = all.findIndex(
        (event) => event.type === type && 'nodeId' in event && event.nodeId === nodeId,
      );
      if (cut < 0) throw new Error('missing actual crash boundary');
      const prefix = all.slice(0, cut + 1);
      const authority = prefix.find(
        (event) => event.type === 'budget:authorization' && event.nodeId === nodeId,
      );
      if (authority?.type !== 'budget:authorization')
        throw new Error('missing actual budget authority');
      const cp = reconstructCheckpointState(prefix);
      const recordedBudgetIds = prefix
        .filter((event) => event.type === 'budget:authorization')
        .map((event) => event.gateId);
      expect(
        cp?.pendingGates
          .filter((gate) => gate.isBudgetGate)
          .map((gate) => gate.gateId)
          .sort(),
      ).toEqual([...recordedBudgetIds].sort());
      const human = prefix.find(
        (event) => event.type === 'human_gate:paused' && event.nodeId === 'human',
      );
      if (human?.type !== 'human_gate:paused') throw new Error('missing actual ordinary sibling');
      expect(cp?.pendingGates.find((gate) => gate.gateId === human.gateId)).toMatchObject({
        nodeId: 'human',
        isBudgetGate: false,
      });
      const { host, store } = await hostFromLog(prefix);
      run.handle.cancel();
      await run.drained;
      const engine = new WorkflowEngine({
        host,
        executor: run.executor,
        resolvePrice: new Map([[MODEL, run.price]]),
      });
      const handle = await engine.resumeFromCheckpoint({
        runId: run.handle.runId,
        workflow: run.workflow,
        gateId: authority.gateId,
        decision: { decision: 'rejected', decidedBy: 'offline' },
      });
      const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(events.at(-1)).toMatchObject({
        type: 'run:failed',
        error: { code: 'budget_exceeded', nodeId },
      });
      expect(
        store
          .eventsFor(run.handle.runId)
          .filter((event) => event.type === 'human_gate:resumed')
          .map((event) => event.gateId),
      ).toEqual([authority.gateId]);
      expect(run.requests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      expect(host.armedCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
      expect(await host.runLeases.read(run.handle.runId)).toBeUndefined();
    },
  );

  it.each([
    ['approved', 'authority'],
    ['approved', 'companion'],
    ['rejected', 'authority'],
    ['rejected', 'companion'],
  ] as const)(
    'an actual parallel-gate crash after %s %s preserves all three identities without restoring allowance',
    async (decision, boundary) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const hold = async (event: RunEvent) => {
        if (event.type === 'human_gate:resumed') {
          entered.resolve();
          await release.promise;
        }
      };
      const run = await parallelParkedRun({
        ...(boundary === 'authority' ? { beforePersist: hold } : { afterPersist: hold }),
      });
      const other = run.events.find(
        (event) => event.type === 'budget:authorization' && event.nodeId === 'second',
      );
      const human = run.events.find(
        (event) => event.type === 'human_gate:paused' && event.nodeId === 'human',
      );
      if (other?.type !== 'budget:authorization' || human?.type !== 'human_gate:paused')
        throw new Error('missing sibling identities');
      const resumed = run.engine.resume(run.handle.runId, run.authority.gateId, {
        decision,
        decidedBy: 'offline',
        ...(decision === 'approved' ? { approvedAmountMicrocents: run.amount } : {}),
      });
      await entered.promise;
      const prefix = run.store.eventsFor(run.handle.runId);
      const cp = reconstructCheckpointState(prefix);
      expect(cp?.resolvedGateIds).toContain(run.authority.gateId);
      expect(cp?.pendingGates.map((gate) => gate.gateId).sort()).toEqual(
        [other.gateId, human.gateId].sort(),
      );
      expect(cp?.nodeStates.get('agent')?.output).toBeUndefined();
      expect(prefix.some((event) => event.type === 'node:completed')).toBe(false);
      const { host } = await hostFromLog(prefix);
      run.handle.cancel();
      release.resolve();
      await resumed;
      await run.drained;
      const engine = new WorkflowEngine({
        host,
        executor: run.executor,
        resolvePrice: new Map([[MODEL, run.price]]),
      });
      const handle = await engine.resumeFromCheckpoint({
        runId: run.handle.runId,
        workflow: run.workflow,
        gateId: other.gateId,
        decision: { decision: 'rejected', decidedBy: 'offline' },
      });
      const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(events.at(-1)).toMatchObject({
        type: 'run:failed',
        error: { code: 'budget_exceeded', nodeId: decision === 'approved' ? 'second' : 'agent' },
      });
      expect(run.requests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      expect(host.armedCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
      expect(await host.runLeases.read(run.handle.runId)).toBeUndefined();
    },
  );

  it.each(['complete', 'cancel'] as const)(
    'an approved actual async media job freezes its paid reservation and reconciles on %s',
    async (terminal) => {
      const submitted = deferred<void>();
      const installed = deferred<void>();
      const run = await parkedRun({
        mediaJob: true,
        onEvent: (event) => {
          if (event.type === 'media_job:submitted') submitted.resolve();
        },
        onTimer: (ms, kind) => {
          if (kind === 'work' && ms === MEDIA_JOB_POLL_DEFAULTS.pollInitialMs) installed.resolve();
        },
      });
      expect(run.amount).toBe(2000);
      expect(run.quote.provenance).toMatchObject({ route: 'generative', calls: 1, attempts: 1 });
      expect(run.mediaRequests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      await run.engine.resume(run.handle.runId, run.authority.gateId, {
        decision: 'approved',
        decidedBy: 'offline',
        approvedAmountMicrocents: run.amount,
      });
      await submitted.promise;
      const event = run.events.find((item) => item.type === 'media_job:submitted');
      expect(event).toMatchObject({ acceptedCostMicrocents: 2000, units: 2 });
      expect(
        reconstructCheckpointState(run.store.eventsFor(run.handle.runId))?.pendingMediaJobs,
      ).toMatchObject([{ acceptedCostMicrocents: 2000 }]);
      expect(run.mediaRequests).toHaveLength(1);
      expect(run.keyReads()).toBe(1);
      if (terminal === 'complete') {
        await installed.promise;
        run.host.fireTimers();
      } else run.handle.cancel();
      await run.drained;
      const cp = reconstructCheckpointState(run.store.eventsFor(run.handle.runId));
      if (terminal === 'complete') {
        expect(cp?.pendingMediaJobs).toEqual([]);
        expect(run.events.at(-1)).toMatchObject({
          type: 'run:completed',
          totalCostMicrocents: 2000,
        });
        expect(cp?.conservativeCostMicrocents).toBe(0);
        expect(run.polls()).toBe(1);
        expect(run.keyReads()).toBe(2);
      } else {
        expect(run.events.at(-1)).toMatchObject({
          type: 'run:cancelled',
          cumulativeCostMicrocents: 2000,
        });
        // Existing media accounting records the accepted authored volume as its lone realized addend.
        expect(run.store.eventsFor(run.handle.runId).at(-1)).toMatchObject({
          type: 'run:cancelled',
          cumulativeCostMicrocents: 2000,
        });
        expect(run.events.filter((event) => event.type === 'cost:updated')).toMatchObject([
          { costMicrocents: 2000 },
        ]);
        expect(cp?.conservativeCostMicrocents).toBe(0);
        // Cancellation stops this run; it does not claim the external provider cancelled an accepted job.
        expect(cp?.pendingMediaJobs).toMatchObject([{ acceptedCostMicrocents: 2000 }]);
        expect(await run.store.listInterruptedRuns()).toEqual([]);
        expect(run.polls()).toBe(0);
      }
      expect(run.events.filter((item) => item.type === 'budget:authorization')).toHaveLength(2);
      expect(run.requests).toEqual([]);
      expect(run.host.armedCount()).toBe(0);
      expect(run.host.livenessCount()).toBe(0);
      expect(run.host.deadlineCount()).toBe(0);
      expect(await run.host.runLeases.read(run.handle.runId)).toBeUndefined();
    },
  );

  it.each([
    'pause_authority',
    'budget_companion',
    'gate_companion',
    'decision_authority',
    'decision_companion',
  ] as const)(
    'a sibling failure during %s acknowledgement keeps its cause and prevents any later grant',
    async (boundary) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const sibling = deferred<NodeOutcome>();
      const aborted = deferred<void>();
      const pause = deferred<void>();
      const run = startRun({
        siblingGate: true,
        siblingFailure: sibling.promise,
        onSiblingAbort: () => aborted.resolve(),
        onEvent: (event) => {
          if (event.type === 'human_gate:paused' && event.nodeId === 'agent') pause.resolve();
        },
        beforePersist: async (event) => {
          const matches =
            boundary === 'pause_authority'
              ? event.type === 'budget:authorization' && event.authorization.state === 'paused'
              : boundary === 'budget_companion'
                ? event.type === 'budget:paused'
                : boundary === 'gate_companion'
                  ? event.type === 'human_gate:paused' && event.nodeId === 'agent'
                  : boundary === 'decision_authority'
                    ? event.type === 'budget:authorization' &&
                      event.authorization.state === 'decided'
                    : event.type === 'human_gate:resumed';
          if (matches) {
            entered.resolve();
            await release.promise;
          }
        },
      });
      let resumed: Promise<void> | undefined;
      if (boundary === 'decision_authority' || boundary === 'decision_companion') {
        await pause.promise;
        const authority = run.events.find((event) => event.type === 'budget:authorization');
        if (
          authority?.type !== 'budget:authorization' ||
          authority.authorization.allowance.kind !== 'frozen'
        )
          throw new Error('missing frozen authority');
        const quote = authority.authorization.allowance.quote;
        if (quote.kind !== 'quoted' || quote.quote.amount.kind !== 'representable')
          throw new Error('missing safe amount');
        resumed = run.engine.resume(run.handle.runId, authority.gateId, {
          decision: 'approved',
          decidedBy: 'offline',
          approvedAmountMicrocents: quote.quote.amount.microcents,
        });
      }
      await entered.promise;
      sibling.resolve({
        kind: 'failed',
        error: { code: 'provider_auth', message: 'fixture sibling failure', retryable: false },
      });
      await aborted.promise;
      release.resolve();
      await resumed;
      await run.drained;
      expect(run.events.at(-1)).toMatchObject({
        type: 'run:failed',
        error: { code: 'provider_auth', nodeId: 'human' },
      });
      expect(run.events.filter((event) => event.type === 'run:failed')).toHaveLength(1);
      expect(run.requests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      if (boundary === 'pause_authority')
        expect(
          run.events.some(
            (event) => event.type === 'budget:paused' || event.type === 'human_gate:paused',
          ),
        ).toBe(false);
      if (boundary === 'decision_authority')
        expect(run.events.some((event) => event.type === 'human_gate:resumed')).toBe(false);
      expect(run.host.armedCount()).toBe(0);
      expect(run.host.livenessCount()).toBe(0);
      expect(await run.host.runLeases.read(run.handle.runId)).toBeUndefined();
    },
  );
  it('two parallel budget gates and an ordinary sibling retain separate decisions and real outputs', async () => {
    const run = await parkedRun({ siblingGate: true, siblingBudget: true });
    const human = run.events.find(
      (event) => event.type === 'human_gate:paused' && event.nodeId === 'human',
    );
    const second = run.events.find(
      (event) => event.type === 'budget:authorization' && event.nodeId === 'second',
    );
    if (
      human?.type !== 'human_gate:paused' ||
      second?.type !== 'budget:authorization' ||
      second.authorization.allowance.kind !== 'frozen'
    )
      throw new Error('missing parallel gates');
    const result = second.authorization.allowance.quote;
    if (result.kind !== 'quoted' || result.quote.amount.kind !== 'representable')
      throw new Error('missing parallel quote');
    expect(new Set([human.gateId, second.gateId, run.authority.gateId]).size).toBe(3);
    await run.engine.resume(run.handle.runId, run.authority.gateId, {
      decision: 'approved',
      decidedBy: 'offline',
      approvedAmountMicrocents: run.amount,
    });
    const firstDone = deferred<void>();
    // Join the real node boundary through its durable store rather than assuming resume waits for dispatch.
    const originalPersist = run.host.store.persistEvent;
    run.host.store.persistEvent = async (...args) => {
      await originalPersist(...args);
      if (args[0].type === 'node:completed' && args[0].nodeId === 'agent') firstDone.resolve();
    };
    if (
      !run.store
        .eventsFor(run.handle.runId)
        .some((event) => event.type === 'node:completed' && event.nodeId === 'agent')
    )
      await firstDone.promise;
    expect(
      (await run.host.checkpointer.load(run.handle.runId))?.pendingGates
        .map((gate) => gate.gateId)
        .sort(),
    ).toEqual([human.gateId, second.gateId].sort());
    await run.engine.resume(run.handle.runId, run.authority.gateId, {
      decision: 'rejected',
      decidedBy: 'duplicate',
    });
    await run.engine.resume(run.handle.runId, second.gateId, {
      decision: 'approved',
      decidedBy: 'offline',
      approvedAmountMicrocents: result.quote.amount.microcents,
    });
    await run.engine.resume(run.handle.runId, human.gateId, {
      decision: 'rejected',
      decidedBy: 'ordinary',
    });
    await run.drained;
    expect(run.events.at(-1)).toMatchObject({ type: 'run:completed', totalCostMicrocents: 4 });
    const cp = reconstructCheckpointState(run.store.eventsFor(run.handle.runId));
    expect(cp?.nodeStates.get('agent')).toMatchObject({ status: 'completed', output: 'ANSWER' });
    expect(cp?.nodeStates.get('second')).toMatchObject({ status: 'completed', output: 'ANSWER' });
    expect(cp?.nodeStates.get('human')).toMatchObject({
      status: 'completed',
      output: { decision: 'rejected' },
    });
    expect(
      run.events.filter(
        (event) => event.type === 'budget:authorization' && event.authorization.state === 'decided',
      ),
    ).toHaveLength(2);
    expect(run.requests).toHaveLength(2);
    expect(run.keyReads()).toBe(2);
    expect(run.host.armedCount()).toBe(0);
    expect(run.host.livenessCount()).toBe(0);
  });

  it('an existing native auto-approve timeout acknowledges exact A before paid execution', async () => {
    const run = await parkedRun({ gateDeadline: { timeoutMs: 1000, timeoutAction: 'approve' } });
    expect(run.host.armedCount()).toBe(1);
    run.host.fireTimers();
    await run.drained;
    expect(
      run.events.find(
        (event) => event.type === 'budget:authorization' && event.authorization.state === 'decided',
      ),
    ).toMatchObject({
      authorization: {
        decidedBy: 'timeout',
        decision: 'approved',
        approvedAmountMicrocents: run.amount,
      },
    });
    expect(run.events.at(-1)).toMatchObject({ type: 'run:completed', totalCostMicrocents: 2 });
    expect(run.requests).toHaveLength(1);
    expect(run.keyReads()).toBe(1);
    expect(run.host.armedCount()).toBe(0);
    expect(run.host.livenessCount()).toBe(0);
  });
  it('an actually free followup grants only explicit zero and retains ordinary budget governance', async () => {
    const again = deferred<void>();
    let pauses = 0;
    const run = await parkedRun({
      freeFollowup: true,
      onEvent: (event) => {
        if (event.type === 'run:paused' && ++pauses === 2) again.resolve();
      },
    });
    await run.engine.resume(run.handle.runId, run.authority.gateId, {
      decision: 'approved',
      decidedBy: 'offline',
      approvedAmountMicrocents: run.amount,
    });
    await again.promise;
    const free = run.events.find(
      (event) => event.type === 'budget:authorization' && event.nodeId === 'free',
    );
    expect(free).toMatchObject({
      authorization: {
        state: 'paused',
        allowance: {
          kind: 'frozen',
          quote: { kind: 'quoted', quote: { amount: { kind: 'representable', microcents: 0 } } },
        },
      },
    });
    if (free?.type !== 'budget:authorization') throw new Error('missing zero gate');
    await expect(
      run.engine.resume(run.handle.runId, free.gateId, {
        decision: 'approved',
        decidedBy: 'offline',
      }),
    ).rejects.toMatchObject({ code: 'invalid_decision' });
    expect(run.requests).toHaveLength(1);
    await run.engine.resume(run.handle.runId, free.gateId, {
      decision: 'approved',
      decidedBy: 'offline',
      approvedAmountMicrocents: 0,
    });
    await run.drained;
    expect(run.events.at(-1)).toMatchObject({ type: 'run:completed', totalCostMicrocents: 2 });
    expect(run.requests).toHaveLength(2);
    expect(run.keyReads()).toBe(2);
    expect(run.events.filter((event) => event.type === 'node:completed')).toMatchObject([
      { output: 'ANSWER' },
      { output: 'ANSWER' },
    ]);
    expect(run.host.armedCount()).toBe(0);
    expect(run.host.livenessCount()).toBe(0);
  });

  it.each([250, -60_000])(
    'an authority-only budget survivor keeps its absolute deadline with %i ms remaining',
    async (remaining) => {
      const run = await parkedRun({
        siblingGate: true,
        gateDeadline: { timeoutMs: 1000, timeoutAction: 'reject' },
      });
      const human = run.events.find(
        (event) => event.type === 'human_gate:paused' && event.nodeId === 'human',
      );
      if (
        human?.type !== 'human_gate:paused' ||
        run.authority.authorization.expiresAt === undefined
      )
        throw new Error('missing gate/deadline');
      // An actual ordered prefix, cut immediately after authority; never remove individual rows.
      const logged = run.store.eventsFor(run.handle.runId);
      const prefix = logged.slice(
        0,
        logged.findIndex((event) => event.type === 'budget:authorization') + 1,
      );
      expect(
        prefix.some((event) => event.type === 'human_gate:paused' && event.nodeId === 'human'),
      ).toBe(true);
      const { host: base, store } = await hostFromLog(prefix);
      run.handle.cancel();
      await run.drained;
      const expiresAt = run.authority.authorization.expiresAt;
      const armed: number[] = [];
      const host = {
        ...base,
        clock: { now: () => new Date(Date.parse(expiresAt) - remaining).toISOString() },
        setTimer: (ms: number, fire: () => void, kind: TimerKind = 'work') => {
          if (kind === 'work') armed.push(ms);
          return base.setTimer(ms, fire, kind);
        },
      };
      const engine = new WorkflowEngine({
        host,
        executor: run.executor,
        resolvePrice: new Map([[MODEL, run.price]]),
      });
      const handle = await engine.resumeFromCheckpoint({
        runId: run.handle.runId,
        workflow: run.workflow,
        gateId: human.gateId,
        decision: { decision: 'approved', decidedBy: 'offline' },
      });
      const parked = deferred<void>();
      const events: RunEvent[] = [];
      const drained = (async () => {
        for await (const event of handle.events) {
          events.push(event);
          if (event.type === 'run:paused') parked.resolve();
        }
      })();
      await parked.promise;
      expect(armed).toEqual([Math.max(0, remaining)]);
      expect((await host.checkpointer.load(run.handle.runId))?.pendingGates).toMatchObject([
        { gateId: run.authority.gateId, expiresAt, timeoutMs: 1000, isBudgetGate: true },
      ]);
      expect(events.some((event) => event.type === 'run:failed')).toBe(false);
      expect(run.requests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      if (remaining < 0) {
        base.fireTimers();
        await drained;
        expect(events.at(-1)).toMatchObject({ type: 'run:failed', error: { code: 'run_timeout' } });
      } else {
        await engine.resume(run.handle.runId, run.authority.gateId, {
          decision: 'rejected',
          decidedBy: 'offline',
        });
        await drained;
      }
      expect(
        store.eventsFor(run.handle.runId).filter((event) => event.type === 'human_gate:resumed'),
      ).toHaveLength(remaining < 0 ? 1 : 2);
      expect(base.armedCount()).toBe(0);
      expect(base.livenessCount()).toBe(0);
    },
  );
  it('above-chain retry/backoff retains the same consumed allowance and cannot mint another grant', async () => {
    const retry = deferred<void>();
    const run = await parkedRun({
      failProvider: true,
      onTimer: (ms, kind) => {
        if (kind === 'work' && ms === 1) retry.resolve();
      },
    });
    expect(run.quote.provenance.attempts).toBe(1); // above-chain retry does not multiply A
    await run.engine.resume(run.handle.runId, run.authority.gateId, {
      decision: 'approved',
      decidedBy: 'offline',
      approvedAmountMicrocents: run.amount,
    });
    await retry.promise;
    expect(run.requests).toHaveLength(1);
    expect(run.keyReads()).toBe(1);
    expect(run.host.armedCount()).toBe(1);
    run.host.fireTimers();
    await run.drained;
    expect(run.requests).toHaveLength(1);
    expect(run.keyReads()).toBe(1);
    expect(run.events.at(-1)).toMatchObject({
      type: 'run:failed',
      error: { code: 'budget_exceeded' },
    });
    expect(run.events.filter((event) => event.type === 'run:paused')).toHaveLength(1);
    expect(run.events.filter((event) => event.type === 'budget:authorization')).toHaveLength(2);
    expect(run.events.filter((event) => event.type === 'node:retrying')).toHaveLength(1);
    expect(
      reconstructCheckpointState(run.store.eventsFor(run.handle.runId))?.conservativeCostMicrocents,
    ).toBe(run.amount);
    expect(run.host.armedCount()).toBe(0);
    expect(run.host.livenessCount()).toBe(0);
  });
  it.each([false, true])(
    'approved tool-round input remains governed (large result: %s)',
    async (large) => {
      const run = await parkedRun({ toolOutput: large ? 'x'.repeat(100_000) : 'short' });
      expect(run.quote.provenance.calls).toBe(2);
      await run.engine.resume(run.handle.runId, run.authority.gateId, {
        decision: 'approved',
        decidedBy: 'offline',
        approvedAmountMicrocents: run.amount,
      });
      await run.drained;
      expect(run.toolCalls()).toBe(1);
      expect(run.requests).toHaveLength(large ? 1 : 2);
      expect(run.keyReads()).toBe(large ? 1 : 2);
      expect(run.events.filter((event) => event.type === 'budget:authorization')).toHaveLength(2);
      expect(run.events.filter((event) => event.type === 'run:paused')).toHaveLength(1);
      expect(run.events.some((event) => event.type === 'node:retrying')).toBe(false);
      expect(run.events.at(-1)).toMatchObject(
        large
          ? { type: 'run:failed', error: { code: 'budget_exceeded' }, cumulativeCostMicrocents: 2 }
          : { type: 'run:completed', totalCostMicrocents: 4 },
      );
      expect(run.host.armedCount()).toBe(0);
      expect(run.host.livenessCount()).toBe(0);
    },
  );
  it('an existing authored cap above the safe-grant range does not prevent an unrepresentable quote from pausing for rejection', async () => {
    const run = startRun({ cap: Number.MAX_SAFE_INTEGER + 1, inputRate: 1e24 });
    await Promise.race([run.atPause, run.drained]);
    const authority = run.events.find((event) => event.type === 'budget:authorization');
    expect(authority).toMatchObject({
      authorization: {
        state: 'paused',
        limitMicrocents: Number.MAX_SAFE_INTEGER + 1,
        allowance: {
          kind: 'frozen',
          quote: { kind: 'quoted', quote: { amount: { kind: 'unrepresentable' } } },
        },
      },
    });
    if (authority?.type !== 'budget:authorization') throw new Error('missing reject-only pause');
    await expect(
      run.engine.resume(run.handle.runId, authority.gateId, {
        decision: 'approved',
        decidedBy: 'offline',
        approvedAmountMicrocents: 0,
      }),
    ).rejects.toMatchObject({ code: 'invalid_decision' });
    await run.engine.resume(run.handle.runId, authority.gateId, {
      decision: 'rejected',
      decidedBy: 'offline',
    });
    await run.drained;
    expect(run.events.at(-1)).toMatchObject({
      type: 'run:failed',
      error: { code: 'budget_exceeded' },
    });
    expect(run.requests).toEqual([]);
    expect(run.keyReads()).toBe(0);
  });
  it('does not accept a decision or publish companions while pause authority is unacknowledged', async () => {
    const entered = deferred<Extract<RunEvent, { type: 'budget:authorization' }>>();
    const release = deferred<void>();
    const run = startRun({
      beforePersist: async (event) => {
        if (event.type === 'budget:authorization') {
          entered.resolve(event);
          await release.promise;
        }
      },
    });
    const authority = await entered.promise;
    expect(
      run.events.some(
        (event) => event.type === 'budget:paused' || event.type === 'human_gate:paused',
      ),
    ).toBe(false);
    expect(run.host.armedCount()).toBe(0);
    await expect(
      run.engine.resume(run.handle.runId, authority.gateId, {
        decision: 'rejected',
        decidedBy: 'offline',
      }),
    ).rejects.toMatchObject({ code: 'invalid_decision' });
    expect(run.keyReads()).toBe(0);
    expect(run.requests).toEqual([]);
    release.resolve();
    await run.atPause;
    await run.engine.resume(run.handle.runId, authority.gateId, {
      decision: 'rejected',
      decidedBy: 'offline',
    });
    await run.drained;
    expect(run.events.at(-1)).toMatchObject({
      type: 'run:failed',
      error: { code: 'budget_exceeded' },
    });
  });

  it.each([
    'missing_amount',
    'wrong_amount',
    'input_provided',
    'missing_preparer',
    'changed_basis',
  ] as const)(
    'an in-process %s refusal leaves the native gate deadline and rejection available',
    async (reason) => {
      const run = await parkedRun({
        omitPreparation: reason === 'missing_preparer',
        gateDeadline: { timeoutMs: 1000, timeoutAction: 'reject' },
      });
      expect(run.host.armedCount()).toBe(1);
      const before = run.store.eventsFor(run.handle.runId).length;
      if (reason === 'changed_basis') run.price.inputPerMtokMicrocents += 1;
      const decision =
        reason === 'input_provided'
          ? { decision: 'input_provided' as const, decidedBy: 'offline', payload: 'PRIVATE' }
          : {
              decision: 'approved' as const,
              decidedBy: 'offline',
              ...(reason === 'missing_amount'
                ? {}
                : { approvedAmountMicrocents: run.amount + (reason === 'wrong_amount' ? 1 : 0) }),
            };
      await expect(
        run.engine.resume(run.handle.runId, run.authority.gateId, decision),
      ).rejects.toMatchObject({ code: 'invalid_decision' });
      expect(run.store.eventsFor(run.handle.runId)).toHaveLength(before);
      expect(run.host.armedCount()).toBe(1);
      expect(
        reconstructCheckpointState(run.store.eventsFor(run.handle.runId))?.pendingGates,
      ).toMatchObject([
        { gateId: run.authority.gateId, expiresAt: run.authority.authorization.expiresAt },
      ]);
      expect(run.requests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      await run.engine.resume(run.handle.runId, run.authority.gateId, {
        decision: 'rejected',
        decidedBy: 'offline',
      });
      await run.drained;
      expect(run.events.at(-1)).toMatchObject({
        type: 'run:failed',
        error: { code: 'budget_exceeded' },
      });
      expect(run.host.armedCount()).toBe(0);
      expect(run.host.livenessCount()).toBe(0);
      expect(run.host.deadlineCount()).toBe(0);
      expect(await run.host.runLeases.read(run.handle.runId)).toBeUndefined();
    },
  );

  it.each([
    'pause_authority',
    'budget_companion',
    'gate_companion',
    'decision_authority',
    'decision_companion',
  ] as const)(
    'an absorbed %s write fault grants no egress and terminates exactly once',
    async (boundary) => {
      const run = startRun({
        beforePersist: (event) => {
          const matches =
            boundary === 'pause_authority'
              ? event.type === 'budget:authorization' && event.authorization.state === 'paused'
              : boundary === 'budget_companion'
                ? event.type === 'budget:paused'
                : boundary === 'gate_companion'
                  ? event.type === 'human_gate:paused'
                  : boundary === 'decision_authority'
                    ? event.type === 'budget:authorization' &&
                      event.authorization.state === 'decided'
                    : event.type === 'human_gate:resumed';
          return matches ? Promise.reject(new Error('PRIVATE storage fault')) : Promise.resolve();
        },
      });
      if (boundary === 'decision_authority' || boundary === 'decision_companion') {
        await run.atPause;
        const authority = run.events.find((event) => event.type === 'budget:authorization');
        if (
          authority?.type !== 'budget:authorization' ||
          authority.authorization.allowance.kind !== 'frozen'
        )
          throw new Error('missing authority');
        const result = authority.authorization.allowance.quote;
        if (result.kind !== 'quoted' || result.quote.amount.kind !== 'representable')
          throw new Error('missing amount');
        await run.engine.resume(run.handle.runId, authority.gateId, {
          decision: 'approved',
          decidedBy: 'offline',
          approvedAmountMicrocents: result.quote.amount.microcents,
        });
      }
      await run.drained;
      expect(
        run.events.filter((event) =>
          ['run:failed', 'run:cancelled', 'run:completed'].includes(event.type),
        ),
      ).toHaveLength(1);
      expect(run.events.at(-1)).toMatchObject({ type: 'run:failed', error: { code: 'internal' } });
      // ADR-0078 still delivers a failed append in-process to preserve sequence continuity.
      // A failed authority cannot publish a companion at all; a failed companion never becomes durable.
      if (boundary !== 'decision_companion')
        expect(run.events.some((event) => event.type === 'human_gate:resumed')).toBe(false);
      expect(
        run.store.eventsFor(run.handle.runId).some((event) => event.type === 'human_gate:resumed'),
      ).toBe(false);
      if (boundary === 'pause_authority')
        expect(
          run.events.some(
            (event) => event.type === 'budget:paused' || event.type === 'human_gate:paused',
          ),
        ).toBe(false);
      expect(JSON.stringify(run.events)).not.toContain('PRIVATE');
      expect(run.requests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      expect(run.host.armedCount()).toBe(0);
      expect(run.host.livenessCount()).toBe(0);
      expect(await run.host.runLeases.read(run.handle.runId)).toBeUndefined();
    },
  );

  it.each(['pause_authority', 'budget_companion', 'gate_companion'] as const)(
    'cancellation during %s acknowledgement cannot install a gate timer or admit execution',
    async (boundary) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const run = startRun({
        gateDeadline: { timeoutMs: 1000, timeoutAction: 'approve' },
        beforePersist: async (event) => {
          const matches =
            boundary === 'pause_authority'
              ? event.type === 'budget:authorization' && event.authorization.state === 'paused'
              : boundary === 'budget_companion'
                ? event.type === 'budget:paused'
                : event.type === 'human_gate:paused';
          if (matches) {
            entered.resolve();
            await release.promise;
          }
        },
      });
      await entered.promise;
      expect(run.host.armedCount()).toBe(0);
      run.handle.cancel();
      release.resolve();
      await run.drained;
      expect(run.events.at(-1)).toMatchObject({ type: 'run:cancelled' });
      expect(
        run.events.filter((event) =>
          ['run:cancelled', 'run:failed', 'run:completed'].includes(event.type),
        ),
      ).toHaveLength(1);
      expect(
        run.store
          .eventsFor(run.handle.runId)
          .some(
            (event) =>
              event.type === 'budget:authorization' && event.authorization.state === 'decided',
          ),
      ).toBe(false);
      if (boundary === 'pause_authority')
        expect(
          run.events.some(
            (event) => event.type === 'budget:paused' || event.type === 'human_gate:paused',
          ),
        ).toBe(false);
      if (boundary === 'budget_companion')
        expect(run.events.some((event) => event.type === 'human_gate:paused')).toBe(false);
      expect(run.requests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      expect(run.host.armedCount()).toBe(0);
      expect(run.host.livenessCount()).toBe(0);
      expect(run.host.deadlineCount()).toBe(0);
      expect(await run.host.runLeases.read(run.handle.runId)).toBeUndefined();
    },
  );

  it.each(['pause_authority', 'budget_companion', 'gate_companion'] as const)(
    'fencing during %s acknowledgement preserves the successor and cannot install a gate timer',
    async (boundary) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const run = startRun({
        gateDeadline: { timeoutMs: 1000, timeoutAction: 'approve' },
        beforePersist: async (event) => {
          const matches =
            boundary === 'pause_authority'
              ? event.type === 'budget:authorization' && event.authorization.state === 'paused'
              : boundary === 'budget_companion'
                ? event.type === 'budget:paused'
                : event.type === 'human_gate:paused';
          if (matches) {
            entered.resolve();
            await release.promise;
          }
        },
      });
      await entered.promise;
      const old = await run.host.runLeases.read(run.handle.runId);
      if (old === undefined) throw new Error('missing old owner');
      await run.host.runLeases.release(run.handle.runId, old);
      const successor = await run.host.runLeases.acquire(run.handle.runId, 'successor', 60_000);
      if (successor === undefined) throw new Error('missing successor owner');
      release.resolve();
      await run.drained;
      expect(
        run.events.some((event) =>
          ['run:cancelled', 'run:failed', 'run:completed'].includes(event.type),
        ),
      ).toBe(false);
      expect(
        run.store.eventsFor(run.handle.runId).some((event) => event.type === 'human_gate:paused'),
      ).toBe(false);
      expect(run.requests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      expect(run.host.armedCount()).toBe(0);
      expect(run.host.livenessCount()).toBe(0);
      expect(run.host.deadlineCount()).toBe(0);
      expect(await run.host.runLeases.read(run.handle.runId)).toMatchObject(successor);
      await run.host.runLeases.release(run.handle.runId, successor);
    },
  );

  it.each(['decision_authority', 'decision_companion'] as const)(
    'cancellation while %s awaits acknowledgement prevents approved dispatch',
    async (boundary) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const run = await parkedRun({
        beforePersist: async (event) => {
          if (
            (boundary === 'decision_authority' &&
              event.type === 'budget:authorization' &&
              event.authorization.state === 'decided') ||
            (boundary === 'decision_companion' && event.type === 'human_gate:resumed')
          ) {
            entered.resolve();
            await release.promise;
          }
        },
      });
      const resumed = run.engine.resume(run.handle.runId, run.authority.gateId, {
        decision: 'approved',
        decidedBy: 'offline',
        approvedAmountMicrocents: run.amount,
      });
      await entered.promise;
      expect(run.requests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      // An identified duplicate retains the existing API no-op policy even while the winner writes.
      await run.engine.resume(run.handle.runId, run.authority.gateId, {
        decision: 'rejected',
        decidedBy: 'duplicate',
      });
      run.handle.cancel();
      release.resolve();
      await resumed;
      await run.drained;
      expect(run.events.at(-1)).toMatchObject({ type: 'run:cancelled' });
      expect(
        run.events.filter(
          (event) =>
            event.type === 'budget:authorization' && event.authorization.state === 'decided',
        ),
      ).toHaveLength(1);
      expect(run.requests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      if (boundary === 'decision_authority')
        expect(run.events.some((event) => event.type === 'human_gate:resumed')).toBe(false);
      expect(run.host.armedCount()).toBe(0);
      expect(run.host.livenessCount()).toBe(0);
    },
  );

  it.each(['decision_authority', 'decision_companion'] as const)(
    'fencing while %s awaits acknowledgement stops the old owner without freeing its successor',
    async (boundary) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const run = await parkedRun({
        beforePersist: async (event) => {
          if (
            (boundary === 'decision_authority' &&
              event.type === 'budget:authorization' &&
              event.authorization.state === 'decided') ||
            (boundary === 'decision_companion' && event.type === 'human_gate:resumed')
          ) {
            entered.resolve();
            await release.promise;
          }
        },
      });
      const resumed = run.engine.resume(run.handle.runId, run.authority.gateId, {
        decision: 'approved',
        decidedBy: 'offline',
        approvedAmountMicrocents: run.amount,
      });
      await entered.promise;
      const old = await run.host.runLeases.read(run.handle.runId);
      if (old === undefined) throw new Error('missing old owner');
      await run.host.runLeases.release(run.handle.runId, old);
      const successor = await run.host.runLeases.acquire(run.handle.runId, 'successor', 60_000);
      expect(successor).toBeDefined();
      release.resolve();
      await resumed;
      await run.drained;
      expect(
        run.events.some((event) =>
          ['run:failed', 'run:cancelled', 'run:completed'].includes(event.type),
        ),
      ).toBe(false);
      expect(
        run.store.eventsFor(run.handle.runId).some((event) => event.type === 'human_gate:resumed'),
      ).toBe(false);
      expect(run.requests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      expect(run.host.armedCount()).toBe(0);
      expect(run.host.livenessCount()).toBe(0);
      expect(await run.host.runLeases.read(run.handle.runId)).toMatchObject(successor ?? {});
      if (successor !== undefined) await run.host.runLeases.release(run.handle.runId, successor);
    },
  );

  it.each([
    'missing_amount',
    'wrong_amount',
    'input_provided',
    'missing_preparer',
    'changed_basis',
  ] as const)(
    'cross-process %s refusal precedes execution registration and timers, releases ownership, and leaves rejection available',
    async (reason) => {
      const run = await parkedRun();
      const { host, store } = await hostFromLog(run.store.eventsFor(run.handle.runId));
      run.handle.cancel();
      await run.drained;
      const before = store.eventsFor(run.handle.runId).length;
      if (reason === 'changed_basis') run.price.inputPerMtokMicrocents += 1;
      const executor =
        reason === 'missing_preparer'
          ? { execute: run.executor.execute.bind(run.executor) }
          : run.executor;
      const engine = new WorkflowEngine({
        host,
        executor,
        resolvePrice: new Map([[MODEL, run.price]]),
      });
      const decision =
        reason === 'input_provided'
          ? { decision: 'input_provided' as const, decidedBy: 'offline', payload: 'PRIVATE' }
          : {
              decision: 'approved' as const,
              decidedBy: 'offline',
              ...(reason === 'missing_amount'
                ? {}
                : { approvedAmountMicrocents: run.amount + (reason === 'wrong_amount' ? 1 : 0) }),
            };
      await expect(
        engine.resumeFromCheckpoint({
          runId: run.handle.runId,
          workflow: run.workflow,
          gateId: run.authority.gateId,
          decision,
        }),
      ).rejects.toMatchObject({ code: 'invalid_decision' });
      expectUnknownRun(engine, run.handle.runId);
      expect(store.eventsFor(run.handle.runId)).toHaveLength(before);
      expect(host.armedCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
      expect(host.deadlineCount()).toBe(0);
      expect(await host.runLeases.read(run.handle.runId)).toBeUndefined();
      expect(run.keyReads()).toBe(0);
      expect(run.requests).toEqual([]);
      const rejected = await engine.resumeFromCheckpoint({
        runId: run.handle.runId,
        workflow: run.workflow,
        gateId: run.authority.gateId,
        decision: { decision: 'rejected', decidedBy: 'offline' },
      });
      const events: RunEvent[] = [];
      for await (const event of rejected.events) events.push(event);
      expect(events.at(-1)).toMatchObject({
        type: 'run:failed',
        error: { code: 'budget_exceeded' },
      });
      expect(host.armedCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
    },
  );

  it.each(['approved', 'rejected'] as const)(
    'a crash after actual %s authority preserves the decision without an invented output or restored credit',
    async (decision) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const run = await parkedRun({
        beforePersist: async (event) => {
          if (event.type === 'human_gate:resumed') {
            entered.resolve();
            await release.promise;
          }
        },
      });
      const resumed = run.engine.resume(run.handle.runId, run.authority.gateId, {
        decision,
        decidedBy: 'offline',
        ...(decision === 'approved' ? { approvedAmountMicrocents: run.amount } : {}),
      });
      await entered.promise;
      const { host, store } = await hostFromLog(run.store.eventsFor(run.handle.runId));
      expect(
        store.eventsFor(run.handle.runId).some((event) => event.type === 'human_gate:resumed'),
      ).toBe(false);
      const cp = await host.checkpointer.load(run.handle.runId);
      run.handle.cancel();
      release.resolve();
      await resumed;
      await run.drained;
      // Checkpoint absence is the canonical pending representation; it must never be completed.
      expect(cp?.nodeStates.get('agent')?.status ?? 'pending').toBe(
        decision === 'approved' ? 'pending' : 'failed',
      );
      expect(cp?.nodeStates.get('agent')?.output).toBeUndefined();
      const engine = new WorkflowEngine({
        host,
        executor: run.executor,
        resolvePrice: new Map([[MODEL, run.price]]),
      });
      const handle = await engine.resumeFromCheckpoint({
        runId: run.handle.runId,
        workflow: run.workflow,
        gateId: run.authority.gateId,
        // Already resolved API requests remain no-ops, even when the request contradicts the recorded winner.
        decision: {
          decision: decision === 'approved' ? 'rejected' : 'approved',
          decidedBy: 'duplicate',
        },
      });
      const events: RunEvent[] = [];
      const paused = deferred<void>();
      const drained = (async () => {
        for await (const event of handle.events) {
          events.push(event);
          if (event.type === 'run:paused') paused.resolve();
        }
      })();
      if (decision === 'approved') {
        await paused.promise;
        const fresh = events.find((event) => event.type === 'budget:authorization');
        expect(fresh).toMatchObject({
          authorization: { state: 'paused', allowance: { kind: 'frozen' } },
        });
        if (fresh?.type !== 'budget:authorization') throw new Error('missing fresh gate');
        expect(fresh.gateId).not.toBe(run.authority.gateId);
        expect(
          (await host.checkpointer.load(run.handle.runId))?.nodeStates.get('agent')?.output,
        ).toBeUndefined();
        await engine.resume(run.handle.runId, run.authority.gateId, {
          decision: 'approved',
          decidedBy: 'old-duplicate',
          approvedAmountMicrocents: run.amount,
        });
        expect(events.filter((event) => event.type === 'budget:authorization')).toHaveLength(1);
        handle.cancel();
      }
      await drained;
      expect(events.at(-1)).toMatchObject(
        decision === 'approved'
          ? { type: 'run:cancelled' }
          : { type: 'run:failed', error: { code: 'budget_exceeded' } },
      );
      expect(run.requests).toEqual([]);
      expect(run.keyReads()).toBe(0);
      expect(host.armedCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
    },
  );

  it('an unresolved tier-3 effect refuses native approval before authorization, timers or credential resolution', async () => {
    const run = await parkedRun();
    const { host, store } = await hostFromLog(run.store.eventsFor(run.handle.runId));
    run.handle.cancel();
    await run.drained;
    const journal = createInMemoryEffectJournalStore();
    await journal
      .for({ kind: 'run', runId: run.handle.runId, nodeId: 'agent', attempt: 1 })
      .prepare(0, 'http_request', 3, { url: 'https://example.test/effect' });
    const engine = new WorkflowEngine({
      host,
      executor: run.executor,
      resolvePrice: new Map([[MODEL, run.price]]),
      effectResume: journal.resume,
    });
    const handle = await engine.resumeFromCheckpoint({
      runId: run.handle.runId,
      workflow: run.workflow,
      gateId: run.authority.gateId,
      decision: {
        decision: 'approved',
        decidedBy: 'offline',
        approvedAmountMicrocents: run.amount,
      },
    });
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: 'run:failed',
      error: { code: 'effect_needs_attention' },
    });
    expect(
      store.eventsFor(run.handle.runId).filter((event) => event.type === 'budget:authorization'),
    ).toHaveLength(1);
    expect(
      events.some((event) => event.type === 'human_gate:resumed' || event.type === 'node:started'),
    ).toBe(false);
    expect(run.requests).toEqual([]);
    expect(run.keyReads()).toBe(0);
    expect(host.armedCount()).toBe(0);
    expect(host.livenessCount()).toBe(0);
    expect(host.deadlineCount()).toBe(0);
    expect(await host.runLeases.read(run.handle.runId)).toBeUndefined();
  });

  it('rechecks the whole current quote after asynchronous effect admission and does not register a stale request', async () => {
    const run = await parkedRun();
    const { host, store } = await hostFromLog(run.store.eventsFor(run.handle.runId));
    run.handle.cancel();
    await run.drained;
    const entered = deferred<void>();
    const release = deferred<void>();
    const before = store.eventsFor(run.handle.runId).length;
    const engine = new WorkflowEngine({
      host,
      executor: run.executor,
      resolvePrice: new Map([[MODEL, run.price]]),
      effectResume: {
        unresolvedForRun: async () => {
          entered.resolve();
          await release.promise;
          return [];
        },
      },
    });
    const resumed = engine.resumeFromCheckpoint({
      runId: run.handle.runId,
      workflow: run.workflow,
      gateId: run.authority.gateId,
      decision: {
        decision: 'approved',
        decidedBy: 'offline',
        approvedAmountMicrocents: run.amount,
      },
    });
    await entered.promise;
    expectUnknownRun(engine, run.handle.runId);
    await expect(
      engine.resumeFromCheckpoint({
        runId: run.handle.runId,
        workflow: run.workflow,
        gateId: run.authority.gateId,
        decision: { decision: 'rejected', decidedBy: 'concurrent' },
      }),
    ).rejects.toMatchObject({ code: 'run_already_active' });
    run.price.inputPerMtokMicrocents += 1;
    release.resolve();
    await expect(resumed).rejects.toMatchObject({ code: 'invalid_decision' });
    expect(store.eventsFor(run.handle.runId)).toHaveLength(before);
    expect(host.armedCount()).toBe(0);
    expect(host.livenessCount()).toBe(0);
    expect(host.deadlineCount()).toBe(0);
    expect(await host.runLeases.read(run.handle.runId)).toBeUndefined();
    expect(run.requests).toEqual([]);
    expect(run.keyReads()).toBe(0);
  });

  it('an unreadable effect journal refuses approval without exposing its private host error', async () => {
    const run = await parkedRun();
    const { host } = await hostFromLog(run.store.eventsFor(run.handle.runId));
    run.handle.cancel();
    await run.drained;
    const engine = new WorkflowEngine({
      host,
      executor: run.executor,
      resolvePrice: new Map([[MODEL, run.price]]),
      effectResume: {
        unresolvedForRun: () => Promise.reject(new Error('PRIVATE host storage path')),
      },
    });
    const handle = await engine.resumeFromCheckpoint({
      runId: run.handle.runId,
      workflow: run.workflow,
      gateId: run.authority.gateId,
      decision: {
        decision: 'approved',
        decidedBy: 'offline',
        approvedAmountMicrocents: run.amount,
      },
    });
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: 'run:failed',
      error: { code: 'effect_needs_attention' },
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
    expect(run.requests).toEqual([]);
    expect(run.keyReads()).toBe(0);
    expect(host.armedCount()).toBe(0);
    expect(host.livenessCount()).toBe(0);
  });
  it('records the pause before companions, refuses invalid decisions without consuming the gate, and durably rejects', async () => {
    const run = await parkedRun();
    const types = run.events.map((event) => event.type);
    expect(types.indexOf('budget:authorization')).toBeLessThan(types.indexOf('budget:paused'));
    expect(types.indexOf('budget:paused')).toBeLessThan(types.indexOf('human_gate:paused'));
    expect(run.keyReads()).toBe(0);
    expect(run.requests).toEqual([]);
    expect(reconstructCheckpointState(run.events)?.pendingGates).toMatchObject([
      { isBudgetGate: true, allowance: { kind: 'frozen' } },
    ]);
    for (const decision of [
      { decision: 'approved', decidedBy: 'offline' },
      { decision: 'approved', decidedBy: 'offline', approvedAmountMicrocents: run.amount + 1 },
      { decision: 'input_provided', decidedBy: 'offline', payload: 'PRIVATE' },
      { decision: 'rejected', decidedBy: 'offline', approvedAmountMicrocents: run.amount },
    ] as const)
      await expect(
        run.engine.resume(run.handle.runId, run.authority.gateId, decision),
      ).rejects.toMatchObject({ code: 'invalid_decision' });
    expect(run.events.filter((event) => event.type === 'budget:authorization')).toHaveLength(1);
    await run.engine.resume(run.handle.runId, run.authority.gateId, {
      decision: 'rejected',
      decidedBy: 'offline',
    });
    await run.drained;
    expect(run.events.at(-1)).toMatchObject({
      type: 'run:failed',
      error: { code: 'budget_exceeded' },
    });
    expect(run.keyReads()).toBe(0);
    expect(run.requests).toEqual([]);
    expect(run.events.filter((event) => event.type === 'budget:authorization')).toHaveLength(2);
    const companion = run.events.find((event) => event.type === 'human_gate:resumed');
    expect(companion).toMatchObject({ gateId: run.authority.gateId, decision: 'rejected' });
    expect(run.host.armedCount()).toBe(0);
  });
  it('acknowledges exact A and executes the real output with governance still installed', async () => {
    const run = await parkedRun();
    await run.engine.resume(run.handle.runId, run.authority.gateId, {
      decision: 'approved',
      decidedBy: 'offline',
      approvedAmountMicrocents: run.amount,
    });
    await run.drained;
    expect(run.events.at(-1)).toMatchObject({ type: 'run:completed', totalCostMicrocents: 2 });
    expect(run.events.find((event) => event.type === 'node:completed')).toMatchObject({
      nodeId: 'agent',
      output: 'ANSWER',
    });
    const authority = run.events.find(
      (event) => event.type === 'budget:authorization' && event.authorization.state === 'decided',
    );
    const companion = run.events.find((event) => event.type === 'human_gate:resumed');
    expect(authority?.sequenceNumber).toBeLessThan(companion?.sequenceNumber ?? -1);
    expect(run.keyReads()).toBe(1);
    expect(run.requests).toHaveLength(1);
    expect(reconstructCheckpointState(run.events)?.nodeStates.get('agent')).toMatchObject({
      status: 'completed',
      output: 'ANSWER',
    });
    expect(await run.host.runLeases.read(run.handle.runId)).toBeUndefined();
    expect(run.host.armedCount()).toBe(0);
  });
  it('refuses a changed price basis even when aggregate A stays exactly equal', async () => {
    const run = await parkedRun();
    const entry = run.quote.provenance.entries[0];
    if (entry === undefined) throw new Error('missing price witness');
    const input = entry.estimate.basis.inputTokensEstimate;
    run.price.inputPerMtokMicrocents = 0;
    run.price.outputPerMtokMicrocents = (input + 64) * 15625;
    await expect(
      run.engine.resume(run.handle.runId, run.authority.gateId, {
        decision: 'approved',
        decidedBy: 'offline',
        approvedAmountMicrocents: run.amount,
      }),
    ).rejects.toMatchObject({ code: 'invalid_decision' });
    expect(run.keyReads()).toBe(0);
    expect(run.requests).toEqual([]);
    await run.engine.resume(run.handle.runId, run.authority.gateId, {
      decision: 'rejected',
      decidedBy: 'offline',
    });
    await run.drained;
    expect(run.events.at(-1)).toMatchObject({
      type: 'run:failed',
      error: { code: 'budget_exceeded' },
    });
  });
});

describe('terminal paid-media money barrier — ADR-0077/0097', () => {
  it.each(['acknowledged', 'write_failure', 'takeover'] as const)(
    'waits for the terminal sweep commitment and cleans up on %s',
    async (outcome) => {
      const { run, prefix } = await fundedMediaPrefix();
      let now = 1000;
      const leases = createInMemoryRunLeases(() => now);
      const store = new InMemoryRunStore();
      for (const event of prefix) await store.persistEvent(event);
      const base = createInMemoryHost({ store, runLeases: leases });
      const entered = deferred<void>();
      const release = deferred<void>();
      const host = {
        ...base,
        store: {
          resolveWorkflowId: (slug: string) => store.resolveWorkflowId(slug),
          readWorkflowSnapshot: (runId: string) => store.readWorkflowSnapshot(runId),
          listInterruptedRuns: () => store.listInterruptedRuns(),
          persistEvent: async (...args: Parameters<typeof store.persistEvent>) => {
            if (args[0].type === 'budget:estimate_committed') {
              entered.resolve();
              await release.promise;
              if (outcome === 'write_failure') throw new Error('PRIVATE commitment storage path');
            }
            await store.persistEvent(...args);
          },
        },
      };
      const engine = new WorkflowEngine({
        host,
        executor: run.executor,
        resolvePrice: new Map([[MODEL, { ...run.price, mediaOutputRates: {} }]]),
        effectResume: {
          unresolvedForRun: () => Promise.reject(new Error('PRIVATE effect storage path')),
        },
      });
      let finished = false;
      const resumed = engine
        .resumeFromCheckpoint({ runId: run.handle.runId, workflow: run.workflow })
        .then((handle) => {
          finished = true;
          return handle;
        });
      let successor: Awaited<ReturnType<typeof leases.acquire>>;
      try {
        await entered.promise;
        for (let i = 0; i < 100; i += 1) await Promise.resolve();
        expect(finished).toBe(false);
        expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
        expect(store.eventsFor(run.handle.runId).some((event) => event.type === 'run:failed')).toBe(
          false,
        );
        if (outcome === 'takeover') {
          now += 80_000;
          successor = await leases.acquire(run.handle.runId, 'successor', 60_000);
          expect(successor).toBeDefined();
        }
      } finally {
        release.resolve();
      }
      const handle = await resumed;
      const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(run.keyReads()).toBe(1);
      expect(run.polls()).toBe(0);
      expect(run.mediaRequests).toHaveLength(1);
      expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
      expect(JSON.stringify(events)).not.toContain('PRIVATE');
      if (outcome === 'takeover') {
        expect(store.eventsFor(run.handle.runId)).toEqual(prefix);
        expect(events.some((event) => event.type === 'run:failed')).toBe(false);
        expect(handle.durability()).toBe('uncertain');
        expect(await leases.read(run.handle.runId)).toMatchObject({ ownerId: 'successor' });
        if (successor !== undefined) await leases.release(run.handle.runId, successor);
      } else {
        expect(events.at(-1)).toMatchObject({
          type: 'run:failed',
          error: { code: 'effect_needs_attention' },
          cumulativeCostMicrocents: 0,
        });
        const commitments = store
          .eventsFor(run.handle.runId)
          .filter((event) => event.type === 'budget:estimate_committed');
        expect(commitments).toHaveLength(outcome === 'acknowledged' ? 1 : 0);
        if (outcome === 'acknowledged') {
          expect(commitments[0]).toMatchObject({ estimateMicrocents: 2000 });
          expect(commitments[0]?.sequenceNumber).toBeLessThan(
            store.eventsFor(run.handle.runId).at(-1)?.sequenceNumber ?? 0,
          );
        }
      }
      expect(await leases.read(run.handle.runId)).toBeUndefined();
    },
  );

  it('reentrant pricing cancellation joins the newly queued native conservative commitment', async () => {
    const parked = deferred<void>();
    let pauses = 0;
    const run = await parkedRun({
      mediaJob: true,
      onEvent: (event) => {
        if (event.type === 'run:paused' && ++pauses === 2) parked.resolve();
      },
    });
    await run.engine.resume(run.handle.runId, run.authority.gateId, {
      decision: 'approved',
      decidedBy: 'offline',
      approvedAmountMicrocents: run.amount,
    });
    await parked.promise;
    let reentered = false;
    Object.defineProperty(run.price, 'mediaOutputRates', {
      configurable: true,
      get: () => {
        if (!reentered) {
          reentered = true;
          run.handle.cancel();
        }
        return undefined;
      },
    });
    run.host.fireTimers();
    await run.drained;
    expect(reentered).toBe(true);
    expect(run.events.at(-1)).toMatchObject({ type: 'run:cancelled', cumulativeCostMicrocents: 0 });
    const stored = run.store.eventsFor(run.handle.runId);
    const commitments = stored.filter((event) => event.type === 'budget:estimate_committed');
    expect(commitments).toHaveLength(1);
    expect(commitments[0]).toMatchObject({ estimateMicrocents: 2000 });
    expect(commitments[0]?.sequenceNumber).toBeLessThan(stored.at(-1)?.sequenceNumber ?? 0);
    expect(run.keyReads()).toBe(2);
    expect(run.polls()).toBe(1);
    expect(run.mediaRequests).toHaveLength(1);
    expect(run.host.armedCount() + run.host.deadlineCount() + run.host.livenessCount()).toBe(0);
    expect(await run.host.runLeases.read(run.handle.runId)).toBeUndefined();
  });

  it.each(['known', 'unpriced', 'throws', 'unsafe'] as const)(
    'retains safe accepted cost before the refused resume terminal (%s)',
    async (mode) => {
      const { run, prefix } = await fundedMediaPrefix();
      const { host, store } = await hostFromLog(prefix);
      class ThrowingPrice extends Map<string, ModelPricing> {
        override get(model: string): ModelPricing | undefined {
          if (model === MODEL) throw new Error('PRIVATE price source');
          return super.get(model);
        }
      }
      const resolvePrice: PricingOverlay =
        mode === 'throws'
          ? new ThrowingPrice([[MODEL, run.price]])
          : new Map([
              [
                MODEL,
                mode === 'unpriced'
                  ? { ...run.price, mediaOutputRates: {} }
                  : mode === 'unsafe'
                    ? { ...run.price, mediaOutputRates: { image: Number.MAX_SAFE_INTEGER } }
                    : run.price,
              ],
            ]);
      const engine = new WorkflowEngine({
        host,
        executor: run.executor,
        resolvePrice,
        effectResume: { unresolvedForRun: () => Promise.reject(new Error('PRIVATE effect port')) },
      });
      const handle = await engine.resumeFromCheckpoint({
        runId: run.handle.runId,
        workflow: run.workflow,
      });
      const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      const stored = store.eventsFor(run.handle.runId);
      const commitments = stored.filter((event) => event.type === 'budget:estimate_committed');
      const terminal = stored.at(-1);
      expect(events.at(-1)).toMatchObject({
        type: 'run:failed',
        error: { code: 'effect_needs_attention' },
      });
      expect(JSON.stringify(events)).not.toContain('PRIVATE');
      expect(run.keyReads()).toBe(1);
      expect(run.polls()).toBe(0);
      expect(run.mediaRequests).toHaveLength(1);
      expect(host.armedCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
      expect(host.deadlineCount()).toBe(0);
      expect(await host.runLeases.read(run.handle.runId)).toBeUndefined();
      expect(terminal).toMatchObject({
        type: 'run:failed',
        error: { code: 'effect_needs_attention' },
        cumulativeCostMicrocents: mode === 'known' ? 2000 : 0,
      });
      if (mode === 'known') expect(commitments).toHaveLength(0);
      else {
        expect(commitments).toHaveLength(1);
        expect(commitments[0]).toMatchObject({
          estimateMicrocents: 2000,
          cumulativeConservativeMicrocents: 2000,
        });
        expect(commitments[0]?.sequenceNumber).toBeLessThan(terminal?.sequenceNumber ?? 0);
        expect(reconstructCheckpointState(stored)?.conservativeCostMicrocents).toBe(2000);
      }
    },
  );
});

describe('resume refusal retains its primary outcome on lease cleanup faults', () => {
  for (const branch of [
    'unknown',
    'schema',
    'workflow',
    'terminal',
    'content',
    'identity',
  ] as const) {
    for (const releaseFault of [false, true, 'takeover'] as const) {
      it(`native ${branch} guard preserves its outcome (releaseFault=${releaseFault})`, async () => {
        const run = await parkedRun();
        const { host, store } = await hostFromLog(run.store.eventsFor(run.handle.runId));
        run.handle.cancel();
        await run.drained;
        const before = [...store.eventsFor(run.handle.runId)];
        let releases = 0;
        const engine = new WorkflowEngine({
          host: {
            ...host,
            checkpointer: {
              ...host.checkpointer,
              load: async (runId) => {
                const state = await host.checkpointer.load(runId);
                if (branch === 'unknown') return undefined;
                if (state === undefined) throw new Error('missing native checkpoint');
                if (branch === 'schema') {
                  const unsupported = { ...state };
                  Object.defineProperty(unsupported, 'schemaVersion', { value: 1 });
                  return unsupported;
                }
                return branch === 'terminal'
                  ? { ...state, runStatus: 'completed' as const }
                  : state;
              },
            },
            store: {
              ...host.store,
              resolveWorkflowId: (slug) =>
                branch === 'workflow'
                  ? Promise.resolve('another-workflow')
                  : host.store.resolveWorkflowId(slug),
              readWorkflowSnapshot: () => Promise.resolve(JSON.stringify(run.workflow)),
            },
            runLeases: {
              ...host.runLeases,
              release: async (runId, fence) => {
                releases++;
                if (releaseFault === 'takeover') {
                  await host.runLeases.release(runId, fence);
                  await host.runLeases.acquire(runId, 'successor-owner', 30000);
                  throw new Error('PRIVATE cleanup storage path');
                }
                if (releaseFault) throw new Error('PRIVATE cleanup storage path');
                await host.runLeases.release(runId, fence);
              },
            },
          },
          executor: run.executor,
          resolvePrice: new Map([[MODEL, run.price]]),
        });
        const workflow =
          branch === 'content'
            ? {
                ...run.workflow,
                workflow: { ...run.workflow.workflow, name: 'different frozen name' },
              }
            : run.workflow;
        try {
          const call = engine.resumeFromCheckpoint({
            runId: run.handle.runId,
            workflow,
            ...(branch === 'identity' ? { inputs: { unexpected: 'another value' } } : {}),
          });
          if (branch === 'terminal') {
            const handle = await call;
            const events: RunEvent[] = [];
            for await (const event of handle.events) events.push(event);
            expect(events).toEqual([]);
            expect(handle.durability()).toBe('durable');
          } else {
            let refusal: unknown;
            try {
              await call;
            } catch (error) {
              refusal = error;
            }
            const expected = {
              unknown: 'unknown_run',
              schema: 'admission_record_unreadable',
              workflow: 'workflow_mismatch',
              content: 'workflow_content_mismatch',
              identity: 'input_mismatch',
            };
            expect(refusal).toMatchObject({ code: expected[branch] });
            expect(refusal instanceof Error && refusal.message).not.toContain('PRIVATE');
          }
          expect(releases).toBe(1);
          expectUnknownRun(engine, run.handle.runId);
          expect(store.eventsFor(run.handle.runId)).toEqual(before);
          expect(run.keyReads()).toBe(0);
          expect(run.requests).toEqual([]);
          expect(run.mediaRequests).toEqual([]);
          expect(run.toolCalls()).toBe(0);
          expect(host.armedCount()).toBe(0);
          expect(host.livenessCount()).toBe(0);
          expect(host.deadlineCount()).toBe(0);
          const held = await host.runLeases.read(run.handle.runId);
          if (releaseFault) expect(held).toBeDefined();
          else expect(held).toBeUndefined();
          if (releaseFault === 'takeover') expect(held?.ownerId).toBe('successor-owner');
        } finally {
          const held = await host.runLeases.read(run.handle.runId);
          if (held !== undefined) await host.runLeases.release(run.handle.runId, held);
        }
      });
    }
  }
});
