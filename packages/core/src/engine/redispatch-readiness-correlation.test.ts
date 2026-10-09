import { expect, it } from 'vitest';
import type { RunEvent } from '@relavium/shared';
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
for (const refuseReadiness of [false, true]) {
  it(`preserves the latest entered retry before approved redispatch readiness (${String(refuseReadiness)})`, async () => {
    const host = createInMemoryHost();
    const paused = deferred();
    const attempts: number[] = [];
    const engine = new WorkflowEngine({
      host,
      executor: {
        execute: (ctx) => {
          attempts.push(ctx.attemptNumber);
          if (attempts.length > 2) return Promise.resolve({ kind: 'completed', output: 'answer' });
          return ctx.attemptNumber === 1
            ? Promise.resolve({
                kind: 'failed',
                error: {
                  code: 'provider_unavailable',
                  message: 'temporary outage',
                  retryable: true,
                },
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
            id: 'redispatch-readiness-correlation',
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
    const readiness = handle.whenConsumersReady;
    let resumed = false;
    let refusals = 0;
    handle.whenConsumersReady = () => {
      if (resumed && refuseReadiness) {
        refusals += 1;
        return Promise.reject(new Error('PRIVATE-REDISPATCH-READINESS'));
      }
      return Reflect.apply(readiness, handle, []);
    };
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
      expect(attempts).toEqual([1, 2]);
      resumed = true;
      await engine.resume(handle.runId, gateId, { decision: 'approved', decidedBy: 'tester' });
      await drained;
      const starts = events.filter((event) => event.type === 'node:started');
      const failed = events.filter((event) => event.type === 'node:failed');
      if (refuseReadiness) {
        expect(refusals).toBe(1);
        expect(attempts).toEqual([1, 2]);
        expect(starts.map((event) => event.attemptNumber ?? 1)).toEqual([1, 2]);
        expect(failed).toHaveLength(1);
        expect(failed[0]?.attemptNumber ?? 1).toBe(2);
        expect(failed[0]?.error).toMatchObject({
          code: 'internal',
          message: 'the event consumer readiness check failed',
        });
        expect(events.at(-1)?.type).toBe('run:failed');
      } else {
        expect(refusals).toBe(0);
        expect(attempts).toEqual([1, 2, 1]);
        expect(starts.map((event) => event.attemptNumber ?? 1)).toEqual([1, 2, 1]);
        expect(failed).toEqual([]);
        expect(events.at(-1)?.type).toBe('run:completed');
      }
      expect(JSON.stringify(events)).not.toContain('PRIVATE');
      await expect.poll(() => host.runLeases.read(handle.runId)).toBeUndefined();
      expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
    } finally {
      handle.cancel();
      host.fireDeadlines();
      await drained;
    }
  });
}
