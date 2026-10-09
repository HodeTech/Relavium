import { expect, it } from 'vitest';
import type { EffectDispatchPort, RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';
import type { NodeOutcome } from './node-executor.js';
import type { RunHandle } from './run-handle.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const workflow = parseWorkflow(
  JSON.stringify({
    schema_version: '1.0',
    workflow: {
      id: 'run-departure',
      agents: [{ id: 'worker', model: 'offline-model', provider: 'openai', system_prompt: 'go' }],
      nodes: [{ id: 'work', type: 'agent', agent_ref: 'worker', prompt_template: 'go' }],
      edges: [],
    },
  }),
);
async function readPause(handle: RunHandle) {
  const iterator = handle.events[Symbol.asyncIterator]();
  const events: RunEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error('pause expected');
    events.push(next.value);
    if (next.value.type === 'run:paused') return { iterator, events, pause: next.value };
  }
}
const paused: NodeOutcome = { kind: 'paused', gate: { gateType: 'approval', message: 'approve?' } };

it('detaches one consumed idle pause, closes a pending next and permits same-process checkpoint resume', async () => {
  const host = createInMemoryHost();
  const engine = new WorkflowEngine({ host, executor: { execute: () => Promise.resolve(paused) } });
  const handle = engine.start({ workflow });
  const read = await readPause(handle);
  const next = read.iterator.next();
  const departure = handle.depart();
  expect(handle.depart()).toBe(departure);
  expect(await departure).toEqual({
    kind: 'detached',
    moneyDurability: 'durable',
    effectNeedsAttention: false,
  });
  expect(handle.depart()).toBe(departure);
  expect(await next).toEqual({ done: true, value: undefined });
  expect(read.events.at(-1)?.type).toBe('run:paused');
  expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
  expect(await host.runLeases.read(handle.runId)).toBeUndefined();
  handle.cancel();
  const resumed = await engine.resumeFromCheckpoint({
    runId: handle.runId,
    workflow,
    gateId: read.pause.gateIds[0] ?? '',
    decision: { decision: 'approved', decidedBy: 'tester' },
  });
  const events: RunEvent[] = [];
  for await (const event of resumed.events) events.push(event);
  expect(events.at(-1)?.type).toBe('run:completed');
  expect(await resumed.depart()).toEqual({
    kind: 'closed',
    moneyDurability: 'durable',
    effectNeedsAttention: false,
  });
});

it('unconsumed primary advancement returns continue and retains the original reader', async () => {
  const host = createInMemoryHost();
  const handle = new WorkflowEngine({
    host,
    executor: { execute: () => Promise.resolve(paused) },
  }).start({ workflow });
  const published = deferred<void>();
  const unsubscribe = handle.subscribe((event) => {
    if (event.type === 'run:paused') published.resolve();
  });
  await published.promise;
  expect(await handle.depart()).toEqual({ kind: 'continue' });
  const read = await readPause(handle);
  expect(read.events[0]?.type).toBe('run:started');
  expect(await handle.depart()).toEqual({
    kind: 'detached',
    moneyDurability: 'durable',
    effectNeedsAttention: false,
  });
  expect((await read.iterator.next()).done).toBe(true);
  unsubscribe();
});

it('an abandoned primary cannot authorize paused detachment', async () => {
  const host = createInMemoryHost();
  const handle = new WorkflowEngine({
    host,
    executor: { execute: () => Promise.resolve(paused) },
  }).start({ workflow });
  const read = await readPause(handle);
  await read.iterator.return?.();
  await expect(handle.depart()).rejects.toMatchObject({ code: 'invalid_departure' });
  const terminal = deferred<void>();
  const unsubscribe = handle.subscribe((event) => {
    if (event.type === 'run:cancelled') terminal.resolve();
  });
  handle.cancel();
  await terminal.promise;
  expect((await handle.depart()).kind).toBe('closed');
  unsubscribe();
});

it('a running node retains consumption instead of waiting for an arbitrary executor', async () => {
  const host = createInMemoryHost();
  const entered = deferred<void>();
  const finished = deferred<NodeOutcome>();
  const handle = new WorkflowEngine({
    host,
    executor: {
      execute: () => {
        entered.resolve();
        return finished.promise;
      },
    },
  }).start({ workflow });
  const drained = (async () => {
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    return events;
  })();
  await entered.promise;
  expect(await handle.depart()).toEqual({ kind: 'continue' });
  finished.resolve({ kind: 'completed', output: 'answer' });
  expect((await drained).at(-1)?.type).toBe('run:completed');
  expect((await handle.depart()).kind).toBe('closed');
});

it('terminal visibility precedes the independently joined raw child receipt lifetime', async () => {
  const host = createInMemoryHost();
  const released = deferred<void>();
  const handle = new WorkflowEngine({
    host,
    executor: {
      execute: (ctx) => {
        if (ctx.continueReceipt === undefined) throw new Error('receipt scope expected');
        void ctx.continueReceipt(() => released.promise);
        return Promise.resolve({ kind: 'completed', output: 'answer' });
      },
    },
  }).start({ workflow });
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  expect(events.at(-1)?.type).toBe('run:completed');
  let finished = false;
  const departure = handle.depart();
  void departure.then(() => {
    finished = true;
  });
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
  expect(finished).toBe(false);
  expect(await host.runLeases.read(handle.runId)).toBeDefined();
  released.resolve();
  expect(await departure).toEqual({
    kind: 'closed',
    moneyDurability: 'durable',
    effectNeedsAttention: false,
  });
  expect(await host.runLeases.read(handle.runId)).toBeUndefined();
});

for (const receipt of ['committed', 'failed'] as const) {
  it(`an unchanged pause retains the final child effect disposition (${receipt})`, async () => {
    const host = createInMemoryHost();
    const released = deferred<void>();
    let child: Promise<void> | undefined;
    const port: EffectDispatchPort = {
      prepare: () => Promise.resolve({ outcome: 'proceed' }),
      settle: () =>
        receipt === 'failed'
          ? Promise.reject(new Error('PRIVATE-RECEIPT-CAUSE'))
          : Promise.resolve(),
      discard: () => Promise.resolve(),
    };
    const handle = new WorkflowEngine({
      host,
      effectJournal: () => port,
      executor: {
        execute: async (ctx) => {
          if (ctx.effects === undefined) throw new Error('journal expected');
          if (ctx.continueReceipt === undefined) throw new Error('receipt scope expected');
          await ctx.effects.prepare(0, 'run_command', 3, {});
          child = ctx.continueReceipt(async (scope) => {
            await released.promise;
            if (scope.effects === undefined) throw new Error('receipt port expected');
            await scope.effects.settle(0, 'run_command', 'committed');
          });
          void child.catch(() => undefined);
          return paused;
        },
      },
    }).start({ workflow });
    const read = await readPause(handle);
    const waiting = read.iterator.next();
    const departure = handle.depart();
    let finished = false;
    void departure.then(() => {
      finished = true;
    });
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    expect(finished).toBe(false);
    expect(await host.runLeases.read(handle.runId)).toBeDefined();
    released.resolve();
    await child?.catch(() => undefined);
    const result = await departure;
    expect(result).toEqual({
      kind: 'detached',
      moneyDurability: 'durable',
      effectNeedsAttention: receipt === 'failed',
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect((await waiting).done).toBe(true);
    expect(read.events.at(-1)?.type).toBe('run:paused');
    expect(handle.terminalError()).toBeUndefined();
    expect(handle.durability()).toBe('pending');
    expect(await host.runLeases.read(handle.runId)).toBeUndefined();
  });
}
