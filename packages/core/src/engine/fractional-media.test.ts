import {
  CostTracker,
  InvalidTokenEstimateError,
  UsageSchema,
  cost,
  type LlmProvider,
  type MediaGenRequest,
  type MediaJobStatus,
  type ModelPricing,
} from '@relavium/llm';
import type { ContentPart, MediaBilledModality, RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { parseWorkflow } from '../parser.js';
import { createAgentNodeExecutor, realizedMediaCost } from './agent-runner.js';
import { reconstructCheckpointState } from './checkpoint.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import type { NodeExecutor } from './node-executor.js';

const MODEL = 'offline-fractional-media';
const HANDLE = `media://sha256-${'1'.repeat(64)}`;
const VOLUME = 12.5;
const CHARGE = 2513; // One rounding of 12.5 seconds × 201 micro-cents per second.
const PRICE: ModelPricing = {
  provider: 'gemini',
  nativeId: MODEL,
  displayName: 'Offline fractional media',
  contextWindowTokens: 10000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 0,
  outputPerMtokMicrocents: 0,
  cachedInputPerMtokMicrocents: 0,
  mediaOutputRates: { audio: 201, video: 201 },
};

type Finish = 'sync' | 'done' | 'failed' | 'deadline' | 'cancel';
type PricingChange = 'missing-rate' | 'missing-model' | 'throws' | 'unsafe-cost';

class OfflineOverlay extends Map<string, ModelPricing> {
  failReads = false;

  override get(model: string): ModelPricing | undefined {
    if (this.failReads) throw new Error('offline pricing fault');
    return super.get(model);
  }
}

/** The runner owns submission and its admission; only the external provider result is deterministic. */
function startMedia(options: {
  readonly finish: Finish;
  readonly modality?: 'audio' | 'video';
  readonly price?: ModelPricing;
  readonly unknownModel?: boolean;
  readonly afterEgress?: PricingChange;
  readonly sinkFault?: boolean;
}) {
  const modality = options.modality ?? (options.finish === 'sync' ? 'audio' : 'video');
  const overlay = new OfflineOverlay(options.unknownModel ? [] : [[MODEL, options.price ?? PRICE]]);
  const store = new InMemoryRunStore();
  const base = createInMemoryHost({ store });
  let clockJump = 0;
  const host = {
    ...base,
    clock: { now: () => new Date(Date.parse(base.clock.now()) + clockJump).toISOString() },
  };
  const media: Extract<ContentPart, { type: 'media' }> = {
    type: 'media',
    mimeType: modality === 'audio' ? 'audio/mpeg' : 'video/mp4',
    source: { kind: 'handle', ref: HANDLE },
  };
  const requests: MediaGenRequest[] = [];
  const reservedAmounts: number[] = [];
  let polls = 0;
  const provider: LlmProvider = {
    id: 'gemini',
    supports: {
      tools: false,
      streaming: false,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
      reasoning: false,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [['audio'], ['video']],
        surface: 'generative',
      },
    },
    generate: () => Promise.reject(new Error('unexpected text generation')),
    stream: (): AsyncIterable<never> => {
      throw new Error('unexpected text stream');
    },
    generateMedia: (request) => {
      requests.push(request);
      switch (options.afterEgress) {
        case 'missing-rate':
          overlay.set(MODEL, { ...PRICE, mediaOutputRates: {} });
          break;
        case 'missing-model':
          overlay.delete(MODEL);
          break;
        case 'throws':
          overlay.failReads = true;
          break;
        case 'unsafe-cost':
          overlay.set(MODEL, {
            ...PRICE,
            mediaOutputRates: { audio: Number.MAX_SAFE_INTEGER, video: Number.MAX_SAFE_INTEGER },
          });
          break;
      }
      return Promise.resolve(options.finish === 'sync' ? { media } : { jobId: 'offline-job' });
    },
    pollMediaJob: (): Promise<MediaJobStatus> => {
      polls += 1;
      return Promise.resolve(
        options.finish === 'failed'
          ? {
              state: 'failed',
              error: {
                provider: 'gemini',
                kind: 'content_filter',
                retryable: false,
                message: 'offline content filter',
              },
            }
          : { state: 'done', media },
      );
    },
  };
  const runner = createAgentNodeExecutor({
    resolveProvider: () => provider,
    resolveMediaSurface: () => 'generative',
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => Promise.reject(new Error('unexpected tool dispatch')),
    },
    tools: [],
    keyFor: () => 'offline-test-only',
    sleep: () => Promise.resolve(),
    resolvePrice: overlay,
    newAbortController: host.newAbortController,
    setTimer: host.setTimer,
  });
  const executor: NodeExecutor = {
    ...runner,
    execute: (ctx) =>
      runner.execute({
        ...ctx,
        preEgress: async (info) => {
          const admission = await ctx.preEgress?.(info);
          if (admission?.reservedMicrocents !== undefined) {
            reservedAmounts.push(admission.reservedMicrocents);
          }
          return admission;
        },
        emit: (event) => {
          ctx.emit(event);
          if (options.sinkFault && event.type === 'cost:updated') {
            throw new Error('offline cost observer fault');
          }
        },
      }),
  };
  const engine = new WorkflowEngine({ host, executor, resolvePrice: overlay });
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'fractional-media',
        budget: { max_cost_microcents: 10000, on_exceed: 'fail' },
        agents: [
          { id: 'generator', provider: 'gemini', model: MODEL, system_prompt: 'Generate media.' },
        ],
        nodes: [
          {
            id: 'gen',
            type: 'agent',
            agent_ref: 'generator',
            prompt_template: 'An offline fixture.',
            output_modalities: [modality],
            duration_seconds: VOLUME,
          },
        ],
        edges: [],
      },
    }),
  );
  const handle = engine.start({ workflow });
  const events: RunEvent[] = [];
  const drained = (async () => {
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        if (options.finish === 'cancel') handle.cancel();
        else {
          if (options.finish === 'deadline') clockJump = 2000000;
          base.fireTimers();
        }
      }
    }
  })();
  return { host, store, handle, events, drained, requests, reservedAmounts, polls: () => polls };
}

async function expectCleanup(run: ReturnType<typeof startMedia>): Promise<void> {
  expect(run.host.armedCount()).toBe(0);
  expect(run.host.deadlineCount()).toBe(0);
  await expect.poll(() => run.host.livenessCount()).toBe(0);
  expect(await run.host.runLeases.read(run.handle.runId)).toBeUndefined();
  expect(run.handle.durability()).toBe('durable');
}

function actualCosts(events: readonly RunEvent[]) {
  return events.filter((event) => event.type === 'cost:updated');
}

function commitments(run: ReturnType<typeof startMedia>) {
  return run.store
    .eventsFor(run.handle.runId)
    .filter((event) => event.type === 'budget:estimate_committed');
}

describe('native fractional media — actual runner and engine accounting', () => {
  it.each<Finish>(['sync', 'done', 'failed', 'deadline', 'cancel'])(
    '%s prices exact seconds once and preserves its outcome',
    async (finish) => {
      const run = startMedia({ finish });
      await run.drained;
      expect(run.requests).toHaveLength(1);
      expect(run.requests[0]?.durationSeconds).toBe(VOLUME);
      expect(run.reservedAmounts).toEqual([CHARGE]);
      expect(actualCosts(run.events)).toMatchObject([{ costMicrocents: CHARGE }]);
      expect(actualCosts(run.events)[0]).not.toHaveProperty('priced');
      expect(commitments(run)).toEqual([]);
      const terminal = run.events.at(-1);
      if (finish === 'sync' || finish === 'done') {
        expect(terminal).toMatchObject({ type: 'run:completed', totalCostMicrocents: CHARGE });
      } else if (finish === 'cancel') {
        expect(terminal).toMatchObject({ type: 'run:cancelled', cumulativeCostMicrocents: CHARGE });
      } else {
        expect(terminal).toMatchObject({
          type: 'run:failed',
          cumulativeCostMicrocents: CHARGE,
          error: { code: finish === 'failed' ? 'content_filter' : 'provider_unavailable' },
        });
      }
      if (finish !== 'sync') {
        expect(run.events.filter((event) => event.type === 'media_job:submitted')).toMatchObject([
          { units: VOLUME, acceptedCostMicrocents: CHARGE },
        ]);
      }
      expect(run.polls()).toBe(finish === 'done' || finish === 'failed' ? 1 : 0);
      expect(run.store.eventsFor(run.handle.runId).at(-1)).toEqual(terminal);
      await expectCleanup(run);
    },
  );

  it.each<Finish>(['sync', 'done', 'cancel'])(
    'genuine zero remains priced on %s',
    async (finish) => {
      const run = startMedia({
        finish,
        price: { ...PRICE, mediaOutputRates: { audio: 0, video: 0 } },
      });
      await run.drained;
      expect(run.reservedAmounts).toEqual([]); // Ordinary free egress needs no positive admission.
      expect(actualCosts(run.events)).toMatchObject([{ costMicrocents: 0 }]);
      expect(actualCosts(run.events)[0]).not.toHaveProperty('priced');
      expect(commitments(run)).toEqual([]);
      expect(run.events.at(-1)).toMatchObject({
        type: finish === 'cancel' ? 'run:cancelled' : 'run:completed',
      });
      await expectCleanup(run);
    },
  );

  it.each<Finish>(['sync', 'done'])(
    'unknown model stays explicitly unpriced on %s',
    async (finish) => {
      const run = startMedia({ finish, unknownModel: true });
      await run.drained;
      expect(actualCosts(run.events)).toMatchObject([{ costMicrocents: 0, priced: false }]);
      expect(run.events.at(-1)).toMatchObject({ type: 'run:completed', totalCostMicrocents: 0 });
      expect(commitments(run)).toEqual([]);
      await expectCleanup(run);
    },
  );

  for (const finish of ['sync', 'done', 'cancel'] satisfies Finish[]) {
    it.each<PricingChange>(['missing-rate', 'missing-model'])(
      `${finish}: a post-provider %s preserves the reserved estimate and explicit gap`,
      async (afterEgress) => {
        const run = startMedia({ finish, afterEgress });
        await run.drained;
        expect(run.reservedAmounts).toEqual([CHARGE]);
        expect(actualCosts(run.events)).toMatchObject([{ costMicrocents: 0, priced: false }]);
        expect(commitments(run)).toMatchObject([{ estimateMicrocents: CHARGE }]);
        expect(
          reconstructCheckpointState(run.store.eventsFor(run.handle.runId))
            ?.conservativeCostMicrocents,
        ).toBe(CHARGE);
        expect(run.events.at(-1)).toMatchObject({
          type: finish === 'cancel' ? 'run:cancelled' : 'run:completed',
        });
        await expectCleanup(run);
      },
    );
  }

  for (const finish of ['sync', 'done', 'cancel'] satisfies Finish[]) {
    it.each<PricingChange>(['throws', 'unsafe-cost'])(
      `${finish}: a post-provider %s cannot publish unsafe actual or lose the admission`,
      async (afterEgress) => {
        const run = startMedia({ finish, afterEgress });
        await run.drained;
        expect(actualCosts(run.events)).toEqual([]);
        expect(commitments(run)).toMatchObject([{ estimateMicrocents: CHARGE }]);
        expect(run.events.at(-1)).toMatchObject({
          type: finish === 'cancel' ? 'run:cancelled' : 'run:failed',
          cumulativeCostMicrocents: 0,
        });
        await expectCleanup(run);
      },
    );
  }

  it('a sink fault after known settlement keeps one actual and no conservative duplicate', async () => {
    const run = startMedia({ finish: 'sync', sinkFault: true });
    await run.drained;
    expect(actualCosts(run.events)).toMatchObject([{ costMicrocents: CHARGE }]);
    expect(commitments(run)).toEqual([]);
    expect(run.events.at(-1)).toMatchObject({
      type: 'run:failed',
      cumulativeCostMicrocents: CHARGE,
    });
    await expectCleanup(run);
  });
});

describe('native volume pricing preserves canonical integer Usage', () => {
  it.each<MediaBilledModality>(['audio', 'video'])(
    'prices fractional %s seconds through the rate-only kernel',
    (modality) => {
      expect(realizedMediaCost(MODEL, modality, VOLUME, new Map([[MODEL, PRICE]]))).toEqual({
        costMicrocents: CHARGE,
        priced: true,
      });
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'refuses malformed native duration %s even for an unknown model',
    (units) => {
      expect(() => realizedMediaCost('unknown-offline-model', 'video', units)).toThrow(
        InvalidTokenEstimateError,
      );
    },
  );

  it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1])(
    'refuses non-accountable image count %s before pricing',
    (units) => {
      expect(() => realizedMediaCost('unknown-offline-model', 'image', units)).toThrow(TypeError);
    },
  );

  it('provider-reported fractional seconds and fractional tokens remain refused', () => {
    const overlay = new Map([[MODEL, PRICE]]);
    const fractionalTokens = { inputTokens: 0.5, outputTokens: 0 } satisfies Parameters<
      typeof cost
    >[1];
    const fractionalSeconds = {
      inputTokens: 0,
      outputTokens: 0,
      mediaUnits: [{ modality: 'video', direction: 'output', unit: 'second', units: VOLUME }],
    } satisfies Parameters<typeof cost>[1];
    const tracker = new CostTracker(overlay);
    for (const usage of [fractionalTokens, fractionalSeconds]) {
      expect(UsageSchema.safeParse(usage).success).toBe(false);
      expect(() => cost(MODEL, usage, overlay)).toThrow(TypeError);
      expect(() => tracker.record(MODEL, usage)).toThrow(TypeError);
    }
    expect(tracker.cumulativeCostMicrocents).toBe(0);
  });
});
