import {
  createAgentNodeExecutor,
  createDispatchingNodeExecutor,
  createHumanGateNodeExecutor,
  createInMemoryHost,
  createOutputNodeExecutor,
  parseWorkflow,
  WorkflowEngine,
} from '@relavium/core';
import { InMemoryMediaStore } from '@relavium/db';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import { RunEventSchema, type RunEvent, type UsageCoverage } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { createRunStore } from './tui/run-store.js';

// Complete independent 1x1 RGB PNG: IHDR, zlib-compressed red pixel IDAT, IEND and CRCs.
const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc0000003010100c9fe92ef0000000049454e44ae426082',
    'hex',
  ),
);

const complete: UsageCoverage = { unverified: false, pendingInvocations: 0, unknownCalls: 0 };
type InitialCall = 'missing' | 'zero' | 'positive' | 'unpriced' | 'image-zero' | 'image-unpriced';

function withoutCoverage(event: RunEvent): RunEvent {
  const legacy = { ...event };
  delete legacy.usageCoverage;
  return legacy;
}

async function runThroughResume(kind: InitialCall, secondMissing: boolean) {
  const media = kind.startsWith('image-');
  const mediaStore = new InMemoryMediaStore();
  const imageHandle = await mediaStore.put(PNG_BYTES, 'image/png');
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: `resume-${kind}`,
        agents: [{ id: 'a', provider: 'openai', model: 'offline', system_prompt: 'offline' }],
        nodes: [
          {
            id: 'before',
            type: 'agent',
            agent_ref: 'a',
            prompt_template: 'before',
            ...(media ? { output_modalities: ['image'], count: 1 } : {}),
          },
          { id: 'gate', type: 'human_gate', gate_type: 'approval', message_template: 'approve' },
          ...(secondMissing
            ? [{ id: 'after', type: 'agent', agent_ref: 'a', prompt_template: 'after' }]
            : []),
          { id: 'out', type: 'output' },
        ],
        edges: [
          { from: 'before', to: 'gate' },
          ...(secondMissing
            ? [
                { from: 'gate', to: 'after' },
                { from: 'after', to: 'out' },
              ]
            : [{ from: 'gate', to: 'out' }]),
        ],
      },
    }),
  );
  let calls = 0;
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
        ...(media ? { surface: 'generative' } : {}),
      },
    },
    generate: () => Promise.reject(new Error('generate forbidden')),
    async *stream() {
      await Promise.resolve();
      calls += 1;
      yield { type: 'text_delta', text: 'offline' };
      yield {
        type: 'stop',
        stopReason: 'stop',
        usage:
          kind === 'missing' || calls > 1
            ? { kind: 'missing', reason: 'not_reported' }
            : {
                kind: 'complete',
                usage: { inputTokens: kind === 'positive' ? 10 : 0, outputTokens: 0 },
              },
      };
    },
    generateMedia: (request) => {
      calls += 1;
      expect(request.count).toBe(1);
      return Promise.resolve({
        media: {
          type: 'media',
          mimeType: 'image/png',
          source: { kind: 'handle', ref: imageHandle },
        },
        raw: undefined,
      });
    },
  };
  const price: ModelPricing = {
    provider: 'openai',
    nativeId: 'offline',
    displayName: 'offline',
    contextWindowTokens: 10000,
    maxOutputTokens: 1000,
    inputPerMtokMicrocents: 100000000,
    outputPerMtokMicrocents: 0,
    cachedInputPerMtokMicrocents: 0,
    ...(kind === 'image-zero' ? { mediaOutputRates: { image: 0 } } : {}),
  };
  const resolvePrice = new Map(kind === 'unpriced' ? [] : [['offline', price]]);
  const executor = createDispatchingNodeExecutor({
    agent: createAgentNodeExecutor({
      resolveProvider: () => provider,
      ...(media ? { resolveMediaSurface: () => 'generative' as const } : {}),
      resolvePrice,
      keyFor: () => 'offline-fixture',
      sleep: () => Promise.resolve(),
      tools: [],
      registry: {
        has: () => false,
        list: () => [],
        dispatch: () => Promise.reject(new Error('tools forbidden')),
      },
    }),
    human_in_the_loop: createHumanGateNodeExecutor(),
    output: createOutputNodeExecutor(),
  });
  const host = createInMemoryHost({ mediaStore });
  const first = new WorkflowEngine({ host, executor, resolvePrice }).start({ workflow });
  let pausedResolve: () => void = () => {};
  const paused = new Promise<void>((resolve) => {
    pausedResolve = resolve;
  });
  const initial: RunEvent[] = [];
  const initialDrain = (async () => {
    for await (const event of first.events) {
      initial.push(event);
      if (event.type === 'run:paused') pausedResolve();
    }
  })();
  await Promise.race([
    paused,
    initialDrain.then(() => {
      throw new Error(`run ended before pause: ${JSON.stringify(initial.at(-1))}`);
    }),
  ]);
  const checkpoint = await host.checkpointer.load(first.runId);
  const gate = initial.find((event) => event.type === 'human_gate:paused');
  await first.depart();
  await initialDrain;
  if (gate?.type !== 'human_gate:paused' || checkpoint === undefined)
    throw new Error('missing pause');
  const resumed = await new WorkflowEngine({
    host: createInMemoryHost({ store: host.store, mediaStore }),
    executor,
    resolvePrice,
  }).resumeFromCheckpoint({
    runId: first.runId,
    workflow,
    gateId: gate.gateId,
    decision: { decision: 'approved', decidedBy: 'offline-test' },
  });
  const events: RunEvent[] = [];
  for await (const event of resumed.events) events.push(event);
  expect(await resumed.depart()).toMatchObject({ kind: 'closed', moneyDurability: 'durable' });
  expect(calls).toBe(secondMissing ? 2 : 1);
  expect(events.at(-1)?.type).toBe('run:completed');
  expect(events.some((event) => event.type === 'cost:coverage_started')).toBe(false);
  return { initial, checkpoint, events };
}

describe('run usage coverage across actual checkpoint resume', () => {
  it.each<InitialCall>(['missing', 'zero', 'positive', 'unpriced', 'image-zero', 'image-unpriced'])(
    'keeps %s coverage and amount in the fresh shipping run store',
    async (kind) => {
      const { checkpoint, events } = await runThroughResume(kind, false);
      const expected = { ...complete, unknownCalls: kind === 'missing' ? 1 : 0 };
      expect(checkpoint.usageCoverage?.coverage).toEqual(expected);
      const view = createRunStore(false);
      for (const event of events) {
        view.apply(event);
        view.flush();
        expect(view.getSnapshot().state.cumulativeCostMicrocents).toBe(
          kind === 'positive' ? 1000 : 0,
        );
        expect(view.getSnapshot().state.usageCoverage).toEqual(event.usageCoverage);
        // Repeated delivery cannot erase an inherited snapshot or add a charge.
        const before = view.getSnapshot().state;
        view.apply(event);
        view.flush();
        expect(view.getSnapshot().state).toMatchObject({
          usageCoverage: before.usageCoverage,
          cumulativeCostMicrocents: before.cumulativeCostMicrocents,
          unpricedCalls: before.unpricedCalls,
        });
      }
      expect(view.getSnapshot().state.usageCoverage).toEqual(expected);
      expect(view.getSnapshot().state.cumulativeCostMicrocents).toBe(
        kind === 'positive' ? 1000 : 0,
      );
      expect(view.getSnapshot().state.unpricedCalls).toBe(
        kind === 'unpriced' || kind === 'image-unpriced' ? 1 : 0,
      );
      if (kind === 'missing') expect(view.summaryText()).toContain('usage unknown for 1 call');
      else if (kind === 'unpriced' || kind === 'image-unpriced')
        expect(view.summaryText()).toContain('price unknown for 1 call');
      else if (kind !== 'positive') {
        expect(view.summaryText()).toContain('cost $0.0000');
        expect(view.summaryText()).not.toMatch(/usage unknown|price unknown|unverified/);
      }
      if (kind === 'missing' || kind === 'unpriced' || kind === 'image-unpriced')
        expect(view.summaryText()).not.toContain('free');
    },
  );

  it('restores known positive money on the first resumed frame before any further node completes', async () => {
    const { checkpoint, events } = await runThroughResume('positive', false);
    expect(checkpoint.cumulativeCostMicrocents).toBe(1000);
    const first = events[0];
    if (first === undefined) throw new Error('missing first resumed event');
    expect(first.type).toBe('human_gate:resumed');
    expect(first.usageCoverage).toEqual(complete);
    const view = createRunStore(false);
    view.apply(first);
    view.flush();
    expect(view.getSnapshot().state.cumulativeCostMicrocents).toBe(1000);
    expect(view.summaryText()).not.toContain('free');
  });

  it('retains inherited unknown usage while a resumed call becomes pending then incomplete, with legacy delta fallback', async () => {
    const { initial, events } = await runThroughResume('missing', true);
    const authoritative = createRunStore(false);
    const fallback = createRunStore(false);
    const allLegacy = createRunStore(false);
    for (const event of initial) allLegacy.apply(withoutCoverage(event));
    let seeded = false;
    let pending = false;
    let disposition = false;
    let expected: UsageCoverage = { ...complete, unknownCalls: 1 };
    for (const event of events) {
      if (event.usageCoverage !== undefined) expected = event.usageCoverage;
      else if (event.type === 'cost:usage_pending') {
        pending = true;
        expected = { ...complete, pendingInvocations: 1, unknownCalls: 1 };
      } else if (
        event.type === 'cost:usage_disposition' &&
        event.disposition.kind === 'incomplete'
      ) {
        disposition = true;
        // A later receipt-retirement disposition keeps the same aggregate uncertainty.
        expected = { ...complete, unknownCalls: 2 };
      }
      authoritative.apply(event);
      // Only the first resumed event supplies the inherited snapshot. Every later event is a
      // genuine engine event exercised through the compatible envelope-less delta path.
      const fallbackEvent = seeded ? withoutCoverage(event) : event;
      seeded = true;
      fallback.apply(fallbackEvent);
      allLegacy.apply(withoutCoverage(event));
      for (const view of [authoritative, fallback, allLegacy]) {
        view.flush();
        expect(view.getSnapshot().state.usageCoverage).toEqual(expected);
      }
      if (event.type === 'cost:usage_pending') {
        expect(event.usageCoverage).toBeUndefined();
      }
      if (event.type === 'cost:usage_disposition' && event.disposition.kind === 'incomplete') {
        expect(event.usageCoverage).toBeUndefined();
      }
      fallback.apply(fallbackEvent);
      fallback.flush();
      expect(fallback.getSnapshot().state.usageCoverage).toEqual(expected);
    }
    expect(pending).toBe(true);
    expect(disposition).toBe(true);
    expect(fallback.summaryText()).toContain('usage unknown for 2 calls');
  });

  it('uses authoritative snapshots over stale local counts and preserves inherited pending in later delta events', () => {
    const view = createRunStore(false);
    let sequenceNumber = 0;
    const apply = (body: Record<string, unknown>) => {
      const event = RunEventSchema.parse({
        runId: 'resumed',
        timestamp: '2026-10-10T00:00:00.000Z',
        sequenceNumber: ++sequenceNumber,
        ...body,
      });
      view.apply(event);
      view.apply(event);
      view.flush();
      return view.getSnapshot().state.usageCoverage;
    };
    const invocation = {
      producerId: 'live',
      ordinal: 1,
      dispatchId: 'after',
      round: 0,
      chainAttempt: 1,
    };
    apply({
      type: 'node:started',
      nodeId: 'after',
      nodeType: 'agent',
      usageCoverage: { ...complete, pendingInvocations: 3, unknownCalls: 2 },
    });
    expect(
      apply({ type: 'cost:usage_pending', nodeId: 'after', model: 'offline', invocation }),
    ).toEqual({ ...complete, pendingInvocations: 4, unknownCalls: 2 });
    expect(
      apply({
        type: 'node:started',
        nodeId: 'other',
        nodeType: 'agent',
        usageCoverage: { ...complete, pendingInvocations: 5, unknownCalls: 7 },
      }),
    ).toEqual({ ...complete, pendingInvocations: 5, unknownCalls: 7 });
    expect(
      apply({
        type: 'cost:usage_disposition',
        nodeId: 'after',
        model: 'offline',
        invocation,
        disposition: { kind: 'incomplete', evidence: { kind: 'missing', reason: 'not_reported' } },
      }),
    ).toEqual({ ...complete, pendingInvocations: 4, unknownCalls: 8 });
    // The producer may resolve inherited identities outside this view's local correlation map.
    // A newer authoritative snapshot can lower both counts; retaining a local maximum is wrong.
    expect(
      apply({
        type: 'node:started',
        nodeId: 'resolved',
        nodeType: 'agent',
        usageCoverage: complete,
      }),
    ).toEqual(complete);
  });
});
