import type { ContentPart, MediaBilledModality, RunEvent } from '@relavium/shared';
import { eq, sum } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

// Test-only composition: the host-bound DB owns SQLite; shipping core remains platform-free. Concrete
// adapters stay host-injected, and the fixture observes only Relavium seam types and native Fetch types.
import { createAgentNodeExecutor } from '../../core/src/engine/agent-runner.js';
import { WorkflowEngine } from '../../core/src/engine/engine.js';
import { createInMemoryHost } from '../../core/src/engine/execution-host.js';
import { parseWorkflow } from '../../core/src/parser.js';
import { createOpenAiAdapter } from '../../llm/src/adapters/openai.js';
import type { LlmProvider, MediaGenRequest, MediaJobStatus } from '../../llm/src/types.js';
import type { ModelPricing } from '../../llm/src/pricing.js';
import type { PricingOverlay } from '../../llm/src/cost-tracker.js';
import { createClient, runMigrations } from './client.js';
import { createRunHistoryStore, createRunLeasePort } from './run-history-store.js';
import { runCosts } from './schema.js';

const VOLUME = 12.5;
const CHARGE = 2513;
const MODEL = 'offline-fractional-history';
const HANDLE = `media://sha256-${'2'.repeat(64)}`;

type Finish = 'sync-sdk' | 'done' | 'failed' | 'deadline' | 'cancel';

/** A successful native generation has one DB charge, regardless of its synchronous/parked result. */
async function runMedia(finish: Finish) {
  const modality: MediaBilledModality = finish === 'sync-sdk' ? 'audio' : 'video';
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'fractional-history',
        budget: { max_cost_microcents: 10000, on_exceed: 'fail' },
        agents: [
          { id: 'generator', provider: 'openai', model: MODEL, system_prompt: 'Generate media.' },
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
  const price: ModelPricing = {
    provider: 'openai',
    nativeId: MODEL,
    displayName: 'Offline fractional history',
    contextWindowTokens: 10000,
    maxOutputTokens: 1000,
    inputPerMtokMicrocents: 0,
    outputPerMtokMicrocents: 0,
    cachedInputPerMtokMicrocents: 0,
    mediaOutputRates: { audio: 201, video: 201 },
  };
  const resolvePrice: PricingOverlay = new Map([[MODEL, price]]);
  const client = createClient(':memory:');
  try {
    runMigrations(client.db);
    let next = 0;
    const store = createRunHistoryStore(client.db, {
      uuid: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      workflow: {
        slug: workflow.workflow.id,
        name: workflow.workflow.id,
        definitionJson: JSON.stringify(workflow),
      },
    });
    const base = createInMemoryHost({
      store,
      runLeases: createRunLeasePort(store),
      // The fixture store consumes only the tiny SDK response; no real CAS or filesystem is opened.
      mediaStore: {
        put: () => Promise.resolve(HANDLE),
        get: () => Promise.resolve(new Uint8Array([1])),
        readRange: () => Promise.reject(new Error('offline range read is not used')),
        resolveForEgress: () => Promise.resolve({ kind: 'base64', data: 'AQ==' }),
      },
    });
    let clockJump = 0;
    const host = {
      ...base,
      clock: { now: () => new Date(Date.parse(base.clock.now()) + clockJump).toISOString() },
    };
    const media: Extract<ContentPart, { type: 'media' }> = {
      type: 'media',
      mimeType: 'video/mp4',
      source: { kind: 'handle', ref: HANDLE },
    };
    const wireBodies: unknown[] = [];
    const adapter = createOpenAiAdapter({
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        expect(url).toBe('https://api.openai.com/v1/audio/speech');
        expect(typeof init?.body).toBe('string');
        if (typeof init?.body !== 'string') throw new Error('offline speech body was absent');
        wireBodies.push(JSON.parse(init.body));
        return Promise.resolve(
          new Response('OFFLINE-AUDIO-BYTES', {
            status: 200,
            headers: { 'content-type': 'audio/mpeg' },
          }),
        );
      },
    });
    const requests: MediaGenRequest[] = [];
    let polls = 0;
    const provider: LlmProvider = {
      id: 'openai',
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
      generateMedia: (request, key) => {
        requests.push(request);
        if (finish === 'sync-sdk') {
          const generate = adapter.generateMedia?.({ ...request, model: 'gpt-4o-mini-tts' }, key);
          if (generate === undefined) throw new Error('offline SDK adapter lacks generateMedia');
          return generate;
        }
        return Promise.resolve({ jobId: 'offline-video-job' });
      },
      pollMediaJob: (): Promise<MediaJobStatus> => {
        polls += 1;
        return Promise.resolve(
          finish === 'failed'
            ? {
                state: 'failed',
                error: {
                  provider: 'openai',
                  kind: 'content_filter',
                  retryable: false,
                  message: 'offline content filter',
                },
              }
            : { state: 'done', media },
        );
      },
    };
    const executor = createAgentNodeExecutor({
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
      resolvePrice,
      newAbortController: host.newAbortController,
      setTimer: host.setTimer,
    });
    const engine = new WorkflowEngine({ host, executor, resolvePrice });
    const handle = engine.start({ workflow });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        if (finish === 'cancel') handle.cancel();
        else {
          if (finish === 'deadline') clockJump = 2000000;
          base.fireTimers();
        }
      }
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]?.durationSeconds).toBe(VOLUME);
    if (finish === 'sync-sdk') {
      expect(wireBodies).toEqual([
        {
          model: 'gpt-4o-mini-tts',
          voice: 'alloy',
          input: 'An offline fixture.',
          response_format: 'mp3',
        },
      ]);
    } else {
      expect(wireBodies).toEqual([]);
      expect(events.filter((event) => event.type === 'media_job:submitted')).toMatchObject([
        { units: VOLUME, acceptedCostMicrocents: CHARGE },
      ]);
    }
    expect(polls).toBe(finish === 'done' || finish === 'failed' ? 1 : 0);
    const actual = events.filter((event) => event.type === 'cost:updated');
    expect(actual).toMatchObject([{ costMicrocents: CHARGE, cumulativeCostMicrocents: CHARGE }]);
    expect(actual[0]).not.toHaveProperty('priced');
    const durable = store.loadRunEventLogForReplay(handle.runId);
    expect(durable.filter((event) => event.type === 'budget:estimate_committed')).toEqual([]);
    expect(durable.at(-1)).toEqual(events.at(-1));
    const rows = client.db.select().from(runCosts).where(eq(runCosts.runId, handle.runId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.costMicrocents).toBe(CHARGE);
    const aggregate = client.db
      .select({ total: sum(runCosts.costMicrocents).mapWith(Number) })
      .from(runCosts)
      .where(eq(runCosts.runId, handle.runId))
      .get();
    expect(aggregate?.total).toBe(CHARGE);
    expect(store.loadRun(handle.runId)?.totalCostMicrocents).toBe(CHARGE);
    expect(base.armedCount()).toBe(0);
    expect(base.deadlineCount()).toBe(0);
    expect(base.livenessCount()).toBe(0);
    expect(await host.runLeases.read(handle.runId)).toBeUndefined();
    expect(handle.durability()).toBe('durable');
    if (finish === 'sync-sdk' || finish === 'done') {
      expect(events.at(-1)).toMatchObject({ type: 'run:completed', totalCostMicrocents: CHARGE });
    } else if (finish === 'cancel') {
      expect(events.at(-1)).toMatchObject({
        type: 'run:cancelled',
        cumulativeCostMicrocents: CHARGE,
      });
    } else {
      expect(events.at(-1)).toMatchObject({
        type: 'run:failed',
        cumulativeCostMicrocents: CHARGE,
        error: { code: finish === 'failed' ? 'content_filter' : 'provider_unavailable' },
      });
    }
  } finally {
    client.sqlite.close();
  }
}

describe('fractional native media — SQLite history and offline SDK composition', () => {
  it.each<Finish>(['sync-sdk', 'done', 'failed', 'deadline', 'cancel'])(
    '%s persists one integer charge matching its run total',
    runMedia,
  );
});
