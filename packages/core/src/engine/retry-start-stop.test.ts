import { expect, it } from 'vitest';
import type { DurableWriteContext, RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import type { NodeExecContext, NodeOutcome } from './node-executor.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const ending of ['live', 'cancel', 'sibling-failure', 'grace'] as const) {
  it(`rechecks admission after an entered retry-start append (${ending})`, async () => {
    const cancelled = ending === 'cancel' || ending === 'grace';
    const siblingEntered = deferred();
    let finishSibling!: (outcome: NodeOutcome) => void;
    const siblingOutcome = new Promise<NodeOutcome>((resolve) => {
      finishSibling = resolve;
    });
    const entered = deferred();
    const released = deferred();
    const appended = deferred();
    class Store extends InMemoryRunStore {
      override async persistEvent(event: RunEvent, context?: DurableWriteContext): Promise<void> {
        if (event.type === 'node:started' && event.nodeId === 'work' && event.attemptNumber === 2) {
          entered.resolve();
          await released.promise;
          await super.persistEvent(event, context);
          appended.resolve();
          return;
        }
        await super.persistEvent(event, context);
      }
    }
    const host = createInMemoryHost({ store: new Store() });
    const attempts: number[] = [];
    let workSignal: NodeExecContext['signal'] | undefined;
    const handle = new WorkflowEngine({
      host,
      executor: {
        execute: (ctx) => {
          if (ctx.vertex.id === 'sibling') {
            siblingEntered.resolve();
            return siblingOutcome;
          }
          workSignal = ctx.signal;
          attempts.push(ctx.attemptNumber);
          return ctx.attemptNumber === 1
            ? Promise.resolve({
                kind: 'failed',
                error: {
                  code: 'provider_unavailable',
                  message: 'temporary outage',
                  retryable: true,
                },
              })
            : Promise.resolve({ kind: 'completed', output: 'answer' });
        },
      },
    }).start({
      workflow: parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'retry-start-stop',
            agents: [
              { id: 'worker', model: 'offline-model', provider: 'openai', system_prompt: 'go' },
            ],
            nodes: [
              ...(ending === 'sibling-failure'
                ? [{ id: 'sibling', type: 'agent', agent_ref: 'worker', prompt_template: 'wait' }]
                : []),
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
    const drained = (async () => {
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'node:retrying') {
          for (let turn = 0; turn < 1000 && host.armedCount() === 0; turn += 1)
            await Promise.resolve();
          expect(host.armedCount()).toBeGreaterThan(0);
          host.fireTimers();
        }
      }
    })();
    try {
      await entered.promise;
      expect(attempts).toEqual([1]);
      if (ending === 'sibling-failure') {
        await siblingEntered.promise;
        finishSibling({
          kind: 'failed',
          error: { code: 'tool_failed', message: 'sibling refused', retryable: false },
        });
        await expect.poll(() => workSignal?.aborted).toBe(true);
      }
      if (cancelled) handle.cancel();
      if (ending === 'grace') {
        expect(host.deadlineCount()).toBe(1);
        host.fireDeadlines();
        expect(host.deadlineCount()).toBe(0);
      }
      expect(workSignal?.aborted).toBe(ending !== 'live');
      released.resolve();
      await appended.promise;
      for (
        let turn = 0;
        turn < 1000 &&
        !events.some(
          (event) =>
            event.type === 'run:cancelled' ||
            event.type === 'run:completed' ||
            event.type === 'run:failed',
        );
        turn += 1
      )
        await Promise.resolve();
      expect(attempts).toEqual(ending === 'live' ? [1, 2] : [1]);
      await drained;
      expect(events.at(-1)?.type).toBe(
        cancelled ? 'run:cancelled' : ending === 'sibling-failure' ? 'run:failed' : 'run:completed',
      );
      if (ending !== 'live')
        expect(
          events.filter((event) => event.type === 'node:failed' && event.nodeId === 'work'),
        ).toMatchObject([{ nodeId: 'work', attemptNumber: 2, error: { code: 'cancelled' } }]);
      if (ending === 'sibling-failure')
        expect(events.at(-1)).toMatchObject({ type: 'run:failed', error: { code: 'tool_failed' } });
      await expect.poll(() => host.runLeases.read(handle.runId)).toBeUndefined();
      expect(host.armedCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
    } finally {
      finishSibling({ kind: 'completed', output: 'cleanup' });
      released.resolve();
      handle.cancel();
      host.fireDeadlines();
      await drained;
    }
  });
}
