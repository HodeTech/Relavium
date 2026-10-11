import { expect, it } from 'vitest';
import { UsageCoverageFold, type RunEvent, type UsageInvocation } from '@relavium/shared';
import type { LlmProvider } from '@relavium/llm';
import { parseWorkflow } from '../parser.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';
import { MoneyDurability } from './money-durability.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function turns(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

it('serializes allocation through ACK and fold even when a later pending port would acknowledge immediately', async () => {
  const first = deferred<void>();
  const entered = deferred<void>();
  const fold = new UsageCoverageFold();
  fold.start('complete');
  let ordinal = 0;
  const begun: number[] = [];
  const acknowledged: number[] = [];
  const money = new MoneyDurability({
    emitUsageDisposition: () => undefined,
    beginUsageInvocation: async (draft) => {
      const invocation: UsageInvocation = Object.freeze({
        producerId: 'owner',
        ordinal: ++ordinal,
        dispatchId: draft.nodeId,
        round: draft.round,
        chainAttempt: draft.chainAttempt,
      });
      begun.push(invocation.ordinal);
      if (invocation.ordinal === 1) {
        entered.resolve();
        await first.promise;
      }
      acknowledged.push(invocation.ordinal);
      fold.pending(draft.model, invocation);
      return invocation;
    },
    emit: () => undefined,
  });
  const one = money.beginUsageInvocation({
    nodeId: 'one',
    model: 'offline',
    round: 0,
    chainAttempt: 1,
  });
  const two = money.beginUsageInvocation({
    nodeId: 'two',
    model: 'offline',
    round: 0,
    chainAttempt: 1,
  });
  // Attach rejection observation before inspecting the deliberately held first callback.
  const settled = Promise.allSettled([one, two]);
  await entered.promise;
  await turns();
  const beforeRelease = [...begun];
  let drained = false;
  const writes = money.waitForWrites().then(() => {
    drained = true;
  });
  await turns();
  const drainedBeforeRelease = drained;
  first.resolve();
  const results = await settled;
  await writes;
  expect(beforeRelease).toEqual([1]);
  expect(drainedBeforeRelease).toBe(false);
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  expect(acknowledged).toEqual([1, 2]);
  expect(fold.snapshot().coverage).toEqual({
    unverified: false,
    pendingInvocations: 2,
    unknownCalls: 0,
  });
  await money.join();
});

it('a failed pending ACK refuses a concurrently queued allocation and drains without joining itself', async () => {
  const release = deferred<void>();
  const entered = deferred<void>();
  let calls = 0;
  const money = new MoneyDurability({
    emitUsageDisposition: () => undefined,
    beginUsageInvocation: async () => {
      calls++;
      entered.resolve();
      await release.promise;
      throw new Error('pending acknowledgement failed');
    },
    emit: () => undefined,
  });
  const attempts = Promise.allSettled(
    ['one', 'two'].map((nodeId) =>
      money.beginUsageInvocation({ nodeId, model: 'offline', round: 0, chainAttempt: 1 }),
    ),
  );
  await entered.promise;
  release.resolve();
  expect((await attempts).map((attempt) => attempt.status)).toEqual(['rejected', 'rejected']);
  expect(calls).toBe(1);
  expect(money.durabilityBroken).toBe(true);
  await money.waitForWrites();
  await money.join();
});

for (const budgeted of [false, true])
  it(`real parallel agent nodes wait for pending ACK and preserve replay order (budget=${budgeted})`, async () => {
    const first = deferred<void>();
    const entered = deferred<void>();
    const host = createInMemoryHost();
    const persist = host.store.persistEvent.bind(host.store);
    const stored: RunEvent[] = [];
    const markerOrdinals: number[] = [];
    host.store.persistEvent = async (event, context) => {
      await persist(event, context);
      stored.push(event);
      if (event.type === 'cost:usage_pending') {
        markerOrdinals.push(event.invocation.ordinal);
        if (markerOrdinals.length === 1) {
          entered.resolve();
          await first.promise;
        }
      }
    };
    let invocations = 0;
    const provider: LlmProvider = {
      id: 'openai',
      supports: {
        tools: false,
        streaming: true,
        parallelToolCalls: false,
        vision: false,
        promptCache: false,
        reasoning: false,
        media: {
          input: { image: false, audio: false, video: false, document: false },
          outputCombinations: [],
        },
      },
      generate: () => Promise.reject(new Error('unexpected generate')),
      stream: async function* () {
        await Promise.resolve();
        invocations++;
        yield {
          type: 'stop',
          stopReason: 'stop',
          usage: { kind: 'complete', usage: { inputTokens: 1, outputTokens: 1 } },
        };
      },
    };
    const workflow = parseWorkflow(
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'parallel-usage',
          max_parallel: 2,
          ...(budgeted ? { budget: { max_cost_microcents: 1000000000, on_exceed: 'fail' } } : {}),
          agents: [{ id: 'agent', provider: 'openai', model: 'gpt-4o', system_prompt: 'offline' }],
          nodes: ['one', 'two'].map((id) => ({
            id,
            type: 'agent',
            agent_ref: 'agent',
            prompt_template: 'offline',
          })),
          edges: [],
        },
      }),
    );
    const handle = new WorkflowEngine({
      host,
      executor: createAgentNodeExecutor({
        resolveProvider: () => provider,
        keyFor: () => 'offline',
        sleep: () => Promise.resolve(),
        tools: [],
        registry: {
          has: () => false,
          list: () => [],
          dispatch: () => Promise.reject(new Error('unexpected tool')),
        },
      }),
    }).start({ workflow });
    const live: RunEvent[] = [];
    const drained = (async () => {
      for await (const event of handle.events) live.push(event);
    })();
    await entered.promise;
    await turns();
    const beforeRelease = {
      markers: [...markerOrdinals],
      invocations,
      nodes: live.filter((event) => event.type === 'node:started').length,
    };
    first.resolve();
    await drained;
    await handle.depart();
    expect(beforeRelease).toEqual({ markers: [1], invocations: 0, nodes: 2 });
    expect(invocations).toBe(2);
    expect(markerOrdinals).toEqual([1, 2]);
    expect(live.at(-1)?.type).toBe('run:completed');
    const replay = new UsageCoverageFold();
    for (const event of stored) replay.apply(event);
    const checkpoint = await host.checkpointer.load(handle.runId);
    expect(replay.snapshot()).toEqual(checkpoint?.usageCoverage);
    expect(replay.snapshot().coverage).toEqual({
      unverified: false,
      pendingInvocations: 0,
      unknownCalls: 0,
    });
    expect(live.at(-1)?.usageCoverage).toEqual(replay.snapshot().coverage);
    expect(stored.map((event) => event.sequenceNumber)).toEqual(
      [...stored.map((event) => event.sequenceNumber)].sort((a, b) => a - b),
    );
  });
