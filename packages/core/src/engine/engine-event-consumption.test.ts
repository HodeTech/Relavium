import { expect, it } from 'vitest';
import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine, type ResumeFromCheckpointInput } from './engine.js';
import { createInMemoryHost } from './execution-host.js';
import type { EventConsumption } from './event-stream.js';
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
      id: 'event-consumption',
      budget: { max_cost_microcents: 100, on_exceed: 'pause_for_approval' },
      agents: [{ id: 'worker', provider: 'openai', model: 'offline', system_prompt: 'go' }],
      nodes: [
        { id: 'work', type: 'agent', agent_ref: 'worker', prompt_template: 'go' },
        { id: 'out', type: 'output' },
      ],
      edges: [{ from: 'work', to: 'out' }],
    },
  }),
);

async function drain(handle: RunHandle): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

async function turns(): Promise<void> {
  for (let turn = 0; turn < 100; turn++) await Promise.resolve();
}

function observeTerminal(handle: RunHandle) {
  const terminal = deferred<RunEvent>();
  const events: RunEvent[] = [];
  handle.subscribe((event) => {
    if (!('runId' in event)) return;
    events.push(event);
    if (['run:completed', 'run:failed', 'run:cancelled'].includes(event.type))
      terminal.resolve(event);
  });
  return { events, terminal: terminal.promise };
}

function assertOrdered(events: readonly RunEvent[], first = 0): void {
  expect(events.map((event) => event.sequenceNumber)).toEqual(
    events.map((_, index) => first + index),
  );
}

it('the default capacity-one start waits before first pull and later delivers its complete terminal sequence', async () => {
  let calls = 0;
  const handle = new WorkflowEngine({
    host: createInMemoryHost(),
    eventBufferCapacity: 1,
    executor: {
      execute: () => {
        calls++;
        return Promise.resolve({ kind: 'completed', output: 'ok' });
      },
    },
  }).start({ workflow });
  const observed = observeTerminal(handle);
  await turns();
  expect(handle.bufferedCount).toBe(1);
  expect(calls).toBe(0);
  let ready = false;
  void handle.whenConsumersReady().then(() => {
    ready = true;
  });
  await turns();
  expect(ready).toBe(false);
  const events = await drain(handle);
  expect(events.at(-1)?.type).toBe('run:completed');
  expect(events).toEqual(observed.events);
  assertOrdered(events);
  expect(calls).toBe(2);
  expect((await handle.depart()).kind).toBe('closed');
});

it('subscribe-only starts stream without a primary buffer and join child receipts after terminal visibility', async () => {
  const host = createInMemoryHost();
  const release = deferred<void>();
  const handle = new WorkflowEngine({
    host,
    eventBufferCapacity: 1,
    executor: {
      execute: async (ctx) => {
        if (ctx.vertex.id === 'work') {
          if (ctx.continueReceipt === undefined) throw new Error('missing receipt scope');
          void ctx.continueReceipt(() => release.promise);
          if (ctx.whenReady === undefined) throw new Error('missing readiness');
          for (let index = 0; index < 5; index++) {
            await ctx.whenReady();
            ctx.emit({
              type: 'agent:token',
              nodeId: 'work',
              token: String(index),
              model: 'offline',
            });
          }
        }
        return Promise.resolve({ kind: 'completed', output: 'ok' });
      },
    },
  }).start({ workflow, eventConsumption: 'subscribe-only' });
  const observed = observeTerminal(handle);
  expect((await observed.terminal).type).toBe('run:completed');
  expect(handle.bufferedCount).toBe(0);
  expect(handle.durability()).toBe('durable');
  expect(observed.events.filter((event) => event.type === 'agent:token')).toHaveLength(5);
  assertOrdered(observed.events);
  await expect(drain(handle)).rejects.toMatchObject({ code: 'invalid_consumer_mode' });
  let joined = false;
  const departure = handle.depart().then((value) => {
    joined = true;
    return value;
  });
  await turns();
  expect(joined).toBe(false);
  expect(await host.runLeases.read(handle.runId)).toBeDefined();
  release.resolve();
  expect((await departure).kind).toBe('closed');
  expect(await host.runLeases.read(handle.runId)).toBeUndefined();
});

it('subscribe-only pause refuses primary departure authority but can still cancel and join', async () => {
  const handle = new WorkflowEngine({
    host: createInMemoryHost(),
    eventBufferCapacity: 1,
    executor: {
      execute: () =>
        Promise.resolve({
          kind: 'paused',
          gate: { gateType: 'approval', message: 'approve?' },
        }),
    },
  }).start({ workflow, eventConsumption: 'subscribe-only' });
  const paused = deferred<void>();
  handle.subscribe((event) => {
    if (event.type === 'run:paused') paused.resolve();
  });
  const observed = observeTerminal(handle);
  await paused.promise;
  expect(handle.bufferedCount).toBe(0);
  await expect(handle.depart()).rejects.toMatchObject({ code: 'invalid_departure' });
  handle.cancel();
  expect((await observed.terminal).type).toBe('run:cancelled');
  expect((await handle.depart()).kind).toBe('closed');
});

it.each(['iterated', 'subscribe-only'] as const)(
  'running %s departure continues until a pause needs primary authority',
  async (eventConsumption) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const paused = deferred<void>();
    const handle = new WorkflowEngine({
      host: createInMemoryHost(),
      eventBufferCapacity: 1,
      executor: {
        execute: async () => {
          entered.resolve();
          await release.promise;
          return { kind: 'paused', gate: { gateType: 'approval', message: 'approve?' } };
        },
      },
    }).start({ workflow, eventConsumption });
    const observed = observeTerminal(handle);
    handle.subscribe((event) => {
      if (event.type === 'run:paused') paused.resolve();
    });
    const reader = eventConsumption === 'iterated' ? drain(handle) : undefined;
    try {
      await entered.promise;
      await expect(handle.depart()).resolves.toEqual({ kind: 'continue' });
      release.resolve();
      await paused.promise;
      if (eventConsumption === 'subscribe-only')
        await expect(handle.depart()).rejects.toMatchObject({ code: 'invalid_departure' });
    } finally {
      release.resolve();
      handle.cancel();
      await observed.terminal;
      await reader;
      expect((await handle.depart()).kind).toBe('closed');
    }
  },
);

type ResumeCase =
  | 'gate'
  | 'budget-approved'
  | 'budget-rejected'
  | 'resolved'
  | 'media'
  | 'refused'
  | 'terminal';
async function seed(kind: ResumeCase) {
  const host = createInMemoryHost();
  const runId = 'resumed-consumption';
  const workflowId = await host.store.resolveWorkflowId(workflow.workflow.id);
  const fields: Readonly<Record<string, unknown>>[] = [
    { type: 'run:started', workflowId, inputs: {}, executionMode: 'local' },
    { type: 'node:started', nodeId: 'work', nodeType: 'agent' },
  ];
  if (kind === 'media') {
    fields.push({
      type: 'media_job:submitted',
      nodeId: 'work',
      jobId: 'paid-job',
      provider: 'openai',
      model: 'offline',
      modality: 'image',
      units: 1,
      acceptedCostMicrocents: 7,
      startedAt: new Date(0).toISOString(),
      deadlineAt: new Date(30000).toISOString(),
    });
    fields.push({
      type: 'run:paused',
      gateIds: [],
      pendingGateCount: 0,
      pendingMediaJobNodeIds: ['work'],
    });
  } else if (kind === 'terminal') {
    fields.push({
      type: 'run:completed',
      outputs: {},
      durationMs: 1,
      totalCostMicrocents: 0,
      totalTokensUsed: { input: 0, output: 0 },
    });
  } else {
    fields.push(
      kind.startsWith('budget')
        ? {
            type: 'budget:paused',
            nodeId: 'work',
            gateId: 'gate',
            spentMicrocents: 2,
            limitMicrocents: 1,
          }
        : {
            type: 'human_gate:paused',
            nodeId: 'work',
            gateId: 'gate',
            gateType: 'approval',
            message: 'approve?',
          },
    );
    fields.push({ type: 'run:paused', gateIds: ['gate'], pendingGateCount: 1 });
    if (kind === 'resolved')
      fields.push({
        type: 'human_gate:resumed',
        nodeId: 'work',
        decision: 'approved',
        decidedBy: 'tester',
      });
  }
  for (const [sequenceNumber, field] of fields.entries()) {
    await host.store.persistEvent(
      RunEventSchema.parse({
        runId,
        timestamp: new Date(0).toISOString(),
        sequenceNumber,
        ...field,
      }),
    );
  }
  return { host, runId, first: fields.length };
}

for (const kind of [
  'gate',
  'budget-approved',
  'budget-rejected',
  'resolved',
  'media',
  'refused',
  'terminal',
] as const) {
  for (const eventConsumption of ['iterated', 'subscribe-only'] as const) {
    it(`capacity-one ${eventConsumption} checkpoint resume publishes a usable handle through ${kind}`, async () => {
      const { host, runId, first } = await seed(kind);
      let calls = 0;
      let polls = 0;
      const published: RunEvent[] = [];
      const terminal = deferred<void>();
      const engine = new WorkflowEngine({
        host: {
          ...host,
          clock: { now: () => new Date(1000).toISOString() },
          store: {
            resolveWorkflowId: (slug) => host.store.resolveWorkflowId(slug),
            readWorkflowSnapshot: (id) => host.store.readWorkflowSnapshot(id),
            listInterruptedRuns: () => host.store.listInterruptedRuns(),
            persistEvent: async (event, context) => {
              await host.store.persistEvent(event, context);
              published.push(event);
              if (['run:completed', 'run:failed', 'run:cancelled'].includes(event.type))
                terminal.resolve();
            },
          },
        },
        eventBufferCapacity: 1,
        ...(kind !== 'refused'
          ? {}
          : {
              effectResume: {
                unresolvedForRun: () => Promise.reject(new Error('unreadable journal')),
              },
            }),
        executor: {
          execute: () => {
            calls++;
            return Promise.resolve({ kind: 'completed', output: 'ok' });
          },
          pollMediaJob: () => {
            polls++;
            return Promise.resolve({
              state: 'failed',
              error: {
                provider: 'openai',
                kind: 'transport',
                message: 'offline failure',
                retryable: false,
              },
            });
          },
        },
      });
      const handle = await engine.resumeFromCheckpoint({
        runId,
        workflow,
        eventConsumption,
        ...(kind === 'media'
          ? {}
          : {
              gateId: 'gate',
              decision: {
                decision: kind === 'budget-rejected' ? 'rejected' : 'approved',
                decidedBy: 'tester',
              },
            }),
      });
      const observed = observeTerminal(handle);
      if (kind === 'media') host.fireTimers();
      if (eventConsumption === 'iterated') {
        const events = await drain(handle);
        expect(events.filter((event) => event.type !== 'cost:updated')).toEqual(published);
        assertOrdered(events, first);
      } else {
        if (kind !== 'terminal') await terminal.promise;
        await expect(drain(handle)).rejects.toMatchObject({ code: 'invalid_consumer_mode' });
        expect(handle.bufferedCount).toBe(0);
        assertOrdered(kind === 'media' ? observed.events : published, first);
      }
      const failed = ['budget-rejected', 'media', 'refused'].includes(kind);
      expect(published.at(-1)?.type).toBe(
        kind === 'terminal' ? undefined : failed ? 'run:failed' : 'run:completed',
      );
      if (kind === 'refused') expect(handle.terminalError()).toBe('effect_needs_attention');
      expect(handle.durability()).toBe('durable');
      expect((await handle.depart()).kind).toBe('closed');
      expect(await host.runLeases.read(runId)).toBeUndefined();
      expect(polls).toBe(kind === 'media' ? 1 : 0);
      if (['refused', 'terminal', 'budget-rejected', 'media'].includes(kind)) expect(calls).toBe(0);
    });
  }
}

for (const initial of ['iterated', 'subscribe-only'] as const) {
  it(`snapshots ${initial} before the first asynchronous resume port`, async () => {
    const { host, runId } = await seed('terminal');
    const entered = deferred<void>();
    const release = deferred<void>();
    const engine = new WorkflowEngine({
      host: {
        ...host,
        runLeases: {
          ...host.runLeases,
          acquire: async (...args) => {
            entered.resolve();
            await release.promise;
            return host.runLeases.acquire(...args);
          },
        },
      },
      executor: { execute: () => Promise.resolve({ kind: 'completed', output: 'unused' }) },
    });
    const input: ResumeFromCheckpointInput & { eventConsumption: EventConsumption } = {
      runId,
      workflow,
      eventConsumption: initial,
    };
    const pending = engine.resumeFromCheckpoint(input);
    await entered.promise;
    input.eventConsumption = initial === 'iterated' ? 'subscribe-only' : 'iterated';
    release.resolve();
    const handle = await pending;
    if (initial === 'iterated') expect(await drain(handle)).toEqual([]);
    else await expect(drain(handle)).rejects.toMatchObject({ code: 'invalid_consumer_mode' });
    expect((await handle.depart()).kind).toBe('closed');
  });
}

it('subscribe-only fencing joins the real executor without inventing a terminal or primary acknowledgement', async () => {
  const base = createInMemoryHost();
  const entered = deferred<void>();
  const release = deferred<void>();
  let takenOver = false;
  const host: typeof base = {
    ...base,
    runLeases: {
      ...base.runLeases,
      heartbeat: (...args) =>
        takenOver ? Promise.resolve(false) : base.runLeases.heartbeat(...args),
    },
  };
  const handle = new WorkflowEngine({
    host,
    eventBufferCapacity: 1,
    executor: {
      execute: async () => {
        entered.resolve();
        await release.promise;
        return { kind: 'completed', output: 'too late' };
      },
    },
  }).start({ workflow, eventConsumption: 'subscribe-only' });
  const observed = observeTerminal(handle);
  await entered.promise;
  takenOver = true;
  host.fireLiveness();
  await turns();
  expect(handle.durability()).toBe('uncertain');
  let joined = false;
  const departure = handle.depart().then((result) => {
    joined = true;
    return result;
  });
  await turns();
  expect(joined).toBe(false);
  release.resolve();
  expect((await departure).kind).toBe('closed');
  expect(observed.events.map((event) => event.type)).toEqual(['run:started', 'node:started']);
  expect(handle.bufferedCount).toBe(0);
  await expect(drain(handle)).rejects.toMatchObject({ code: 'invalid_consumer_mode' });
});

it('a live resume snapshots its omitted iterated default before checkpoint loading can mutate the input', async () => {
  const { host, runId } = await seed('gate');
  const entered = deferred<void>();
  const release = deferred<void>();
  const input: { eventConsumption?: EventConsumption } & ResumeFromCheckpointInput = {
    runId,
    workflow,
    gateId: 'gate',
    decision: { decision: 'approved', decidedBy: 'tester' },
  };
  const engine = new WorkflowEngine({
    host: {
      ...host,
      checkpointer: {
        load: async (id) => {
          entered.resolve();
          await release.promise;
          return host.checkpointer.load(id);
        },
      },
    },
    eventBufferCapacity: 1,
    executor: { execute: () => Promise.resolve({ kind: 'completed', output: 'ok' }) },
  });
  const pending = engine.resumeFromCheckpoint(input);
  await entered.promise;
  input.eventConsumption = 'subscribe-only';
  release.resolve();
  const handle = await pending;
  const events = await drain(handle);
  expect(events.map((event) => event.type)).toEqual([
    'human_gate:resumed',
    'node:started',
    'node:completed',
    'run:completed',
  ]);
  expect((await handle.depart()).kind).toBe('closed');
});
