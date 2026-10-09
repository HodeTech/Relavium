import { AllowanceQuoteResultSchema, RunEventSchema, type RunEvent } from '@relavium/shared';
import { expect, it } from 'vitest';
import { parseWorkflow } from '../parser.js';
import { reconstructCheckpointState, type CheckpointPendingGate } from './checkpoint.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';

const workflow = parseWorkflow(
  JSON.stringify({
    schema_version: '1.0',
    workflow: {
      id: 'parked-node-clock',
      budget: { max_cost_microcents: 100, on_exceed: 'pause_for_approval' },
      agents: [{ id: 'worker', model: 'offline-model', provider: 'openai', system_prompt: 'go' }],
      nodes: [
        { id: 'work', type: 'agent', agent_ref: 'worker', prompt_template: 'go', timeout_ms: 4000 },
      ],
      edges: [],
    },
  }),
);

async function seed(mode: 'budget' | 'approved-gap' | 'media', native: boolean, invalid = false) {
  const base = createInMemoryHost();
  const workflowId = await base.store.resolveWorkflowId(workflow.workflow.id);
  const events: RunEvent[] = [];
  const append = (ms: number, fields: Readonly<Record<string, unknown>>) => {
    events.push(
      RunEventSchema.parse({
        runId: 'parked-clock-run',
        timestamp: new Date(ms).toISOString(),
        sequenceNumber: events.length,
        ...fields,
      }),
    );
  };
  append(0, { type: 'run:started', workflowId, inputs: {}, executionMode: 'local' });
  const start = (ms: number, attemptNumber?: number) =>
    append(ms, {
      type: 'node:started',
      nodeId: 'work',
      nodeType: 'agent',
      attemptNumber,
    });
  const pause = (ms: number, gateId: string) => {
    if (native)
      append(ms, {
        type: 'budget:authorization',
        nodeId: 'work',
        gateId,
        authorization: {
          state: 'paused',
          allowance: { kind: 'legacy_no_allowance' },
          spentMicrocents: 2,
          limitMicrocents: 1,
        },
      });
    else
      append(ms, {
        type: 'budget:paused',
        nodeId: 'work',
        gateId,
        spentMicrocents: 2,
        limitMicrocents: 1,
      });
  };
  const approve = (ms: number, gateId: string) => {
    if (native)
      append(ms, {
        type: 'budget:authorization',
        nodeId: 'work',
        gateId,
        authorization: {
          state: 'decided',
          allowance: { kind: 'legacy_no_allowance' },
          decision: 'approved',
          decidedBy: 'offline',
        },
      });
    append(ms, {
      type: 'human_gate:resumed',
      nodeId: 'work',
      gateId,
      decision: 'approved',
      decidedBy: 'offline',
    });
  };
  start(0);
  start(1000); // a genuine running crash begins T1, not the original T0
  pause(2000, 'first');
  approve(2100, 'first');
  start(2200); // consumes the first continuation, preserving T1
  if (!invalid)
    append(2300, {
      type: 'node:retrying',
      nodeId: 'work',
      attemptNumber: 1,
      error: { code: 'provider_unavailable', message: 'offline', retryable: true },
      delayMs: 0,
    });
  start(2400, 2);
  if (mode === 'media')
    append(2500, {
      type: 'media_job:submitted',
      nodeId: 'work',
      jobId: 'same-job',
      provider: 'openai',
      model: 'offline-model',
      modality: 'image',
      units: 1,
      acceptedCostMicrocents: 7,
      startedAt: new Date(2500).toISOString(),
      deadlineAt: new Date(30000).toISOString(),
    });
  else {
    pause(2500, 'second');
    if (mode === 'approved-gap') approve(2600, 'second');
  }
  if (mode !== 'approved-gap')
    append(2700, {
      type: 'run:paused',
      gateIds: mode === 'budget' ? ['second'] : [],
      pendingGateCount: mode === 'budget' ? 1 : 0,
      ...(mode === 'media' ? { pendingMediaJobNodeIds: ['work'] } : {}),
    });
  for (const event of events) await base.store.persistEvent(event);
  return { base, events };
}

for (const native of [false, true]) {
  for (const mode of ['budget', 'approved-gap'] as const) {
    it(`reconstructs remaining T1 across ${mode} (${native ? 'typed' : 'legacy'})`, async () => {
      const { base } = await seed(mode, native);
      const timers: number[] = [];
      const host: typeof base = {
        ...base,
        clock: { now: () => new Date(4500).toISOString() },
        setTimer: (ms, fire, kind) => {
          if (kind === 'deadline') timers.push(ms);
          return base.setTimer(ms, fire, kind);
        },
      };
      let calls = 0;
      const handle = await new WorkflowEngine({
        host,
        executor: {
          execute: () => {
            calls += 1;
            return Promise.resolve({ kind: 'completed', output: 'answer' });
          },
        },
      }).resumeFromCheckpoint({
        runId: 'parked-clock-run',
        workflow,
        gateId: 'second',
        decision: { decision: 'approved', decidedBy: 'tester' },
      });
      const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(calls).toBe(1);
      expect(timers).toEqual([500]);
      expect(events.at(-1)?.type).toBe('run:completed');
      expect((await handle.depart()).kind).toBe('closed');
      expect(await host.runLeases.read(handle.runId)).toBeUndefined();
      expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
    });
  }
  it(`an expired ${native ? 'typed' : 'legacy'} budget life refuses before redispatch`, async () => {
    const { base } = await seed('budget', native);
    const host: typeof base = { ...base, clock: { now: () => new Date(5000).toISOString() } };
    let calls = 0;
    const handle = await new WorkflowEngine({
      host,
      executor: {
        execute: () => {
          calls += 1;
          return Promise.resolve({ kind: 'completed', output: 'unexpected' });
        },
      },
    }).resumeFromCheckpoint({
      runId: 'parked-clock-run',
      workflow,
      gateId: 'second',
      decision: { decision: 'approved', decidedBy: 'tester' },
    });
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect(calls).toBe(0);
    expect(
      events.filter(
        (event) => event.type === 'node:started' || event.type === 'human_gate:resumed',
      ),
    ).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'run:failed', error: { code: 'run_timeout' } });
    expect((await handle.depart()).kind).toBe('closed');
    expect(await host.runLeases.read(handle.runId)).toBeUndefined();
    expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
  });
}

it('an expired media node refuses paid polling while retaining the existing job accounting', async () => {
  const { base } = await seed('media', true);
  const host: typeof base = { ...base, clock: { now: () => new Date(5000).toISOString() } };
  let calls = 0;
  let polls = 0;
  const handle = await new WorkflowEngine({
    host,
    executor: {
      execute: () => {
        calls += 1;
        return Promise.resolve({ kind: 'completed', output: undefined });
      },
      pollMediaJob: () => {
        polls += 1;
        return Promise.resolve({ state: 'pending' });
      },
    },
  }).resumeFromCheckpoint({ runId: 'parked-clock-run', workflow });
  const events: RunEvent[] = [];
  const drained = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  try {
    await expect.poll(() => events.at(-1)?.type).toBe('run:failed');
    await drained;
    expect(calls).toBe(0);
    expect(polls).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: 'run:failed', error: { code: 'run_timeout' } });
    expect(events.filter((event) => event.type === 'media_job:submitted')).toEqual([]);
    expect(events.filter((event) => event.type === 'budget:estimate_committed')).toEqual([
      expect.objectContaining({ estimateMicrocents: 7 }),
    ]);
    expect((await handle.depart()).kind).toBe('closed');
    expect(await host.runLeases.read(handle.runId)).toBeUndefined();
    expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
  } finally {
    handle.cancel();
    host.fireDeadlines();
    await drained;
    await handle.depart();
  }
});

it('invalid retry association refuses admission without leaking the acquired fence', async () => {
  const { base } = await seed('budget', true, true);
  const host: typeof base = { ...base, clock: { now: () => new Date(3000).toISOString() } };
  let calls = 0;
  await expect(
    new WorkflowEngine({
      host,
      executor: {
        execute: () => {
          calls += 1;
          return Promise.resolve({ kind: 'completed', output: undefined });
        },
      },
    }).resumeFromCheckpoint({
      runId: 'parked-clock-run',
      workflow,
      gateId: 'second',
      decision: { decision: 'approved', decidedBy: 'tester' },
    }),
  ).rejects.toMatchObject({ code: 'admission_record_unreadable' });
  expect(calls).toBe(0);
  expect(await host.runLeases.read('parked-clock-run')).toBeUndefined();
  expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
});

it('a missing parked-node basis refuses before preparation or executor entry', async () => {
  const { base, events } = await seed('budget', true);
  const checkpoint = reconstructCheckpointState(events);
  if (checkpoint === undefined) throw new Error('checkpoint expected');
  // A representable frozen quote makes preparation reachable if clock admission moves later.
  const quote = AllowanceQuoteResultSchema.parse({
    kind: 'quoted',
    quote: {
      amount: { kind: 'representable', microcents: 10 },
      provenance: {
        version: 1,
        route: 'text',
        calls: 1,
        attempts: 2,
        entries: [
          {
            index: 0,
            model: 'offline-model',
            provider: 'openai',
            endpoint: 'custom',
            attempts: 2,
            estimate: {
              kind: 'priced',
              microcents: 5,
              basis: {
                inputTokensEstimate: 2,
                outputTokensReservation: 3,
                inputRateKind: 'non_cached',
                inputPerMtokMicrocents: 1000000,
                outputPerMtokMicrocents: 1000000,
                media: [],
              },
              unpricedModalities: [],
            },
          },
        ],
      },
      excludedEntries: [],
    },
  });
  const host: typeof base = {
    ...base,
    checkpointer: {
      load: () =>
        Promise.resolve({
          ...checkpoint,
          nodeLifeClocks: new Map(),
          pendingGates: checkpoint.pendingGates.map(
            (gate): CheckpointPendingGate => ({ ...gate, allowance: { kind: 'frozen', quote } }),
          ),
        }),
    },
  };
  let preparations = 0;
  let executions = 0;
  await expect(
    new WorkflowEngine({
      host,
      executor: {
        prepareBudgetDispatch: () => {
          preparations += 1;
          throw new Error('PRIVATE-PREPARATION-MUST-NOT-ENTER');
        },
        execute: () => {
          executions += 1;
          return Promise.resolve({ kind: 'completed', output: undefined });
        },
      },
    }).resumeFromCheckpoint({
      runId: 'parked-clock-run',
      workflow,
      gateId: 'second',
      decision: { decision: 'approved', decidedBy: 'tester', approvedAmountMicrocents: 10 },
    }),
  ).rejects.toMatchObject({ code: 'admission_record_unreadable' });
  expect(preparations).toBe(0);
  expect(executions).toBe(0);
  expect(await host.runLeases.read('parked-clock-run')).toBeUndefined();
  expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
});

it('an older cached derivation refuses until its durable events are folded by the current reader', async () => {
  const { base, events } = await seed('budget', true);
  const current = reconstructCheckpointState(events);
  if (current === undefined) throw new Error('checkpoint expected');
  const host: typeof base = {
    ...base,
    clock: { now: () => new Date(4500).toISOString() },
    checkpointer: { load: () => Promise.resolve({ ...current, schemaVersion: 2 }) },
  };
  await expect(
    new WorkflowEngine({
      host,
      executor: {
        execute: () => Promise.resolve({ kind: 'completed', output: undefined }),
      },
    }).resumeFromCheckpoint({
      runId: 'parked-clock-run',
      workflow,
      gateId: 'second',
      decision: { decision: 'approved', decidedBy: 'tester' },
    }),
  ).rejects.toMatchObject({ code: 'admission_record_unreadable' });
  expect(await host.runLeases.read('parked-clock-run')).toBeUndefined();
  expect((await base.checkpointer.load('parked-clock-run'))?.schemaVersion).toBe(3);
  const rebuiltHost: typeof host = { ...host, checkpointer: base.checkpointer };
  const rebuilt = await new WorkflowEngine({
    host: rebuiltHost,
    executor: {
      execute: () => Promise.resolve({ kind: 'completed', output: 'rebuilt' }),
    },
  }).resumeFromCheckpoint({
    runId: 'parked-clock-run',
    workflow,
    gateId: 'second',
    decision: { decision: 'approved', decidedBy: 'tester' },
  });
  const delivered: RunEvent[] = [];
  for await (const event of rebuilt.events) delivered.push(event);
  expect(delivered.at(-1)?.type).toBe('run:completed');
  expect((await rebuilt.depart()).kind).toBe('closed');
});

it('a live reattachment polls the same job and can detach without another pause or charge', async () => {
  const { base } = await seed('media', true);
  const arms: number[] = [];
  const host: typeof base = {
    ...base,
    clock: { now: () => new Date(4500).toISOString() },
    setTimer: (ms, fire, kind) => {
      if (kind === 'deadline') arms.push(ms);
      return base.setTimer(ms, fire, kind);
    },
  };
  const jobs: string[] = [];
  let calls = 0;
  const handle = await new WorkflowEngine({
    host,
    executor: {
      execute: () => {
        calls += 1;
        return Promise.resolve({ kind: 'completed', output: undefined });
      },
      pollMediaJob: (job) => {
        jobs.push(job.jobId);
        return Promise.resolve({ state: 'pending' });
      },
    },
  }).resumeFromCheckpoint({ runId: 'parked-clock-run', workflow });
  expect(arms).toEqual([500]);
  host.fireTimers();
  await expect.poll(() => jobs).toEqual(['same-job']);
  const iterator = handle.events[Symbol.asyncIterator]();
  const pending = iterator.next();
  expect(await handle.depart()).toEqual({
    kind: 'detached',
    moneyDurability: 'durable',
    effectNeedsAttention: false,
  });
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(jobs).toEqual(['same-job']);
  expect(calls).toBe(0);
  expect(await host.runLeases.read(handle.runId)).toBeUndefined();
  expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
});
