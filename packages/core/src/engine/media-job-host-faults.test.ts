import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { prepareOutputCapPlan, type LlmProvider, type ModelPricing } from '@relavium/llm';
import type { MediaStore, RunEvent } from '@relavium/shared';
import { createAgentNodeExecutor } from './agent-runner.js';
import { BudgetGovernor, type GovernorEventDraft } from './budget-governor.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import { WorkflowEngine } from './engine.js';
import { parseWorkflow } from '../parser.js';

const MODEL = 'financial-review-synthetic-media';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 100_000,
  maxOutputTokens: 100,
  inputPerMtokMicrocents: 0,
  outputPerMtokMicrocents: 1_000_000,
  cachedInputPerMtokMicrocents: 0,
  mediaOutputRates: { image: 9 },
};
const store: MediaStore = {
  put: (bytes) =>
    Promise.resolve('media://sha256-' + createHash('sha256').update(bytes).digest('hex')),
  get: () => Promise.resolve(new Uint8Array([1])),
  readRange: () => Promise.reject(new Error('unexpected range')),
  resolveForEgress: () => Promise.reject(new Error('unexpected network')),
};
type Fault =
  | 'none'
  | 'poll-clock'
  | 'poll-timer'
  | 'park-clock'
  | 'park-invalid-clock'
  | 'park-timer'
  | 'park-timer-cancel'
  | 'park-cancel'
  | 'handoff-cancel';
async function lifecycle(fault: Fault) {
  const commits: GovernorEventDraft[] = [];
  const governor = new BudgetGovernor({
    budget: { max_cost_microcents: 1, on_exceed: 'pause_for_approval' },
    resolvePrice: new Map([[MODEL, price]]),
    emit: (event) => {
      commits.push(event);
      return Promise.resolve();
    },
  });
  // Test the real transferred-admission consumer; durable engine activation remains Step 10.
  const token = governor.activateDispatchAllowance({
    nodeId: 'render',
    dispatchId: 1,
    amountMicrocents: 54,
    isLive: () => true,
  });
  let submitted = 0;
  let polled = 0;
  let clockFault = false;
  let timerFault = false;
  let initialParkRead = false;
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
    generate: () => Promise.reject(new Error('unexpected text')),
    stream: () => {
      throw new Error('unexpected stream');
    },
    generateMedia: () => {
      submitted += 1;
      initialParkRead =
        fault === 'park-clock' || fault === 'park-invalid-clock' || fault === 'park-cancel';
      timerFault = fault === 'park-timer' || fault === 'park-timer-cancel';
      return Promise.resolve({ jobId: 'synthetic-paid-job', raw: {} });
    },
    pollMediaJob: () => {
      polled += 1;
      return Promise.resolve({
        state: 'done',
        media: { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'AQ==' } },
      });
    },
  };
  const runner = createAgentNodeExecutor({
    resolveProvider: () => provider,
    resolvePrice: new Map([[MODEL, price]]),
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => Promise.reject(new Error('unexpected tool')),
    },
    tools: [],
    keyFor: () => 'synthetic-offline',
    now: () => 0,
    sleep: () => Promise.resolve(),
    resolveMediaSurface: () => 'generative',
    preEgress: (info) => governor.checkPreEgress(info, token),
  });
  const durableStore = new InMemoryRunStore();
  const base = createInMemoryHost({ mediaStore: store, store: durableStore });
  const host = {
    ...base,
    clock: {
      now: () => {
        if (initialParkRead && fault === 'park-cancel') {
          initialParkRead = false;
          cancelHandoff?.();
          return base.clock.now();
        }
        if (initialParkRead && fault === 'park-invalid-clock') {
          initialParkRead = false;
          return 'invalid-date';
        }
        if (clockFault || initialParkRead) {
          clockFault = false;
          initialParkRead = false;
          throw new Error('PRIVATE-CLOCK-FAULT');
        }
        return base.clock.now();
      },
    },
    setTimer: (...args: Parameters<typeof base.setTimer>) => {
      if (timerFault) {
        timerFault = false;
        if (fault === 'park-timer-cancel') cancelHandoff?.();
        else throw new Error('PRIVATE-TIMER-FAULT');
      }
      return base.setTimer(...args);
    },
  };
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'financial-review',
        agents: [{ id: 'image-agent', provider: 'openai', model: MODEL, system_prompt: 'offline' }],
        nodes: [
          {
            id: 'render',
            type: 'agent',
            agent_ref: 'image-agent',
            prompt_template: 'synthetic',
            output_modalities: ['image'],
            count: 2,
          },
        ],
        edges: [],
      },
    }),
  );
  const cancelHandoff = (): void => handle.cancel();
  const executor = {
    ...runner,
    execute: async (ctx: Parameters<typeof runner.execute>[0]) => {
      const outcome = await runner.execute(ctx);
      if (outcome.kind === 'media_job' && fault === 'handoff-cancel') cancelHandoff?.();
      return outcome;
    },
  };
  const engine = new WorkflowEngine({ host, executor, resolvePrice: new Map([[MODEL, price]]) });
  const handle = engine.start({ workflow });
  const events: RunEvent[] = [];
  const iterator = handle.events[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const drain = async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      events.push(next.value);
      if (next.value.type === 'run:paused') {
        clockFault = fault === 'poll-clock';
        timerFault = fault === 'poll-timer';
        base.fireTimers();
      }
    }
  };
  const draining = drain();
  try {
    await Promise.race([
      draining,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, 800);
      }),
    ]);
    if (timedOut) {
      handle.cancel();
      await iterator.return?.();
      await draining;
    }
    await governor.flushCommitments();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const cap = prepareOutputCapPlan({
    model: MODEL,
    provider: 'openai',
    endpoint: 'custom',
    maxTokens: 0,
    providerOptions: undefined,
  });
  return {
    persisted: durableStore.eventsFor(handle.runId),
    events,
    submitted,
    polled,
    timedOut,
    commits,
    state: governor.dispatchAllowanceState(token),
    conservative: governor.conservativeCostMicrocents,
    global: governor.evaluatePreEgress({
      ...cap,
      route: 'text',
      outputCapPlan: cap,
      inputTokensEstimate: 0,
      maxTokensEstimate: undefined,
    }),
    timers: base.armedCount() + base.deadlineCount() + base.livenessCount(),
    lease: await base.runLeases.read(handle.runId),
  };
}
for (const fault of [
  'none',
  'poll-clock',
  'poll-timer',
  'park-clock',
  'park-invalid-clock',
  'park-timer',
  'park-timer-cancel',
  'park-cancel',
  'handoff-cancel',
] as const) {
  it(`paid admission closes on ${fault}`, async () => {
    const result = await lifecycle(fault);
    expect(result.timedOut).toBe(false);
    expect(result.submitted).toBe(1);
    expect(result.state).toMatchObject({ remaining: 36, inFlight: false });
    expect(result.events.at(-1)?.type).toBe(
      fault === 'none'
        ? 'run:completed'
        : fault === 'handoff-cancel' || fault === 'park-cancel' || fault === 'park-timer-cancel'
          ? 'run:cancelled'
          : 'run:failed',
    );
    expect(result.timers).toBe(0);
    expect(result.lease).toBeUndefined();
    expect(result.global).toMatchObject({ kind: 'pause' });
    expect(JSON.stringify(result.events)).not.toContain('PRIVATE-');
    const actual = result.events
      .filter((event) => event.type === 'cost:updated')
      .reduce((sum, event) => sum + event.costMicrocents, 0);
    expect(actual + result.conservative).toBe(18);
    const uncertain =
      fault === 'poll-clock' ||
      fault === 'poll-timer' ||
      fault === 'park-clock' ||
      fault === 'park-invalid-clock' ||
      fault === 'park-cancel';
    expect(result.conservative).toBe(uncertain ? 18 : 0);
    expect(actual).toBe(uncertain ? 0 : 18);
    if (uncertain) {
      expect(result.commits).toMatchObject([
        { type: 'budget:estimate_committed', nodeId: 'render', estimateMicrocents: 18 },
      ]);
      expect(result.commits).toHaveLength(1);
    } else expect(result.commits).toEqual([]);
    const descriptor = result.events.find((event) => event.type === 'media_job:submitted');
    if (fault === 'park-clock' || fault === 'park-invalid-clock' || fault === 'park-cancel')
      expect(descriptor).toBeUndefined();
    else expect(descriptor).toMatchObject({ acceptedCostMicrocents: 18, units: 2 });
    expect(result.events.at(-1)).toMatchObject(
      fault === 'none'
        ? { totalCostMicrocents: 18 }
        : { cumulativeCostMicrocents: uncertain ? 0 : 18 },
    );
    expect(result.persisted.at(-1)).toMatchObject(
      fault === 'none'
        ? { totalCostMicrocents: 18 }
        : { cumulativeCostMicrocents: uncertain ? 0 : 18 },
    );
  });
}
