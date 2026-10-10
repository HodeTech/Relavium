import { expect, it } from 'vitest';
import type { DurableWriteContext, RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('binds grace to the new first start after a retried budget pause', async () => {
  const paused = deferred();
  const entered = deferred();
  const released = deferred();
  let starts = 0;
  class Store extends InMemoryRunStore {
    override async persistEvent(event: RunEvent, context?: DurableWriteContext): Promise<void> {
      if (event.type === 'node:started' && event.nodeId === 'work') {
        starts += 1;
        if (starts === 3) {
          expect(event.attemptNumber).toBeUndefined();
          entered.resolve();
          await released.promise;
        }
      }
      await super.persistEvent(event, context);
    }
  }
  const host = createInMemoryHost({ store: new Store() });
  const attempts: number[] = [];
  const engine = new WorkflowEngine({
    host,
    executor: {
      execute: (ctx) => {
        attempts.push(ctx.attemptNumber);
        return ctx.attemptNumber === 1
          ? Promise.resolve({
              kind: 'failed',
              error: { code: 'provider_unavailable', message: 'temporary outage', retryable: true },
            })
          : Promise.resolve({
              kind: 'paused',
              gate: {
                gateType: 'approval',
                isBudgetGate: true,
                message: 'budget approval',
                spentMicrocents: 0,
                limitMicrocents: 1,
              },
            });
      },
    },
  });
  const handle = engine.start({
    workflow: parseWorkflow(
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'redispatch-grace-correlation',
          agents: [
            { id: 'worker', model: 'offline-model', provider: 'openai', system_prompt: 'go' },
          ],
          nodes: [
            {
              id: 'work',
              type: 'agent',
              agent_ref: 'worker',
              prompt_template: 'go',
              retry: { max: 2, backoff: 'linear', backoff_ms: 1 },
            },
          ],
          edges: [],
        },
      }),
    ),
  });
  const events: RunEvent[] = [];
  let gateId = '';
  const drained = (async () => {
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'node:retrying') {
        for (let turn = 0; turn < 1000 && host.armedCount() === 0; turn += 1)
          await Promise.resolve();
        expect(host.armedCount()).toBe(1);
        host.fireTimers();
      }
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        paused.resolve();
      }
    }
  })();
  try {
    await paused.promise;
    expect(gateId).not.toBe('');
    expect(attempts).toEqual([1, 2]);
    const resumed = engine.resume(handle.runId, gateId, {
      decision: 'approved',
      decidedBy: 'tester',
    });
    await entered.promise;
    await resumed;
    handle.cancel();
    expect(host.deadlineCount()).toBe(1);
    host.fireDeadlines();
    expect(host.deadlineCount()).toBe(0);
    released.resolve();
    await drained;
    expect(attempts).toEqual([1, 2]);
    expect(starts).toBe(3);
    const failures = events.filter((event) => event.type === 'node:failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.attemptNumber ?? 1).toBe(1);
    expect(failures[0]?.error.code).toBe('cancelled');
    expect(events.at(-1)?.type).toBe('run:cancelled');
    await expect.poll(() => host.runLeases.read(handle.runId)).toBeUndefined();
    expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
  } finally {
    released.resolve();
    handle.cancel();
    host.fireDeadlines();
    await drained;
  }
});
