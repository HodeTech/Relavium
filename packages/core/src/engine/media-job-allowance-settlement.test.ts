import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { prepareOutputCapPlan, type LlmProvider, type ModelPricing } from '@relavium/llm';
import type { MediaStore, RunEvent } from '@relavium/shared';
import { createAgentNodeExecutor } from './agent-runner.js';
import { BudgetGovernor, type GovernorEventDraft } from './budget-governor.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import { WorkflowEngine } from './engine.js';
import { parseWorkflow } from '../parser.js';

const MODEL = 'w7-parked-settlement';
const SIBLING_MODEL = 'w7-parked-sibling';
const changes = [
  'known',
  'zero',
  'underspend',
  'overrun',
  'missing-model',
  'missing-rate',
  'negative-rate',
  'nan-rate',
  'infinite-rate',
  'throwing',
  'unsafe',
] as const;
type PriceChange = (typeof changes)[number];
type Terminal = 'done' | 'failed' | 'cancel' | 'deadline';

function price(patch: Partial<ModelPricing> = {}): ModelPricing {
  return {
    provider: 'openai',
    nativeId: MODEL,
    displayName: MODEL,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 64,
    inputPerMtokMicrocents: 0,
    outputPerMtokMicrocents: 1_000_000,
    cachedInputPerMtokMicrocents: 0,
    mediaOutputRates: { image: 7 },
    ...patch,
  };
}
function mediaStore(): MediaStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    put: (bytes) => {
      const key = 'media://sha256-' + createHash('sha256').update(bytes).digest('hex');
      blobs.set(key, bytes);
      return Promise.resolve(key);
    },
    get: (key) => {
      const bytes = blobs.get(key);
      return bytes === undefined
        ? Promise.reject(new Error('missing synthetic media'))
        : Promise.resolve(bytes);
    },
    readRange: () => Promise.reject(new Error('unexpected range read')),
    resolveForEgress: () => Promise.reject(new Error('unexpected media egress')),
  };
}

async function runParked(
  terminal: Terminal,
  change: PriceChange,
  options: { reenter?: boolean; sinkFault?: boolean; sibling?: boolean } = {},
) {
  let parked = false;
  let submissions = 0;
  let polls = 0;
  let accountingCallbackFired = false;
  let cancelFromPricing: (() => void) | undefined;
  let faultNextClockRead = false;
  const prices = new Map([[MODEL, price()]]);
  if (options.sibling) prices.set(SIBLING_MODEL, price({ nativeId: SIBLING_MODEL }));
  class Overlay extends Map<string, ModelPricing> {
    override get(model: string): ModelPricing | undefined {
      if (parked && !accountingCallbackFired) {
        accountingCallbackFired = true;
        if (options.reenter) cancelFromPricing?.();
        if (options.sinkFault) faultNextClockRead = true;
      }
      if (parked && model === MODEL && change === 'throwing') {
        throw new Error('PRIVATE-SYNTHETIC-PRICING-FAULT');
      }
      return prices.get(model);
    }
  }
  const overlay = new Overlay();
  const durable: GovernorEventDraft[] = [];
  const governor = new BudgetGovernor({
    budget: { max_cost_microcents: 2, on_exceed: 'pause_for_approval' },
    resolvePrice: overlay,
    emit: (event) => {
      durable.push(event);
      return Promise.resolve();
    },
  });
  // Step 9 tests transfer an actually held admission into the real engine consumer.
  // Durable engine activation of this token is Step 10's separate acceptance boundary.
  const token = governor.activateDispatchAllowance({
    nodeId: 'render',
    dispatchId: 1,
    amountMicrocents: 63,
    isLive: () => true,
  });
  const siblingToken = options.sibling
    ? governor.activateDispatchAllowance({
        nodeId: 'other',
        dispatchId: 1,
        amountMicrocents: 63,
        isLive: () => true,
      })
    : undefined;
  const provider: LlmProvider = {
    id: 'openai',
    customEndpoint: true,
    supports: {
      streaming: true,
      tools: true,
      parallelToolCalls: true,
      vision: false,
      reasoning: false,
      promptCache: false,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [['image']],
      },
    },
    generate: () => Promise.reject(new Error('unexpected text generation')),
    stream: () => {
      throw new Error('unexpected text stream');
    },
    generateMedia: () => {
      submissions += 1;
      return Promise.resolve({ jobId: 'synthetic-job', raw: {} });
    },
    pollMediaJob: () => {
      polls += 1;
      return Promise.resolve(
        terminal === 'failed'
          ? {
              state: 'failed' as const,
              error: {
                kind: 'bad_request' as const,
                provider: 'openai' as const,
                retryable: false,
                message: 'synthetic job failed',
              },
            }
          : {
              state: 'done' as const,
              media: {
                type: 'media' as const,
                mimeType: 'image/png',
                source: { kind: 'base64' as const, data: 'eA==' },
              },
            },
      );
    },
  };
  const runner = createAgentNodeExecutor({
    resolveProvider: () => provider,
    resolvePrice: overlay,
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => Promise.reject(new Error('unexpected tool dispatch')),
    },
    tools: [],
    keyFor: () => 'offline-synthetic-key',
    sleep: () => Promise.resolve(),
    now: () => 0,
    resolveMediaSurface: () => 'generative',
    preEgress: (info) =>
      governor.checkPreEgress(info, info.model === SIBLING_MODEL ? siblingToken : token),
  });
  const durableStore = new InMemoryRunStore();
  const baseHost = createInMemoryHost({ mediaStore: mediaStore(), store: durableStore });
  let pastDeadline = false;
  const host = {
    ...baseHost,
    clock: {
      now: () => {
        if (faultNextClockRead) {
          faultNextClockRead = false;
          throw new Error('PRIVATE-SYNTHETIC-DELIVERY-FAULT');
        }
        return pastDeadline ? '2026-01-01T01:00:00.000Z' : baseHost.clock.now();
      },
    },
  };
  const engine = new WorkflowEngine({ host, executor: runner, resolvePrice: overlay });
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'w7-parked-settlement',
        agents: [
          { id: 'image-agent', provider: 'openai', model: MODEL, system_prompt: 'offline' },
          ...(options.sibling
            ? [
                {
                  id: 'sibling-agent',
                  provider: 'openai',
                  model: SIBLING_MODEL,
                  system_prompt: 'offline',
                },
              ]
            : []),
        ],
        nodes: [
          {
            id: 'render',
            type: 'agent',
            agent_ref: 'image-agent',
            prompt_template: 'offline',
            output_modalities: ['image'],
            count: 3,
          },
          ...(options.sibling
            ? [
                {
                  id: 'other',
                  type: 'agent',
                  agent_ref: 'sibling-agent',
                  prompt_template: 'offline',
                  output_modalities: ['image'],
                  count: 3,
                },
              ]
            : []),
        ],
        edges: [],
      },
    }),
  );
  const handle = engine.start({ workflow });
  const iterator = handle.events[Symbol.asyncIterator]();
  const events: RunEvent[] = [];
  const rejected: unknown[] = [];
  const onRejected = (error: unknown): void => {
    rejected.push(error);
  };
  process.on('unhandledRejection', onRejected);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = async (): Promise<void> => {
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      const event = next.value;
      events.push(event);
      if (event.type === 'run:paused') {
        parked = true;
        cancelFromPricing = () => handle.cancel();
        if (change === 'missing-model') prices.delete(MODEL);
        if (change === 'missing-rate') prices.set(MODEL, price({ mediaOutputRates: {} }));
        const rate =
          change === 'zero'
            ? 0
            : change === 'underspend'
              ? 2
              : change === 'overrun'
                ? 30
                : change === 'negative-rate'
                  ? -1
                  : change === 'nan-rate'
                    ? Number.NaN
                    : change === 'infinite-rate'
                      ? Number.POSITIVE_INFINITY
                      : change === 'unsafe'
                        ? Number.MAX_SAFE_INTEGER
                        : undefined;
        if (rate !== undefined) prices.set(MODEL, price({ mediaOutputRates: { image: rate } }));
        if (terminal === 'cancel') handle.cancel();
        else {
          pastDeadline = terminal === 'deadline';
          host.fireTimers();
        }
      }
    }
  };
  try {
    const draining = drain();
    await Promise.race([
      draining,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, 500);
      }),
    ]);
    if (timedOut) {
      await iterator.return?.();
      await draining;
    }
    await governor.flushCommitments();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    process.off('unhandledRejection', onRejected);
  }
  return {
    persisted: durableStore.eventsFor(handle.runId),
    governor,
    token,
    siblingToken,
    durable,
    events,
    host,
    handle,
    timedOut,
    rejected,
    submissions,
    polls,
    restorePrice: () => {
      parked = false;
      prices.set(MODEL, price());
    },
  };
}

for (const change of ['missing-rate', 'throwing', 'unsafe'] as const) {
  it(`cancellation ${change} still accounts for the other paid parked job`, async () => {
    const test = await runParked('cancel', change, { sibling: true });
    expect(test.timedOut).toBe(false);
    expect(test.rejected).toEqual([]);
    expect(test.submissions).toBe(2);
    expect(test.polls).toBe(0);
    expect(test.events.at(-1)).toMatchObject({
      type: 'run:cancelled',
      cumulativeCostMicrocents: 21,
    });
    expect(test.governor.dispatchAllowanceState(test.token)).toMatchObject({
      remaining: 42,
      inFlight: false,
    });
    expect(test.siblingToken).toBeDefined();
    if (test.siblingToken === undefined) throw new Error('missing sibling allowance');
    expect(test.governor.dispatchAllowanceState(test.siblingToken)).toMatchObject({
      remaining: 42,
      inFlight: false,
    });
    expect(test.governor.conservativeCostMicrocents).toBe(21);
    expect(test.durable).toMatchObject([
      { type: 'budget:estimate_committed', nodeId: 'render', estimateMicrocents: 21 },
    ]);
    expect(test.durable).toHaveLength(1);
    expect(
      test.events.filter((event) => event.type === 'cost:updated' && event.nodeId === 'other'),
    ).toMatchObject([{ costMicrocents: 21 }]);
    await expect
      .poll(() => test.host.armedCount() + test.host.deadlineCount() + test.host.livenessCount())
      .toBe(0);
    expect(await test.host.runLeases.read(test.handle.runId)).toBeUndefined();
  });
}

for (const terminal of ['done', 'cancel'] as const) {
  it(`pricing reentry during ${terminal} cannot settle a transferred admission twice`, async () => {
    const test = await runParked(terminal, 'known', { reenter: true });
    expect(test.timedOut).toBe(false);
    expect(test.rejected).toEqual([]);
    expect(test.events.at(-1)).toMatchObject({
      type: 'run:cancelled',
      cumulativeCostMicrocents: 21,
    });
    expect(test.persisted.at(-1)).toMatchObject({
      type: 'run:cancelled',
      cumulativeCostMicrocents: 21,
    });
    expect(test.governor.dispatchAllowanceState(test.token)).toMatchObject({
      remaining: 42,
      inFlight: false,
    });
    expect(test.governor.conservativeCostMicrocents).toBe(0);
    expect(test.durable).toEqual([]);
    expect(test.events.filter((event) => event.type === 'cost:updated')).toMatchObject([
      { costMicrocents: 21 },
    ]);
    expect(test.events.filter((event) => event.type === 'cost:updated')).toHaveLength(1);
    await expect
      .poll(() => test.host.armedCount() + test.host.deadlineCount() + test.host.livenessCount())
      .toBe(0);
    expect(await test.host.runLeases.read(test.handle.runId)).toBeUndefined();
  });

  it(`delivery fault after known actual during ${terminal} preserves actual and closes the run`, async () => {
    const test = await runParked(terminal, 'known', { sinkFault: true });
    expect(test.timedOut).toBe(false);
    expect(test.rejected).toEqual([]);
    expect(test.events.at(-1)?.type).toBe(terminal === 'cancel' ? 'run:cancelled' : 'run:failed');
    expect(test.governor.dispatchAllowanceState(test.token)).toMatchObject({
      remaining: 42,
      inFlight: false,
    });
    expect(test.governor.conservativeCostMicrocents).toBe(0);
    expect(test.durable).toEqual([]);
    expect(test.events.filter((event) => event.type === 'cost:updated')).toEqual([]);
    await expect
      .poll(() => test.host.armedCount() + test.host.deadlineCount() + test.host.livenessCount())
      .toBe(0);
    expect(await test.host.runLeases.read(test.handle.runId)).toBeUndefined();
    expect(JSON.stringify(test.events)).not.toContain('PRIVATE-SYNTHETIC-DELIVERY-FAULT');
  });
}

for (const terminal of ['done', 'failed', 'cancel', 'deadline'] as const) {
  for (const change of changes) {
    it(`parked ${terminal}/${change} reconciles one admission and closes the run`, async () => {
      const test = await runParked(terminal, change);
      const fault = change === 'throwing' || change === 'unsafe';
      const uncertain =
        fault ||
        change === 'missing-model' ||
        change === 'missing-rate' ||
        change === 'negative-rate' ||
        change === 'nan-rate' ||
        change === 'infinite-rate';
      const actual =
        change === 'zero' ? 0 : change === 'underspend' ? 6 : change === 'overrun' ? 90 : 21;
      expect(test.timedOut).toBe(false);
      expect(test.rejected).toEqual([]);
      expect(test.submissions).toBe(1);
      expect(test.polls).toBe(terminal === 'cancel' || terminal === 'deadline' ? 0 : 1);
      expect(
        test.events.filter(
          (event) =>
            event.type.startsWith('run:') &&
            ['run:completed', 'run:failed', 'run:cancelled'].includes(event.type),
        ),
      ).toHaveLength(1);
      expect(test.events.at(-1)?.type).toBe(
        terminal === 'cancel'
          ? 'run:cancelled'
          : terminal === 'done' && !fault
            ? 'run:completed'
            : 'run:failed',
      );
      expect(test.events.find((event) => event.type === 'media_job:submitted')).toMatchObject({
        units: 3,
        acceptedCostMicrocents: 21,
      });
      expect(test.governor.dispatchAllowanceState(test.token)).toMatchObject({
        remaining: uncertain ? 42 : Math.max(0, 63 - actual),
        inFlight: false,
        exhausted: !uncertain && actual >= 63,
      });
      expect(test.governor.conservativeCostMicrocents).toBe(uncertain ? 21 : 0);
      if (uncertain) {
        expect(test.durable).toMatchObject([
          {
            type: 'budget:estimate_committed',
            nodeId: 'render',
            estimateMicrocents: 21,
          },
        ]);
        expect(test.durable).toHaveLength(1);
      } else expect(test.durable).toEqual([]);
      const costs = test.events.filter((event) => event.type === 'cost:updated');
      if (fault) expect(costs).toEqual([]);
      else
        expect(costs).toMatchObject([
          { costMicrocents: uncertain ? 0 : actual, ...(uncertain ? { priced: false } : {}) },
        ]);
      expect(costs).toHaveLength(fault ? 0 : 1);
      expect(test.host.armedCount()).toBe(0);
      expect(test.host.deadlineCount()).toBe(0);
      await expect.poll(() => test.host.livenessCount()).toBe(0);
      expect(await test.host.runLeases.read(test.handle.runId)).toBeUndefined();
      expect(test.handle.durability()).toBe('durable');
      expect(JSON.stringify(test.events)).not.toContain('PRIVATE-SYNTHETIC-PRICING-FAULT');
      test.restorePrice();
      const plan = prepareOutputCapPlan({
        model: MODEL,
        provider: 'openai',
        endpoint: 'custom',
        maxTokens: 0,
        providerOptions: undefined,
      });
      if (change !== 'zero')
        expect(
          test.governor.evaluatePreEgress({
            ...plan,
            route: 'text',
            outputCapPlan: plan,
            inputTokensEstimate: 0,
            maxTokensEstimate: undefined,
          }),
        ).toMatchObject({ kind: 'pause' });
    });
  }
}
