import { describe, expect, it } from 'vitest';
import { prepareOutputCapPlan } from '@relavium/llm';
import type { RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import { MoneyDurability, isLedgerDurabilityError } from './money-durability.js';
import type { NodeExecContext, NodeOutcome, NodeReceiptContext } from './node-executor.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 1000; turn++) {
    if (await check()) return;
    await Promise.resolve();
  }
  expect.fail('observable host transition did not complete');
}
const workflow = parseWorkflow(`schema_version: '1.0'
workflow:
  id: receipt-lifetime
  budget: { max_cost_microcents: 100000000, on_exceed: fail }
  nodes:
    - { id: start, type: input }
    - { id: out, type: output, save_to: 'media/{{ run.id }}/image.png' }
  edges:
    - { from: start, to: out }
`);
const plain = parseWorkflow(`schema_version: '1.0'
workflow:
  id: receipt-child
  nodes: [{ id: n, type: input }]
  edges: []
`);
const draft = {
  nodeId: 'out',
  model: 'offline-model',
  attemptNumber: 1,
  inputTokens: 1,
  outputTokens: 1,
  costMicrocents: 17,
  priced: true,
};
const capPlan = prepareOutputCapPlan({
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  endpoint: 'official',
  maxTokens: 1,
  providerOptions: undefined,
});

it('the exact held raw producer outlives bounded cancellation; late incurred receipts work but new pin/save/prepare/admission do not', async () => {
  const store = new InMemoryRunStore();
  let pins = 0;
  let saves = 0;
  const effects: string[] = [];
  const host = createInMemoryHost({
    store,
    mediaStore: {
      put: () => {
        pins++;
        return Promise.resolve(`media://sha256-${'1'.repeat(64)}`);
      },
      get: () => Promise.resolve(new Uint8Array([1])),
      readRange: () => Promise.reject(new Error('unexpected range')),
      resolveForEgress: () => Promise.reject(new Error('unexpected egress')),
    },
    mediaWrite: () => {
      saves++;
      return Promise.resolve({ bytesWritten: 1 });
    },
  });
  const raw = deferred<NodeOutcome>();
  let thenReads = 0;
  // Registering a wrapper through the producer's overridden then would misobserve or throw. Native raw
  // settlement must be the authority; the actual Promise stays held until the test resolves it below.
  void Object.defineProperty(raw.promise, 'then', {
    get: () => {
      thenReads++;
      throw new Error('do not read raw.then');
    },
  });
  const entered = deferred<NodeExecContext>();
  const engine = new WorkflowEngine({
    host,
    effectJournal: () => ({
      prepare: () => {
        effects.push('prepare');
        return Promise.resolve({ outcome: 'proceed' });
      },
      settle: () => {
        effects.push('settle');
        return Promise.resolve();
      },
      discard: () => {
        effects.push('discard');
        return Promise.resolve();
      },
    }),
    executor: {
      execute: (ctx) => {
        if (ctx.vertex.id === 'start')
          return Promise.resolve({ kind: 'completed', output: 'start' });
        entered.resolve(ctx);
        return raw.promise;
      },
    },
  });
  const handle = engine.start({ workflow });
  const events: RunEvent[] = [];
  const drained = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  const ctx = await entered.promise;
  await ctx.effects?.prepare(0, 'offline-effect', 1, {});
  const initialFence = await host.runLeases.read(handle.runId);
  handle.cancel();
  await until(() => host.deadlineCount() > 0);
  host.fireDeadlines();
  await drained;
  expect(events.at(-1)).toMatchObject({ type: 'run:cancelled', cumulativeCostMicrocents: 0 });
  expect(await host.runLeases.read(handle.runId)).toEqual(initialFence);
  expect(host.livenessCount()).toBe(1);
  expect(thenReads).toBe(0);
  await expect(ctx.effects?.prepare(1, 'new-effect', 1, {})).rejects.toThrow(
    'no new effect may be prepared',
  );
  expect(() =>
    ctx.preEgress?.({
      ...capPlan,
      route: 'text',
      inputTokensEstimate: 0,
      maxTokensEstimate: undefined,
      outputCapPlan: capPlan,
    }),
  ).toThrow('no new admission is allowed');
  await ctx.effects?.settle(0, 'offline-effect', 'committed');
  await ctx.effects?.discard(0, 'offline-effect');
  ctx.emit({ type: 'cost:updated', ...draft, cumulativeCostMicrocents: 0 });
  ctx.money?.record(draft);
  await ctx.money?.join();
  expect(store.eventsFor(handle.runId).at(-1)).toMatchObject({
    type: 'cost:attempt_settled',
    costMicrocents: 17,
  });
  expect(events.at(-1)?.type).toBe('run:cancelled');
  expect(effects).toEqual(['prepare', 'settle', 'discard']);
  expect(pins).toBe(0);
  expect(saves).toBe(0);
  raw.resolve({
    kind: 'completed',
    output: { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'AQ==' } },
  });
  await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
  expect(pins).toBe(0); // losing outcome never starts a new pin before save-to's later refusal
  expect(saves).toBe(0);
  expect(thenReads).toBe(0);
  expect(() => ctx.money?.record(draft)).toThrow('receipt scope has already ended');
});

for (const rejects of [false, true])
  it(`nested transferred effects retain exact entered host lifetime after all producing scopes end (${rejects ? 'rejection' : 'ACK'})`, async () => {
    const host = createInMemoryHost();
    const raw = deferred<NodeOutcome>();
    const parentDone = deferred<void>();
    const childDone = deferred<void>();
    const effectDone = deferred<void>();
    const entered = deferred<NodeExecContext>();
    let effectCalls = 0;
    const engine = new WorkflowEngine({
      host,
      effectJournal: () => ({
        prepare: () => Promise.resolve({ outcome: 'proceed' }),
        settle: () => {
          effectCalls++;
          return effectDone.promise;
        },
        discard: () => Promise.resolve(),
      }),
      executor: {
        execute: (ctx) => {
          entered.resolve(ctx);
          return raw.promise;
        },
      },
    });
    const handle = engine.start({ workflow: plain });
    const events: RunEvent[] = [];
    const drained = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    const ctx = await entered.promise;
    await ctx.effects?.prepare(0, 'offline-effect', 1, {});
    let parent: NodeReceiptContext | undefined;
    let child: NodeReceiptContext | undefined;
    const parentPromise = ctx.continueReceipt?.((receipt) => {
      parent = receipt;
      void receipt.continueReceipt((nested) => {
        child = nested;
        return childDone.promise;
      });
      return parentDone.promise;
    });
    if (parent === undefined || child === undefined)
      expect.fail('factories must enter synchronously');
    raw.resolve({ kind: 'completed', output: 'done' });
    parentDone.resolve();
    await parentPromise;
    await drained;
    expect(events.at(-1)?.type).toBe('run:completed');
    expect(() => parent?.continueReceipt(() => Promise.resolve())).toThrow(
      'receipt scope has already ended',
    );
    expect(effectCalls).toBe(0); // child was registered before its first host call, after both parents ended
    expect(Object.keys(child).sort()).toEqual([
      'continueReceipt',
      'effects',
      'money',
      'updateCost',
    ]);
    expect(Object.keys(child.effects ?? {}).sort()).toEqual(['discard', 'settle']);
    const fence = await host.runLeases.read(handle.runId);
    expect(fence).toBeDefined();
    const settlement = child.effects?.settle(0, 'offline-effect', 'committed');
    if (settlement === undefined) expect.fail('wired effect receipt');
    expect(settlement).toBe(effectDone.promise); // entered host promise is returned unchanged
    const cause = new Error('PRIVATE effect settlement');
    const observed = rejects
      ? expect(settlement).rejects.toBe(cause)
      : expect(settlement).resolves.toBeUndefined();
    childDone.resolve();
    await childDone.promise;
    expect(() => child?.effects?.discard(0, 'offline-effect')).toThrow(
      'receipt scope has already ended',
    );
    expect(await host.runLeases.read(handle.runId)).toEqual(fence);
    host.fireLiveness();
    await until(() => host.livenessCount() === 1);
    if (rejects) effectDone.reject(cause);
    else effectDone.resolve();
    await observed;
    await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
    expect(effectCalls).toBe(1);
    expect(handle.durability()).toBe('durable');
  });

describe('nonconsuming money lifetime join', () => {
  it('rechecks newly recorded work and preserves the first original failure for the semantic caller', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const firstCause = new Error('PRIVATE original ledger');
    let writes = 0;
    const money = new MoneyDurability({
      emit: () => (++writes === 1 ? first.promise : second.promise),
    });
    money.record(draft, 17);
    let quiet = false;
    const observation = money.waitForWrites().then(() => {
      quiet = true;
    });
    await until(() => writes === 1);
    money.record({ ...draft, attemptNumber: 2 }, 34);
    first.reject(firstCause);
    await until(() => writes === 2);
    expect(quiet).toBe(false);
    second.resolve();
    await observation;
    await money.waitForWrites();
    const caught = await money.join().then(
      () => expect.fail('semantic barrier lost the failure'),
      (error: unknown) => error,
    );
    if (!isLedgerDurabilityError(caught)) expect.fail('existing money error required');
    expect(caught.cause).toBe(firstCause);
    expect(money.durabilityBroken).toBe(true);
    await money.join();
    await money.waitForWrites();
    expect(money.durabilityBroken).toBe(true);
  });
});
