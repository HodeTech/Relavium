import { expect, it } from 'vitest';
import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('rejected budget activation joins an entered heartbeat before releasing its fence or returning', async () => {
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'resume-abandon-heartbeat',
        budget: { max_cost_microcents: 100, on_exceed: 'pause_for_approval' },
        agents: [{ id: 'worker', provider: 'openai', model: 'offline', system_prompt: 's' }],
        nodes: [
          {
            id: 'work',
            type: 'agent',
            agent_ref: 'worker',
            prompt_template: 'p',
            timeout_ms: 60000,
          },
        ],
        edges: [],
      },
    }),
  );
  const base = createInMemoryHost();
  const runId = 'abandoned-budget-run';
  const workflowId = await base.store.resolveWorkflowId(workflow.workflow.id);
  const fields = [
    { type: 'run:started', workflowId, inputs: {}, executionMode: 'local' },
    { type: 'node:started', nodeId: 'work', nodeType: 'agent' },
    {
      type: 'budget:paused',
      nodeId: 'work',
      gateId: 'gate',
      spentMicrocents: 2,
      limitMicrocents: 1,
    },
    { type: 'run:paused', gateIds: ['gate'], pendingGateCount: 1 },
  ];
  for (const [sequenceNumber, field] of fields.entries())
    await base.store.persistEvent(
      RunEventSchema.parse({
        runId,
        timestamp: new Date(0).toISOString(),
        sequenceNumber,
        ...field,
      }),
    );
  const decisionEntered = deferred(),
    releaseDecision = deferred(),
    heartbeatEntered = deferred(),
    releaseHeartbeat = deferred(),
    publicationFailed = deferred();
  const fault = new Error('one-shot activation publication fault');
  const published: RunEvent[] = [];
  let now = 1000,
    heartbeatDue = 0,
    heartbeatCount = 0,
    failClock = false,
    heartbeatSettled = false,
    returned = false,
    callerClosed = false,
    usedAfterClose = false;
  const host: typeof base = {
    ...base,
    clock: {
      now: () => {
        if (failClock) {
          failClock = false;
          publicationFailed.resolve();
          throw fault;
        }
        return new Date(now).toISOString();
      },
    },
    setTimer: (ms, fire, kind) => {
      const due = now + ms;
      if (kind === 'liveness') heartbeatDue = due;
      return base.setTimer(
        ms,
        () => {
          expect(now).toBeGreaterThanOrEqual(due);
          fire();
        },
        kind,
      );
    },
    store: {
      resolveWorkflowId: (slug) => base.store.resolveWorkflowId(slug),
      readWorkflowSnapshot: (id) => base.store.readWorkflowSnapshot(id),
      listInterruptedRuns: () => base.store.listInterruptedRuns(),
      persistEvent: async (event, context) => {
        if (event.type === 'budget:authorization' && event.authorization.state === 'decided') {
          decisionEntered.resolve();
          await releaseDecision.promise;
          await base.store.persistEvent(event, context);
          published.push(event);
          failClock = true;
          return;
        }
        await base.store.persistEvent(event, context);
        published.push(event);
      },
    },
    runLeases: {
      ...base.runLeases,
      heartbeat: async (...args) => {
        const entered = ++heartbeatCount > 1;
        if (entered) {
          heartbeatEntered.resolve();
          await releaseHeartbeat.promise;
          usedAfterClose = callerClosed;
        }
        try {
          return await base.runLeases.heartbeat(...args);
        } finally {
          if (entered) heartbeatSettled = true;
        }
      },
    },
  };
  let executorCalls = 0;
  const engine = new WorkflowEngine({
    host,
    executor: {
      execute: () => {
        executorCalls++;
        return Promise.resolve({ kind: 'completed', output: 'unused' });
      },
    },
  });
  const resuming = engine.resumeFromCheckpoint({
    runId,
    workflow,
    gateId: 'gate',
    decision: { decision: 'approved', decidedBy: 'offline' },
  });
  const outcome = resuming.then(
    () => {
      returned = true;
      throw new Error('unexpected handle');
    },
    (error: unknown) => {
      returned = true;
      return error;
    },
  );
  try {
    await decisionEntered.promise;
    expect(heartbeatDue).toBe(21000);
    now = heartbeatDue;
    host.fireLiveness();
    await heartbeatEntered.promise;
    releaseDecision.resolve();
    await publicationFailed.promise;
    for (let turn = 0; turn < 40; turn++) await Promise.resolve();
    expect(returned).toBe(false);
    expect(heartbeatSettled).toBe(false);
    expect(await host.runLeases.read(runId)).toBeDefined();
    expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
    releaseHeartbeat.resolve();
    expect(await outcome).toBe(fault);
    callerClosed = true;
    expect(heartbeatSettled).toBe(true);
    expect(usedAfterClose).toBe(false);
    expect(await host.runLeases.read(runId)).toBeUndefined();
    expect(executorCalls).toBe(0);
    expect(published.map((event) => event.type)).toEqual(['budget:authorization']);
    expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
  } finally {
    releaseDecision.resolve();
    releaseHeartbeat.resolve();
    await outcome;
    // A failing old implementation must not leave even a manual fixture timer armed.
    now = 60000;
    host.fireDeadlines();
  }
});

it('a partially installed restored node deadline is disarmed when the next arm throws', async () => {
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'resume-abandon-partial-timer',
        agents: [{ id: 'worker', provider: 'openai', model: 'offline', system_prompt: 's' }],
        nodes: ['first', 'second'].map((id) => ({
          id,
          type: 'agent',
          agent_ref: 'worker',
          prompt_template: 'p',
          timeout_ms: 5000,
        })),
        edges: [],
      },
    }),
  );
  const base = createInMemoryHost();
  const runId = 'abandoned-media-run';
  const workflowId = await base.store.resolveWorkflowId(workflow.workflow.id);
  const events: RunEvent[] = [];
  const add = (fields: Readonly<Record<string, unknown>>) =>
    events.push(
      RunEventSchema.parse({
        runId,
        timestamp: new Date(0).toISOString(),
        sequenceNumber: events.length,
        ...fields,
      }),
    );
  add({ type: 'run:started', workflowId, inputs: {}, executionMode: 'local' });
  for (const nodeId of ['first', 'second']) {
    add({ type: 'node:started', nodeId, nodeType: 'agent' });
    add({
      type: 'media_job:submitted',
      nodeId,
      jobId: nodeId + '-job',
      provider: 'openai',
      model: 'offline',
      modality: 'image',
      units: 1,
      acceptedCostMicrocents: 7,
      startedAt: new Date(0).toISOString(),
      deadlineAt: new Date(30000).toISOString(),
    });
  }
  add({
    type: 'run:paused',
    gateIds: [],
    pendingGateCount: 0,
    pendingMediaJobNodeIds: ['first', 'second'],
  });
  for (const event of events) await base.store.persistEvent(event);
  let arms = 0;
  const fault = new Error('second restored deadline arm fault');
  const host: typeof base = {
    ...base,
    clock: { now: () => new Date(1000).toISOString() },
    setTimer: (ms, fire, kind) => {
      if (kind === 'deadline' && ++arms === 2) throw fault;
      return base.setTimer(ms, fire, kind);
    },
  };
  let calls = 0;
  try {
    await expect(
      new WorkflowEngine({
        host,
        executor: {
          execute: () => {
            calls++;
            return Promise.resolve({ kind: 'completed', output: 'unused' });
          },
        },
      }).resumeFromCheckpoint({ runId, workflow }),
    ).rejects.toBe(fault);
    expect(arms).toBe(2);
    expect(calls).toBe(0);
    expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
    expect(await host.runLeases.read(runId)).toBeUndefined();
  } finally {
    host.fireDeadlines();
  }
});
